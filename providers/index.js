// The provider registry. Every service lives in providers/<name>.js and
// exposes the same interface; app.js routes by `source` and never learns
// service details. Adding a service is one file here plus one entry in the
// client's utils/services.js.
//
// Interface (every method optional except name/label/capabilities):
//   name, label, sourceId (sources.id, or null for local)
//   connect: { kind: 'oauth' | 'none', required: boolean }
//   capabilities: { search, playlists, liked, like, stream }
//   searchRequiresToken: boolean
//   isAvailable(): boolean          server has what it needs to connect this source
//   getToken(db, userId)            -> access token, or throws SourceError
//   getPlaylists(ctx, { cursor })    -> { items: Playlist[], nextCursor }
//   getPlaylistTracks(ctx, id, { cursor })
//   getLikedTracks(ctx, { cursor })  when capabilities.liked
//   likeTrack(ctx, id) / unlikeTrack(ctx, id)   when capabilities.like
//   search(ctx, q, { cursor })       when capabilities.search
// where ctx = { db, userId, token }.
const youtube = require('./youtube');
const soundcloud = require('./soundcloud');
const custom = require('./custom');

const PROVIDERS = Object.freeze({
    [custom.name]: custom,
    [youtube.name]: youtube,
    [soundcloud.name]: soundcloud
});

const SOURCE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

function getProvider(name) {
    if (typeof name !== 'string' || !SOURCE_NAME.test(name)) return null;
    return Object.prototype.hasOwnProperty.call(PROVIDERS, name) ? PROVIDERS[name] : null;
}

function listProviders() {
    return Object.values(PROVIDERS);
}

module.exports = { getProvider, listProviders, PROVIDERS };
