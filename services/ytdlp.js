// Shared yt-dlp binary location and its self-update.
//
// yt-dlp breaks whenever YouTube or SoundCloud change their sites, and the fix
// is nearly always "run the latest release", so the server refreshes it in
// the background, once a day, shortly after it starts. Startup never waits on
// it: the update only logs its outcome. Disable with
// YTDLP_AUTO_UPDATE=false (tests and CI, or offline machines).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { resolveYtDlp, dataDir, isPackaged } = require('./paths');
const folder = require('./ytdlpFolder');

// The yt-dlp found at start-up. See services/paths.js: bin/ in the project
// during development; the data folder when packaged (so `-U` can rewrite
// it); else a system install.
const foundAtStart = resolveYtDlp();

// The folder build, when the app has fetched one and it proved faster
// (services/ytdlpFolder.js). It can arrive while the server runs, so the
// yt-dlp to use is asked for each time (ytDlpPath()), not kept in a constant.
let folderBuild = folder.currentExe();

/** The yt-dlp to run, now. */
const ytDlpPath = () => process.env.YTDLP_PATH || folderBuild || foundAtStart;

// --- The JavaScript runtime yt-dlp needs for YouTube -------------------------------
//
// YouTube's player hides the audio addresses behind JavaScript, and yt-dlp
// runs that script in a runtime it finds on the computer. Left alone it only
// looks for deno; with none it falls back to one limited YouTube client
// ("YouTube extraction without a JS runtime has been deprecated, and some
// formats may be missing"), and what that client hands out may not be
// something ffmpeg can fetch. So yt-dlp is told where a runtime is:
//   - YTDLP_JS_RUNTIME=off: nothing is passed (yt-dlp's own default);
//   - YTDLP_JS_RUNTIME=<name[:path]>: that one (deno, node, bun, quickjs);
//   - otherwise: the Node this server runs on. The packaged app is not a
//     Node that can run a script, so there a deno or node installed on the
//     computer is looked for in the usual places.
// yt-dlp runs node with its permission model switched on (no files, no
// network, no processes for the script); deno, where installed, still wins.
const RUNTIME_DIRS = process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin', '/usr/local/bin', path.join(require('os').homedir(), '.deno', 'bin'), '/usr/bin'];
const MIN_NODE_MAJOR = 20;

function findOnComputer(name) {
    const exe = process.platform === 'win32' ? `${name}.exe` : name;
    const dirs = [...String(process.env.PATH || '').split(path.delimiter), ...RUNTIME_DIRS].filter(Boolean);
    for (const dir of dirs) {
        const candidate = path.join(dir, exe);
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch { /* not there */ }
    }
    return null;
}

let runtimeMemo; // undefined: not looked for yet
/** { name, path, from } of the runtime yt-dlp is pointed at, or null. */
function jsRuntime() {
    const wanted = String(process.env.YTDLP_JS_RUNTIME || 'auto').trim();
    if (/^(off|none|no|false|0)$/i.test(wanted)) return null;
    if (wanted.toLowerCase() !== 'auto') {
        const [name, ...rest] = wanted.split(':');
        return { name, path: rest.join(':') || null, from: 'YTDLP_JS_RUNTIME' };
    }
    if (runtimeMemo !== undefined) return runtimeMemo;
    if (!isPackaged() && Number(process.versions.node.split('.')[0]) >= MIN_NODE_MAJOR) {
        runtimeMemo = { name: 'node', path: process.execPath, from: 'this server' };
    } else {
        const deno = findOnComputer('deno');
        const node = deno ? null : findOnComputer('node');
        runtimeMemo = deno ? { name: 'deno', path: deno, from: 'this computer' }
            : node ? { name: 'node', path: node, from: 'this computer' } : null;
    }
    return runtimeMemo;
}

/** The flags that tell yt-dlp which runtime to use (none when there is none). */
function jsRuntimeArgs() {
    const runtime = jsRuntime();
    if (!runtime) return [];
    return ['--js-runtimes', runtime.path ? `${runtime.name}:${runtime.path}` : runtime.name];
}

const UPDATE_TIMEOUT_MS = 2 * 60 * 1000;

function autoUpdateEnabled() {
    const raw = String(process.env.YTDLP_AUTO_UPDATE ?? 'true').toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
}

// Wrapped so tests can stub the process call.
const runner = {
    exec: (args, options = {}) => new Promise((resolve, reject) => {
        execFile(foundAtStart, args, { timeout: UPDATE_TIMEOUT_MS, windowsHide: true, ...options }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout ? stdout.toString() : '';
                error.stderr = stderr ? stderr.toString() : '';
                return reject(error);
            }
            resolve({ stdout: stdout.toString(), stderr: stderr ? stderr.toString() : '' });
        });
    })
};

// Reads the outcome out of `yt-dlp -U` output. Both messages are printed by
// yt-dlp's own updater; anything else is passed through verbatim.
function summarizeUpdateOutput(stdout) {
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    const upToDate = lines.find(l => /is up to date/i.test(l));
    if (upToDate) return { updated: false, message: upToDate };
    const updated = lines.find(l => /^Updated yt-dlp to/i.test(l));
    if (updated) return { updated: true, message: updated };
    return { updated: false, message: lines[lines.length - 1] || 'yt-dlp update finished' };
}

/**
 * Runs `yt-dlp -U`. Resolves with { skipped | updated, message }; never
 * rejects, so a caller can fire-and-forget it at startup.
 */
async function updateYtDlp({ log = console } = {}) {
    if (!autoUpdateEnabled()) {
        return { skipped: true, message: 'yt-dlp auto-update disabled (YTDLP_AUTO_UPDATE=false)' };
    }
    if (!fs.existsSync(foundAtStart)) {
        const message = `yt-dlp binary not found at ${foundAtStart}; skipping update`;
        log.warn(message);
        return { skipped: true, message };
    }

    try {
        const { stdout } = await runner.exec(['-U', '--no-warnings']);
        const result = summarizeUpdateOutput(stdout);
        log.log(`yt-dlp: ${result.message}`);
        return { skipped: false, ...result };
    } catch (err) {
        // A failed update leaves the existing binary in place; playback still works.
        const detail = (err.stderr || err.stdout || err.message || '').trim().split('\n').pop();
        log.warn(`yt-dlp: self-update failed (${detail}). Continuing with the installed version.`);
        return { skipped: false, updated: false, failed: true, message: detail };
    }
}

// The update is looked for once a day, not on every start: it costs a network
// round trip and a process, right when the app has just been opened
// (docs/performance-plan.md, step 3.2). The time of the last successful look
// is the modification time of a small file in the data folder.
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const defaultStampFile = () => path.join(dataDir(), '.ytdlp-update-check');

function updateDue(stampFile = defaultStampFile(), now = Date.now()) {
    try {
        return now - fs.statSync(stampFile).mtimeMs >= CHECK_EVERY_MS;
    } catch {
        return true; // never looked
    }
}

/**
 * The daily look at yt-dlp, unless it already happened in the last day. A
 * failed look is tried again at the next start.
 *
 * First the folder build (services/ytdlpFolder.js): brought up to date when
 * it is in use, fetched when the yt-dlp in use is slow to start or missing.
 * When it is in use afterwards there is nothing else to update. Otherwise
 * the single-file yt-dlp updates itself with `yt-dlp -U`, as before.
 */
async function updateYtDlpIfDue({ log = console, stampFile = defaultStampFile() } = {}) {
    const due = updateDue(stampFile);
    // Whether to fetch the folder build at all is settled at the first start
    // where it could help, not a day later (it then settles in a moment,
    // from what was found last time).
    const undecided = !folderBuild && !folder.notManaged();
    if (!due && !undecided) return { skipped: true, message: 'yt-dlp was checked for updates less than a day ago' };
    const fast = await folder.ensure({ currentPath: foundAtStart, log });
    if (fast.status === 'installed') {
        folderBuild = fast.exe;
        // Settings -> System shows the new one at once.
        require('./health')._resetMemo();
    }
    if (!due) return { skipped: fast.status !== 'installed', updated: fast.status === 'installed', message: fast.message };
    const result = folderBuild && !process.env.YTDLP_PATH
        ? { skipped: false, updated: fast.status === 'installed', failed: fast.status === 'failed', message: fast.message }
        : await updateYtDlp({ log });
    if (!result.skipped && !result.failed) {
        try {
            fs.writeFileSync(stampFile, `${new Date().toISOString()}\n`);
        } catch { /* looked again next start: harmless */ }
    }
    return result;
}

// Tests only.
function _useFolderBuild(exe) { folderBuild = exe || null; }

module.exports = { ytDlpPath, jsRuntime, jsRuntimeArgs, _forgetRuntime: () => { runtimeMemo = undefined; }, runner, autoUpdateEnabled, summarizeUpdateOutput, updateYtDlp, updateYtDlpIfDue, updateDue, CHECK_EVERY_MS, _useFolderBuild };
