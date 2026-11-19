// SoundCloud endpoints: connect flow (OAuth 2.1 + PKCE), search, library
// (playlists + likes), stream resolution and duration.
//
// Search and streaming use the app-level client_credentials token because
// public content does not need a user session; /me/* endpoints go through
// middleware/sourceToken.js and use the user's own token.
const { sendSourceError } = require('../services/errors');
const { parseReturnTarget, finishOAuth, clientOrigin } = require('../services/oauthReturn');
const cloudSoundcloud = require('../services/cloud/soundcloud');
const { describeConnectFailure } = require('../services/cloud/connectError');
const client = require('./soundcloud/client');
const tokens = require('./soundcloud/tokens');
const ytdlp = require('./soundcloud/ytdlp');
const { parseSeek, serveFromCache, streamTranscoded, qualityCacheKey } = require('./transcode');


const SEARCH_LIMIT = 30;
const LIBRARY_PAGE_LIMIT = 50;
const LIBRARY_MAX_PAGES = 4; // up to 200 items per library call
const LIKED_PLAYLIST_ID = 'liked';

// Lengths are remembered there, across restarts, so repeated plays do not
// fetch metadata (or start yt-dlp) again.
const trackLengths = require('../services/trackLengths');
const playReport = require('../services/playReport');

// --- Provider selection (shared with providers/soundcloud.js) -----------------
// See controllers/soundcloud/fallback.js for how api / ytdlp / auto is chosen.
const { providerMode, activeProvider, apiAvailable, withFallback } = require('./soundcloud/fallback');

function sendYtdlpError(res, err, fallbackMessage) {
    console.error(`SoundCloud (yt-dlp): ${fallbackMessage}:`, err.message);
    playReport.reason(res, err.message);
    if (err.code === 'YTDLP_NO_URL') {
        return sendSourceError(res, 'TRACK_UNAVAILABLE', 'soundcloud', { status: 404, reason: 'blocked' });
    }
    return sendSourceError(res, 'TRACK_UNAVAILABLE', 'soundcloud', { reason: 'resolve_failed' });
}

// Tells the client which SoundCloud features exist on this server.
const getStatus = (req, res) => {
    res.json({
        provider: activeProvider(),
        mode: providerMode(),
        // With credentials on this computer, or through the cloud service.
        apiConfigured: apiAvailable(),
        viaCloud: cloudSoundcloud.available(),
        // Connecting an account (and thus the library) needs the official API.
        connectAvailable: apiAvailable(),
        searchAvailable: true,
        libraryAvailable: apiAvailable()
    });
};

// --- Pending PKCE flows -------------------------------------------------------
// The code_verifier must never travel through the browser (that is the whole
// point of PKCE), so it stays here keyed by the random `state` we send to
// SoundCloud. Entries are single-use and expire after ten minutes.
const PENDING_TTL_MS = 10 * 60 * 1000;
const pendingFlows = new Map(); // state -> { userId, verifier, expiresAt }

function prunePendingFlows() {
    const now = Date.now();
    for (const [state, flow] of pendingFlows) {
        if (flow.expiresAt <= now) pendingFlows.delete(state);
    }
}

// --- Error mapping ------------------------------------------------------------

function sendSoundCloudError(res, err, fallbackMessage) {
    if (err instanceof client.SoundCloudError) {
        if (err.code === 'SOUNDCLOUD_NOT_CONFIGURED') {
            return res.status(503).json({ error: 'SoundCloud is not configured on this server.', code: err.code });
        }
        if (err.status === 429) {
            return res.status(429).json({
                error: 'SoundCloud rate limit reached. Try again later.',
                code: 'SOUNDCLOUD_RATE_LIMITED',
                resetTime: err.resetTime || null
            });
        }
        if (err.status === 401) {
            return sendSourceError(res, 'SOURCE_TOKEN_EXPIRED', 'soundcloud', { reason: 'token_rejected' });
        }
        if (err.status === 403 || err.status === 404) {
            return res.status(404).json({ error: 'Track or playlist not available on SoundCloud.', code: 'SOUNDCLOUD_NOT_FOUND' });
        }
        if (err.status === 400 && err.code === 'BAD_CURSOR') {
            return res.status(400).json({ error: 'Invalid cursor' });
        }
    }
    console.error(`SoundCloud: ${fallbackMessage}:`, err.message);
    return res.status(502).json({ error: fallbackMessage });
}

// --- Connect flow -------------------------------------------------------------

// Returns the SoundCloud consent URL for the logged-in user (requireAuth runs first).
//
// Through the cloud service when it holds SoundCloud's credentials: the login
// is then kept with the cloud account and works on every computer signed in
// to it. Otherwise with this computer's own credentials, when it has some.
const getAuthUrl = async (req, res, next) => {
    // The cloud sends the browser back to the desktop app's link, to the web
    // client on this computer, or to a site in its WEB_ORIGINS.
    const returnTo = parseReturnTarget(req.query.return) === 'app' ? 'app' : clientOrigin();
    try {
        const viaCloud = await cloudSoundcloud.startConnect(req.app.locals.db, req.userId, { returnTo });
        if (viaCloud) return res.json({ url: viaCloud, via: 'cloud' });
    } catch (err) {
        console.warn(`SoundCloud connect: the cloud account could not start it: ${err.message}`);
        if (!client.isConfigured()) {
            // Say what the cloud said: most refusals are a setting, not a wait.
            const { status, body } = describeConnectFailure(err, { label: 'SoundCloud', source: 'soundcloud', returnTo });
            return res.status(status).json(body);
        }
    }
    try {
        return localAuthUrl(req, res);
    } catch (err) {
        return next(err);
    }
};

const localAuthUrl = (req, res) => {
    if (!client.isConfigured()) {
        return res.status(503).json({ error: 'SoundCloud is not configured on this server.', code: 'SOUNDCLOUD_NOT_CONFIGURED' });
    }
    prunePendingFlows();

    const { verifier, challenge } = client.generatePkce();
    const state = client.generateState();
    pendingFlows.set(state, {
        userId: req.userId,
        verifier,
        ret: parseReturnTarget(req.query.return), // web client or the desktop app's deep link
        expiresAt: Date.now() + PENDING_TTL_MS
    });

    res.json({ url: client.buildAuthorizeUrl({ state, codeChallenge: challenge }) });
};

// SoundCloud redirects the bare browser here (no Authorization header), so the
// user is identified through the `state` we issued in getAuthUrl.
const callback = async (req, res) => {
    const { code, state, error } = req.query;
    // The return target was fixed when the flow started; read it before the
    // state is consumed below. Unknown state: back to the web client.
    const ret = (typeof state === 'string' && pendingFlows.get(state)?.ret) || 'web';

    if (error) {
        // Attacker-controlled query value: strip everything but a short token
        // so it cannot forge extra log lines.
        console.error('SoundCloud authorization denied:', String(error).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64));
        return finishOAuth(res, ret, `soundcloud=error`);
    }
    if (!code) return res.status(400).send('No authorization code received');
    if (!state) return res.status(400).send('Missing state. Start the connect flow from the app.');

    const flow = pendingFlows.get(state);
    pendingFlows.delete(state); // single-use, whether or not it validates
    if (!flow || flow.expiresAt <= Date.now()) {
        return res.status(400).send('Invalid or expired state. Start the connect flow again from the app.');
    }

    // Exchange and storage are separate failure modes; log which one failed.
    let result;
    try {
        result = await client.exchangeCode({ code, codeVerifier: flow.verifier });
    } catch (err) {
        console.error('SoundCloud token exchange failed:', err.message);
        return finishOAuth(res, ret, `soundcloud=error&reason=token_exchange`);
    }

    const db = req.app.locals.db;
    try {
        // The session JWT only proves a signature; its user may have been deleted
        // since. user_connections.user_id has a FOREIGN KEY to users(id), so check
        // first and give a clear reason instead of a constraint error.
        const user = await db.get(`SELECT id FROM users WHERE id = ?`, [flow.userId]);
        if (!user) {
            console.error(`SoundCloud connect: user ${flow.userId} from the state no longer exists; the client is holding a stale session. Log out and in again.`);
            return finishOAuth(res, ret, `soundcloud=error&reason=user_not_found`);
        }

        await tokens.storeUserTokens(db, flow.userId, result);

        // Tokens stay server-side; the client only learns the expiry (via the URL
        // fragment, which never reaches a server or its logs).
        finishOAuth(res, ret, `soundcloud=connected&expires_at=${result.expiresAt}`);
    } catch (err) {
        console.error('Failed to store SoundCloud tokens:', err.message);
        finishOAuth(res, ret, `soundcloud=error&reason=store_failed`);
    }
};

// Removes the stored connection for the logged-in user.
const disconnect = async (req, res, next) => {
    try {
        await tokens.disconnectUser(req.app.locals.db, req.userId);
        res.status(204).end();
    } catch (err) {
        if (err instanceof client.SoundCloudError && err.code === 'SOUNDCLOUD_UNAVAILABLE') {
            return res.status(502).json({
                error: 'Your cloud account could not be reached, so SoundCloud is still connected there. Try again in a moment.',
                code: 'SOURCE_UPSTREAM',
                source: 'soundcloud'
            });
        }
        next(err);
    }
};

// --- Search -------------------------------------------------------------------

// Uses the user's token when they have connected (so `user_favorite` and
// private content are correct) and falls back to the app token otherwise.
async function tokenForPublicRead(db, userId) {
    if (userId) {
        try {
            return await tokens.getUserToken(db, userId);
        } catch (err) {
            if (!(err instanceof client.SoundCloudError) || err.status !== 401) throw err;
        }
    }
    return tokens.getAppToken(db);
}

const searchTracks = async (req, res) => {
    const query = req.query.q;
    const cursor = req.query.cursor;

    if (typeof query !== 'string' || query.trim().length === 0 || query.length > 200) {
        return res.status(400).json({ error: 'A search query (q) of 1-200 characters is required' });
    }
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2000)) {
        return res.status(400).json({ error: 'Invalid cursor' });
    }

    const viaApi = async () => {
        const token = await tokenForPublicRead(req.app.locals.db, req.userId);
        const { items, nextHref } = await client.fetchCollection(cursor || '/tracks', {
            token,
            query: cursor ? {} : { q: query.trim(), access: 'playable,preview', limit: SEARCH_LIMIT },
            maxPages: 1
        });
        return { items: items.map(client.normalizeTrack).filter(t => t.id), nextCursor: nextHref, provider: 'api' };
    };

    // yt-dlp has no cursor: a "next page" request gets an empty page.
    const viaYtdlp = async () => {
        if (cursor) return { items: [], nextCursor: null, provider: 'ytdlp' };
        const items = await ytdlp.search(query.trim(), SEARCH_LIMIT);
        return { items, nextCursor: null, provider: 'ytdlp' };
    };

    let usedYtdlp = false;
    try {
        const result = await withFallback('search', viaApi, () => { usedYtdlp = true; return viaYtdlp(); });
        res.json(result);
    } catch (err) {
        if (usedYtdlp) return sendYtdlpError(res, err, 'Search provider request failed');
        sendSoundCloudError(res, err, 'Search provider request failed');
    }
};

// --- Library (requires sourceToken('soundcloud') -> req.sourceToken) ------

const getPlaylists = async (req, res) => {
    try {
        const { items } = await client.fetchCollection('/me/playlists', {
            token: req.sourceToken,
            query: { show_tracks: false, limit: LIBRARY_PAGE_LIMIT },
            maxPages: LIBRARY_MAX_PAGES
        });

        const liked = {
            id: LIKED_PLAYLIST_ID,
            source: client.SOURCE_NAME,
            kind: 'liked',
            title: 'Liked Tracks',
            name: 'Liked Tracks',
            thumbnail: null,
            itemCount: null,
            readOnly: true
        };

        res.json([liked, ...items.map(client.normalizePlaylist).filter(p => p.id)]);
    } catch (err) {
        sendSoundCloudError(res, err, 'Failed to fetch SoundCloud playlists');
    }
};

const getPlaylistTracks = async (req, res) => {
    const { id } = req.params;
    if (id !== LIKED_PLAYLIST_ID && !client.isValidId(id)) {
        return res.status(400).json({ error: 'Invalid playlist id' });
    }

    const path = id === LIKED_PLAYLIST_ID
        ? '/me/likes/tracks'
        : `/playlists/${client.toPlaylistUrn(id)}/tracks`;

    try {
        const { items } = await client.fetchCollection(path, {
            token: req.sourceToken,
            query: { access: 'playable,preview,blocked', limit: LIBRARY_PAGE_LIMIT },
            maxPages: LIBRARY_MAX_PAGES
        });
        res.json(items.map(client.normalizeTrack).filter(t => t.id));
    } catch (err) {
        sendSoundCloudError(res, err, 'Failed to fetch SoundCloud tracks');
    }
};

// --- Playback (public route, no Bearer: the <audio> element cannot send one) ---

const streamTrack = async (req, res) => {
    const id = req.query.videoId;
    if (!id || id === 'undefined') return res.status(400).json({ error: 'Missing videoId' });
    if (!client.isValidId(id)) return res.status(400).json({ error: 'Invalid videoId' });

    const { seekTime, error: seekError } = parseSeek(req.query.seek);
    if (seekError) return res.status(400).json({ error: seekError });

    // Both providers use the same numeric id, so one cache entry serves both.
    const cacheKey = qualityCacheKey(req, `soundcloud_${id}`);
    if (serveFromCache(res, cacheKey, { req, seekTime })) return;

    const viaApi = async () => {
        const token = await tokens.getAppToken(req.app.locals.db);
        // Each call here counts toward the 15,000 plays / 24 h limit; the disk
        // cache above is what keeps repeat plays from spending it.
        const streams = await client.apiRequest(`/tracks/${client.toTrackUrn(id)}/streams`, { token });
        return client.pickStreamUrl(streams);
    };
    const viaYtdlp = () => ytdlp.resolveStream(id);

    // Resolving can take seconds (API round-trip or a yt-dlp spawn). If the
    // client leaves meanwhile, do not start ffmpeg for a dead request.
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) clientGone = true; });

    let usedYtdlp = false;
    let picked;
    const resolveStartedAt = Date.now();
    try {
        picked = await withFallback('stream', viaApi, () => { usedYtdlp = true; return viaYtdlp(); });
    } catch (err) {
        if (usedYtdlp) return sendYtdlpError(res, err, 'Could not resolve audio source');
        return sendSoundCloudError(res, err, 'Could not resolve audio source');
    }

    if (!picked) {
        return sendSourceError(res, 'TRACK_UNAVAILABLE', 'soundcloud', { status: 404, reason: 'blocked' });
    }

    if (clientGone) return;

    const timing = { label: `soundcloud ${id}`, resolveMs: Date.now() - resolveStartedAt, resolvedBy: usedYtdlp ? (picked.from || 'yt-dlp') : 'api' };

    // A rendition found by yt-dlp that is not MP3 (AAC, Opus): yt-dlp
    // downloads it and ffmpeg converts what it is handed. Given the address,
    // ffmpeg decodes those as noise (ytdlp.js, handsOverAddress).
    if (usedYtdlp && !ytdlp.handsOverAddress(picked.format)) {
        playReport.note(res, `yt-dlp chose ${picked.format}; downloaded by yt-dlp`);
        return streamTranscoded(req, res, {
            feed: ytdlp.downloadFeed(id, picked.format, { res, timing }),
            cacheKey,
            seekTime,
            allowCache: !picked.isPreview,
            timing
        });
    }

    // Preview snippets are short and cheap; do not let them occupy the cache
    // under the full track's key.
    streamTranscoded(req, res, {
        sourceUrl: picked.url,
        cacheKey,
        seekTime,
        allowCache: !picked.isPreview,
        // SoundCloud's MP3 renditions ("http_mp3_...", "hls_mp3_128") are
        // passed through as they are; only its AAC ones need converting.
        sourceCodec: /(^|_)mp3(_|$)/.test(picked.format || '') ? 'mp3' : undefined,
        timing,
        // A remembered address that no longer works must not be handed out again.
        onSourceFailed: () => ytdlp.forget(id)
    });
};

const getDuration = async (req, res) => {
    const id = req.query.videoId;
    if (!id) return res.status(400).json({ error: 'Missing videoId' });
    if (!client.isValidId(id)) return res.status(400).json({ error: 'Invalid videoId' });

    const remembered = await trackLengths.known('soundcloud', id);
    if (remembered) return res.json({ duration: remembered });

    const viaApi = async () => {
        const token = await tokens.getAppToken(req.app.locals.db);
        const track = await client.apiRequest(`/tracks/${client.toTrackUrn(id)}`, { token });
        return Math.round((Number(track && track.duration) || 0) / 1000);
    };
    const viaYtdlp = () => ytdlp.getDuration(id);

    try {
        const duration = await withFallback('duration', viaApi, viaYtdlp);
        trackLengths.remember('soundcloud', id, duration);
        res.json({ duration });
    } catch (err) {
        if (err instanceof client.SoundCloudError && err.status === 429) {
            return sendSoundCloudError(res, err, 'Could not fetch duration');
        }
        console.error('SoundCloud duration lookup failed:', err.message);
        res.status(502).json({ duration: 0 });
    }
};

module.exports = {
    getStatus,
    activeProvider,
    getAuthUrl,
    callback,
    disconnect,
    searchTracks,
    getPlaylists,
    getPlaylistTracks,
    streamTrack,
    getDuration,
    _pendingFlows: pendingFlows
};
