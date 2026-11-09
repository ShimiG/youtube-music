import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { paths } from '../utils/services';

const EMPTY = { items: [], nextCursor: null, loading: false, error: null, loaded: false };

// A cursor-paged list from the generic library API. `key` identifies what is
// being listed; when it changes the hook presents an empty list for the new
// key (derived, no state reset in render) and the effect loads its first page.
// `loadMore` appends the next page while `nextCursor` is present. A request
// id guards against a slow response for an old key landing on a new one.
function usePagedList(key, pathFor, { enabled = true } = {}) {
    const [state, setState] = useState({ key, ...EMPTY });
    const reqId = useRef(0);

    // What the caller sees: the stored list if it belongs to this key, else empty.
    const current = state.key === key ? state : { key, ...EMPTY };

    const fetchPage = useCallback((cursor, append) => {
        const id = ++reqId.current;
        const forKey = (s) => (s.key === key ? s : { key, ...EMPTY });
        // The loading flag is set in a microtask so no state update runs
        // synchronously inside the effect that kicks off the first page.
        return Promise.resolve()
            .then(() => {
                if (id !== reqId.current) return null;
                setState(s => ({ ...forKey(s), loading: true, error: null }));
                return apiFetch(pathFor(cursor));
            })
            .then(data => {
                if (id !== reqId.current || data === null) return;
                setState(s => {
                    const base = forKey(s);
                    return {
                        key,
                        items: append ? [...base.items, ...(data.items || [])] : (data.items || []),
                        nextCursor: data.nextCursor || null,
                        loading: false,
                        error: null,
                        loaded: true
                    };
                });
            })
            .catch(err => {
                if (id !== reqId.current) return;
                setState(s => ({ ...forKey(s), loading: false, error: err, loaded: true }));
            });
    }, [pathFor, key]);

    useEffect(() => {
        if (enabled) fetchPage(undefined, false);
    }, [enabled, fetchPage]);

    const loadMore = useCallback(() => {
        if (current.nextCursor && !current.loading) fetchPage(current.nextCursor, true);
    }, [current.nextCursor, current.loading, fetchPage]);

    const reload = useCallback(() => fetchPage(undefined, false), [fetchPage]);

    // Lets a caller drop an item locally (e.g. after unliking) without a refetch.
    const removeItem = useCallback((predicate) => {
        setState(s => ({ ...s, items: s.items.filter(item => !predicate(item)) }));
    }, []);

    return { ...current, hasMore: Boolean(current.nextCursor), loadMore, reload, removeItem };
}

// The playlists of one source. The server pins the virtual "liked" playlist
// first when the source supports it.
export function useLibrary(source) {
    const pathFor = useCallback((cursor) => paths.playlists(source, cursor), [source]);
    return usePagedList(`playlists:${source}`, pathFor, { enabled: Boolean(source) });
}

// The tracks of one playlist (id 'liked' for the liked songs).
export function usePlaylistTracks(source, playlistId) {
    const pathFor = useCallback((cursor) => paths.tracks(source, playlistId, cursor), [source, playlistId]);
    return usePagedList(`tracks:${source}:${playlistId}`, pathFor, { enabled: Boolean(source && playlistId) });
}

// A search in one source, run on demand with `run(query)`.
export function useSearch(source) {
    const [query, setQuery] = useState('');
    const pathFor = useCallback((cursor) => paths.search(source, query, cursor), [source, query]);
    const list = usePagedList(`search:${source}:${query}`, pathFor, { enabled: Boolean(source && query) });
    const run = useCallback((q) => setQuery((q || '').trim()), []);
    const clear = useCallback(() => setQuery(''), []);
    return { ...list, query, run, clear };
}
