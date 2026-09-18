// SoundCloud endpoints: connect flow (OAuth 2.1 + PKCE), search, library
// (playlists + likes), stream resolution and duration.
//
// Search and streaming use the app-level client_credentials token because
// public content does not need a user session; /me/* endpoints go through
// middleware/soundcloudToken.js and use the user's own token.
const client = require('./soundcloud/client');
const tokens = require('./soundcloud/tokens');
const ytdlp = require('./soundcloud/ytdlp');
const { parseSeek, serveFromCache, streamTranscoded } = require('./transcode');

const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim();

const SEARCH_LIMIT = 30;
const LIBRARY_PAGE_LIMIT = 50;
const LIBRARY_MAX_PAGES = 4; // up to 200 items per library call
const LIKED_PLAYLIST_ID = 'liked';

// Small in-memory cache for /duration so repeated plays do not re-fetch metadata.
const durationCache = new Map();
const DURATION_CACHE_MAX = 500;

// --- Provider selection -------------------------------------------------------
// Two ways to reach public SoundCloud content:
//   api    the official API (needs SOUNDCLOUD_CLIENT_ID / SECRET, Artist Pro)
//   ytdlp  yt-dlp, no credentials (see ./soundcloud/ytdlp.js for the caveats)
// SOUNDCLOUD_PROVIDER=auto (default) uses the API when configured and falls
// back to yt-dlp when it is not, or when an API call fails in a way yt-dlp
// might survive (rate limit, outage, network). `api` and `ytdlp` force one.
// The library (/me/*) is API-only either way: yt-dlp has no user session.
function providerMode() {
    const mode = String(process.env.SOUNDCLOUD_PROVIDER || 'auto').toLowerCase();
    return ['api', 'ytdlp', 'auto'].includes(mode) ? mode : 'auto';
}

function activeProvider() {
    const mode = providerMode();
    if (mode === 'ytdlp') return 'ytdlp';
    if (mode === 'api') return 'api';
    return client.isConfigured() ? 'api' : 'ytdlp';
}

// Errors where trying yt-dlp instead is worthwhile. Auth failures on the user's
// own account are not: they need the user to reconnect, not another backend.
function shouldFallBack(err) {
    if (providerMode() !== 'auto') return false;
    if (!(err instanceof client.SoundCloudError)) return true; // network / unexpected
    return err.code === 'SOUNDCLOUD_NOT_CONFIGURED' || err.status === 429 || err.status >= 500;
}

// Runs `viaApi`, and on a recoverable failure runs `viaYtdlp` instead.
async function withFallback(label, viaApi, viaYtdlp) {
    const provider = activeProvider();
    if (provider === 'ytdlp') return viaYtdlp();
    try {
        return await viaApi();
    } catch (err) {
        if (!shouldFallBack(err)) throw err;
        console.warn(`SoundCloud ${label}: official API failed (${err.message}); falling back to yt-dlp.`);
        return viaYtdlp();
    }
}

function sendYtdlpError(res, err, fallbackMessage) {
    console.error(`SoundCloud (yt-dlp): ${fallbackMessage}:`, err.message);
    if (err.code === 'YTDLP_NO_URL') {
        return res.status(404).json({ error: 'This track is not streamable.', code: 'SOUNDCLOUD_BLOCKED' });
    }
    return res.status(502).json({ error: fallbackMessage, code: 'SOUNDCLOUD_YTDLP_FAILED' });
}

// Tells the client which SoundCloud features exist on this server.
const getStatus = (req, res) => {
    res.json({
        provider: activeProvider(),
        mode: providerMode(),
        apiConfigured: client.isConfigured(),
        // Connecting an account (and thus the library) needs the official API.
        connectAvailable: client.isConfigured(),
        searchAvailable: true,
        libraryAvailable: client.isConfigured()
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
            return res.status(401).json({ error: 'SoundCloud rejected the access token.', code: 'SOUNDCLOUD_TOKEN_INVALID' });
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
const getAuthUrl = (req, res) => {
    if (!client.isConfigured()) {
        return res.status(503).json({ error: 'SoundCloud is not configured on this server.', code: 'SOUNDCLOUD_NOT_CONFIGURED' });
    }
    prunePendingFlows();

    const { verifier, challenge } = client.generatePkce();
    const state = client.generateState();
    pendingFlows.set(state, { userId: req.userId, verifier, expiresAt: Date.now() + PENDING_TTL_MS });

    res.json({ url: client.buildAuthorizeUrl({ state, codeChallenge: challenge }) });
};

// SoundCloud redirects the bare browser here (no Authorization header), so the
// user is identified through the `state` we issued in getAuthUrl.
const callback = async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        console.error('SoundCloud authorization denied:', error);
        return res.redirect(`${CLIENT_ORIGIN}/#soundcloud=error`);
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
        return res.redirect(`${CLIENT_ORIGIN}/#soundcloud=error&reason=token_exchange`);
    }

    const db = req.app.locals.db;
    try {
        // The session JWT only proves a signature; its user may have been deleted
        // since. user_connections.user_id has a FOREIGN KEY to users(id), so check
        // first and give a clear reason instead of a constraint error.
        const user = await db.get(`SELECT id FROM users WHERE id = ?`, [flow.userId]);
        if (!user) {
            console.error(`SoundCloud connect: user ${flow.userId} from the state no longer exists; the client is holding a stale session. Log out and in again.`);
            return res.redirect(`${CLIENT_ORIGIN}/#soundcloud=error&reason=user_not_found`);
        }

        await tokens.storeUserTokens(db, flow.userId, result);

        // Tokens stay server-side; the client only learns the expiry (via the URL
        // fragment, which never reaches a server or its logs).
        res.redirect(`${CLIENT_ORIGIN}/#soundcloud=connected&expires_at=${result.expiresAt}`);
    } catch (err) {
        console.error('Failed to store SoundCloud tokens:', err.message);
        res.redirect(`${CLIENT_ORIGIN}/#soundcloud=error&reason=store_failed`);
    }
};

// Removes the stored connection for the logged-in user.
const disconnect = async (req, res, next) => {
    try {
        await tokens.disconnectUser(req.app.locals.db, req.userId);
        res.status(204).end();
    } catch (err) {
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

// --- Library (requires soundcloudToken middleware -> req.soundcloudToken) ------

const getPlaylists = async (req, res) => {
    try {
        const { items } = await client.fetchCollection('/me/playlists', {
            token: req.soundcloudToken,
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
            token: req.soundcloudToken,
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
    const cacheKey = `soundcloud_${id}`;
    if (serveFromCache(res, cacheKey)) return;

    const viaApi = async () => {
        const token = await tokens.getAppToken(req.app.locals.db);
        // Each call here counts toward the 15,000 plays / 24 h limit; the disk
        // cache above is what keeps repeat plays from spending it.
        const streams = await client.apiRequest(`/tracks/${client.toTrackUrn(id)}/streams`, { token });
        return client.pickStreamUrl(streams);
    };
    const viaYtdlp = () => ytdlp.resolveStream(id);

    let usedYtdlp = false;
    let picked;
    try {
        picked = await withFallback('stream', viaApi, () => { usedYtdlp = true; return viaYtdlp(); });
    } catch (err) {
        if (usedYtdlp) return sendYtdlpError(res, err, 'Could not resolve audio source');
        return sendSoundCloudError(res, err, 'Could not resolve audio source');
    }

    if (!picked) {
        return res.status(404).json({ error: 'This track is not streamable.', code: 'SOUNDCLOUD_BLOCKED' });
    }

    // Preview snippets are short and cheap; do not let them occupy the cache
    // under the full track's key.
    streamTranscoded(req, res, { sourceUrl: picked.url, cacheKey, seekTime, allowCache: !picked.isPreview });
};

const getDuration = async (req, res) => {
    const id = req.query.videoId;
    if (!id) return res.status(400).json({ error: 'Missing videoId' });
    if (!client.isValidId(id)) return res.status(400).json({ error: 'Invalid videoId' });

    if (durationCache.has(id)) return res.json({ duration: durationCache.get(id) });

    const viaApi = async () => {
        const token = await tokens.getAppToken(req.app.locals.db);
        const track = await client.apiRequest(`/tracks/${client.toTrackUrn(id)}`, { token });
        return Math.round((Number(track && track.duration) || 0) / 1000);
    };
    const viaYtdlp = () => ytdlp.getDuration(id);

    try {
        const duration = await withFallback('duration', viaApi, viaYtdlp);
        if (durationCache.size >= DURATION_CACHE_MAX) {
            durationCache.delete(durationCache.keys().next().value);
        }
        durationCache.set(id, duration);
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
