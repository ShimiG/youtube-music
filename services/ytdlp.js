// Shared yt-dlp binary location and its self-update.
//
// yt-dlp breaks whenever YouTube or SoundCloud change their sites, and the fix
// is nearly always "run the latest release", so the server refreshes the
// binary in the background, once a day, shortly after it starts. Startup never
// waits on it: the update only logs its outcome. Disable with
// YTDLP_AUTO_UPDATE=false (tests and CI, or offline machines).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { resolveYtDlp, dataDir } = require('./paths');

// See services/paths.js: bin/ in the project during development; the data
// folder when packaged (so `-U` can rewrite it); else a system install.
const ytDlpPath = resolveYtDlp();

const UPDATE_TIMEOUT_MS = 2 * 60 * 1000;

function autoUpdateEnabled() {
    const raw = String(process.env.YTDLP_AUTO_UPDATE ?? 'true').toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
}

// Wrapped so tests can stub the process call.
const runner = {
    exec: (args, options = {}) => new Promise((resolve, reject) => {
        execFile(ytDlpPath, args, { timeout: UPDATE_TIMEOUT_MS, windowsHide: true, ...options }, (error, stdout, stderr) => {
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
    if (!fs.existsSync(ytDlpPath)) {
        const message = `yt-dlp binary not found at ${ytDlpPath}; skipping update`;
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

/** updateYtDlp(), unless it already ran in the last day. A failed run is tried again next time. */
async function updateYtDlpIfDue({ log = console, stampFile = defaultStampFile() } = {}) {
    if (!updateDue(stampFile)) return { skipped: true, message: 'yt-dlp was checked for updates less than a day ago' };
    const result = await updateYtDlp({ log });
    if (!result.skipped && !result.failed) {
        try {
            fs.writeFileSync(stampFile, `${new Date().toISOString()}\n`);
        } catch { /* looked again next start: harmless */ }
    }
    return result;
}

module.exports = { ytDlpPath, runner, autoUpdateEnabled, summarizeUpdateOutput, updateYtDlp, updateYtDlpIfDue, updateDue, CHECK_EVERY_MS };
