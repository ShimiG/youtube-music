// Unified, source-agnostic error codes (ROADMAP Stage 3).
//
// Every service failure the client has to react to is one of these codes plus
// the `source` it concerns, so the client handles "YouTube not connected" and
// "SoundCloud not connected" with one code path and one toast. Messages are
// generic and never echo request input or upstream error text.
const LABELS = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify' };

const label = (source) => LABELS[source] || 'this service';

const CODES = {
    SOURCE_NOT_CONNECTED: {
        status: 401,
        message: (s) => `No ${label(s)} account connected. Connect your account to continue.`
    },
    SOURCE_TOKEN_EXPIRED: {
        status: 401,
        message: (s) => `Your ${label(s)} session has expired. Reconnect your account.`
    },
    TRACK_UNAVAILABLE: {
        status: 502,
        message: () => 'This track is unavailable right now.'
    },
    SOURCE_TIER_REQUIRED: {
        status: 403,
        message: (s) => `Your ${label(s)} plan does not allow this.`
    }
};

class SourceError extends Error {
    constructor(code, source, { status, message, cause } = {}) {
        const def = CODES[code];
        super(message || (def ? def.message(source) : 'Service error'));
        this.name = 'SourceError';
        this.code = code;
        this.source = source;
        this.status = status || (def ? def.status : 500);
        if (cause) this.cause = cause;
    }
}

/**
 * Writes the standard JSON body for a unified error code. `reason` is an
 * optional machine-readable detail (e.g. 'blocked', 'resolve_failed') for
 * logs and diagnostics; the client keys its behaviour off `code` only.
 */
function sendSourceError(res, code, source, { reason, ...overrides } = {}) {
    const err = new SourceError(code, source, overrides);
    const body = { error: err.message, code: err.code, source: err.source };
    if (reason) body.reason = reason;
    return res.status(err.status).json(body);
}

module.exports = { CODES, SourceError, sendSourceError };
