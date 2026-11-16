// Like / unlike through the generic library API. When a source answers
// SOURCE_SCOPE_REQUIRED (YouTube read-only consent), this re-runs the connect
// flow asking for the write scope; the user lands back in the app and taps
// like again.
import { apiFetch } from './api';
import { paths, CODES, serviceOf } from './services';

export async function likeTrack(source, trackId) {
    try {
        await apiFetch(paths.like(source), { method: 'POST', body: { trackId } });
        // The Library may be showing that source's liked list (it stays alive
        // while another view is on screen).
        window.dispatchEvent(new CustomEvent('liked-changed', { detail: { source } }));
        return { ok: true };
    } catch (err) {
        if (err.code === CODES.SCOPE_REQUIRED) {
            const service = serviceOf(source);
            if (service.connect) service.connect({ scope: (err.body && err.body.scope) || 'write' });
            return { ok: false, scopeRequested: true };
        }
        throw err;
    }
}

export async function unlikeTrack(source, trackId) {
    await apiFetch(paths.unlike(source, trackId), { method: 'DELETE' });
    return { ok: true };
}

// --- Custom (local) playlists -------------------------------------------------

export async function createCustomPlaylist(name) {
    return apiFetch('/api/custom-playlists', { method: 'POST', body: { name } });
}

export async function listCustomPlaylists() {
    const data = await apiFetch(paths.playlists('custom'));
    return data.items || [];
}

// Adds a normalised Track (from any source) to one of the user's custom
// playlists. Resolves with { alreadyInPlaylist } when it was there already.
export async function addTrackToCustomPlaylist(playlistId, track) {
    return apiFetch(`/api/custom-playlists/${encodeURIComponent(playlistId)}/tracks`, {
        method: 'POST',
        body: {
            sourceName: track.source || 'youtube',
            externalId: String(track.id),
            title: track.title,
            artist: track.artist || track.channelTitle || null,
            thumbnail: track.thumbnail || track.image || null
        }
    });
}
