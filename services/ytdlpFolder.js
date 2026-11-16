// A yt-dlp that starts quickly (docs/performance-plan.md, step 1.5).
//
// The yt-dlp the installers carry is the single-file build. It unpacks itself
// into a new temporary folder every time it is run, and on macOS the system
// scans what it unpacked each time: measured on the owner's Mac, 7.8 seconds
// before it does anything. Every track that is not in the cache waits for
// that. yt-dlp also publishes a folder build of each release, which is
// unpacked once and then simply starts.
//
// The folder build cannot be shipped as the one file the installer expects,
// and it cannot update itself (`yt-dlp -U` refuses), so the app looks after
// it here: it is downloaded from yt-dlp's releases into the data folder,
// checked against the release's published checksums, unpacked, and then
// *tried*. It is only used if it runs and starts faster than the yt-dlp in
// use; otherwise nothing changes. A new release is picked up the same way.
//
// Never done when YTDLP_PATH names a yt-dlp (that is the user's choice), nor
// when YTDLP_AUTO_UPDATE is off (offline machines, tests, CI).
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');
const { dataDir } = require('./paths');
const { extractZip } = require('./unzip');

const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const CHECKSUMS = 'SHA2-256SUMS';
// Where a download may be redirected to: GitHub's own hosts and no other.
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const MAX_REDIRECTS = 5;
const MAX_ZIP_BYTES = 300 * 1024 * 1024;
const MAX_SUMS_BYTES = 64 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const VERSION_TIMEOUT_MS = 90 * 1000;
// A yt-dlp that starts within this is left alone: nothing worth fetching for.
const SLOW_START_MS = 1500;
// Once it is settled that the yt-dlp in use is the one to keep (it starts
// quickly, or the folder build was not faster), not looked at again for this long.
const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// The archive of each platform's folder build and the program inside it
// (checked against yt-dlp's releases, Nov 2026). Other platforms: not offered.
const ASSETS = {
    'darwin-arm64': { zip: 'yt-dlp_macos.zip', exe: 'yt-dlp_macos' },
    'darwin-x64': { zip: 'yt-dlp_macos.zip', exe: 'yt-dlp_macos' },
    'win32-x64': { zip: 'yt-dlp_win.zip', exe: 'yt-dlp.exe' },
    'linux-x64': { zip: 'yt-dlp_linux.zip', exe: 'yt-dlp_linux' }
};

// --- What tests replace: the network, running a program, the platform ------------

function httpsGet(url, redirectsLeft = MAX_REDIRECTS) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
            return reject(new Error(`refusing to download from ${target.hostname}`));
        }
        const req = https.get(target, { headers: { 'User-Agent': 'MusicManager', Accept: '*/*' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
                return resolve(httpsGet(new URL(res.headers.location, target).href, redirectsLeft - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`the download answered ${res.statusCode}`));
            }
            return resolve(res);
        });
        req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('the download timed out')));
        req.on('error', reject);
        return undefined;
    });
}

const runner = {
    /** A readable stream of the file at `url`. Never the real network from a test run. */
    get: (url) => (process.env.NODE_ENV === 'test' ? Promise.reject(new Error('no downloads from a test run')) : httpsGet(url)),
    /** Runs `<exe> --version`: { version, ms } or null when it does not run. */
    version: (exe) => new Promise((resolve) => {
        const startedAt = Date.now();
        execFile(exe, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
            const version = err ? '' : String(stdout).trim().split('\n')[0].trim();
            resolve(/^\d{4}\.\d{2}\.\d{2}/.test(version) ? { version, ms: Date.now() - startedAt } : null);
        });
    }),
    asset: () => ASSETS[`${process.platform}-${process.arch}`] || null
};

// --- Where it lives ----------------------------------------------------------------

const root = () => path.join(dataDir(), 'bin', 'yt-dlp-folder');
const stateFile = () => path.join(root(), 'current.json');

function readState() {
    try {
        const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
        return state && typeof state === 'object' ? state : {};
    } catch {
        return {};
    }
}

function writeState(state) {
    fs.mkdirSync(root(), { recursive: true });
    const tmp = `${stateFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile());
}

const autoUpdateEnabled = () => !['0', 'false', 'no', 'off'].includes(String(process.env.YTDLP_AUTO_UPDATE ?? 'true').toLowerCase());

/** Why the folder build is not looked after here, or null when it is. */
function notManaged() {
    if (process.env.YTDLP_PATH) return 'YTDLP_PATH names the yt-dlp to use';
    if (!autoUpdateEnabled()) return 'yt-dlp updates are switched off (YTDLP_AUTO_UPDATE)';
    if (!runner.asset()) return `yt-dlp publishes no folder build for ${process.platform}-${process.arch}`;
    return null;
}

/** The folder build in use: the path of its program, or null. */
function currentExe() {
    if (notManaged()) return null;
    const state = readState();
    if (!state.dir || !state.exe || !/^v-[0-9a-f]{12}$/.test(state.dir)) return null;
    const exe = path.join(root(), state.dir, state.exe);
    return fs.existsSync(exe) ? exe : null;
}

// --- Fetching ----------------------------------------------------------------------

async function readText(url, maxBytes) {
    const res = await runner.get(url);
    const chunks = [];
    let size = 0;
    for await (const chunk of res) {
        size += chunk.length;
        if (size > maxBytes) throw new Error('the checksum list is too large');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** The published SHA-256 of `name` in the latest release. */
async function publishedChecksum(name) {
    const text = await readText(RELEASE_BASE + CHECKSUMS, MAX_SUMS_BYTES);
    for (const line of text.split('\n')) {
        const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
        if (m && m[2] === name) return m[1].toLowerCase();
    }
    throw new Error(`the release lists no checksum for ${name}`);
}

/** Downloads `url` to `file`; resolves to its SHA-256. */
async function download(url, file) {
    const res = await runner.get(url);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let size = 0;
    try {
        for await (const chunk of res) {
            size += chunk.length;
            if (size > MAX_ZIP_BYTES) throw new Error('the download is larger than a yt-dlp build can be');
            hash.update(chunk);
            if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
        }
    } finally {
        await new Promise((resolve) => out.end(resolve));
    }
    return hash.digest('hex');
}

const removeQuietly = (target) => {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch { /* in use (Windows): tried again the next time */ }
};

// How long a yt-dlp takes to start once the system has seen it: the better
// of two runs (the first can include a one-off scan of new files).
async function startTime(exe) {
    const first = await runner.version(exe);
    if (!first) return null;
    const second = await runner.version(exe);
    return second && second.ms < first.ms ? second : first;
}

/**
 * Brings the folder build up to date, or installs it when the yt-dlp in use
 * (`currentPath`, may not exist) is slow to start. Resolves to what happened:
 *   { status: 'skipped' | 'kept' | 'current' | 'installed' | 'declined' | 'failed', message, ... }
 * Never throws, and never leaves the app without the yt-dlp it had.
 */
async function ensure({ currentPath, log = console } = {}) {
    const reason = notManaged();
    if (reason) return { status: 'skipped', message: reason };
    const asset = runner.asset();
    const state = readState();
    const inUse = currentExe();

    try {
        if (!inUse) {
            // Not installed. Worth it only when what is there is slow or missing.
            // Decided not long ago (it was tried and was not faster, or the
            // yt-dlp in use starts quickly): not measured again at every start.
            const decidedAt = Math.max(state.declinedAt || 0, state.keptAt || 0);
            if (decidedAt && Date.now() - decidedAt < RETRY_AFTER_MS) {
                return { status: 'kept', message: 'the yt-dlp in use was found good enough recently' };
            }
            const present = currentPath ? await startTime(currentPath) : null;
            if (present && present.ms <= SLOW_START_MS) {
                writeState({ ...state, keptAt: Date.now() });
                return { status: 'kept', message: `yt-dlp starts in ${present.ms} ms; nothing to gain`, startMs: present.ms };
            }
            return await install({ asset, state, wanted: await publishedChecksum(asset.zip), compareWith: present, log });
        }
        const wanted = await publishedChecksum(asset.zip);
        if (state.sha256 === wanted) return { status: 'current', message: `yt-dlp ${state.version} (folder build) is the latest` };
        return await install({ asset, state, wanted, compareWith: null, log });
    } catch (err) {
        const message = `yt-dlp folder build: ${err.message}. Continuing with the yt-dlp in use.`;
        log.warn(message);
        return { status: 'failed', message };
    }
}

async function install({ asset, state, wanted, compareWith, log }) {
    fs.mkdirSync(root(), { recursive: true });
    const zipFile = path.join(root(), 'download.part');
    const dirName = `v-${wanted.slice(0, 12)}`;
    const finalDir = path.join(root(), dirName);
    const tmpDir = `${finalDir}.tmp`;
    removeQuietly(tmpDir);
    try {
        const got = await download(RELEASE_BASE + asset.zip, zipFile);
        if (got !== wanted) throw new Error(`the download does not match the published checksum (${got.slice(0, 12)}… instead of ${wanted.slice(0, 12)}…)`);
        await extractZip(zipFile, tmpDir);
        removeQuietly(finalDir);
        fs.renameSync(tmpDir, finalDir);
    } finally {
        removeQuietly(zipFile);
        removeQuietly(tmpDir);
    }
    const exe = path.join(finalDir, asset.exe);
    if (!fs.existsSync(exe)) {
        removeQuietly(finalDir);
        throw new Error(`the archive has no ${asset.exe} in it`);
    }
    try { fs.chmodSync(exe, 0o755); } catch { /* Windows */ }

    // Tried before it is trusted with playback.
    const fresh = await startTime(exe);
    if (!fresh) {
        removeQuietly(finalDir);
        throw new Error('the folder build does not run on this computer');
    }
    if (compareWith && fresh.ms >= compareWith.ms) {
        removeQuietly(finalDir);
        writeState({ ...state, declinedAt: Date.now() });
        const message = `the folder build starts in ${fresh.ms} ms, the yt-dlp in use in ${compareWith.ms} ms: keeping what is there`;
        log.log(`yt-dlp: ${message}.`);
        return { status: 'declined', message, startMs: fresh.ms };
    }

    const previous = state.dir;
    writeState({ dir: dirName, exe: asset.exe, sha256: wanted, version: fresh.version, startMs: fresh.ms, installedAt: Date.now() });
    // Older copies go; one that is still running a look-up goes the next time.
    for (const name of fs.readdirSync(root())) {
        if (/^v-[0-9a-f]{12}(\.tmp)?$/.test(name) && name !== dirName) removeQuietly(path.join(root(), name));
    }
    const was = compareWith ? ` instead of ${compareWith.ms} ms` : '';
    const message = previous && previous !== dirName
        ? `updated to ${fresh.version} (folder build), starts in ${fresh.ms} ms`
        : `now using the folder build ${fresh.version}: starts in ${fresh.ms} ms${was}`;
    log.log(`yt-dlp: ${message}.`);
    return { status: 'installed', message, version: fresh.version, startMs: fresh.ms, exe };
}

module.exports = { ensure, currentExe, notManaged, runner, root, SLOW_START_MS, RETRY_AFTER_MS, ASSETS, _internals: { httpsGet, readState, writeState } };
