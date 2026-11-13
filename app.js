const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const requireAuth = require('./middleware/requireAuth');
const requireExistingUser = require('./middleware/requireExistingUser');
const sourceToken = require('./middleware/sourceToken');
const requireMediaToken = require('./middleware/requireMediaToken');
const { issueMediaToken } = require('./services/mediaToken');

const authController = require('./controllers/authController');
const { registerUser, loginUser } = require('./controllers/UserController');
const searchController = require('./controllers/searchController');
const playlistController = require('./controllers/playlistController');
const historyController = require('./controllers/historyController');
const streamingController = require('./controllers/streamingController');
const { getHealth } = require('./services/health');
const usage = require('./services/usage');
const matchJournal = require('./services/matcher/journal');
const soundcloudController = require('./controllers/soundcloudController');
const libraryController = require('./controllers/libraryController');
const matchController = require('./controllers/matchController');
const localController = require('./controllers/localController');
const lyricsController = require('./controllers/lyricsController');
const artworkController = require('./controllers/artworkController');
const settingsController = require('./controllers/settingsController');
const cloudController = require('./controllers/cloudController');
const logFile = require('./services/logFile');

const app = express();

// --- Global middleware ---
app.use(helmet());

// Allow only known client origins (dev Vite server + the Tauri webview).
// Configure extra origins via CLIENT_ORIGIN (comma-separated).
const allowedOrigins = new Set([
    'http://localhost:5173',
    'http://localhost:1420',
    'tauri://localhost',
    'https://tauri.localhost',
    'http://tauri.localhost', // Tauri v2 on Windows
    ...(process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',').map(o => o.trim()) : [])
]);
app.use(cors({
    origin: (origin, cb) => {
        // Requests with no Origin (e.g. the native <audio> element, curl) are allowed.
        if (!origin || allowedOrigins.has(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
    }
}));

app.use(express.json({ limit: '1mb' }));

// --- Rate limiters ---
// A general baseline cap on every request. Rate-limiting middleware bounds how
// many requests one client (by IP) may make in a window, so a single caller
// cannot exhaust the server with floods of DB queries, yt-dlp/ffmpeg work, or
// brute-force guesses. This baseline also protects routes that do file-system
// or database work; the auth and media limiters below stack a tighter cap on
// their sensitive endpoints.
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 });
// yt-dlp + ffmpeg are expensive, so the media endpoints get their own cap.
const mediaLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
// Login/register are brute-force targets, so they get a tighter cap.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
// Each resolve may spend up to 100 YouTube Music searches (and yt-dlp time);
// a page of a playlist needs one call, so this is generous for a person and
// tight for a script.
const matchResolveLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120 });
// Changing the installation's service credentials is rare.
const settingsLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
// "Sync now" is a button; background runs do not pass through here.
const cloudSyncLimiter = rateLimit({ windowMs: 60 * 1000, max: 12 });
// One lyrics request per track played; a lookup may call the lyrics server.
const lyricsLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
// One per track played; each new cover costs a download and an ffmpeg run.
const artworkLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

// Apply the baseline limiter to every route (defined before the routes so it
// sits in front of them all).
app.use(apiLimiter);

// --- Health ---
app.get('/', (req, res) => {
    res.json({ status: 'Running', message: 'Music Backend is active' });
});
app.get('/test', (req, res) => res.send('Server is working!'));
// Detailed health (app + yt-dlp/ffmpeg versions + cache usage). Behind our
// login because binary versions help an attacker pick a known exploit.
app.get('/api/health', requireAuth, async (req, res, next) => {
    try {
        res.json(await getHealth({ fresh: req.query.fresh === '1' }));
    } catch (err) {
        next(err);
    }
});

// The end of the server's log (services/logFile.js), for a problem report.
// Owner only: the log covers every account on this installation.
app.get('/api/system/log', requireAuth, settingsController.requireOwner, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ file: `logs/${logFile.FILE_NAME}`, lines: logFile.readRecent(req.query.lines) });
});

// What the app spent on outside services (services/usage.js): searches,
// yt-dlp runs and YouTube Data API quota units per day, and what is left of
// today's quota. Owner only, like the log: it covers every account here.
app.get('/api/system/usage', requireAuth, settingsController.requireOwner, async (req, res, next) => {
    try {
        res.set('Cache-Control', 'no-store');
        res.json(await usage.report(req.app.locals.db, { days: req.query.days }));
    } catch (err) {
        next(err);
    }
});

// The match engine's latest decisions with what each was made from
// (services/matcher/journal.js): the place to look when the wrong song played.
app.get('/api/system/matches', requireAuth, settingsController.requireOwner, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ file: `logs/${matchJournal.FILE_NAME}`, enabled: matchJournal.enabled(), entries: matchJournal.readRecent(req.query.limit) });
});

// --- Local account auth ---
app.post('/api/register', authLimiter, registerUser);
app.post('/api/login', authLimiter, loginUser);

// --- Google OAuth (connects a YouTube account to the logged-in user) ---
// The URL endpoint requires our login so the callback can tie the tokens to a
// user; the callback itself is public because Google redirects the bare browser.
// requireExistingUser fails fast if the session names a deleted account, so a
// stale token gets a clear 401 here instead of a FOREIGN KEY error after the
// full round-trip to the provider.
app.get('/auth/google/url', requireAuth, requireExistingUser, authController.getGoogleAuthUrl);
app.get('/auth/google/callback', authController.googleCallback);
app.get('/api/user/connections', requireAuth, authController.getConnections);
app.delete('/api/user/connections/youtube', requireAuth, authController.disconnectGoogle);

// --- Settings -> Accounts: this installation's service credentials. Anyone
// logged in sees what is set up (never the values); only the installation's
// owner changes it (services/appSettings.js). ---
app.get('/api/settings/services', requireAuth, settingsController.listServices);
app.put('/api/settings/services/:source', requireAuth, settingsLimiter, settingsController.requireOwner, settingsController.saveService);
app.delete('/api/settings/services/:source', requireAuth, settingsLimiter, settingsController.requireOwner, settingsController.clearService);

// --- Legacy YouTube-only routes. Kept as thin aliases for one release; the
// generic /api/library and /api/search routes below replace them. Same
// unified SOURCE_* error codes as everything else (Stage 3). ---
app.get('/search', requireAuth, sourceToken('youtube'), searchController.searchTracks);
app.get('/playlists', requireAuth, sourceToken('youtube'), playlistController.getUserPlaylists);
app.get('/playlists/:id/tracks', requireAuth, sourceToken('youtube'), playlistController.getPlaylistTracks);

// --- SoundCloud OAuth 2.1 (PKCE). Same shape as Google: the URL endpoint needs
// our login; the callback is a bare browser redirect identified by `state`. ---
app.get('/auth/soundcloud/url', requireAuth, requireExistingUser, soundcloudController.getAuthUrl);
app.get('/auth/soundcloud/callback', soundcloudController.callback);
app.delete('/api/user/connections/soundcloud', requireAuth, soundcloudController.disconnect);

// --- SoundCloud-backed endpoints. Search works with the app token alone;
// the library needs the user's own token (refreshed server-side). ---
app.get('/api/soundcloud/status', requireAuth, soundcloudController.getStatus);
app.get('/api/soundcloud/search', requireAuth, soundcloudController.searchTracks);
app.get('/api/soundcloud/playlists', requireAuth, sourceToken('soundcloud'), soundcloudController.getPlaylists);
app.get('/api/soundcloud/playlists/:id/tracks', requireAuth, sourceToken('soundcloud'), soundcloudController.getPlaylistTracks);

// --- Generic library API: one shape for every source (see providers/). The
// :source segment picks the provider; sourceToken attaches the user's stored
// token (or fails with SOURCE_NOT_CONNECTED / SOURCE_TOKEN_EXPIRED). Every
// list call returns { items, nextCursor }. ---
app.get('/api/sources', requireAuth, libraryController.getSources);
app.get('/api/library/:source/playlists', requireAuth, sourceToken(), libraryController.getPlaylists);
app.get('/api/library/:source/playlists/:id/tracks', requireAuth, sourceToken(), libraryController.getPlaylistTracks);
app.post('/api/library/:source/liked', requireAuth, sourceToken(), libraryController.likeTrack);
app.delete('/api/library/:source/liked/:id', requireAuth, sourceToken(), libraryController.unlikeTrack);
// Search runs the token lookup in optional mode: some sources (SoundCloud) can
// search public content without the user's own token.
app.get('/api/search/:source', requireAuth, sourceToken(null, { optional: true }), libraryController.search);

// --- Local files (issue #24): the folders a user plays music from. Adding a
// folder starts a background scan; tracks then appear under source=local in
// the Library and Search. ---
app.get('/api/local/folders', requireAuth, localController.listFolders);
app.post('/api/local/folders', requireAuth, requireExistingUser, localController.addFolder);
app.post('/api/local/folders/:id/rescan', requireAuth, localController.rescanFolder);
app.delete('/api/local/folders/:id', requireAuth, localController.removeFolder);

// --- Lyrics (issue #30): from the user's own files, or looked up online when
// the client says the user agreed (services/lyrics.js). ---
app.get('/api/lyrics', requireAuth, lyricsLimiter, lyricsController.getLyrics);

// --- Cloud sync (docs/cloud-data.md): a user links this computer to their
// cloud account; playlists and history are then kept the same on every linked
// computer. Where the cloud service is, is the owner's to set. Signing in is
// limited like any login. ---
app.get('/api/cloud/status', requireAuth, cloudController.getStatus);
app.put('/api/cloud/url', requireAuth, settingsLimiter, settingsController.requireOwner, cloudController.saveUrl);
app.delete('/api/cloud/url', requireAuth, settingsLimiter, settingsController.requireOwner, cloudController.clearUrl);
app.post('/api/cloud/link', requireAuth, authLimiter, requireExistingUser, cloudController.link);
app.delete('/api/cloud/link', requireAuth, cloudController.unlink);
app.post('/api/cloud/sync', requireAuth, cloudSyncLimiter, cloudController.syncNow);
app.get('/api/cloud/google/status', requireAuth, cloudSyncLimiter, cloudController.googleStatus);
// Before anyone is logged in: signing in to the app with the cloud account,
// which also sets this computer up for it (controllers/cloudController.js).
app.get('/api/cloud/info', cloudController.getInfo);
app.post('/api/cloud/login', authLimiter, cloudController.login);

// --- Theme colours from the playing track's cover (issue #26). The server
// reads the image because the browser may not read another site's pixels;
// services/artworkColors.js keeps that fetch away from private addresses. ---
app.get('/api/artwork/colors', requireAuth, artworkLimiter, artworkController.getColors);

// --- Match engine (Stage 2). Tracks of a match-mode source (Spotify) must be
// matched to an official YouTube video before they can play; these routes read,
// request, correct and forget those matches. Our login is required: resolving
// spends YouTube Music / yt-dlp calls, and overrides and reports are
// attributed to the user. The match table itself is global, not per user.
// Override and report write rows that reference users(id), so a valid token
// for a deleted account must fail with 401 here rather than a FK error. ---
app.get('/api/match/:source/:id', requireAuth, matchController.getMatch);
app.post('/api/match/resolve', requireAuth, matchResolveLimiter, matchController.resolveTracks);
app.post('/api/match/override', requireAuth, requireExistingUser, matchController.override);
app.post('/api/match/report', requireAuth, requireExistingUser, matchController.report);
app.delete('/api/match/:source/:id', requireAuth, matchController.forget);

// --- Media (rate-limited + input-validated). The browser <audio> element
// cannot send a Bearer header, so these two routes take a short-lived media
// token in the URL instead (`t`, from GET /api/media/token; see
// services/mediaToken.js). Without it any page in the user's browser could
// start transcodes. `source` selects the provider; `source=spotify` goes
// through the match table first (controllers/matchedStream.js). ---
app.get('/api/media/token', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(issueMediaToken(req.userId));
});
app.get('/stream', mediaLimiter, requireMediaToken, streamingController.handleStream);
app.get('/duration', mediaLimiter, requireMediaToken, streamingController.handleDuration);

// --- History (our own login required) ---
app.post('/history', requireAuth, historyController.logHistory);
app.get('/history', requireAuth, historyController.getHistory);

// --- Custom playlists (our own login required) ---
app.get('/api/custom-playlists', requireAuth, playlistController.getCustomPlaylists);
app.post('/api/custom-playlists', requireAuth, playlistController.createCustomPlaylist);
app.get('/api/custom-playlists/:playlistId/tracks', requireAuth, playlistController.getCustomPlaylistTracks);
app.post('/api/custom-playlists/:playlistId/tracks', requireAuth, playlistController.addTrackToPlaylist);

// --- 404 (JSON, not Express's default HTML) ---
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// --- Central error handler. Controllers call next(err); this is the single
// place that logs the detail and returns a safe, generic message to the client.
// Express only treats a handler as an error handler if it declares 4 args. ---
app.use((err, req, res, next) => {
    if (err && err.message === 'Not allowed by CORS') {
        return res.status(403).json({ error: 'Origin not allowed' });
    }
    console.error('Unhandled error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
