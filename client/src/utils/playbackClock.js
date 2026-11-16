import { useSyncExternalStore } from 'react';

// The position in the playing track, kept outside React state.
//
// It changes about four times a second. As part of the music context it made
// every component that reads the context render again on each tick: the lists,
// the queue, the sidebar (docs/performance-plan.md, step 5.1). Here only what
// actually shows the position subscribes: the seek bar and the timed lyrics.

let time = 0;
const listeners = new Set();

export const getPlaybackTime = () => time;

export function setPlaybackTime(next) {
    if (next === time) return;
    time = next;
    listeners.forEach((listener) => listener());
}

function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * The position in seconds. With `select`, the component only renders again
 * when what `select` returns changes: `usePlaybackTime(t => lineAt(lines, t))`
 * renders once per lyrics line, not once per tick. `select` must return a
 * number, a string or a boolean.
 */
export function usePlaybackTime(select) {
    return useSyncExternalStore(subscribe, select ? () => select(time) : getPlaybackTime);
}
