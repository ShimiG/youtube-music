// Legacy alias kept for one release for the old /search and /playlists routes.
// It is the generic sourceToken middleware pinned to YouTube, emitting the
// pre-Stage-0 codes (GOOGLE_NOT_CONNECTED / GOOGLE_TOKEN_EXPIRED) and setting
// req.oauthToken. New routes use sourceToken() and the SOURCE_* codes; remove
// this file together with the alias routes.
const sourceToken = require('./sourceToken');

module.exports = sourceToken('youtube', { legacyCodes: true });
