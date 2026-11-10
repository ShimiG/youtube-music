// YouTube provider: the user's playlists, liked videos and search through the
// YouTube Data API v3, plus the token lookup for the stored Google connection.
// Everything leaves here in the normalised Playlist / Track shapes.
//
// Pagination is YouTube's pageToken, passed through as the opaque cursor.
const { getYouTubeClient } = require('../controllers/youtubeClient');
const { SourceError, fromConnectionError } = require('./errors');
const { getSourceToken } = require('../services/connections');
const { makePlaylist, makeTrack, page } = require('./normalize');

const SOURCE = 'youtube';
const LABEL = 'YouTube';
const SOURCE_ID = 1; // sources.id in config/db.js
const PAGE_SIZE = 50;
const SEARCH_SIZE = 30;

// YouTube's "Music" category. The liked list is filtered to it so a user's
// liked cooking videos do not show up as songs.
const MUSIC_CATEGORY_ID = '10';

const PLAYLIST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// --- Token ------------------------------------------------------------------

// services/connections.js decrypts the stored Google token and renews it with
// the refresh token when it is about to expire; only a failed renewal (or no
// connection at all) reaches the user as TOKEN_EXPIRED / NOT_CONNECTED.
async function getToken(db, userId) {
    try {
        return await getSourceToken(db, userId, SOURCE);
    } catch (err) {
        throw fromConnectionError(err, SOURCE, LABEL);
    }
}

// --- Error mapping ------------------------------------------------------------

function reasonOf(err) {
    const first = err && Array.isArray(err.errors) && err.errors[0];
    return (first && first.reason) || '';
}

// googleapis errors carry a numeric `code` (HTTP status) and a `reason`.
function mapError(err, { action = 'read' } = {}) {
    if (err instanceof SourceError) return err;
    const status = Number(err && err.code);
    const reason = reasonOf(err);

    if (status === 401 || (err && /Invalid Credentials/i.test(err.message || ''))) {
        return new SourceError('TOKEN_EXPIRED', `Your ${LABEL} session has expired. Reconnect your account.`, { source: SOURCE, cause: err });
    }
    if (status === 403) {
        if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
            return new SourceError('RATE_LIMITED', `${LABEL} API quota reached. Try again later.`, { source: SOURCE, cause: err });
        }
        if (action === 'write') {
            // Liking needs the youtube write scope; read-only users connected with
            // the smaller consent. The client re-runs connect with scope=write.
            return new SourceError('SCOPE_REQUIRED', `${LABEL} needs extra permission to change your likes.`, { source: SOURCE, extra: { scope: 'write' }, cause: err });
        }
        return new SourceError('TOKEN_EXPIRED', `Your ${LABEL} session has expired. Reconnect your account.`, { source: SOURCE, cause: err });
    }
    if (status === 404) {
        return new SourceError('NOT_FOUND', 'Not found on YouTube.', { source: SOURCE, cause: err });
    }
    if (status === 429) {
        return new SourceError('RATE_LIMITED', `${LABEL} API quota reached. Try again later.`, { source: SOURCE, cause: err });
    }
    return new SourceError('UPSTREAM', `${LABEL} request failed.`, { source: SOURCE, cause: err });
}

// --- Normalisation --------------------------------------------------------------

// ISO 8601 duration (PT1H2M3S) -> whole seconds.
function parseDuration(isoDuration) {
    const matches = (isoDuration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!matches) return null;
    const hours = parseInt(matches[1] || 0, 10);
    const minutes = parseInt(matches[2] || 0, 10);
    const seconds = parseInt(matches[3] || 0, 10);
    return hours * 3600 + minutes * 60 + seconds;
}

function bestThumbnail(thumbnails) {
    if (!thumbnails) return null;
    return (thumbnails.high && thumbnails.high.url)
        || (thumbnails.medium && thumbnails.medium.url)
        || (thumbnails.default && thumbnails.default.url)
        || null;
}

function normalizePlaylist(item) {
    return makePlaylist({
        source: SOURCE,
        id: item.id,
        kind: 'playlist',
        name: item.snippet && item.snippet.title,
        thumbnail: bestThumbnail(item.snippet && item.snippet.thumbnails),
        itemCount: item.contentDetails && item.contentDetails.itemCount,
        readOnly: true
    });
}

// playlistItems.list gives the video id and owner but no duration; the player
// fetches /duration on demand for that.
function normalizePlaylistItem(item) {
    const snippet = item.snippet || {};
    return makeTrack({
        source: SOURCE,
        id: snippet.resourceId && snippet.resourceId.videoId,
        title: snippet.title,
        artist: snippet.videoOwnerChannelTitle || snippet.channelTitle,
        thumbnail: bestThumbnail(snippet.thumbnails),
        durationSec: null
    });
}

// videos.list gives everything, including the duration.
function normalizeVideo(video) {
    const snippet = video.snippet || {};
    return makeTrack({
        source: SOURCE,
        id: video.id,
        title: snippet.title,
        artist: snippet.channelTitle,
        thumbnail: bestThumbnail(snippet.thumbnails),
        durationSec: parseDuration(video.contentDetails && video.contentDetails.duration)
    });
}

// --- Library ---------------------------------------------------------------------

async function getPlaylists({ token }, { cursor } = {}) {
    try {
        const youtube = getYouTubeClient(token);
        const response = await youtube.playlists.list({
            part: 'snippet,contentDetails',
            mine: true,
            maxResults: PAGE_SIZE,
            pageToken: cursor || undefined
        });
        const items = (response.data.items || []).map(normalizePlaylist).filter(p => p.id);
        return page(items, response.data.nextPageToken);
    } catch (err) {
        throw mapError(err);
    }
}

async function getPlaylistTracks({ token }, playlistId, { cursor } = {}) {
    if (!PLAYLIST_ID.test(String(playlistId))) {
        throw new SourceError('NOT_FOUND', 'Invalid playlist id.', { source: SOURCE });
    }
    try {
        const youtube = getYouTubeClient(token);
        const response = await youtube.playlistItems.list({
            part: 'snippet,contentDetails',
            playlistId,
            maxResults: PAGE_SIZE,
            pageToken: cursor || undefined
        });
        // Deleted / private videos come back without a resourceId; drop them.
        const items = (response.data.items || []).map(normalizePlaylistItem).filter(t => t.id);
        return page(items, response.data.nextPageToken);
    } catch (err) {
        throw mapError(err);
    }
}

// The music-category filter runs per page, so a page can be shorter than
// PAGE_SIZE while a nextCursor still exists. The client keeps loading.
async function getLikedTracks({ token }, { cursor } = {}) {
    try {
        const youtube = getYouTubeClient(token);
        const response = await youtube.videos.list({
            part: 'snippet,contentDetails',
            myRating: 'like',
            maxResults: PAGE_SIZE,
            pageToken: cursor || undefined
        });
        const items = (response.data.items || [])
            .filter(video => video.snippet && video.snippet.categoryId === MUSIC_CATEGORY_ID)
            .map(normalizeVideo)
            .filter(t => t.id);
        return page(items, response.data.nextPageToken);
    } catch (err) {
        throw mapError(err);
    }
}

async function likeTrack({ token }, trackId) {
    if (!VIDEO_ID.test(String(trackId))) throw new SourceError('NOT_FOUND', 'Invalid video id.', { source: SOURCE });
    try {
        await getYouTubeClient(token).videos.rate({ id: trackId, rating: 'like' });
    } catch (err) {
        throw mapError(err, { action: 'write' });
    }
}

async function unlikeTrack({ token }, trackId) {
    if (!VIDEO_ID.test(String(trackId))) throw new SourceError('NOT_FOUND', 'Invalid video id.', { source: SOURCE });
    try {
        await getYouTubeClient(token).videos.rate({ id: trackId, rating: 'none' });
    } catch (err) {
        throw mapError(err, { action: 'write' });
    }
}

// --- Search ---------------------------------------------------------------------

async function search({ token }, query, { cursor } = {}) {
    try {
        const youtube = getYouTubeClient(token);
        const searchResponse = await youtube.search.list({
            part: 'snippet',
            q: query,
            type: 'video',
            maxResults: SEARCH_SIZE,
            pageToken: cursor || undefined
        });
        const hits = searchResponse.data.items || [];
        if (hits.length === 0) return page([], null);

        // search.list has no durations; a second call fetches them in one go.
        const videosResponse = await youtube.videos.list({
            part: 'contentDetails,snippet',
            id: hits.map(item => item.id && item.id.videoId).filter(Boolean).join(',')
        });
        const items = (videosResponse.data.items || []).map(normalizeVideo).filter(t => t.id);
        return page(items, searchResponse.data.nextPageToken);
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
    searchRequiresToken: true,
    // Connecting needs the server's Google OAuth client; without it the
    // connect button would only lead to a Google error page.
    isAvailable: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    getToken,
    getPlaylists,
    getPlaylistTracks,
    getLikedTracks,
    likeTrack,
    unlikeTrack,
    search,
    // exported for tests
    parseDuration,
    normalizePlaylist,
    normalizeVideo,
    normalizePlaylistItem,
    mapError
};
