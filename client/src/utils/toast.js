// Tiny app-wide toast bus. Any module (components, MusicContext, utils) can
// call toast(); <Toaster /> renders whatever is pending. No React context, so
// it works from plain functions like the connect helpers too.
const listeners = new Set();
let nextId = 1;

export function toast(message, { kind = 'info', timeoutMs = 5000 } = {}) {
    const item = { id: nextId++, message, kind, timeoutMs };
    listeners.forEach((fn) => fn(item));
    return item.id;
}

export function subscribeToasts(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
