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
