import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { paths, serviceOf } from '../utils/services';

// One call (GET /api/sources) tells the client every source the server knows,
// its capabilities, whether it can be connected here, and whether this user has
// connected it. Each entry is merged with the registry's visuals:
//
//   name, label, capabilities, connected, expiresAt     from the server
//   connect: { required, kind, available }              from the server
//   icon, color, connectLabel, attribution, local,
//   manageFolders                                       from the registry
//   connectAction: () => void | null                    the registry's connect flow
//
// The answer is kept in one place for the whole app. Each component that
// used this hook had its own copy and asked the server on its own, so the
// same request went out twice at start-up and again on every change of view
// (docs/performance-plan.md, step 3.3). Now it is asked once, and again only
// when something says the connections changed.

const EMPTY = [];
// sources: null until the first answer (or [] when logged out).
let state = { sources: null, error: null };
let inFlight = null;
const listeners = new Set();

const loggedIn = () => Boolean(localStorage.getItem('authToken'));

function publish(next) {
    state = next;
    listeners.forEach((listener) => listener());
}

function merge(source) {
    const visuals = serviceOf(source.name);
    return {
        ...source,
        icon: visuals.icon,
        color: visuals.color,
        connectLabel: visuals.connectLabel || `Connect ${source.label}`,
        attribution: visuals.attribution || null,
        local: Boolean(visuals.local),
        manageFolders: Boolean(visuals.manageFolders),
        connectAction: typeof visuals.connect === 'function' ? visuals.connect : null
    };
}

/** Asks the server. Callers that arrive while a request is out share it. */
export function reloadSources() {
    if (!loggedIn()) {
        publish({ sources: EMPTY, error: null });
        return Promise.resolve();
    }
    if (inFlight) return inFlight;
    inFlight = apiFetch(paths.sources())
        .then((data) => publish({ sources: (data.sources || []).map(merge), error: null }))
        .catch((error) => publish({ sources: EMPTY, error }))
        .finally(() => { inFlight = null; });
    return inFlight;
}

/** Forgets what is known: another user is logging in, or this one logged out. */
export function resetSources() {
    inFlight = null;
    publish({ sources: null, error: null });
}

function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
const snapshot = () => state;

// A connect flow that finishes while the app stays open (the desktop app's
// musicmanager:// deep link, see App.jsx) announces itself; one reload then
// reaches every consumer (connect banner, Library dropdown, Search switch).
window.addEventListener('connections-changed', () => { if (loggedIn()) reloadSources(); });

export function useSources() {
    const current = useSyncExternalStore(subscribe, snapshot);
    const unknown = current.sources === null;
    useEffect(() => {
        if (unknown) reloadSources();
    }, [unknown]);
    return { sources: current.sources || EMPTY, loading: unknown && loggedIn(), error: current.error, reload: reloadSources };
}
