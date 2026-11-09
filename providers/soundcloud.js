// SoundCloud provider over the existing SoundCloud modules: official API for
// the user's library (playlists, likes, like/unlike), and the api/yt-dlp
// fallback for public search. Everything leaves here in the normalised
// Playlist / Track shapes.
//
// Pagination is SoundCloud's next_href, passed through as the opaque cursor.
const client = require('../controllers/soundcloud/client');
const tokens = require('../controllers/soundcloud/tokens');
const ytdlp = require('../controllers/soundcloud/ytdlp');
const { withFallback, activeProvider } = require('../controllers/soundcloud/fallback');
const { SourceError, fromConnectionError } = require('./errors');
const { getSourceToken } = require('../services/connections');
const { makePlaylist, makeTrack, page } = require('./normalize');

const SOURCE = client.SOURCE_NAME; // 'soundcloud'
const LABEL = 'SoundCloud';
const SOURCE_ID = tokens.SOURCE_SOUNDCLOUD; // 3
const PAGE_SIZE = 50;
const SEARCH_SIZE = 30;

// --- Token ------------------------------------------------------------------

// Decrypted and refreshed (single-flight, single-use refresh tokens) by
// services/connections.js -> controllers/soundcloud/tokens.js.
async function getToken(db, userId) {
    try {
        return await getSourceToken(db, userId, SOURCE);
    } catch (err) {
        throw fromConnectionError(err, SOURCE, LABEL);
    }
}

// --- Error mapping ------------------------------------------------------------

function mapError(err) {
    if (err instanceof SourceError) return err;
    if (err instanceof client.SoundCloudError) {
        if (err.code === 'SOUNDCLOUD_NOT_CONFIGURED') return new SourceError('NOT_CONFIGURED', `${LABEL} is not configured on this server.`, { source: SOURCE, cause: err });
        if (err.code === 'BAD_CURSOR') return new SourceError('BAD_CURSOR', 'Invalid cursor.', { source: SOURCE, cause: err });
        if (err.status === 429) return new SourceError('RATE_LIMITED', `${LABEL} rate limit reached. Try again later.`, { source: SOURCE, extra: { resetTime: err.resetTime || null }, cause: err });
        if (err.status === 401) return new SourceError('TOKEN_EXPIRED', `${LABEL} rejected the access token.`, { source: SOURCE, cause: err });
        if (err.status === 403 || err.status === 404) return new SourceError('NOT_FOUND', `Not available on ${LABEL}.`, { source: SOURCE, cause: err });
    }
    if (err && err.code === 'YTDLP_NO_URL') return new SourceError('NOT_FOUND', 'This track is not streamable.', { source: SOURCE, cause: err });
    return new SourceError('UPSTREAM', `${LABEL} request failed.`, { source: SOURCE, cause: err });
}

// --- Normalisation --------------------------------------------------------------

// client.normalizeTrack already produces most fields; this maps its names
// (duration in seconds, channelTitle) onto the shared Track shape and keeps the
// SoundCloud-specific extras the UI shows (playable, permalinkUrl).
function toTrack(t) {
    return makeTrack({
        source: SOURCE,
        id: t.id,
        title: t.title,
        artist: t.artist || t.channelTitle,
        thumbnail: t.thumbnail,
        durationSec: t.duration,
        preview: t.preview,
        playable: t.playable !== false,
        permalinkUrl: t.permalinkUrl || null,
        uploaderUrl: t.uploaderUrl || null
    });
}

function toPlaylist(p) {
    return makePlaylist({
        source: SOURCE,
        id: p.id,
        kind: 'playlist',
        name: p.name || p.title,
        thumbnail: p.thumbnail,
        itemCount: p.itemCount,
        readOnly: true,
        permalinkUrl: p.permalinkUrl || null
    });
}

// --- Library ---------------------------------------------------------------------

async function listTracks(token, path, cursor) {
    const { items, nextHref } = await client.fetchCollection(cursor || path, {
        token,
        query: cursor ? {} : { access: 'playable,preview,blocked', limit: PAGE_SIZE },
        maxPages: 1
    });
    return page(items.map(client.normalizeTrack).filter(t => t.id).map(toTrack), nextHref);
}

async function getPlaylists({ token }, { cursor } = {}) {
    try {
        const { items, nextHref } = await client.fetchCollection(cursor || '/me/playlists', {
            token,
            query: cursor ? {} : { show_tracks: false, limit: PAGE_SIZE },
            maxPages: 1
        });
        return page(items.map(client.normalizePlaylist).filter(p => p.id).map(toPlaylist), nextHref);
    } catch (err) {
        throw mapError(err);
    }
}

async function getPlaylistTracks({ token }, playlistId, { cursor } = {}) {
    if (!client.isValidId(String(playlistId))) throw new SourceError('NOT_FOUND', 'Invalid playlist id.', { source: SOURCE });
    try {
        return await listTracks(token, `/playlists/${client.toPlaylistUrn(playlistId)}/tracks`, cursor);
    } catch (err) {
        throw mapError(err);
    }
}

async function getLikedTracks({ token }, { cursor } = {}) {
    try {
        return await listTracks(token, '/me/likes/tracks', cursor);
    } catch (err) {
        throw mapError(err);
    }
}

async function likeTrack({ token }, trackId) {
    if (!client.isValidId(String(trackId))) throw new SourceError('NOT_FOUND', 'Invalid track id.', { source: SOURCE });
    try {
        await client.apiRequest(`/likes/tracks/${client.toTrackUrn(trackId)}`, { token, method: 'POST' });
    } catch (err) {
        throw mapError(err);
    }
}

async function unlikeTrack({ token }, trackId) {
    if (!client.isValidId(String(trackId))) throw new SourceError('NOT_FOUND', 'Invalid track id.', { source: SOURCE });
    try {
        await client.apiRequest(`/likes/tracks/${client.toTrackUrn(trackId)}`, { token, method: 'DELETE' });
    } catch (err) {
        throw mapError(err);
    }
}

// --- Search ---------------------------------------------------------------------

// Public search needs no user session: the user's token is used when present
// (so `user_favorite` is right), otherwise the cached app token, otherwise
// yt-dlp. `provider` in the result says which path answered.
async function search({ db, token }, query, { cursor } = {}) {
    const viaApi = async () => {
        const apiToken = token || await tokens.getAppToken(db);
        const { items, nextHref } = await client.fetchCollection(cursor || '/tracks', {
            token: apiToken,
            query: cursor ? {} : { q: query, access: 'playable,preview', limit: SEARCH_SIZE },
            maxPages: 1
        });
        return { ...page(items.map(client.normalizeTrack).filter(t => t.id).map(toTrack), nextHref), provider: 'api' };
    };
    // yt-dlp has no cursor: a "next page" request gets an empty page.
    const viaYtdlp = async () => {
        if (cursor) return { ...page([], null), provider: 'ytdlp' };
        const items = await ytdlp.search(query, SEARCH_SIZE);
        return { ...page(items.map(toTrack), null), provider: 'ytdlp' };
    };

    try {
        return await withFallback('search', viaApi, viaYtdlp);
    } catch (err) {
        throw mapError(err);
    }
}

module.exports = {
    name: SOURCE,
    label: LABEL,
    sourceId: SOURCE_ID,
    connect: { kind: 'oauth', required: true },
    capabilities: { search: true, playlists: true, liked: true, like: true, stream: true },
    searchRequiresToken: false,
    // Connecting an account (and so the library) needs the official API; search
    // and playback still work through yt-dlp without it.
    isAvailable: () => client.isConfigured(),
    activeProvider,
    getToken,
    getPlaylists,
    getPlaylistTracks,
    getLikedTracks,
    likeTrack,
    unlikeTrack,
    search,
    toTrack,
    toPlaylist,
    mapError
};
