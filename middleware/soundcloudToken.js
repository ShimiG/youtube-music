// Legacy alias kept for one release for the old /api/soundcloud/* routes. It is
// the generic sourceToken middleware pinned to SoundCloud, emitting the
// pre-Stage-0 codes (SOUNDCLOUD_NOT_CONNECTED / SOUNDCLOUD_TOKEN_EXPIRED) and
// setting req.soundcloudToken. New routes use sourceToken() and the SOURCE_*
// codes; remove this file together with the alias routes.
const sourceToken = require('./sourceToken');

module.exports = sourceToken('soundcloud', { legacyCodes: true });
