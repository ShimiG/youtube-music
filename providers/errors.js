// One error type every provider throws, so the library routes can map any
// provider's failure to the same HTTP status and `code` regardless of service.
//
// Codes (routes turn these into `SOURCE_<CODE>` for the client):
//   NOT_CONNECTED   the user has not linked this service           -> 401
//   TOKEN_EXPIRED   linked, but the stored token cannot be used     -> 401
//   SCOPE_REQUIRED  the action needs a consent the token lacks      -> 403
//   NOT_FOUND       playlist/track missing or not the user's        -> 404
//   NOT_SUPPORTED   provider does not offer this capability         -> 404
//   BAD_CURSOR      pagination cursor is malformed                  -> 400
//   RATE_LIMITED    the service throttled us                        -> 429
//   NOT_CONFIGURED  server lacks the credentials for this service   -> 503
//   UPSTREAM        anything else the service returned              -> 502
const STATUS_BY_CODE = {
    NOT_CONNECTED: 401,
    TOKEN_EXPIRED: 401,
    SCOPE_REQUIRED: 403,
    NOT_FOUND: 404,
    NOT_SUPPORTED: 404,
    BAD_CURSOR: 400,
    RATE_LIMITED: 429,
    NOT_CONFIGURED: 503,
    UPSTREAM: 502
};

class SourceError extends Error {
    constructor(code, message, { source = null, extra = {}, cause = null } = {}) {
        super(message || code);
        this.name = 'SourceError';
        this.code = STATUS_BY_CODE[code] ? code : 'UPSTREAM';
        this.status = STATUS_BY_CODE[this.code];
        this.source = source;
        this.extra = extra;
        this.cause = cause;
    }
}

module.exports = { SourceError, STATUS_BY_CODE };
