import { useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { DEFAULT_SOURCE } from '../utils/services';

// Lyrics for a track from GET /api/lyrics (issue #30). Nothing is requested
// until `enabled` (the Lyrics tab is on screen), so tracks nobody reads the
// lyrics of are never looked up. `online` says the user agreed to online
// lookups. Returns { loading, result, retry }: `result` is the server's
// answer ({ status, synced, plain, origin, credit }), or { status:
// 'unavailable' } when the request itself failed.
export default function useLyrics(track, { enabled, online }) {
    const [attempt, setAttempt] = useState(0);
    const [loaded, setLoaded] = useState({ key: null, result: null });

    const id = track ? (track.id || track.videoId) : null;
    const source = track ? (track.source || DEFAULT_SOURCE) : null;
    const title = track ? (track.title || '') : '';
    const artist = track ? (track.artist || track.channelTitle || '') : '';
    const length = track ? (track.durationSec ?? track.duration ?? '') : '';
    const key = track && id ? `${source}\n${id}\n${online ? 1 : 0}\n${attempt}` : null;

    useEffect(() => {
        if (!enabled || !key) return undefined;
        const controller = new AbortController();
        const params = new URLSearchParams({ source, id: String(id), title, artist });
        if (Number(length) > 0) params.set('duration', String(Math.round(Number(length))));
        if (online) params.set('online', '1');
        apiFetch(`/api/lyrics?${params}`, { signal: controller.signal })
            .then((result) => setLoaded({ key, result }))
            .catch((err) => {
                if (err.name === 'AbortError') return;
                setLoaded({ key, result: { status: 'unavailable' } });
            });
        return () => controller.abort();
    }, [enabled, key, source, id, title, artist, length, online]);

    const current = loaded.key === key ? loaded.result : null;
    return {
        loading: Boolean(key) && !current,
        result: current,
        retry: () => setAttempt((n) => n + 1)
    };
}
