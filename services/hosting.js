// Running as a website (Render and the like) instead of on someone's computer.
//
// The desktop app's server listens on 127.0.0.1 and the web client is a
// separate dev server or the desktop window. Hosted, one server does both:
// it listens on every address, serves the built client from the same origin
// (so the client calls the API with relative addresses), sits behind the
// host's proxy, and leaves out what only makes sense on one's own computer.
//
//   SERVE_CLIENT=1          serve client/dist (or SERVE_CLIENT=<folder>)
//   PUBLIC_URL=https://...  the site's own address. On Render it is taken
//                           from RENDER_EXTERNAL_URL, which Render sets.
//   TRUST_PROXY=1           how many proxies sit in front (Render: 1), so rate
//                           limits count each visitor, not the proxy
//   LOCAL_FILES=off         no "Local Files": a website has no music folders
//                           of its visitors, and its own disk is not theirs
//   COMPRESS=on|off         compress the client's files and JSON answers
//                           (services/compression.js). Default: on when the
//                           client is served (hosted), off otherwise.
const fs = require('fs');
const path = require('path');

const off = (value) => ['0', 'false', 'no', 'off'].includes(String(value ?? '').trim().toLowerCase());
const on = (value) => value !== undefined && String(value).trim() !== '' && !off(value);

/** The site's own address (no trailing slash), or null on a computer. */
function publicUrl() {
    const raw = String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
    } catch {
        return null;
    }
}

/** The folder of the built client to serve, or null. */
function clientDir() {
    const value = process.env.SERVE_CLIENT;
    if (!on(value)) return null;
    const dir = ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
        ? path.join(__dirname, '..', 'client', 'dist')
        : path.resolve(String(value));
    return fs.existsSync(path.join(dir, 'index.html')) ? dir : null;
}

/** For app.set('trust proxy'): a number of proxies, or false. */
function trustProxy() {
    const value = String(process.env.TRUST_PROXY || '').trim();
    if (/^\d{1,2}$/.test(value)) return Number(value);
    return on(value) ? 1 : false;
}

const localFilesEnabled = () => !off(process.env.LOCAL_FILES);

function compressionEnabled() {
    const value = process.env.COMPRESS;
    if (value !== undefined && String(value).trim() !== '') return !off(value);
    return Boolean(clientDir());
}

module.exports = { publicUrl, clientDir, trustProxy, localFilesEnabled, compressionEnabled };
