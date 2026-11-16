// Talks to the cloud service (the Cloudflare Worker in cloud/).
//
// The address is this installation's own Worker, set by the installation's
// owner (or built in through CLOUD_URL). Three rules keep it from being used
// to make this server call somewhere it should not (security review
// 2026-11-16, cloud-url-no-ssrf-guard):
//   - only https, and only a bare address: requests go to fixed paths under
//     it and nowhere else;
//   - only the public internet: an address on this computer or a private
//     network is refused, both as written and, for a name, by checking the
//     address the socket actually connects to (services/netGuard.js);
//   - redirects are not followed, so the session token is never sent to
//     another host.
// For a Worker running on this computer (`wrangler dev`), CLOUD_ALLOW_LOCAL=1
// lifts the second rule and allows http://localhost. It is off unless set.
const crypto = require('crypto');
const dns = require('dns');
const httpCore = require('http');
const https = require('https');
const pkg = require('../../package.json');
const netGuard = require('../netGuard');

const TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const CLIENT_ID = `MusicManager/${pkg.version}`;

/** Whether addresses on this computer or a private network are accepted (development). */
const allowLocal = () => ['1', 'true', 'yes', 'on'].includes(String(process.env.CLOUD_ALLOW_LOCAL || '').toLowerCase());

const PRIVATE_ADDRESS = 'That address is on this computer or a private network. The cloud service has to be on the internet.';

// Wrapped so tests can stand in for the network and for DNS.
const http = {
    fetch: (url, options) => send(url, options),
    dnsLookup: (hostname, options, callback) => dns.lookup(hostname, options, callback)
};

const publicLookup = netGuard.guardedLookup({
    lookup: (hostname, options, callback) => http.dnsLookup(hostname, options, callback),
    blockedError: () => new Error('the host is not on the public internet')
});

/**
 * One HTTP request, as little of `fetch` as request() needs:
 * { ok, status, body } with `body` readable chunk by chunk. Node's own fetch
 * cannot be told which address to connect to; this can, which is what lets
 * the address be checked on the socket. Redirects are not followed, and the
 * whole exchange (answer included) has TIMEOUT_MS.
 */
function send(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const lib = url.protocol === 'https:' ? https : httpCore;
        const req = lib.request(url, {
            method,
            headers: { ...headers, ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
            ...(allowLocal() ? {} : { lookup: publicLookup })
        });
        const timer = setTimeout(() => req.destroy(new Error('timed out')), TIMEOUT_MS);
        req.on('error', (err) => { clearTimeout(timer); reject(err); });
        req.on('response', (res) => {
            res.on('close', () => clearTimeout(timer));
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: res });
        });
        req.end(body);
    });
}

class CloudError extends Error {
    constructor(code, message, status = 0, options) {
        super(message, options);
        this.name = 'CloudError';
        this.code = code; // the cloud's own code, or BAD_URL | UNREACHABLE | BAD_RESPONSE
        this.status = status;
    }
}

/** The cloud address as "scheme://host[:port]", or throws CloudError('BAD_URL'). */
function normalizeUrl(raw) {
    const bad = (why) => new CloudError('BAD_URL', why, 400);
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 300) throw bad('Enter the address of your cloud service.');
    let url;
    try {
        url = new URL(raw.trim());
    } catch {
        throw bad('That is not an address. It looks like https://music-manager-cloud.example.workers.dev');
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && allowLocal())) {
        throw bad('The address must start with https://');
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
        throw bad('Enter only the address itself, without a path or anything after it.');
    }
    if (!allowLocal() && netGuard.namesPrivateHost(url)) throw bad(PRIVATE_ADDRESS);
    return url.origin;
}

async function readBody(res) {
    const chunks = [];
    let size = 0;
    if (res.body) {
        for await (const chunk of res.body) {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) throw new CloudError('BAD_RESPONSE', 'The cloud service sent too much data.');
            chunks.push(chunk);
        }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        throw new CloudError('BAD_RESPONSE', 'The cloud service sent an answer that could not be read. Is the address right?');
    }
}

/** One call to the cloud. Resolves to the parsed answer; throws CloudError. */
async function request(baseUrl, path, { method = 'GET', token, body } = {}) {
    const url = new URL(path, baseUrl);
    // Whatever the address came from (typed in, saved by an older version,
    // CLOUD_URL): nothing is sent to this computer or a private network.
    if (!allowLocal() && netGuard.namesPrivateHost(url)) throw new CloudError('BAD_URL', PRIVATE_ADDRESS, 400);
    const unreachable = (err) => new CloudError('UNREACHABLE', 'The cloud service could not be reached.', 0, { cause: err });
    let res;
    try {
        res = await http.fetch(url, {
            method,
            headers: {
                'User-Agent': CLIENT_ID,
                Accept: 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
            },
            body: body !== undefined ? JSON.stringify(body) : undefined
        });
    } catch (err) {
        throw unreachable(err);
    }
    let data;
    try {
        data = await readBody(res);
    } catch (err) {
        if (err instanceof CloudError) throw err;
        throw unreachable(err); // cut off, or out of time, part-way through the answer
    }
    if (!res.ok) {
        const code = data && typeof data.code === 'string' ? data.code : 'BAD_RESPONSE';
        const message = data && typeof data.error === 'string' ? data.error : `The cloud service answered ${res.status}.`;
        throw new CloudError(code, message, res.status);
    }
    return data;
}

/**
 * The key sent to the cloud instead of the password (cloud/README.md): the
 * cloud's free plan cannot afford to stretch a password, so it is done here.
 * The same name and password give the same key on every computer.
 */
function deriveAuthKey(username, password) {
    const salt = `music-manager-cloud:v1:${String(username).trim().toLowerCase()}`;
    return new Promise((resolve, reject) => {
        crypto.scrypt(String(password), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => {
            if (err) reject(err);
            else resolve(key.toString('hex'));
        });
    });
}

module.exports = { http, CloudError, normalizeUrl, request, deriveAuthKey, allowLocal, TIMEOUT_MS, MAX_RESPONSE_BYTES };
