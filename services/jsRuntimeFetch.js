// A JavaScript runtime for yt-dlp, where the computer has none.
//
// YouTube hides its audio behind a script, and yt-dlp runs that script in a
// runtime it finds on the computer (services/ytdlp.js, jsRuntime). In
// development that is the Node the server runs on. The installed app is not
// a Node that can run a script; it uses a deno or Node that happens to be
// installed, and most computers have neither. Without one, yt-dlp works with
// a single limited YouTube client ("deprecated, some formats may be
// missing"), which is how playback stopped working once already.
//
// So where there is none, the app fetches deno (the runtime yt-dlp
// recommends: it runs the script with no access to files, network or
// programs) from deno's own releases on GitHub into the data folder. Like
// the yt-dlp folder build (services/ytdlpFolder.js): checked against the
// checksum the release publishes, unpacked by the app's own code, and tried
// before it is used. Looked at again once a week for a newer release.
//
// Never when YTDLP_JS_RUNTIME says which runtime to use (or "off"), nor when
// YTDLP_AUTO_UPDATE is off (offline machines, tests, CI).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { dataDir } = require('./paths');
const { extractZip } = require('./unzip');
const folder = require('./ytdlpFolder');

const RELEASE_BASE = 'https://github.com/denoland/deno/releases/latest/download/';
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_SUM_BYTES = 4 * 1024;
const VERSION_TIMEOUT_MS = 60 * 1000;
const CHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

// deno's archive for each platform (its releases, Nov 2026); each holds the
// one program.
const ASSETS = {
    'darwin-arm64': { zip: 'deno-aarch64-apple-darwin.zip', exe: 'deno' },
    'darwin-x64': { zip: 'deno-x86_64-apple-darwin.zip', exe: 'deno' },
    'win32-x64': { zip: 'deno-x86_64-pc-windows-msvc.zip', exe: 'deno.exe' },
    'linux-x64': { zip: 'deno-x86_64-unknown-linux-gnu.zip', exe: 'deno' },
    'linux-arm64': { zip: 'deno-aarch64-unknown-linux-gnu.zip', exe: 'deno' }
};

// What tests replace: the network, running a program, the platform.
const runner = {
    /** A readable stream of the file at `url` (GitHub's hosts only). Never the real network from a test run. */
    get: (url) => (process.env.NODE_ENV === 'test' ? Promise.reject(new Error('no downloads from a test run')) : folder._internals.httpsGet(url)),
    /** Runs `<exe> --version`: its version ("2.5.6"), or null when it does not run. */
    version: (exe) => new Promise((resolve) => {
        execFile(exe, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
            const m = err ? null : /^deno (\d+\.\d+\.\d+)/.exec(String(stdout).trim());
            resolve(m ? m[1] : null);
        });
    }),
    asset: () => ASSETS[`${process.platform}-${process.arch}`] || null
};

const root = () => path.join(dataDir(), 'bin', 'deno');
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

/** Why no runtime is fetched here, or null when one may be. */
function notManaged() {
    const wanted = String(process.env.YTDLP_JS_RUNTIME || 'auto').trim().toLowerCase();
    if (wanted !== 'auto') return 'YTDLP_JS_RUNTIME says which runtime to use';
    if (!autoUpdateEnabled()) return 'downloads are switched off (YTDLP_AUTO_UPDATE)';
    if (!runner.asset()) return `deno publishes no build for ${process.platform}-${process.arch}`;
    return null;
}

/** The fetched deno: the path of its program, or null. */
function currentExe() {
    if (notManaged()) return null;
    const state = readState();
    if (!state.dir || !state.exe || !/^v-[0-9a-f]{12}$/.test(state.dir)) return null;
    const exe = path.join(root(), state.dir, state.exe);
    return fs.existsSync(exe) ? exe : null;
}

async function publishedChecksum(asset) {
    const res = await runner.get(`${RELEASE_BASE}${asset.zip}.sha256sum`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res) {
        size += chunk.length;
        if (size > MAX_SUM_BYTES) throw new Error('the checksum file is too large');
        chunks.push(chunk);
    }
    const m = /^([0-9a-f]{64})\b/i.exec(Buffer.concat(chunks).toString('utf8').trim());
    if (!m) throw new Error(`the release gives no checksum for ${asset.zip}`);
    return m[1].toLowerCase();
}

async function download(url, file) {
    const res = await runner.get(url);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let size = 0;
    try {
        for await (const chunk of res) {
            size += chunk.length;
            if (size > MAX_ZIP_BYTES) throw new Error('the download is larger than deno can be');
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

/**
 * Makes sure a deno is there and current. Resolves to
 * { status: 'skipped' | 'current' | 'installed' | 'failed', message, exe?, version? }.
 * Never throws: a computer that cannot fetch one carries on as it was.
 */
async function ensure({ log = console } = {}) {
    const reason = notManaged();
    if (reason) return { status: 'skipped', message: reason };
    const asset = runner.asset();
    const state = readState();
    const inUse = currentExe();
    if (inUse && state.checkedAt && Date.now() - state.checkedAt < CHECK_EVERY_MS) {
        return { status: 'current', message: `deno ${state.version} was checked less than a week ago`, exe: inUse, version: state.version };
    }
    try {
        const wanted = await publishedChecksum(asset);
        if (inUse && state.sha256 === wanted) {
            writeState({ ...state, checkedAt: Date.now() });
            return { status: 'current', message: `deno ${state.version} is the latest`, exe: inUse, version: state.version };
        }
        fs.mkdirSync(root(), { recursive: true });
        const zipFile = path.join(root(), 'download.part');
        const dirName = `v-${wanted.slice(0, 12)}`;
        const finalDir = path.join(root(), dirName);
        const tmpDir = `${finalDir}.tmp`;
        removeQuietly(tmpDir);
        try {
            const got = await download(RELEASE_BASE + asset.zip, zipFile);
            if (got !== wanted) throw new Error(`the download does not match the published checksum (${got.slice(0, 12)}… instead of ${wanted.slice(0, 12)}…)`);
            await extractZip(zipFile, tmpDir, { maxEntries: 50 });
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
        // Tried before yt-dlp is pointed at it.
        const version = await runner.version(exe);
        if (!version) {
            removeQuietly(finalDir);
            throw new Error('the downloaded deno does not run on this computer');
        }
        writeState({ dir: dirName, exe: asset.exe, sha256: wanted, version, installedAt: Date.now(), checkedAt: Date.now() });
        for (const name of fs.readdirSync(root())) {
            if (/^v-[0-9a-f]{12}(\.tmp)?$/.test(name) && name !== dirName) removeQuietly(path.join(root(), name));
        }
        const message = inUse ? `updated deno to ${version}` : `fetched deno ${version} for YouTube (this computer had no JavaScript runtime)`;
        log.log(`yt-dlp: ${message}.`);
        return { status: 'installed', message, exe, version };
    } catch (err) {
        const message = `JavaScript runtime for yt-dlp: ${err.message}.${inUse ? ' Continuing with the deno in use.' : ' YouTube tracks may not play until one is installed (brew install deno).'}`;
        log.warn(message);
        return { status: 'failed', message, ...(inUse ? { exe: inUse } : {}) };
    }
}

module.exports = { ensure, currentExe, notManaged, runner, root, ASSETS, CHECK_EVERY_MS };
