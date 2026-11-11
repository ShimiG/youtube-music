// Settings kept on this device (localStorage). Reads and writes are guarded:
// storage can be unavailable (private windows), and the app must still work.

export const QUALITY_OPTIONS = [
    { value: 'low', label: 'Data Saver', detail: '96 kbps. Smallest downloads; fine for speech and small speakers.' },
    { value: 'standard', label: 'Standard', detail: '128 kbps. The default.' },
    { value: 'high', label: 'High', detail: '256 kbps. Closest to what the source provides; larger downloads and cache.' }
];
const DEFAULT_QUALITY = 'standard';
const QUALITY_KEY = 'audioQuality';

export function getAudioQuality() {
    try {
        const stored = localStorage.getItem(QUALITY_KEY);
        return QUALITY_OPTIONS.some(o => o.value === stored) ? stored : DEFAULT_QUALITY;
    } catch {
        return DEFAULT_QUALITY;
    }
}

export function setAudioQuality(value) {
    if (!QUALITY_OPTIONS.some(o => o.value === value)) return;
    try {
        if (value === DEFAULT_QUALITY) localStorage.removeItem(QUALITY_KEY);
        else localStorage.setItem(QUALITY_KEY, value);
    } catch { /* not persisted; still applies until reload via the caller's state */ }
}

export const isDefaultQuality = (value) => value === DEFAULT_QUALITY;

// Online lyrics lookups (issue #30). Lyrics kept with the user's own files are
// always shown; for everything else the app asks a lyrics server, which means
// sending it the playing track's title and artist. That needs a yes first:
// 'ask' until the user decides, then 'on' or 'off'.
const ONLINE_LYRICS_KEY = 'onlineLyrics';
const ONLINE_LYRICS_EVENT = 'settings:onlineLyrics';
let onlineLyricsUnsaved = null; // the choice when storage is unavailable; lasts until reload

export function getOnlineLyrics() {
    try {
        const stored = localStorage.getItem(ONLINE_LYRICS_KEY);
        if (stored === 'on' || stored === 'off') return stored;
    } catch { /* fall through */ }
    return onlineLyricsUnsaved || 'ask';
}

export function setOnlineLyrics(value) {
    if (value !== 'on' && value !== 'off') return;
    onlineLyricsUnsaved = value;
    try { localStorage.setItem(ONLINE_LYRICS_KEY, value); } catch { /* kept in memory only */ }
    window.dispatchEvent(new Event(ONLINE_LYRICS_EVENT));
}

/** Calls `onChange` when the choice changes, here or in another window. */
export function subscribeOnlineLyrics(onChange) {
    window.addEventListener(ONLINE_LYRICS_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
        window.removeEventListener(ONLINE_LYRICS_EVENT, onChange);
        window.removeEventListener('storage', onChange);
    };
}

// Dynamic theming (issue #26): the player bar and the Now Playing view take
// their colours from the playing track's cover. On unless turned off.
const DYNAMIC_THEME_KEY = 'dynamicTheme';
const DYNAMIC_THEME_EVENT = 'settings:dynamicTheme';
let dynamicThemeUnsaved = null; // the choice when storage is unavailable; lasts until reload

export function getDynamicTheme() {
    try {
        return localStorage.getItem(DYNAMIC_THEME_KEY) !== 'off';
    } catch {
        return dynamicThemeUnsaved ?? true;
    }
}

export function setDynamicTheme(on) {
    dynamicThemeUnsaved = Boolean(on);
    try {
        if (on) localStorage.removeItem(DYNAMIC_THEME_KEY);
        else localStorage.setItem(DYNAMIC_THEME_KEY, 'off');
    } catch { /* kept in memory only */ }
    window.dispatchEvent(new Event(DYNAMIC_THEME_EVENT));
}

/** Calls `onChange` when the choice changes, here or in another window. */
export function subscribeDynamicTheme(onChange) {
    window.addEventListener(DYNAMIC_THEME_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
        window.removeEventListener(DYNAMIC_THEME_EVENT, onChange);
        window.removeEventListener('storage', onChange);
    };
}
