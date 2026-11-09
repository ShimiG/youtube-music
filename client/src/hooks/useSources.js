import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { paths, serviceOf } from '../utils/services';

// One call (GET /api/sources) tells the client every source the server knows,
// its capabilities, whether it can be connected here, and whether this user has
// connected it. Each entry is merged with the registry's visuals:
//
//   name, label, capabilities, connected, expiresAt     from the server
//   connect: { required, kind, available }              from the server
//   icon, color, connectLabel, attribution, local       from the registry
//   connectAction: () => void | null                    the registry's connect flow
export function useSources() {
    // null while the first load is in flight; [] when logged out.
    const [sources, setSources] = useState(() => (localStorage.getItem('authToken') ? null : []));
    const [error, setError] = useState(null);

    const reload = useCallback(() => {
        return apiFetch(paths.sources())
            .then(data => {
                const merged = (data.sources || []).map(s => {
                    const visuals = serviceOf(s.name);
                    return {
                        ...s,
                        icon: visuals.icon,
                        color: visuals.color,
                        connectLabel: visuals.connectLabel || `Connect ${s.label}`,
                        attribution: visuals.attribution || null,
                        local: Boolean(visuals.local),
                        connectAction: typeof visuals.connect === 'function' ? visuals.connect : null
                    };
                });
                setSources(merged);
                setError(null);
            })
            .catch(err => {
                setError(err);
                setSources([]);
            });
    }, []);

    useEffect(() => {
        if (localStorage.getItem('authToken')) reload();
    }, [reload]);

    return { sources: sources || [], loading: sources === null, error, reload };
}
