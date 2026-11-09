import { connectGoogle } from './googleAuth';
import { connectSoundCloud } from './soundcloudAuth';

// The client-side service registry: the ONLY place a specific service is
// named. The connect banner, the Library dropdown, the Search switch and the
// error panels all read from here. Facts about a service (label, capabilities,
// whether it is connected) come from GET /api/sources; this file adds the
// visuals and the connect action for each. Adding a service is one entry.
export const SERVICES = {
    custom: {
        name: 'custom',
        label: 'Custom Playlists',
        icon: '📁',
        color: '#1db954',
        connect: null,
        // Lives in our own database: the Library shows a "create" card for it.
        local: true
    },
    youtube: {
        name: 'youtube',
        label: 'YouTube',
        icon: '▶',
        color: '#ff0000',
        connectLabel: 'Connect YouTube',
        // connect({ scope: 'write' }) re-runs consent with the like/unlike scope.
        connect: connectGoogle,
        // The API's OAuth callback bounces back with #google=connected|error.
        callbackParam: 'google',
        // Its token is not refreshed server-side, so the client logs out when it
        // expires (stored under this key) to force a fresh connect.
        expiryStorageKey: 'googleExpiresAt',
        autoLogoutOnExpiry: true
    },
    soundcloud: {
        name: 'soundcloud',
        label: 'SoundCloud',
        icon: '☁',
        color: '#ff5500',
        connectLabel: 'Connect SoundCloud',
        connect: connectSoundCloud,
        // The API terms require crediting SoundCloud and linking to it.
        attribution: { text: 'SoundCloud', url: 'https://soundcloud.com' },
        callbackParam: 'soundcloud',
        // Refreshed server-side: expiry never logs the user out.
        autoLogoutOnExpiry: false
    }
};

export const SERVICE_LIST = Object.values(SERVICES);

// Tracks stored before every row carried a source are from this service.
export const DEFAULT_SOURCE = 'youtube';

// Visuals for a source name, with a neutral fallback for one the client has no
// entry for yet (the server can still list it).
export function serviceOf(name) {
    return SERVICES[name] || { name, label: name, icon: '♪', color: '#888', connect: null };
}

// --- Generic API paths: one code path for every source ---------------------------

const enc = encodeURIComponent;
const qs = (params) => {
    const parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${enc(k)}=${enc(v)}`);
    return parts.length ? `?${parts.join('&')}` : '';
};

export const paths = {
    sources: () => '/api/sources',
    playlists: (source, cursor) => `/api/library/${enc(source)}/playlists${qs({ cursor })}`,
    tracks: (source, id, cursor) => `/api/library/${enc(source)}/playlists/${enc(id)}/tracks${qs({ cursor })}`,
    like: (source) => `/api/library/${enc(source)}/liked`,
    unlike: (source, id) => `/api/library/${enc(source)}/liked/${enc(id)}`,
    search: (source, q, cursor) => `/api/search/${enc(source)}${qs({ q, cursor })}`
};

// Error codes the API uses for every source.
export const CODES = {
    NOT_CONNECTED: 'SOURCE_NOT_CONNECTED',
    TOKEN_EXPIRED: 'SOURCE_TOKEN_EXPIRED',
    SCOPE_REQUIRED: 'SOURCE_SCOPE_REQUIRED',
    NOT_CONFIGURED: 'SOURCE_NOT_CONFIGURED',
    RATE_LIMITED: 'SOURCE_RATE_LIMITED',
    NOT_SUPPORTED: 'SOURCE_NOT_SUPPORTED'
};

// Turns an ApiError into what a panel should say and whether a connect button
// would help, for whichever source is active.
export function describeSourceError(err, service) {
    const label = (service && service.label) || 'this service';
    switch (err && err.code) {
        case CODES.NOT_CONNECTED:
            return { message: `Connect your ${label} account to view this.`, canConnect: true, connectLabel: `Connect ${label}` };
        case CODES.TOKEN_EXPIRED:
            return { message: `Your ${label} session has expired. Reconnect your account.`, canConnect: true, connectLabel: `Reconnect ${label}` };
        case CODES.SCOPE_REQUIRED:
            return { message: `${label} needs extra permission for that.`, canConnect: true, connectLabel: `Allow on ${label}`, scope: (err.body && err.body.scope) || 'write' };
        case CODES.NOT_CONFIGURED:
            return { message: `${label} is not configured on this server.`, canConnect: false };
        case CODES.RATE_LIMITED:
            return { message: `${label} rate limit reached. Try again later.`, canConnect: false };
        default:
            return { message: (err && err.message) || 'Something went wrong.', canConnect: false };
    }
}
