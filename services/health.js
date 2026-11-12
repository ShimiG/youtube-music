// Health report (ROADMAP Stage 3): app version, the yt-dlp and ffmpeg versions
// actually installed, and cache usage. A stale yt-dlp is the most common cause
// of "nothing plays", so this is the first thing to check in a bug report.
//
// Binary versions are probed once and memoised for PROBE_TTL_MS; a missing or
// broken binary reports `null` instead of failing the request. Absolute paths
// are never included in the response.
const fs = require('fs');
const { execFile } = require('child_process');
const { ytDlpPath } = require('./ytdlp');
const { resolveFfmpeg } = require('./paths');

const ffmpegPath = resolveFfmpeg();
const { cacheDir, cacheMaxBytes } = require('../controllers/transcode');
const pkg = require('../package.json');

const logFile = require('./logFile');

const PROBE_TTL_MS = 10 * 60 * 1000;
// "Check again" in Settings asks for a fresh probe; not more often than this.
const FRESH_PROBE_MIN_MS = 5 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;

// Wrapped so tests can stub the process calls.
const runner = {
    version: (bin, args) => new Promise((resolve) => {
        // A bare name ("ffmpeg") is looked up on the PATH by execFile itself.
        const isBareName = bin && !bin.includes('/') && !bin.includes('\\');
        if (!bin || (!isBareName && !fs.existsSync(bin))) return resolve(null);
        execFile(bin, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
            if (err) return resolve(null);
            resolve(String(stdout).split('\n')[0].trim() || null);
        });
    })
};

let memo = null; // { at, binaries }

function parseFfmpegVersion(line) {
    if (!line) return null;
    const m = line.match(/ffmpeg version (\S+)/i);
    return m ? m[1] : line;
}

async function probeBinaries(fresh = false) {
    const maxAge = fresh ? FRESH_PROBE_MIN_MS : PROBE_TTL_MS;
    if (memo && Date.now() - memo.at < maxAge) return memo.binaries;
    // yt-dlp's own start time is part of every wait before a streamed track
    // plays (the one-file builds unpack themselves on each start), so it is
    // reported: Settings -> System shows it.
    const ytDlpStartedAt = Date.now();
    let ytDlpStartMs = null;
    const [ytDlp, ffmpegLine] = await Promise.all([
        runner.version(ytDlpPath, ['--version']).then((v) => { ytDlpStartMs = Date.now() - ytDlpStartedAt; return v; }),
        runner.version(ffmpegPath, ['-version'])
    ]);
    const binaries = {
        ytDlp: { available: Boolean(ytDlp), version: ytDlp, ...(ytDlp ? { startMs: ytDlpStartMs } : {}) },
        ffmpeg: { available: Boolean(ffmpegLine), version: parseFfmpegVersion(ffmpegLine) }
    };
    memo = { at: Date.now(), binaries };
    return binaries;
}

async function cacheUsage() {
    let bytes = 0;
    let files = 0;
    try {
        for (const name of await fs.promises.readdir(cacheDir)) {
            if (!name.endsWith('.mp3')) continue;
            try {
                bytes += (await fs.promises.stat(`${cacheDir}/${name}`)).size;
                files++;
            } catch { /* removed meanwhile */ }
        }
    } catch { /* no cache dir yet */ }
    return { files, bytes, maxBytes: cacheMaxBytes() };
}

async function getHealth({ fresh = false } = {}) {
    const [binaries, cache] = await Promise.all([probeBinaries(fresh), cacheUsage()]);
    const degraded = !binaries.ytDlp.available || !binaries.ffmpeg.available;
    return {
        status: degraded ? 'degraded' : 'ok',
        version: pkg.version,
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        platform: process.platform,
        binaries,
        cache,
        // Relative to the data folder; absolute paths stay out of responses.
        log: { enabled: logFile.enabled(), file: `logs/${logFile.FILE_NAME}` }
    };
}

// Tests only.
function _resetMemo() { memo = null; }

module.exports = { getHealth, runner, parseFfmpegVersion, _resetMemo };
