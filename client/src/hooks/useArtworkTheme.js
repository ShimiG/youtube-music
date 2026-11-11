import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { artOf } from '../utils/artwork';
import { getDynamicTheme, subscribeDynamicTheme } from '../utils/settings';

// Dynamic theming (issue #26). The colours of the playing track's cover come
// from GET /api/artwork/colors (the server reads the image; a page may not
// read another site's pixels) and are published as CSS variables on <html>:
//   --theme-bg       top of the Now Playing view
//   --theme-surface  the player bar
//   --theme-accent   tab marker, volume, active controls
// App.css gives each a default, so removing them restores the stock look.
// While the next cover's colours load, the previous ones stay, so the bar
// does not flash back to grey between tracks.

const VARIABLES = { '--theme-bg': 'background', '--theme-surface': 'surface', '--theme-accent': 'accent' };
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_REMEMBERED = 300;
const remembered = new Map(); // cover URL -> theme, or null when it has none

function remember(url, theme) {
    if (remembered.size >= MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
    remembered.set(url, theme);
}

const themeOf = (result) => (result && result.status === 'ok'
    && Object.values(VARIABLES).every((key) => HEX.test(result[key] || '')) ? result : null);

export function useDynamicTheme() {
    return useSyncExternalStore(subscribeDynamicTheme, getDynamicTheme);
}

/** Applies the cover's colours for `track`; call once, near the top of the app. */
export default function useArtworkTheme(track) {
    const enabled = useDynamicTheme();
    const art = artOf(track);
    const url = enabled && typeof art === 'string' && art.startsWith('https://') ? art : null;
    const [, setLoaded] = useState(null); // re-renders when an answer arrives

    useEffect(() => {
        if (!url || remembered.has(url)) return undefined;
        const controller = new AbortController();
        apiFetch(`/api/artwork/colors?${new URLSearchParams({ url })}`, { signal: controller.signal })
            .then((result) => {
                remember(url, themeOf(result));
                setLoaded(url);
            })
            .catch((err) => {
                if (err.name === 'AbortError') return;
                remember(url, null);
                setLoaded(url);
            });
        return () => controller.abort();
    }, [url]);

    // undefined: still loading (keep what is shown); null: no theme.
    const theme = !url ? null : (remembered.has(url) ? remembered.get(url) : undefined);

    useEffect(() => {
        if (theme === undefined) return;
        const style = document.documentElement.style;
        for (const [name, key] of Object.entries(VARIABLES)) {
            if (theme) style.setProperty(name, theme[key]);
            else style.removeProperty(name);
        }
    }, [theme]);
}
