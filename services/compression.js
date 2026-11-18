// Smaller answers for a server that is reached over the internet (hosted,
// services/hosting.js). On a computer the client talks to localhost, where
// compressing would only cost time; there none of this is switched on.
//
// Two parts, both without a dependency:
//
// - The client's files (client/dist/assets) are compressed once, when the
//   server starts, and kept in memory: brotli at its best setting and gzip.
//   Their names carry a hash of their content, so they never change while
//   the server runs, and the answer for each is the same every time. The
//   main script: 295 KB as it is, 79 KB with brotli.
//
// - JSON answers (search results, playlists, history) are compressed as they
//   are sent, when they are large enough to gain from it, with a quick
//   brotli setting: a 100 KB list takes about a millisecond.
//
// Audio is never compressed: it is compressed already, and the player asks
// for parts of it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Below this, the headers cost more than compression saves.
const MIN_JSON_BYTES = 1400;
const TYPES = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
};
// Images and fonts in these formats are compressed already.
const WORTH_COMPRESSING = new Set(Object.keys(TYPES));

/** The encoding to answer with: 'br', 'gzip' or null, from the request's Accept-Encoding. */
function chooseEncoding(req) {
    // "gzip, deflate, br;q=0.8": names with an optional weight; "q=0" means "not this one".
    const accepted = new Map();
    for (const part of String(req.headers['accept-encoding'] || '').toLowerCase().split(',')) {
        const [name, ...params] = part.split(';').map((p) => p.trim());
        if (!name) continue;
        const q = params.map((p) => /^q=([\d.]+)$/.exec(p)).find(Boolean);
        accepted.set(name, q ? Number(q[1]) : 1);
    }
    if (accepted.get('br') > 0) return 'br';
    if (accepted.get('gzip') > 0) return 'gzip';
    return null;
}

/**
 * Compresses every file in `dir` worth compressing, in the background.
 * Returns a lookup: name -> { type, raw, br, gzip } (br and gzip appear when
 * ready; until then the file is sent as it is).
 */
function compressFolder(dir) {
    const files = new Map();
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return files;
    }
    for (const name of names) {
        const ext = path.extname(name).toLowerCase();
        if (!WORTH_COMPRESSING.has(ext) || !/^[\w.-]+$/.test(name)) continue;
        let raw;
        try {
            raw = fs.readFileSync(path.join(dir, name));
        } catch {
            continue;
        }
        const entry = { type: TYPES[ext], raw, br: null, gzip: null };
        files.set(name, entry);
        // Once, at the best settings: the time is spent at start-up, not per visit.
        zlib.brotliCompress(raw, {
            params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
                [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT
            }
        }, (err, out) => { if (!err && out.length < raw.length) entry.br = out; });
        zlib.gzip(raw, { level: 9 }, (err, out) => { if (!err && out.length < raw.length) entry.gzip = out; });
    }
    return files;
}

/**
 * Express middleware for the client's assets, served from memory, compressed
 * when the browser accepts it. Unknown names fall through (to a 404).
 */
function serveCompressedAssets(dir) {
    const files = compressFolder(dir);
    return (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const name = req.path.replace(/^\//, '');
        const entry = files.get(name);
        if (!entry) return next();
        const encoding = chooseEncoding(req);
        const body = (encoding && entry[encoding]) || entry.raw;
        res.set({
            'Content-Type': entry.type,
            // The name changes with the content: keep it for a year.
            'Cache-Control': 'public, max-age=31536000, immutable',
            Vary: 'Accept-Encoding'
        });
        if (body !== entry.raw) res.set('Content-Encoding', encoding);
        return res.send(body);
    };
}

/**
 * Express middleware: res.json answers compressed when the browser accepts it
 * and the answer is large enough. Install before the routes.
 */
function compressJson(req, res, next) {
    const encoding = chooseEncoding(req);
    if (!encoding) return next();
    const send = res.json.bind(res);
    res.json = (body) => {
        // Express's own rules for turning the value into text.
        const text = JSON.stringify(body, req.app.get('json replacer'), req.app.get('json spaces'));
        if (text === undefined || Buffer.byteLength(text) < MIN_JSON_BYTES || res.headersSent) return send(body);
        const raw = Buffer.from(text);
        const packed = encoding === 'br'
            ? zlib.brotliCompressSync(raw, {
                params: {
                    [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
                    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
                    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT
                }
            })
            : zlib.gzipSync(raw, { level: 6 });
        if (!res.get('Content-Type')) res.set('Content-Type', 'application/json; charset=utf-8');
        res.set('Content-Encoding', encoding);
        res.vary('Accept-Encoding');
        return res.send(packed);
    };
    return next();
}

module.exports = { chooseEncoding, compressFolder, serveCompressedAssets, compressJson, MIN_JSON_BYTES };
