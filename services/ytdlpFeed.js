// yt-dlp as the source of a conversion: it downloads the audio and writes it
// to its standard output, and ffmpeg reads it from there
// (controllers/transcode.js, `feed` and connectFeed).
//
// Used where handing ffmpeg an address does not work: YouTube answers 403 to
// a plain request (controllers/YouTubeController.js), and SoundCloud's AAC
// renditions are fragments that ffmpeg decodes as noise when it fetches them
// itself (controllers/soundcloudController.js). yt-dlp fetches both the way
// the site expects and hands over a stream that decodes.
//
// With `-o -` yt-dlp keeps its standard output for the audio and writes
// everything else to its standard error: the lines asked for with --print
// (`length: ...`, `chosen: ...`), warnings and errors.
const { ytDlpPath, jsRuntimeArgs } = require('./ytdlp');
const playReport = require('./playReport');

const TAIL_CHARS = 4000;

// Each distinct warning goes to the log once, not on every play.
const warned = new Set();
// eslint-disable-next-line no-control-regex
const clean = (line, max) => String(line).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
function noteWarning(line) {
    const text = clean(line, 240);
    if (!warned.has(text) && warned.size < 20) {
        warned.add(text);
        console.warn(`yt-dlp: ${text}`);
    }
    return text;
}

/** The last ERROR line yt-dlp wrote, else its last line, cleaned for showing. */
function lastWords(stderr) {
    const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines.filter((l) => /^ERROR:/.test(l)).pop() || lines.pop() || 'unknown error';
    return clean(last, 300);
}

/**
 * For transcode's `feed`: a function that starts yt-dlp downloading `url`.
 *
 *   url        the page or API address of the track
 *   format     yt-dlp's format selection (`-f`)
 *   spawn      starts the process (tests replace it)
 *   res        the response, for the play report (what was chosen, warnings)
 *   timing     its resolveMs/resolvedBy are set when the first audio arrives
 *   onLength   called with the track's length in seconds, when yt-dlp knows it
 *   jsRuntime  pass yt-dlp the JavaScript runtime (YouTube needs one)
 */
function ytdlpFeed({ url, format, spawn, res, timing, onLength, jsRuntime = false }) {
    return () => {
        const startedAt = Date.now();
        const args = [
            '-f', format, '--no-playlist', ...(jsRuntime ? jsRuntimeArgs() : []),
            '--no-part', '--no-simulate',
            '--print', 'length: %(duration)s',
            '--print', 'chosen: format %(format_id)s, %(protocol)s, %(acodec)s',
            '-o', '-',
            url
        ];
        const child = spawn(ytDlpPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        // How long it took yt-dlp to start delivering: the look-up, in effect.
        child.stdout.once('data', () => {
            if (timing && timing.resolveMs === null) {
                timing.resolveMs = Date.now() - startedAt;
                timing.resolvedBy = 'yt-dlp';
            }
        });
        let tail = '';
        let pending = '';
        let lastError = null;
        child.stderr.on('data', (data) => {
            const text = data.toString();
            tail = (tail + text).slice(-TAIL_CHARS);
            pending += text;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop().slice(-TAIL_CHARS); // an unfinished line waits for its end
            for (const raw of lines) {
                const line = raw.trim();
                if (!line) continue;
                const length = /^length: (\d+(?:\.\d+)?)$/.exec(line);
                if (length) {
                    const seconds = Math.round(Number(length[1]));
                    if (seconds > 0 && onLength) onLength(seconds);
                } else if (line.startsWith('chosen: ')) {
                    if (res) playReport.note(res, `yt-dlp ${line.slice(0, 140)}`.replace('chosen:', 'chose'));
                } else if (/^WARNING:/.test(line)) {
                    const warning = noteWarning(line);
                    if (res) playReport.note(res, `yt-dlp: ${warning}`);
                } else if (/^ERROR:/.test(line)) {
                    lastError = clean(line, 300);
                }
            }
        });
        return {
            child,
            // Its own account of a failure; null when it did not fail.
            failure(code, signal, { endedByUs = false } = {}) {
                if (lastError) return `yt-dlp: ${lastError}`;
                if (endedByUs || (code === 0 && !signal)) return null;
                if (code === -1) return `yt-dlp not found at "${ytDlpPath()}". Install it (brew install yt-dlp) or set YTDLP_PATH.`;
                return `yt-dlp: ${lastWords(tail)} (${signal ? `ended by ${signal}` : `exit code ${code}`})`;
            }
        };
    };
}

module.exports = { ytdlpFeed, noteWarning, lastWords };
