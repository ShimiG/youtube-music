// Shared yt-dlp binary location and its self-update.
//
// yt-dlp breaks whenever YouTube or SoundCloud change their sites, and the fix
// is nearly always "run the latest release", so the server refreshes the
// binary in the background every time it starts. Startup never waits on it:
// the update runs after listen() and only logs its outcome. Disable with
// YTDLP_AUTO_UPDATE=false (tests and CI, or offline machines).
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const isWindows = process.platform === 'win32';
const ytDlpPath = path.join(__dirname, '../bin', isWindows ? 'yt-dlp.exe' : 'yt-dlp_macos');

const UPDATE_TIMEOUT_MS = 2 * 60 * 1000;

function autoUpdateEnabled() {
    const raw = String(process.env.YTDLP_AUTO_UPDATE ?? 'true').toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
}

// Wrapped so tests can stub the process call.
const runner = {
    exec: (args, options = {}) => new Promise((resolve, reject) => {
        execFile(ytDlpPath, args, { timeout: UPDATE_TIMEOUT_MS, ...options }, (error, stdout, stderr) => {
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

module.exports = { ytDlpPath, runner, autoUpdateEnabled, summarizeUpdateOutput, updateYtDlp };
