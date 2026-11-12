// The one library API for every source. Routes by `:source` through the
// provider registry and never knows service details.
//
//   GET    /api/sources
//   GET    /api/library/:source/playlists?cursor=
//   GET    /api/library/:source/playlists/:id/tracks?cursor=   (id 'liked' -> liked songs)
//   POST   /api/library/:source/liked        { trackId }
//   DELETE /api/library/:source/liked/:id
//   GET    /api/search/:source?q=&cursor=
//
// Every list call returns { items, nextCursor }. Errors carry a `code` of the
// form SOURCE_<CODE> plus `source`, so the client can show one panel for all.
// Track lists additionally carry `matching` (a summary) when they held tracks
// of a match-mode source; see withMatching below.
const { canRefresh } = require('../services/connections');
const cloudGoogle = require('../services/cloud/google');
const { listProviders } = require('../providers');
const { SourceError } = require('../providers/errors');
const { likedPlaylist, LIKED_PLAYLIST_ID } = require('../providers/normalize');
const matcher = require('../services/matcher');

const MAX_CURSOR_LENGTH = 2000;

function ctx(req) {
    return { db: req.app.locals.db, userId: req.userId, token: req.sourceToken };
}

// Match-mode sources (Spotify) play through a YouTube video the match engine
// picks, and the product rule is that a track without a confirmed match is not
// shown at all. Custom playlists mix tracks from many sources, so every track
// list goes through this regardless of `:source`; the engine is only called
// when at least one item belongs to a match-mode source, so YouTube and
// SoundCloud pages cost nothing extra (no DB access, no queue). The page may
// come back shorter; `nextCursor` is left alone and the client keeps loading
// while one exists.
async function withMatching(db, result) {
    const items = Array.isArray(result.items) ? result.items : [];
    if (!items.some(t => t && matcher.isMatchSource(t.source))) return result;
    const { items: playable, summary } = await matcher.filterPlayable(db, items);
    return { ...result, items: playable, matching: summary };
}

// A cursor is opaque but must still be a bounded string.
function readCursor(req, res) {
    const cursor = req.query.cursor;
    if (cursor === undefined || cursor === '') return { cursor: undefined };
    if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH) {
        res.status(400).json({ error: 'Invalid cursor', code: 'SOURCE_BAD_CURSOR', source: req.source });
        return { error: true };
    }
    return { cursor };
}

function sendSourceError(res, err, source, fallbackMessage) {
    if (err instanceof SourceError) {
        const body = { error: err.message, code: `SOURCE_${err.code}`, source: err.source || source, ...err.extra };
        if (err.code === 'UPSTREAM') console.error(`${source}: ${fallbackMessage}: ${err.cause ? err.cause.message : err.message}`);
        return res.status(err.status).json(body);
    }
    console.error(`${source}: ${fallbackMessage}: ${err && err.message}`);
    return res.status(502).json({ error: fallbackMessage, code: 'SOURCE_UPSTREAM', source });
}

function notSupported(res, source, what) {
    return res.status(404).json({ error: `${what} is not supported for this source.`, code: 'SOURCE_NOT_SUPPORTED', source });
}

// --- GET /api/sources -----------------------------------------------------------
// Everything the client needs to draw the connect banner, the Library dropdown
// and the Search switch in one call.
const getSources = async (req, res, next) => {
    try {
        const rows = await req.app.locals.db.all(
            `SELECT s.name AS source_name, uc.expires_at, uc.refresh_token IS NOT NULL AS refreshable
             FROM user_connections uc
             JOIN sources s ON uc.source_id = s.id
             WHERE uc.user_id = ?`,
            [req.userId]
        );
        const byName = new Map((rows || []).map(r => [r.source_name, r]));
        const now = Date.now();
        // YouTube connected through the cloud account: this computer holds at
        // most a short-lived token, and asks the cloud for the next one.
        const youtubeViaCloud = await cloudGoogle.connected(req.app.locals.db, req.userId);

        const sources = listProviders().map(p => {
            const row = byName.get(p.name);
            let connected;
            if (!p.connect.required) {
                connected = true;
            } else if (p.name === 'youtube' && youtubeViaCloud) {
                connected = true;
            } else if (!row) {
                connected = false;
            } else {
                // The server renews tokens itself (services/connections.js), so a
                // stored refresh token keeps the connection alive past expires_at.
                // This used to name SoundCloud only; since Stage 3 YouTube renews
                // too, and showed as disconnected an hour after connecting.
                const renews = canRefresh(p.name, row.refreshable);
                connected = renews || !row.expires_at || row.expires_at > now;
            }
            return {
                name: p.name,
                label: p.label,
                capabilities: { ...p.capabilities },
                connect: {
                    required: Boolean(p.connect.required),
                    kind: p.connect.kind,
                    available: typeof p.isAvailable === 'function' ? Boolean(p.isAvailable()) : true
                },
                connected,
                // Whether searching this source needs the user's own connection.
                // SoundCloud searches public tracks without one, so the Search
                // tab must stay usable even when it cannot be connected here.
                searchRequiresConnection: Boolean(p.connect.required && p.searchRequiresToken),
                // No expiry to act on when the cloud account renews it.
                expiresAt: row && row.expires_at && !(p.name === 'youtube' && youtubeViaCloud) ? row.expires_at : null
            };
        });
        res.json({ sources });
    } catch (err) {
        next(err);
    }
};

// --- Library ----------------------------------------------------------------------

const getPlaylists = async (req, res) => {
    const { provider, source } = req;
    if (!provider.capabilities.playlists) return notSupported(res, source, 'Playlists');
    const { cursor, error } = readCursor(req, res);
    if (error) return;

    try {
        const result = await provider.getPlaylists(ctx(req), { cursor });
        // The virtual liked playlist is pinned first, on the first page only.
        const items = (provider.capabilities.liked && !cursor)
            ? [likedPlaylist(source), ...result.items]
            : result.items;
        res.json({ items, nextCursor: result.nextCursor || null });
    } catch (err) {
        sendSourceError(res, err, source, 'Failed to fetch playlists');
    }
};

const getPlaylistTracks = async (req, res, next) => {
    const { provider, source } = req;
    const { id } = req.params;
    const { cursor, error } = readCursor(req, res);
    if (error) return;

    let result;
    try {
        if (id === LIKED_PLAYLIST_ID) {
            if (!provider.capabilities.liked) return notSupported(res, source, 'Liked songs');
            result = await provider.getLikedTracks(ctx(req), { cursor });
        } else {
            if (!provider.capabilities.playlists) return notSupported(res, source, 'Playlists');
            result = await provider.getPlaylistTracks(ctx(req), id, { cursor });
        }
    } catch (err) {
        return sendSourceError(res, err, source, 'Failed to fetch tracks');
    }

    // Outside the provider try/catch: a failure here is ours (the match table),
    // not the service's, so it must not be reported as SOURCE_UPSTREAM.
    try {
        const page = await withMatching(req.app.locals.db, result);
        res.json({
            items: page.items,
            nextCursor: result.nextCursor || null,
            ...(page.matching ? { matching: page.matching } : {})
        });
    } catch (err) {
        next(err);
    }
};

const likeTrack = async (req, res) => {
    const { provider, source } = req;
    if (!provider.capabilities.like) return notSupported(res, source, 'Liking');
    const { trackId } = req.body || {};
    if (typeof trackId !== 'string' || trackId.length === 0 || trackId.length > 128) {
        return res.status(400).json({ error: 'trackId is required', code: 'SOURCE_BAD_REQUEST', source });
    }
    try {
        await provider.likeTrack(ctx(req), trackId);
        res.status(204).end();
    } catch (err) {
        sendSourceError(res, err, source, 'Could not like track');
    }
};

const unlikeTrack = async (req, res) => {
    const { provider, source } = req;
    if (!provider.capabilities.like) return notSupported(res, source, 'Liking');
    try {
        await provider.unlikeTrack(ctx(req), req.params.id);
        res.status(204).end();
    } catch (err) {
        sendSourceError(res, err, source, 'Could not unlike track');
    }
};

// --- Search -------------------------------------------------------------------------

const search = async (req, res, next) => {
    const { provider, source } = req;
    if (!provider.capabilities.search) return notSupported(res, source, 'Search');

    const query = req.query.q;
    if (typeof query !== 'string' || query.trim().length === 0 || query.length > 200) {
        return res.status(400).json({ error: 'A search query (q) of 1-200 characters is required', code: 'SOURCE_BAD_REQUEST', source });
    }
    const { cursor, error } = readCursor(req, res);
    if (error) return;

    // sourceToken ran in optional mode; sources whose search needs the user's
    // own token surface the stashed connection error here.
    if (provider.searchRequiresToken && !req.sourceToken) {
        const err = req.sourceTokenError || new SourceError('NOT_CONNECTED', `No ${provider.label} account connected. Connect your account to continue.`, { source });
        return sendSourceError(res, err, source, 'Search unavailable');
    }

    let result;
    try {
        result = await provider.search(ctx(req), query.trim(), { cursor });
    } catch (err) {
        return sendSourceError(res, err, source, 'Search provider request failed');
    }

    // See getPlaylistTracks: match-table failures are ours, not the service's.
    try {
        const page = await withMatching(req.app.locals.db, result);
        res.json({ ...page, items: page.items, nextCursor: result.nextCursor || null });
    } catch (err) {
        next(err);
    }
};

module.exports = { getSources, getPlaylists, getPlaylistTracks, likeTrack, unlikeTrack, search };
