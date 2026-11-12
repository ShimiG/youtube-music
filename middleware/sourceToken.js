// Resolves the provider for a source and attaches the user's stored token for
// it. Must run AFTER requireAuth (needs req.userId). Providers get the token
// from services/connections.js, which decrypts it and renews it server-side
// when it is about to expire (Stage 3); the client never sees service tokens.
//
//   sourceToken()                 source comes from req.params.source
//   sourceToken('youtube')        fixed source (used by the legacy alias routes)
//   sourceToken(name, { optional: true })
//                                 do not fail when the user is not connected;
//                                 leave req.sourceToken undefined and stash the
//                                 error on req.sourceTokenError (public search)
//   sourceToken(name, { legacyCodes: true })
//                                 emit the pre-Stage-0 codes (GOOGLE_*,
//                                 SOUNDCLOUD_*) instead of SOURCE_*, for the
//                                 alias routes kept for one release
//
// Sets: req.source, req.provider, req.sourceToken (and, for compatibility,
// req.oauthToken for youtube and req.soundcloudToken for soundcloud).
//
// Error codes returned to the client (401): SOURCE_NOT_CONNECTED and
// SOURCE_TOKEN_EXPIRED, always with `source` so one panel can say
// "Connect <label>" or "Reconnect <label>" for whichever source is active.
const { getProvider } = require('../providers');
const { SourceError } = require('../providers/errors');

const LEGACY_PREFIX = { youtube: 'GOOGLE', soundcloud: 'SOUNDCLOUD' };
const LEGACY_TOKEN_PROP = { youtube: 'oauthToken', soundcloud: 'soundcloudToken' };

function codeFor(source, code, legacyCodes) {
    if (legacyCodes && LEGACY_PREFIX[source]) return `${LEGACY_PREFIX[source]}_${code}`;
    return `SOURCE_${code}`;
}

module.exports = function sourceToken(fixedName = null, { optional = false, legacyCodes = false } = {}) {
    return async (req, res, next) => {
        const name = fixedName || req.params.source;
        const provider = getProvider(name);
        if (!provider) {
            return res.status(404).json({ error: 'Unknown source', code: 'SOURCE_UNKNOWN' });
        }
        req.source = name;
        req.provider = provider;

        if (typeof provider.getToken !== 'function') return next(); // local source, nothing to fetch

        try {
            const token = await provider.getToken(req.app.locals.db, req.userId);
            req.sourceToken = token;
            if (LEGACY_TOKEN_PROP[name]) req[LEGACY_TOKEN_PROP[name]] = token;
            next();
        } catch (err) {
            const isAuthProblem = err instanceof SourceError && (err.code === 'NOT_CONNECTED' || err.code === 'TOKEN_EXPIRED');
            if (!isAuthProblem) {
                // The token could not be fetched for a reason that is not the
                // user's connection (the cloud account that holds the login
                // was unreachable): say so instead of a bare 500.
                if (err instanceof SourceError && !optional) {
                    console.warn(`${name}: no token: ${err.cause ? err.cause.message : err.message}`);
                    return res.status(err.status).json({ error: err.message, code: `SOURCE_${err.code}`, source: name });
                }
                if (err instanceof SourceError) {
                    req.sourceTokenError = err;
                    return next();
                }
                return next(err);
            }
            if (optional) {
                req.sourceTokenError = err;
                return next();
            }
            res.status(401).json({ error: err.message, code: codeFor(name, err.code, legacyCodes), source: name });
        }
    };
};
