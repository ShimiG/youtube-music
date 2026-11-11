import { useSyncExternalStore } from 'react';
import { getOnlineLyrics, subscribeOnlineLyrics } from '../utils/settings';

// The user's choice about online lyrics lookups: 'ask' | 'on' | 'off'. Every
// component using it re-renders when the choice changes (Settings and the
// Lyrics tab can both change it).
export default function useOnlineLyrics() {
    return useSyncExternalStore(subscribeOnlineLyrics, getOnlineLyrics);
}
