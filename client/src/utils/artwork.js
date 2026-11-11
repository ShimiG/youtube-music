// Cover art fallback, drawn locally. A data: URI (allowed by the app's CSP)
// instead of a request to a third-party placeholder service for every track
// without artwork, which also failed offline and in the desktop app.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#282828"/><path fill="#7a7a7a" d="M62 24v34.5a10.5 10.5 0 1 1-6-9.5V32l-18 4v27.500a10.500 10.500 0 1 1-6-9.500V31l30-7z"/></svg>`;
export const PLACEHOLDER_ART = `data:image/svg+xml,${encodeURIComponent(svg)}`;

/** A track's cover URL, or null. Older rows carry `image` instead of `thumbnail`. */
export const artOf = (track) => (track && (track.thumbnail || track.image)) || null;
