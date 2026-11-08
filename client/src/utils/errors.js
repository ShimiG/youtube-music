// Client side of the server's unified error codes (services/errors.js).
// Every service failure arrives as { error, code, source }; this maps it to a
// user-facing message and whether a Connect / Reconnect action makes sense.
import { SERVICES } from './services';

export const ERROR_CODES = {
    SOURCE_NOT_CONNECTED: 'SOURCE_NOT_CONNECTED',
    SOURCE_TOKEN_EXPIRED: 'SOURCE_TOKEN_EXPIRED',
    TRACK_UNAVAILABLE: 'TRACK_UNAVAILABLE',
    SOURCE_TIER_REQUIRED: 'SOURCE_TIER_REQUIRED'
};

export function describeSourceError(data = {}, fallbackSource) {
    const service = SERVICES[data.source || fallbackSource];
    const label = service ? service.label : 'this service';
    switch (data.code) {
        case ERROR_CODES.SOURCE_NOT_CONNECTED:
            return { message: `Connect your ${label} account to continue.`, canConnect: true };
        case ERROR_CODES.SOURCE_TOKEN_EXPIRED:
            return { message: `Your ${label} session has expired. Reconnect your account.`, canConnect: true };
        case ERROR_CODES.SOURCE_TIER_REQUIRED:
            return { message: `Your ${label} plan does not allow this.`, canConnect: false };
        case ERROR_CODES.TRACK_UNAVAILABLE:
            return { message: 'This track is unavailable right now.', canConnect: false };
        default:
            return { message: data.error || `${label} request failed. Try again later.`, canConnect: false };
    }
}
