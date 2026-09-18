import { connectGoogle } from './googleAuth';
import { connectSoundCloud } from './soundcloudAuth';

// Every streaming service the client knows about. The connect banner, the
// Search source switch and the Library dropdown all read from here, so adding
// a service is one entry plus its connect action.
export const SERVICES = {
    youtube: {
        name: 'youtube',
        label: 'YouTube',
        connectLabel: 'Connect YouTube',
        connect: connectGoogle,
        color: '#ff0000',
        // Search needs the user's Google token (YouTube Data API quota is per user).
        searchRequiresConnection: true,
        searchEndpoint: (q) => `http://localhost:3000/search?q=${encodeURIComponent(q)}`,
        playlistsEndpoint: 'http://localhost:3000/playlists',
        playlistTracksEndpoint: (id) => `http://localhost:3000/playlists/${encodeURIComponent(id)}/tracks`,
        notConnectedCode: 'GOOGLE_NOT_CONNECTED',
        expiredCode: 'GOOGLE_TOKEN_EXPIRED'
    },
    soundcloud: {
        name: 'soundcloud',
        label: 'SoundCloud',
        connectLabel: 'Connect SoundCloud',
        connect: connectSoundCloud,
        color: '#ff5500',
        // Public search works with the server's app token; connecting unlocks
        // the user's playlists and likes.
        searchRequiresConnection: false,
        searchEndpoint: (q) => `http://localhost:3000/api/soundcloud/search?q=${encodeURIComponent(q)}`,
        playlistsEndpoint: 'http://localhost:3000/api/soundcloud/playlists',
        playlistTracksEndpoint: (id) => `http://localhost:3000/api/soundcloud/playlists/${encodeURIComponent(id)}/tracks`,
        notConnectedCode: 'SOUNDCLOUD_NOT_CONNECTED',
        expiredCode: 'SOUNDCLOUD_TOKEN_EXPIRED'
    }
};

export const SERVICE_LIST = Object.values(SERVICES);

// A connection counts as active if it has not expired, or if the server renews
// it on its own (refreshable), in which case the stored expiry is informational.
export function isConnectionActive(conn, now = Date.now()) {
    if (!conn) return false;
    if (conn.refreshable) return true;
    return !conn.expires_at || conn.expires_at > now;
}
