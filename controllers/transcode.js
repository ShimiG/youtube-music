// Shared "resolve a remote audio URL, transcode it with ffmpeg, stream MP3 to
// the client, and keep a disk-cache copy" pipeline. Used by every source that
// plays through the server (YouTube via yt-dlp, SoundCloud via its streams
// endpoint). Cache files are named `<cacheKey>.mp3` and every key carries its
// source prefix (`youtube_<id>`, `soundcloud_<id>`), so ids can never collide
// across sources. The cache is bounded by total size (CACHE_MAX_BYTES, default
// 500 MB), evicting the least recently played files first.
//
// Two ways a play is served when the track is not in the cache yet:
//   - A full play that may be cached is a *conversion job*: ffmpeg writes the
//     cache file as fast as it can, and the response reads along behind it
//     from the growing file (docs/performance-plan.md, step 2.1). The
//     conversion does not depend on how fast the player reads, so the cache
//     is complete seconds later, and anyone else who asks for the track
//     meanwhile (the next track being prepared and then skipped to) follows
//     the same file instead of starting ffmpeg again.
//   - Anything else (a seek, a preview, a file that is not cached) is piped
//     straight from ffmpeg to the response, and stops when the listener does.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { dataDir, resolveFfmpeg } = require('../services/paths');

const ffmpegPath = resolveFfmpeg();
const cacheDir = path.join(dataDir(), 'cache');
const resolvedCacheDir = path.resolve(cacheDir);

const MAX_SEEK_SECONDS = 24 * 60 * 60; // 24 hours
// How long a conversion nobody is listening to may run (a prepared track, or
// one whose listener left).
const MAX_TRANSCODE_MS = 10 * 60 * 1000;
// A conversion somebody is listening to is wanted for as long as they listen.
// It used to be stopped after ten minutes whatever happened, which cut off
// anything longer once it had been seeked in (ffmpeg then only works as fast
// as the player reads). The ceiling is now only a backstop.
const MAX_ATTENDED_MS = 3 * 60 * 60 * 1000;
// A conversion job whose source has sent nothing for this long is dead.
const STALL_MS = 60 * 1000;
const FOLLOW_CHUNK_BYTES = 64 * 1024;
const MIN_CACHE_BYTES = 100000; // smaller output means a broken/partial download
const DEFAULT_CACHE_MAX_BYTES = 500 * 1024 * 1024;
const LEGACY_YOUTUBE_FILE = /^[A-Za-z0-9_-]{11}\.mp3$/;

function cacheMaxBytes() {
    const raw = Number(process.env.CACHE_MAX_BYTES);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CACHE_MAX_BYTES;
}

// Audio quality of the transcode path (issue #39), chosen per request with
// ?quality=. YouTube, SoundCloud, Audius and Deezer previews are lossy at the
// source (roughly 128-160 kbps), so `high` cannot add detail; it avoids losing
// more in the conversion to MP3. Local MP3 / M4A / FLAC / WAV files do not come
// through here at all: they are sent as they are (controllers/localController.js).
// `standard` keeps the cache file names used before this setting existed.
const QUALITIES = Object.freeze({
    low: { bitrate: '96k', cacheSuffix: '_q96' },
    standard: { bitrate: '128k', cacheSuffix: '' },
    high: { bitrate: '256k', cacheSuffix: '_q256' }
});
const DEFAULT_QUALITY = 'standard';

const isValidQuality = (value) => value === undefined || Object.prototype.hasOwnProperty.call(QUALITIES, value);

/** The quality name a request asks for; `standard` when absent or unknown. */
function qualityOf(req) {
    const value = req && req.query ? req.query.quality : undefined;
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(QUALITIES, value) ? value : DEFAULT_QUALITY;
}

/** The cache key for a track at the request's quality, e.g. youtube_<id>_q256. */
function qualityCacheKey(req, baseKey) {
    return `${baseKey}${QUALITIES[qualityOf(req)].cacheSuffix}`;
}

// Conversion jobs that are filling the cache right now, by cache key. A second
// request for the same track follows the job instead of starting another.
const jobs = new Map();

// A transcode that is writing the cache keeps running after its client leaves,
// so the file is ready next time. That must be bounded, or anything that can
// make the browser request /stream (any web page, via <audio>) can pile up
// ffmpeg processes. Beyond this many, abandoned transcodes are killed.
const MAX_BACKGROUND_TRANSCODES = 2;
let backgroundTranscodes = 0;

// Hard ceiling on ffmpeg processes running at once, whatever their state. One
// listener needs two (the current track, plus the next one preloading) and up
// to MAX_BACKGROUND_TRANSCODES finishing in the background; beyond this the
// server answers 503 instead of starting another process.
const MAX_CONCURRENT_TRANSCODES = 6;
let activeTranscodes = 0;

if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}

// The player loads audio through an <audio> element whose origin (the Vite dev
// server, or the Tauri webview at tauri://localhost) differs from this API's.
// helmet() sets Cross-Origin-Resource-Policy: same-origin on every response,
// which makes the browser fetch the audio and then discard it before playback.
// Media responses must opt into cross-origin so the element can use them. This
// is about the client-vs-API origins only; the upstream audio source is
// irrelevant, since it is fetched and transcoded server-side and never reaches
// the browser directly. Every response an <audio> element consumes (both the
// cache hit and the live transcode) goes through the two functions below.
function setMediaHeaders(res) {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

/**
 * Sends a whole local audio file as it is (local files, issue #24), with HTTP
 * Range support from sendFile so the browser can seek, and the same
 * cross-origin header as every other media response.
 */
function sendMediaFile(res, filePath, contentType) {
    setMediaHeaders(res);
    res.type(contentType);
    res.sendFile(filePath, { dotfiles: 'allow', headers: { 'Content-Type': contentType } });
}

// Only characters that are safe in a filename; bounded length.
function isValidCacheKey(key) {
    return typeof key === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(key);
}

/** Parses ?seek=. Returns { seekTime } or { error }. */
function parseSeek(rawSeek) {
    if (rawSeek === undefined) return { seekTime: 0 };
    const parsed = Number(rawSeek);
    if (!Number.isFinite(parsed)) return { error: 'Invalid seek parameter' };
    const seekTime = Math.floor(parsed);
    if (seekTime < 0 || seekTime > MAX_SEEK_SECONDS) return { error: 'Invalid seek parameter' };
    return { seekTime };
}

function cachePathFor(cacheKey) {
    const finalFilePath = path.resolve(resolvedCacheDir, `${cacheKey}.mp3`);
    if (!finalFilePath.startsWith(resolvedCacheDir + path.sep)) return null;
    return finalFilePath;
}

/**
 * Evicts the least recently played cache files until the total size of the
 * cache is at or below `maxBytes`. serveFromCache() touches a file's mtime on
 * every hit, so mtime order is play-recency order. Resolves with what it did.
 */
async function enforceCacheLimit(maxBytes = cacheMaxBytes(), dir = cacheDir) {
    let entries;
    try {
        entries = await fs.promises.readdir(dir);
    } catch (err) {
        console.error('Error reading cache directory:', err.message);
        return { evicted: 0, totalBytes: 0 };
    }

    const files = [];
    for (const name of entries) {
        if (!name.endsWith('.mp3') && !name.endsWith('.m4a')) continue;
        const fullPath = path.join(dir, name);
        try {
            const st = await fs.promises.stat(fullPath);
            if (st.isFile()) files.push({ path: fullPath, size: st.size, time: st.mtimeMs });
        } catch { /* removed meanwhile */ }
    }

    let totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    let evicted = 0;
    files.sort((a, b) => a.time - b.time);
    for (const file of files) {
        if (totalBytes <= maxBytes) break;
        try {
            await fs.promises.unlink(file.path);
            totalBytes -= file.size;
            evicted++;
        } catch (err) {
            console.error(`Failed to delete old cache file: ${path.basename(file.path)}`, err.message);
        }
    }
    return { evicted, totalBytes };
}

/**
 * Startup housekeeping: removes `.part` files left by a crash or kill, and
 * renames cache files from before source prefixes (`<11-char id>.mp3`, always
 * YouTube) to `youtube_<id>.mp3`. Then applies the size limit.
 */
async function prepareCache(dir = cacheDir) {
    let entries = [];
    try { entries = await fs.promises.readdir(dir); } catch { return; }
    for (const name of entries) {
        const fullPath = path.join(dir, name);
        try {
            if (name.endsWith('.part')) {
                await fs.promises.unlink(fullPath);
            } else if (LEGACY_YOUTUBE_FILE.test(name)) {
                const target = path.join(dir, `youtube_${name}`);
                if (fs.existsSync(target)) await fs.promises.unlink(fullPath);
                else await fs.promises.rename(fullPath, target);
            }
        } catch (err) {
            console.warn(`Cache housekeeping skipped ${name}: ${err.message}`);
        }
    }
    await enforceCacheLimit(cacheMaxBytes(), dir);
}

// "Prepare" requests (?prepare=1) get a track ready without playing it: the
// client sends one shortly before the current track ends, so the next one
// starts from the disk cache instead of waiting for yt-dlp and ffmpeg
// (docs/performance-plan.md, step 1.3). They are answered at once with what
// was done; the conversion, if one was started, runs on its own into the cache.
const isPrepare = (req) => Boolean(req && req.query && req.query.prepare === '1');
const answerPrepare = (res, prepared) => {
    res.set('Cache-Control', 'no-store');
    res.json({ prepared });
};

// One line per play in the log (step 0 of the performance plan): what the
// wait before the first sound was made of. `req.playStartedAt` is set when the
// request arrives (controllers/streamingController.js).
function logPlay(req, timing, detail) {
    if (!timing || !timing.label) return;
    const total = req && req.playStartedAt ? `, ${Date.now() - req.playStartedAt} ms after the request` : '';
    const resolve = timing.resolvedBy ? `address ${timing.resolveMs} ms (${timing.resolvedBy}), ` : '';
    console.log(`Play ${timing.label}: ${resolve}${detail}${total}`);
}

/**
 * Serves the cached MP3 for `cacheKey` if one exists. Returns true when it
 * answered the request.
 *   - a normal play: the file itself, with HTTP Range support via sendFile, so
 *     the browser can seek;
 *   - a seek (`seekTime` > 0): converted from the cached file starting there.
 *     Sending the whole file used to restart the sound from 0:00 while the
 *     player's clock had moved on;
 *   - a prepare request: nothing to do, it is already there.
 * A track that is being converted right now counts too: a play follows that
 * conversion, a prepare request is told it is in progress.
 */
function serveFromCache(res, cacheKey, { req, seekTime = 0, timing } = {}) {
    const finalFilePath = cachePathFor(cacheKey);
    if (!finalFilePath || !fs.existsSync(finalFilePath)) {
        // Not there yet, but on its way: no need to look the address up again.
        const job = req && seekTime === 0 ? jobs.get(cacheKey) : null;
        if (!job) return false;
        if (isPrepare(req)) answerPrepare(res, 'in_progress');
        else follow(job, req, res, timing || { label: cacheKey });
        return true;
    }
    const now = new Date();
    fs.utimes(finalFilePath, now, now, () => {});
    if (isPrepare(req)) {
        answerPrepare(res, 'cached');
        return true;
    }
    if (seekTime > 0 && req) {
        streamTranscoded(req, res, { sourceUrl: finalFilePath, cacheKey, seekTime, allowCache: false, timing: { label: `${cacheKey} (seek in cached file)` } });
        return true;
    }
    logPlay(req, timing || { label: cacheKey }, 'from the disk cache');
    setMediaHeaders(res);
    res.sendFile(finalFilePath);
    return true;
}

function ffmpegArgsFor(req, sourceUrl, seekTime) {
    // The reconnect options only exist for network inputs; ffmpeg refuses to
    // open a local file (`file:` input, local files) when they are given.
    const isNetworkInput = /^https?:\/\//i.test(sourceUrl);
    return [
        ...(isNetworkInput ? ['-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : []),
        '-ss', seekTime.toString(),
        '-i', sourceUrl,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', QUALITIES[qualityOf(req)].bitrate,
        '-f', 'mp3',
        '-'
    ];
}

function logFfmpegErrors(child) {
    child.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('Error') || msg.includes('Invalid')) {
            console.error(`FFmpeg: ${msg.trim()}`);
        }
    });
}

// --- Conversion jobs: ffmpeg -> cache file, responses read the growing file ------

// A job nobody is listening to counts against MAX_BACKGROUND_TRANSCODES and
// gets MAX_TRANSCODE_MS to finish.
function enterBackground(job) {
    job.inBackground = true;
    backgroundTranscodes++;
    job.unattendedTimer = setTimeout(() => job.child.kill('SIGKILL'), MAX_TRANSCODE_MS);
}

function leaveBackground(job) {
    if (!job.inBackground) return;
    job.inBackground = false;
    backgroundTranscodes--;
    clearTimeout(job.unattendedTimer);
}

// Puts the finished file in the cache, or removes a broken one. Windows will
// not rename or delete a file somebody is still reading: in that case this is
// tried again when the last reader has gone, and the job stays known until
// then, so a new play follows the (complete) file instead of converting again.
function settle(job) {
    try {
        if (job.ok && !fs.existsSync(job.finalFilePath)) {
            fs.renameSync(job.partPath, job.finalFilePath);
            enforceCacheLimit().catch(() => {});
        } else if (fs.existsSync(job.partPath)) {
            // Broken or partial, or the track got cached meanwhile: never leave a .part file behind.
            fs.unlinkSync(job.partPath);
        }
    } catch (err) {
        if (job.readers > 0) {
            job.settleLater = true;
            if (!job.ok && jobs.get(job.cacheKey) === job) jobs.delete(job.cacheKey);
            return;
        }
        console.warn(`Cache: could not finish ${path.basename(job.partPath)}: ${err.message}`);
    }
    job.settleLater = false;
    if (jobs.get(job.cacheKey) === job) jobs.delete(job.cacheKey);
}

/** Starts ffmpeg writing `<cacheKey>_<time>.part`. Null when no job could be started. */
function startJob(req, { sourceUrl, cacheKey, finalFilePath, timing, onSourceFailed, prepare }) {
    const partPath = path.resolve(cacheDir, `${cacheKey}_${Date.now()}.part`);
    if (!partPath.startsWith(resolvedCacheDir + path.sep)) return null;
    let fd;
    try {
        // Opened here, not lazily by the stream: a reader may open it right away.
        fd = fs.openSync(partPath, 'w');
    } catch (err) {
        console.error(`Cache: cannot write ${path.basename(partPath)}: ${err.message}`);
        return null;
    }

    // windowsHide: the desktop app has no console; without it every transcode
    // would flash a console window on Windows.
    const child = spawn(ffmpegPath, ffmpegArgsFor(req, sourceUrl, 0), { windowsHide: true });
    const job = {
        cacheKey, partPath, finalFilePath, child,
        events: new EventEmitter(),
        startedAt: Date.now(),
        failedToStart: false,
        bytes: 0,            // written to the file so far
        producedAudio: false,
        done: false,         // ffmpeg has exited and the file is complete
        ok: false,           // ... and it is a whole track
        readers: 0,
        inBackground: false,
        unattendedTimer: null,
        settleLater: false
    };
    job.events.setMaxListeners(0);
    jobs.set(cacheKey, job);

    // Count this process until it is gone. A failed spawn emits 'error' and
    // may not emit 'close', so both release the slot, once.
    activeTranscodes++;
    let slotReleased = false;
    const releaseSlot = () => {
        if (slotReleased) return;
        slotReleased = true;
        activeTranscodes--;
    };

    const file = fs.createWriteStream(partPath, { fd });
    file.on('error', (err) => {
        console.error(`Cache: writing ${path.basename(partPath)} failed: ${err.message}`);
        child.kill('SIGKILL');
    });

    // The backstops: a source that has gone quiet, and a ceiling.
    const stallTimer = setTimeout(() => child.kill('SIGKILL'), STALL_MS);
    const ceilingTimer = setTimeout(() => child.kill('SIGKILL'), MAX_ATTENDED_MS);

    child.stdout.on('data', (chunk) => {
        job.producedAudio = true;
        stallTimer.refresh();
        // Counted once it is in the file, so a reader never waits for bytes
        // that are not there yet.
        const flowing = file.write(chunk, () => {
            job.bytes += chunk.length;
            job.events.emit('grow');
        });
        if (!flowing) {
            child.stdout.pause();
            file.once('drain', () => child.stdout.resume());
        }
    });
    logFfmpegErrors(child);

    // Runs once, when the process is gone (or never started: a failed spawn
    // emits 'error' and may not emit 'close').
    let ended = false;
    const finish = (code) => {
        if (ended) return;
        ended = true;
        releaseSlot();
        clearTimeout(stallTimer);
        clearTimeout(ceilingTimer);
        leaveBackground(job);
        if (code !== 0 && !job.producedAudio && typeof onSourceFailed === 'function') onSourceFailed();
        if (prepare && code === 0) console.log(`Prepared ${timing && timing.label ? timing.label : cacheKey} in ${Date.now() - job.startedAt} ms`);
        file.end(() => {
            let size = 0;
            try { size = fs.statSync(partPath).size; } catch { /* gone */ }
            job.ok = code === 0 && size > MIN_CACHE_BYTES;
            job.done = true;
            // A failed conversion is forgotten at once, so the next play tries again.
            if (!job.ok && jobs.get(cacheKey) === job) jobs.delete(cacheKey);
            settle(job);
            job.events.emit('done');
        });
    };

    child.on('error', (err) => {
        console.error('Failed to start FFmpeg:', err.message);
        job.failedToStart = true;
        finish(-1);
    });
    child.once('close', finish);

    if (prepare) enterBackground(job); // a prepared track has no listener from the start
    return job;
}

/**
 * Sends a job's audio to `res`: what is in the file already, then the rest as
 * it is written, at the pace the client reads.
 */
function follow(job, req, res, timing) {
    let fd;
    try {
        fd = fs.openSync(job.partPath, 'r');
    } catch (err) {
        console.error(`Cache: cannot read ${path.basename(job.partPath)}: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'Audio processor unavailable' });
        return;
    }

    const joinedAfterMs = Date.now() - job.startedAt;
    const joined = job.bytes > 0 || job.done; // the conversion was already under way
    job.readers++;
    leaveBackground(job);

    setMediaHeaders(res);

    let position = 0;
    let reading = false;  // a read from the file is in progress
    let blocked = false;  // waiting for the client to take what was sent
    let over = false;
    let logged = false;

    const leave = () => {
        if (over) return false;
        over = true;
        job.events.off('grow', pump);
        job.events.off('done', pump);
        if (!reading) fs.close(fd, () => {});
        job.readers--;
        if (job.done) {
            if (job.settleLater && job.readers === 0) settle(job);
        } else if (job.readers === 0) {
            // Nobody is listening any more. Let it finish for the cache if
            // there is room for one more unattended conversion; otherwise stop it.
            if (backgroundTranscodes < MAX_BACKGROUND_TRANSCODES) enterBackground(job);
            else job.child.kill('SIGKILL'); // exits non-zero, so the .part file is dropped
        }
        return true;
    };


    function pump() {
        if (over || reading || blocked) return;
        reading = true;
        const buffer = Buffer.allocUnsafe(FOLLOW_CHUNK_BYTES);
        fs.read(fd, buffer, 0, buffer.length, position, (err, bytesRead) => {
            reading = false;
            if (over) return fs.close(fd, () => {});
            if (err) {
                console.error(`Cache: reading ${path.basename(job.partPath)} failed: ${err.message}`);
                leave();
                return res.destroy ? res.destroy(err) : res.end();
            }
            if (bytesRead > 0) {
                position += bytesRead;
                if (!logged) {
                    logged = true;
                    res.setHeader('Content-Type', 'audio/mpeg');
                    res.setHeader('Transfer-Encoding', 'chunked');
                    logPlay(req, timing, joined
                        ? `joined a conversion started ${joinedAfterMs} ms earlier`
                        : `first audio ${Date.now() - job.startedAt} ms after starting ffmpeg`);
                }
                if (res.write(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead))) return pump();
                blocked = true;
                return res.once('drain', () => { blocked = false; pump(); });
            }
            // Caught up with the conversion.
            if (job.bytes > position) return pump(); // more arrived while this read was under way
            if (job.done) {
                leave();
                if (job.failedToStart && position === 0 && !res.headersSent) {
                    return res.status(500).json({ error: 'Audio processor unavailable' });
                }
                return res.end();
            }
            return undefined; // woken by 'grow' or 'done'
        });
    }

    job.events.on('grow', pump);
    job.events.on('done', pump);
    // res 'close' with writableFinished=false means the connection dropped
    // before we finished (req 'close' is not a reliable disconnect signal).
    res.on('close', () => { if (!res.writableFinished) leave(); });
    pump();
}

// --- Straight from ffmpeg to the response ---------------------------------------------

function streamDirect(req, res, { sourceUrl, seekTime, timing, onSourceFailed }) {
    const spawnedAt = Date.now();
    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgsFor(req, sourceUrl, seekTime), { windowsHide: true });
    let finished = false;
    let producedAudio = false;

    activeTranscodes++;
    let slotReleased = false;
    const releaseSlot = () => {
        if (slotReleased) return;
        slotReleased = true;
        activeTranscodes--;
    };

    // ffmpeg only works as fast as the listener reads here, so this is a
    // ceiling on listening time, not on conversion time.
    const cleanupTimer = setTimeout(() => {
        if (!finished) ffmpegProcess.kill('SIGKILL');
    }, MAX_ATTENDED_MS);

    ffmpegProcess.on('error', (err) => {
        releaseSlot();
        console.error('Failed to start FFmpeg:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Audio processor unavailable' });
    });

    ffmpegProcess.stdout.once('data', () => {
        producedAudio = true;
        logPlay(req, timing, `first audio ${Date.now() - spawnedAt} ms after starting ffmpeg${seekTime ? ` (seek to ${seekTime} s)` : ''}`);
    });

    setMediaHeaders(res);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    ffmpegProcess.stdout.pipe(res);
    logFfmpegErrors(ffmpegProcess);

    // Client went away: nothing is being kept, so stop the conversion.
    res.on('close', () => {
        if (res.writableFinished || finished) return;
        ffmpegProcess.stdout.unpipe(res);
        ffmpegProcess.kill('SIGKILL');
    });

    ffmpegProcess.once('close', (code) => {
        releaseSlot();
        finished = true;
        clearTimeout(cleanupTimer);
        if (code !== 0 && !producedAudio && typeof onSourceFailed === 'function') onSourceFailed();
    });
}

/**
 * Transcodes `sourceUrl` to MP3 and streams it into `res`. When `seekTime` is 0
 * and `allowCache` is true, the conversion runs as a job that fills the disk
 * cache under `cacheKey` (see the top of this file); otherwise ffmpeg's output
 * goes straight to the response.
 *
 * For a prepare request nothing is streamed: the conversion only fills the
 * cache, as an unattended job (bounded like the ones a departed listener
 * leaves behind).
 *
 * `timing` ({ label, resolveMs, resolvedBy }) adds a line to the log when the
 * first audio is ready. `onSourceFailed` is called when ffmpeg could not get
 * any audio out of `sourceUrl`.
 */
function streamTranscoded(req, res, { sourceUrl, cacheKey, seekTime = 0, allowCache = true, timing, onSourceFailed }) {
    const finalFilePath = cachePathFor(cacheKey);
    const prepare = isPrepare(req);
    const cacheable = Boolean(allowCache && finalFilePath && seekTime === 0);
    const running = cacheable ? jobs.get(cacheKey) : null;

    if (prepare) {
        // Only worth a process when the result lands in the cache, and only
        // within the same bounds as any other unattended conversion.
        if (!cacheable) return answerPrepare(res, 'skipped');
        if (running) return answerPrepare(res, 'in_progress');
        if (backgroundTranscodes >= MAX_BACKGROUND_TRANSCODES || activeTranscodes >= MAX_CONCURRENT_TRANSCODES) {
            return answerPrepare(res, 'busy');
        }
    }

    // Already being converted (it was being prepared, or it is playing in
    // another window): follow that conversion.
    if (running) return follow(running, req, res, timing);

    if (activeTranscodes >= MAX_CONCURRENT_TRANSCODES) {
        res.setHeader('Retry-After', '5');
        return res.status(503).json({ error: 'Too many streams in progress. Try again in a moment.', code: 'SERVER_BUSY' });
    }

    const job = cacheable ? startJob(req, { sourceUrl, cacheKey, finalFilePath, timing, onSourceFailed, prepare }) : null;
    if (prepare) return answerPrepare(res, job ? 'started' : 'skipped');
    if (job) return follow(job, req, res, timing);
    return streamDirect(req, res, { sourceUrl, seekTime, timing, onSourceFailed });
}

module.exports = {
    cacheDir,
    isValidCacheKey,
    parseSeek,
    QUALITIES,
    isValidQuality,
    qualityOf,
    qualityCacheKey,
    serveFromCache,
    isPrepare,
    answerPrepare,
    sendMediaFile,
    streamTranscoded,
    enforceCacheLimit,
    prepareCache,
    cacheMaxBytes,
    MAX_BACKGROUND_TRANSCODES,
    MAX_CONCURRENT_TRANSCODES,
    MAX_TRANSCODE_MS,
    MAX_ATTENDED_MS,
    STALL_MS,
    _jobs: jobs,
    _activeTranscodes: () => activeTranscodes,
    _backgroundTranscodes: () => backgroundTranscodes
};
