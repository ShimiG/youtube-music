// Theme colours from a track's cover art (issue #26, ROADMAP Stage 7).
//
// The cover is on someone else's server, so the browser cannot read its
// pixels. Instead the client hands the image's URL to this service, which
// downloads it, shrinks it to 32 x 32 with ffmpeg, finds the dominant hue and
// answers with three colours that are safe to put text on:
//   { status: 'ok', color, background, surface, accent }   or   { status: 'none' }
//   color       the dominant colour as found
//   background  a dark shade of it (top of the Now Playing view)
//   surface     a darker one (the player bar)
//   accent      a light shade (tab marker, volume, active controls)
//
// The URL comes from the client (and, for history and custom playlists, from
// whatever the client stored), so fetching it must not become a way to reach
// this computer or its network:
//   - https only, default port, no credentials in the URL;
//   - the host must resolve to public addresses only, checked at connection
//     time on the very addresses the socket uses (no DNS rebinding window);
//     address literals are checked the same way;
//   - redirects are followed by hand, at most 3, each one checked again;
//   - 5 MB and 8 seconds at most; JPEG, PNG and WebP only, recognised by
//     their first bytes and decoded by exactly that ffmpeg reader;
//   - the caller only ever learns colours, never the bytes, and every failure
//     looks the same ("none").
const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const net = require('net');
const { spawn } = require('child_process');
const pkg = require('../package.json');
const { resolveFfmpeg } = require('./paths');

const CLIENT_ID = `MusicManager/${pkg.version}`;
const MAX_URL_CHARS = 2048;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 40 * 1000 * 1000; // decoded size ffmpeg will accept
const FETCH_TIMEOUT_MS = 8000;
const DECODE_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const SIDE = 32; // the image is reduced to SIDE x SIDE pixels
const MAX_RUNNING = 2;
const MAX_WAITING = 30;
const FOUND_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const FAILED_TTL_MS = 10 * 60 * 1000;
const MAX_FAILED = 500;
const MAX_CACHE_ROWS = 20000;
const PRUNE_EVERY = 50;

class ArtworkError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'ArtworkError';
        this.code = code; // BAD_URL | BLOCKED | UNREACHABLE | UNSUPPORTED | BUSY
    }
}

// --- Which addresses may be contacted -----------------------------------------

const blocked = new net.BlockList();
for (const [prefix, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blocked.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) blocked.addSubnet(prefix, bits, 'ipv6');
// IPv4 written as IPv6 (::ffff:127.0.0.1) is never a cover host. Kept apart:
// in the list above this rule would also match every plain IPv4 address.
const mapped = new net.BlockList();
mapped.addSubnet('::ffff:0:0', 96, 'ipv6');

/** Whether an IP address is an ordinary public one. */
function isPublicAddress(address) {
    const family = net.isIP(address);
    if (family === 4) return !blocked.check(address, 'ipv4');
    if (family === 6) return !mapped.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
    return false;
}

// Wrapped so tests can stand in for DNS, the network and ffmpeg.
const runner = {
    dnsLookup: (hostname, options, callback) => dns.lookup(hostname, options, callback),
    download: (url) => downloadWith(url, guardedLookup),
    decode: (image, format) => decodeWithFfmpeg(image, format)
};

/**
 * dns.lookup for the socket, refusing a host with any non-public address.
 * The socket connects to what this returns, so the check and the connection
 * cannot disagree.
 */
function guardedLookup(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options || {});
    runner.dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
        if (err) return done(err);
        const list = Array.isArray(addresses) ? addresses : [];
        if (!list.length || !list.every((entry) => isPublicAddress(entry.address))) {
            return done(new ArtworkError('BLOCKED', 'That host is not on the public internet.'));
        }
        return opts.all ? done(null, list) : done(null, list[0].address, list[0].family);
    });
}

/** Parses and checks a cover URL; throws ArtworkError('BAD_URL' | 'BLOCKED'). */
function checkUrl(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > MAX_URL_CHARS) throw new ArtworkError('BAD_URL', 'A cover image URL is required.');
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new ArtworkError('BAD_URL', 'That is not a URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname) {
        throw new ArtworkError('BAD_URL', 'Only plain https image URLs are accepted.');
    }
    // An address written out is never looked up, so it is checked here.
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal) && !isPublicAddress(literal)) {
        throw new ArtworkError('BLOCKED', 'That host is not on the public internet.');
    }
    url.hash = '';
    return url;
}

// --- Download -------------------------------------------------------------------

/** One GET, no redirects followed: { status, location, body }. */
function downloadWith(url, lookup) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        const req = https.get(url, {
            lookup,
            agent: false,
            headers: { 'User-Agent': CLIENT_ID, Accept: 'image/jpeg,image/png,image/webp' }
        }, (res) => {
            const status = res.statusCode;
            if (status !== 200) {
                res.resume();
                req.destroy();
                return finish(resolve, { status, location: res.headers.location || null, body: null });
            }
            if (Number(res.headers['content-length']) > MAX_IMAGE_BYTES) {
                req.destroy();
                return finish(reject, new ArtworkError('UNSUPPORTED', 'The image is too large.'));
            }
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_IMAGE_BYTES) {
                    req.destroy();
                    return finish(reject, new ArtworkError('UNSUPPORTED', 'The image is too large.'));
                }
                return chunks.push(chunk);
            });
            res.on('end', () => finish(resolve, { status, location: null, body: Buffer.concat(chunks) }));
            res.on('error', (err) => finish(reject, err));
            return undefined;
        });
        req.on('error', (err) => finish(reject, err));
        timer = setTimeout(() => {
            req.destroy();
            finish(reject, new ArtworkError('UNREACHABLE', 'The image took too long to download.'));
        }, FETCH_TIMEOUT_MS);
    });
}

/** Downloads the image, following checked redirects. Resolves to its bytes. */
async function fetchImage(startUrl) {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let res;
        try {
            res = await runner.download(url);
        } catch (err) {
            if (err instanceof ArtworkError) throw err;
            throw new ArtworkError('UNREACHABLE', 'The image could not be downloaded.', { cause: err });
        }
        if (res.status === 200 && res.body) return res.body;
        if (res.status >= 300 && res.status < 400 && res.location) {
            let next;
            try {
                next = new URL(res.location, url).href;
            } catch {
                throw new ArtworkError('UNREACHABLE', 'The image server sent a broken redirect.');
            }
            url = checkUrl(next);
            continue;
        }
        throw new ArtworkError('UNREACHABLE', `The image server answered ${res.status}.`);
    }
    throw new ArtworkError('UNREACHABLE', 'The image server redirected too many times.');
}

// --- Decode ---------------------------------------------------------------------

/** The ffmpeg reader for these bytes, or null when they are not an image we take. */
function imageFormat(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg_pipe';
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png_pipe';
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp_pipe';
    return null;
}

/** SIDE x SIDE RGB pixels of an image, through ffmpeg (stdin to stdout). */
function decodeWithFfmpeg(image, format) {
    return new Promise((resolve, reject) => {
        const child = spawn(resolveFfmpeg(), [
            '-v', 'error', '-nostdin', '-protocol_whitelist', 'pipe', '-max_pixels', String(MAX_PIXELS),
            '-f', format, '-i', 'pipe:0', '-frames:v', '1',
            '-vf', `scale=${SIDE}:${SIDE}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
        ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        const chunks = [];
        let size = 0;
        const timer = setTimeout(() => child.kill('SIGKILL'), DECODE_TIMEOUT_MS);
        child.stdout.on('data', (chunk) => {
            size += chunk.length;
            if (size > SIDE * SIDE * 3) child.kill('SIGKILL');
            else chunks.push(chunk);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(new ArtworkError('UNSUPPORTED', 'ffmpeg could not be started.', { cause: err }));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            const pixels = Buffer.concat(chunks);
            if (code !== 0 || pixels.length !== SIDE * SIDE * 3) {
                return reject(new ArtworkError('UNSUPPORTED', 'The image could not be read.'));
            }
            return resolve(pixels);
        });
        // ffmpeg may stop reading early (a broken image): not an error of ours.
        child.stdin.on('error', () => {});
        child.stdin.end(image);
    });
}

// At most MAX_RUNNING downloads/decodes at once; the rest wait in line.
let running = 0;
const waiting = [];

async function limited(task) {
    if (running >= MAX_RUNNING) {
        if (waiting.length >= MAX_WAITING) throw new ArtworkError('BUSY', 'Too many covers are being read.');
        await new Promise((resolve) => waiting.push(resolve));
    }
    running++;
    try {
        return await task();
    } finally {
        running--;
        const next = waiting.shift();
        if (next) next();
    }
}

// --- Colour ---------------------------------------------------------------------

function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    return [(h * 60 + 360) % 360, Math.min(1, s), l];
}

function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v + m)) * 255));
}

const toHex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// WCAG relative luminance and contrast ratio.
function luminance([r, g, b]) {
    const lin = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const HUE_BINS = 24;
const MIN_CHROMA = 0.12;
const MIN_COLOURED_SHARE = 0.04;

/**
 * The dominant colour of RGB pixels as [r, g, b], or null for an image with
 * no colour to speak of (black and white, or nearly). Pixels vote for their
 * hue with their vividness, so a small bright logo does not beat a large
 * coloured area, and greys, near-black and near-white do not vote at all.
 */
function dominantColor(pixels) {
    const bins = Array.from({ length: HUE_BINS }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
    const total = Math.floor(pixels.length / 3);
    let coloured = 0;
    for (let i = 0; i + 2 < pixels.length; i += 3) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        const [h, , l] = rgbToHsl(r, g, b);
        if (chroma < MIN_CHROMA || l < 0.08 || l > 0.95) continue;
        coloured++;
        const bin = bins[Math.floor((h / 360) * HUE_BINS) % HUE_BINS];
        bin.weight += chroma;
        bin.r += r * chroma;
        bin.g += g * chroma;
        bin.b += b * chroma;
    }
    if (!total || coloured / total < MIN_COLOURED_SHARE) return null;
    // A hue that straddles two bins should not lose to a narrower one.
    const score = (i) => bins[i].weight + 0.5 * (bins[(i + 1) % HUE_BINS].weight + bins[(i + HUE_BINS - 1) % HUE_BINS].weight);
    let best = 0;
    for (let i = 1; i < HUE_BINS; i++) if (score(i) > score(best)) best = i;
    const bin = bins[best];
    return [bin.r, bin.g, bin.b].map((sum) => Math.round(sum / bin.weight));
}

const WHITE = [255, 255, 255];
const SECONDARY_TEXT = [179, 179, 179]; // #b3b3b3, the player's grey text
const DARK_BASE = [24, 24, 24]; // #181818, the player bar without a theme

/**
 * The three theme colours for a dominant colour, each moved along lightness
 * until the text on it is readable (WCAG AA for the grey text, AAA for white).
 */
function themeFrom(rgb) {
    const [h, s] = rgbToHsl(...rgb);
    const shade = (sat, start, step, ok) => {
        let l = start;
        let out = hslToRgb(h, sat, l);
        while (!ok(out) && l > 0.02 && l < 0.98) {
            l += step;
            out = hslToRgb(h, sat, l);
        }
        return out;
    };
    const readableOn = (bg) => contrast(WHITE, bg) >= 7 && contrast(SECONDARY_TEXT, bg) >= 4.5;
    const background = shade(Math.min(s, 0.6), 0.3, -0.01, readableOn);
    const surface = shade(Math.min(s, 0.45), 0.13, -0.01, readableOn);
    const accent = shade(Math.min(Math.max(s, 0.55), 0.85), 0.55, 0.01,
        (c) => contrast(c, DARK_BASE) >= 4.5 && contrast(c, surface) >= 4.5 && contrast(c, background) >= 3);
    return { color: toHex(rgb), background: toHex(background), surface: toHex(surface), accent: toHex(accent) };
}

// --- Cache and entry point ------------------------------------------------------

const NONE = Object.freeze({ status: 'none' });
const failed = new Map(); // url hash -> time of the failure (memory only)
const inFlight = new Map(); // url hash -> Promise<answer>
let writes = 0;

async function readCache(db, key) {
    const row = await db.get('SELECT status, color, fetched_at FROM artwork_colors WHERE url_hash = ?', [key]);
    if (!row || Date.now() - row.fetched_at > FOUND_TTL_MS) return null;
    if (row.status === 'ok' && /^#[0-9a-f]{6}$/.test(row.color || '')) return { status: 'ok', ...themeFrom(fromHex(row.color)) };
    return row.status === 'none' ? NONE : null;
}

async function writeCache(db, key, color) {
    const now = Date.now();
    await db.run(
        `INSERT INTO artwork_colors (url_hash, status, color, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(url_hash) DO UPDATE SET status = excluded.status, color = excluded.color, fetched_at = excluded.fetched_at`,
        [key, color ? 'ok' : 'none', color, now]
    );
    if (++writes % PRUNE_EVERY !== 0) return;
    await db.run('DELETE FROM artwork_colors WHERE fetched_at < ?', [now - FOUND_TTL_MS]);
    await db.run(
        `DELETE FROM artwork_colors WHERE url_hash IN (
            SELECT url_hash FROM artwork_colors ORDER BY fetched_at DESC LIMIT -1 OFFSET ?)`,
        [MAX_CACHE_ROWS]
    );
}

function rememberFailure(key) {
    if (failed.size >= MAX_FAILED) failed.delete(failed.keys().next().value);
    failed.set(key, Date.now());
}

async function work(db, key, url) {
    let rgb;
    try {
        rgb = await limited(async () => {
            const image = await fetchImage(url);
            const format = imageFormat(image);
            if (!format) throw new ArtworkError('UNSUPPORTED', 'Not a JPEG, PNG or WebP image.');
            return dominantColor(await runner.decode(image, format));
        });
    } catch (err) {
        if (!(err instanceof ArtworkError)) throw err;
        // Remembered for a while in memory, so a broken cover is not retried
        // on every play; "busy" is our own state, not the cover's.
        if (err.code !== 'BUSY') rememberFailure(key);
        console.warn(`Cover colours: ${err.message} (${url.hostname})`);
        return NONE;
    }
    // An image without colour is a fact about the image: cached like a result.
    await writeCache(db, key, rgb ? toHex(rgb) : null);
    return rgb ? { status: 'ok', ...themeFrom(rgb) } : NONE;
}

/**
 * Theme colours for the cover at `rawUrl`. Throws ArtworkError('BAD_URL') for
 * something that is not an https image URL; every other problem (blocked
 * host, download or decode failure, colourless image) is { status: 'none' }.
 */
async function getColors(db, rawUrl) {
    let url;
    try {
        url = checkUrl(rawUrl);
    } catch (err) {
        if (err instanceof ArtworkError && err.code === 'BLOCKED') return NONE;
        throw err;
    }
    const key = crypto.createHash('sha256').update(url.href).digest('hex');
    const failedAt = failed.get(key);
    if (failedAt && Date.now() - failedAt < FAILED_TTL_MS) return NONE;
    const cached = await readCache(db, key);
    if (cached) return cached;
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = work(db, key, url).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
}

// Tests only.
function _resetForTests() {
    failed.clear();
    inFlight.clear();
    waiting.length = 0;
    running = 0;
    writes = 0;
}

module.exports = {
    ArtworkError,
    runner,
    getColors,
    checkUrl,
    isPublicAddress,
    guardedLookup,
    downloadWith,
    imageFormat,
    decodeWithFfmpeg,
    dominantColor,
    themeFrom,
    contrast,
    SIDE,
    _resetForTests
};
