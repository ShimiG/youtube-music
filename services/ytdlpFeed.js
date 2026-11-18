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
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
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
 *   extraArgs  more options, before the address
 */
function ytdlpFeed({ url, format, spawn, res, timing, onLength, jsRuntime = false, extraArgs = [] }) {
    return () => {
        const startedAt = Date.now();
        const args = [
            '-f', format, '--no-playlist', ...(jsRuntime ? jsRuntimeArgs() : []),
            '--no-part', '--no-simulate',
            '--print', 'length: %(duration)s',
            '--print', 'chosen: format %(format_id)s, %(protocol)s, %(acodec)s',
            '-o', '-',
            ...extraArgs,
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

/**
 * Several ways to get the same audio, tried in turn: the next one starts only
 * when the one before ended with nothing delivered and its own account of a
 * failure. What ends the conversion ends whichever is running, and nothing
 * further is tried.
 *
 *   steps   [{ start, when?, onFailed?, onDelivered? }]: `start` is a feed (as
 *           ytdlpFeed returns); `when(previousFailure)` says whether to try
 *           this one at all; `onFailed(failure)` / `onDelivered()` are told
 *           how it went.
 *   timing  its resolveMs/resolvedBy are set when the first audio arrives,
 *           counted from the first attempt.
 *
 * Returns a feed: { child, failure } where child behaves as one process
 * (stdout, kill, exitCode, 'close').
 */
function chainFeeds(steps, { timing } = {}) {
    return () => {
        const startedAt = Date.now();
        const out = new PassThrough();
        const child = new EventEmitter();
        child.stdout = out;
        child.exitCode = null;
        let current = null;     // { feed, step }
        let index = -1;
        let killedWith = null;
        let delivered = false;
        let lastFailure = null;
        let last = { code: 1, signal: null };
        let done = false;

        // As a process does: 'close' once its output has been read to the end
        // (or a moment later, if nobody reads it any more).
        const finish = () => {
            if (done) return;
            done = true;
            child.exitCode = last.signal ? null : (last.code ?? 1);
            let told = false;
            const tell = () => {
                if (told) return;
                told = true;
                child.emit('close', last.code, last.signal);
            };
            out.once('end', () => process.nextTick(tell));
            out.end();
            if (out.readableEnded) process.nextTick(tell);
            setTimeout(tell, 2000).unref();
        };

        child.kill = (signal = 'SIGTERM') => {
            killedWith = signal;
            if (current && current.feed.child.exitCode === null) current.feed.child.kill(signal);
            if (!current) finish();
            return true;
        };

        const next = () => {
            index += 1;
            while (index < steps.length && steps[index].when && !steps[index].when(lastFailure)) index += 1;
            if (index >= steps.length || killedWith) return finish();
            const step = steps[index];
            let feed;
            try {
                feed = step.start();
            } catch (err) {
                lastFailure = `it could not be started: ${err.message}`;
                return next();
            }
            current = { feed, step };
            const source = feed.child;
            let ended = false;
            source.stdout.on('data', (chunk) => {
                if (!delivered) {
                    delivered = true;
                    if (timing && timing.resolveMs === null) {
                        timing.resolveMs = Date.now() - startedAt;
                        timing.resolvedBy = 'yt-dlp';
                    }
                }
                if (!out.write(chunk)) {
                    source.stdout.pause();
                    out.once('drain', () => source.stdout.resume());
                }
            });
            const over = (code, signal, startError) => {
                if (ended) return;
                ended = true;
                last = { code, signal };
                const failure = startError
                    ? `yt-dlp could not be started: ${startError.message}`
                    : feed.failure(code, signal, { endedByUs: Boolean(killedWith) });
                if (failure && !delivered) {
                    lastFailure = failure;
                    if (step.onFailed) step.onFailed(failure);
                    if (!killedWith) return next();
                } else if (!failure && delivered && step.onDelivered) {
                    step.onDelivered();
                }
                if (failure) lastFailure = failure;
                return finish();
            };
            source.once('close', (code, signal) => over(code, signal, null));
            source.once('error', (err) => over(-1, null, err));
            return undefined;
        };
        out.on('error', () => {});
        next();
        return {
            child,
            failure(code, signal, { endedByUs = false } = {}) {
                if (delivered && !lastFailure) return null;
                if (endedByUs && !lastFailure) return null;
                return delivered ? null : lastFailure;
            }
        };
    };
}

module.exports = { ytdlpFeed, chainFeeds, noteWarning, lastWords };
