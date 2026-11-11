// Lets any component ask the app to open Settings (optionally at a section)
// without threading a callback through every screen. App.jsx listens.
const EVENT = 'app:open-settings';

export function openSettings(section) {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { section: section || null } }));
}

export function onOpenSettings(handler) {
    const listener = (event) => handler((event.detail && event.detail.section) || null);
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
}
