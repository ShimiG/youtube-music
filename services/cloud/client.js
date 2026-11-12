// Talks to the cloud service (the Cloudflare Worker in cloud/).
//
// The address is this installation's own Worker, set by the installation's
// owner (or built in through CLOUD_URL). Only https is accepted, except for a
// Worker running on this computer (wrangler dev), and only a bare address:
// requests go to fixed paths under it and nowhere else. Redirects are not
// followed, so the session token is never sent to another host.
const crypto = require('crypto');
const pkg = require('../../package.json');

const TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const CLIENT_ID = `MusicManager/${pkg.version}`;

// Wrapped so tests can stand in for the network.
const http = { fetch: (...args) => fetch(...args) };

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
    const bad = (why) => new CloudError('BAD_URL', why);
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 300) throw bad('Enter the address of your cloud service.');
    let url;
    try {
        url = new URL(raw.trim());
    } catch {
        throw bad('That is not an address. It looks like https://music-manager-cloud.example.workers.dev');
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
        throw bad('The address must start with https://');
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
        throw bad('Enter only the address itself, without a path or anything after it.');
    }
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
    let res;
    try {
        res = await http.fetch(new URL(path, baseUrl), {
            method,
            headers: {
                'User-Agent': CLIENT_ID,
                Accept: 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            redirect: 'error',
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (err) {
        throw new CloudError('UNREACHABLE', 'The cloud service could not be reached.', 0, { cause: err });
    }
    const data = await readBody(res);
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

module.exports = { http, CloudError, normalizeUrl, request, deriveAuthKey };
