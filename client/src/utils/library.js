// Like / unlike through the generic library API. When a source answers
// SOURCE_SCOPE_REQUIRED (YouTube read-only consent), this re-runs the connect
// flow asking for the write scope; the user lands back in the app and taps
// like again.
import { apiFetch } from './api';
import { paths, CODES, serviceOf } from './services';

export async function likeTrack(source, trackId) {
    try {
        await apiFetch(paths.like(source), { method: 'POST', body: { trackId } });
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
