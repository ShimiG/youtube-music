// docs/performance-plan.md, step 2.1, in controllers/transcode.js: a full play
// is a conversion job. ffmpeg writes the cache file as fast as it can, and
// each response reads along behind it from the growing file, so the
// conversion no longer depends on how fast the player reads.
// ffmpeg is a fake child process; the cache is a real folder in a temp dir.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-job-'));
process.env.MUSIC_DATA_DIR = tmp;

const mockChildren = [];
jest.mock('child_process', () => ({
    ...jest.requireActual('child_process'),
    spawn: jest.fn(() => {
        const { EventEmitter } = require('events');
        const { PassThrough } = require('stream');
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = jest.fn(() => { child.killed = true; });
        mockChildren.push(child);
        return child;
    })
}));

const { Writable } = require('stream');
const { spawn } = require('child_process');
const transcode = require('../controllers/transcode');

// A response that keeps what it is sent. `stuck` makes it a client that has
// stopped reading (a player whose buffer is full).
function fakeRes({ stuck = false } = {}) {
    const chunks = [];
    let pending = null;
    const res = new Writable({
        highWaterMark: 1024,
        write(chunk, _enc, done) {
            chunks.push(chunk);
            if (!stuck) done();
            else pending = done;
        }
    });
    // Lets a stuck client take what it was sent (once per chunk).
    res.release = () => {
        const done = pending;
        pending = null;
        if (done) done();
    };
    res.body = () => Buffer.concat(chunks);
    res.headers = {};
    res.headersSent = false;
    res.setHeader = jest.fn((name, value) => { res.headers[name] = value; });
    res.set = jest.fn();
    res.status = jest.fn((code) => { res.statusCode = code; return res; });
    // An answer in JSON is the whole answer: the response ends with it.
    res.json = jest.fn(() => { res.end(); });
    res.sendFile = jest.fn();
    return res;
}

jest.setTimeout(30000);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what) => {
    for (let i = 0; i < 1000; i++) { // up to 10 s: the Windows build machine is slow
        if (check()) return;
        await wait(10);
    }
    throw new Error(`timed out waiting for ${what}`);
};
const cacheFile = (key) => path.join(transcode.cacheDir, `${key}.mp3`);
const partFiles = () => fs.readdirSync(transcode.cacheDir).filter((f) => f.endsWith('.part'));
const play = (key, res = fakeRes(), extra = {}) => {
    transcode.streamTranscoded({ query: {}, playStartedAt: Date.now() }, res, { sourceUrl: 'https://media.example/a', cacheKey: key, seekTime: 0, timing: { label: key }, ...extra });
    return res;
};
const prepare = (key) => {
    const res = fakeRes();
    transcode.streamTranscoded({ query: { prepare: '1' } }, res, { sourceUrl: 'https://media.example/a', cacheKey: key, seekTime: 0 });
    return res;
};
// Bytes whose value says where in the track they are, so order mistakes show.
const audio = (bytes, seed = 0) => Buffer.from(Array.from({ length: bytes }, (_, i) => (i + seed) % 251));
const lastChild = () => mockChildren[mockChildren.length - 1];
async function convert(child, data, code = 0) {
    child.stdout.end(data);
    await wait(20);
    child.emit('close', code);
}

let logSpy;
let errorSpy;
beforeEach(() => {
    spawn.mockClear();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
    // Until none is left: a pass-through that fails starts ffmpeg once more.
    const quiet = jest.spyOn(console, 'warn').mockImplementation(() => {});
    while (mockChildren.length) mockChildren.splice(0).forEach((c) => { if (!c.closed) c.emit('close', 1); });
    quiet.mockRestore();
    await until(() => transcode._jobs.size === 0 && transcode._activeTranscodes() === 0, 'the jobs to end');
    logSpy.mockRestore();
    errorSpy.mockRestore();
});
afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.MUSIC_DATA_DIR;
});

describe('a play is a conversion into the cache, with the response reading behind it', () => {
    it('sends the listener exactly what is written to the cache, as it is written', async () => {
        const res = play('youtube_followaaaaa');
        const child = lastChild();
        const first = audio(120000);
        child.stdout.write(first);
        await until(() => res.body().length === first.length, 'the first part');
        expect(res.headers['Content-Type']).toBe('audio/mpeg');
        expect(res.headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
        expect(res.writableEnded).toBe(false); // more is coming

        const second = audio(90000, 7);
        await convert(child, second);
        await until(() => res.writableEnded, 'the end of the response');
        const whole = Buffer.concat([first, second]);
        expect(res.body().equals(whole)).toBe(true);
        await until(() => fs.existsSync(cacheFile('youtube_followaaaaa')), 'the cache file');
        expect(fs.readFileSync(cacheFile('youtube_followaaaaa')).equals(whole)).toBe(true);
        await until(() => partFiles().length === 0, 'the .part file to go');
        expect(transcode._jobs.size).toBe(0);
        expect(logSpy.mock.calls.filter(([line]) => /^Play .*first audio \d+ ms after starting ffmpeg/.test(line))).toHaveLength(1);
    });

    it('does not wait for a listener who has stopped reading: the cache completes anyway', async () => {
        const res = play('youtube_stuckaaaaaa', fakeRes({ stuck: true }));
        const child = lastChild();
        const whole = audio(400000);
        await convert(child, whole);
        // The player took the first bytes and no more; the whole track is on
        // disk regardless. (Under its final name at once, except on Windows,
        // which renames a file only when nobody is reading it any more.)
        const complete = () => (fs.existsSync(cacheFile('youtube_stuckaaaaaa'))
            ? cacheFile('youtube_stuckaaaaaa')
            : [...transcode._jobs.values()].filter((job) => job.done && job.ok).map((job) => job.partPath)[0]);
        await until(() => Boolean(complete()), 'the conversion to complete');
        expect(fs.statSync(complete()).size).toBe(whole.length);
        expect(res.body().length).toBeLessThan(whole.length);
        expect(child.stdout.isPaused()).toBe(false);
        expect(transcode._activeTranscodes()).toBe(0);

        // When the player reads on, it gets the rest, from the finished file.
        const pump = setInterval(() => res.release(), 1);
        await until(() => res.writableEnded, 'the end of the response');
        clearInterval(pump);
        expect(res.body().equals(whole)).toBe(true);
        await until(() => fs.existsSync(cacheFile('youtube_stuckaaaaaa')) && partFiles().length === 0, 'the cache file');
    });

    it('a second request for the track follows the same conversion instead of starting ffmpeg again', async () => {
        const a = play('youtube_sharedaaaaa');
        const child = lastChild();
        const first = audio(150000);
        child.stdout.write(first);
        await until(() => a.body().length === first.length, 'the first listener');

        const b = play('youtube_sharedaaaaa');
        expect(spawn).toHaveBeenCalledTimes(1);
        await until(() => b.body().length === first.length, 'the second listener to catch up');
        await convert(child, audio(50000, 3));
        await until(() => a.writableEnded && b.writableEnded, 'both to end');
        expect(a.body().equals(b.body())).toBe(true);
        expect(a.body().length).toBe(200000);
        expect(logSpy.mock.calls.some(([line]) => /joined a conversion started \d+ ms earlier/.test(line))).toBe(true);
    });

    it('a track being prepared is followed when it is skipped to, from the cache check on', async () => {
        expect(prepare('youtube_prepskipaaa').json).toHaveBeenCalledWith({ prepared: 'started' });
        const child = lastChild();
        expect(transcode._backgroundTranscodes()).toBe(1);
        child.stdout.write(audio(130000));
        await wait(30);

        // The controllers ask the cache first: no address look-up, no second ffmpeg.
        const res = fakeRes();
        expect(transcode.serveFromCache(res, 'youtube_prepskipaaa', { req: { query: {} }, seekTime: 0 })).toBe(true);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(transcode._backgroundTranscodes()).toBe(0); // somebody is listening now
        const again = fakeRes();
        expect(transcode.serveFromCache(again, 'youtube_prepskipaaa', { req: { query: { prepare: '1' } }, seekTime: 0 })).toBe(true);
        expect(again.json).toHaveBeenCalledWith({ prepared: 'in_progress' });
        // A request that only prepares never seeks.
        expect(transcode.serveFromCache(fakeRes(), 'youtube_prepskipaaa', { req: { query: { prepare: '1', seek: '30' } }, seekTime: 30 })).toBe(false);

        await until(() => res.body().length === 130000, 'what was already converted');
        await convert(child, audio(20000));
        await until(() => res.writableEnded, 'the end');
        expect(res.body().length).toBe(150000);
    });

    it('goes on for the cache when the listener leaves, within the limit for unattended conversions', async () => {
        const res = play('youtube_leftaaaaaaa');
        const child = lastChild();
        child.stdout.write(audio(50000));
        await until(() => res.body().length === 50000, 'the first part');
        res.destroy();
        await until(() => transcode._backgroundTranscodes() === 1, 'the job to count as unattended');
        expect(child.kill).not.toHaveBeenCalled();
        await convert(child, audio(100000));
        await until(() => fs.existsSync(cacheFile('youtube_leftaaaaaaa')), 'the cache file');
        expect(fs.statSync(cacheFile('youtube_leftaaaaaaa')).size).toBe(150000);
        expect(transcode._backgroundTranscodes()).toBe(0);
    });

    it('a conversion that fails leaves nothing behind and is tried again on the next play', async () => {
        const failed = jest.fn();
        const res = play('youtube_brokenaaaaa', fakeRes(), { onSourceFailed: failed });
        lastChild().closed = true;
        lastChild().emit('close', 1); // no audio at all: the address was dead
        await until(() => res.writableEnded, 'the response to end');
        expect(failed).toHaveBeenCalledTimes(1);
        expect(res.body().length).toBe(0);
        expect(transcode._jobs.size).toBe(0);
        await until(() => partFiles().length === 0, 'the empty file to go');
        expect(fs.existsSync(cacheFile('youtube_brokenaaaaa'))).toBe(false);

        // Cut short after some audio: not cached either (and not the address's fault).
        const cut = play('youtube_brokenaaaaa', fakeRes(), { onSourceFailed: failed });
        expect(spawn).toHaveBeenCalledTimes(2);
        await convert(lastChild(), audio(150000), 1);
        lastChild().closed = true;
        await until(() => cut.writableEnded, 'the response to end');
        expect(cut.body().length).toBe(150000);
        expect(failed).toHaveBeenCalledTimes(1);
        await until(() => partFiles().length === 0, 'the partial file to go');
        expect(fs.existsSync(cacheFile('youtube_brokenaaaaa'))).toBe(false);
    });

    it('tells the app why when no audio came out, in whatever words ffmpeg used, or none', async () => {
        const playReport = require('../services/playReport');
        const reasons = jest.spyOn(playReport, 'reason').mockImplementation(() => {});
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        // The source refused: ffmpeg's wording has no "Error" in the telling line.
        const refused = play('youtube_refusedaaaa');
        lastChild().stderr.write('[https @ 0x1] HTTP error 403 Forbidden\n[hls @ 0x2] Failed to open segment 0 of playlist 0\n');
        await wait(20);
        lastChild().closed = true;
        lastChild().emit('close', 183, null);
        await until(() => refused.writableEnded, 'the response to end');
        expect(reasons).toHaveBeenLastCalledWith(refused, 'ffmpeg: HTTP error 403 Forbidden / Failed to open segment 0 of playlist 0 (exit code 183)', { failed: true });
        expect(logged.mock.calls.map((c) => c[0])).toContain('youtube_refusedaaaa: no audio. ffmpeg: HTTP error 403 Forbidden / Failed to open segment 0 of playlist 0 (exit code 183)');

        // ffmpeg itself died: it says nothing, the signal is the reason.
        const died = play('youtube_diedaaaaaaa');
        lastChild().closed = true;
        lastChild().emit('close', null, 'SIGSEGV');
        await until(() => died.writableEnded, 'the response to end');
        expect(reasons).toHaveBeenLastCalledWith(died, 'ffmpeg: it said nothing (ended by SIGSEGV)', { failed: true });

        // It ended "successfully" with nothing: that is a failure with a reason too.
        const empty = play('youtube_emptyaaaaaa');
        lastChild().stderr.write('[out#0/mp3 @ 0x1] Output file is empty, nothing was encoded\n');
        await wait(20);
        lastChild().closed = true;
        lastChild().emit('close', 0, null);
        await until(() => empty.writableEnded, 'the response to end');
        expect(reasons).toHaveBeenLastCalledWith(empty, 'ffmpeg: Output file is empty, nothing was encoded (exit code 0)', { failed: true });

        reasons.mockRestore();
        logged.mockRestore();
    });

    it('fetches the source with the headers its look-up named', () => {
        play('youtube_headersaaaa', fakeRes(), { sourceHeaders: { 'User-Agent': 'Mozilla/5.0 Safari', 'Bad\r\nName': 'x' } });
        const args = spawn.mock.calls[spawn.mock.calls.length - 1][1];
        expect(args[args.indexOf('-headers') + 1]).toBe('User-Agent: Mozilla/5.0 Safari\r\n');
        expect(args.indexOf('-headers')).toBeLessThan(args.indexOf('-i'));
    });

    it('answers 500 and frees its slot when ffmpeg cannot be started', async () => {
        const res = play('youtube_nostartaaaa');
        lastChild().closed = true;
        lastChild().emit('error', new Error('spawn ENOENT'));
        await until(() => res.status.mock.calls.length > 0, 'the error answer');
        expect(res.status).toHaveBeenCalledWith(500);
        expect(transcode._activeTranscodes()).toBe(0);
        expect(transcode._jobs.size).toBe(0);
        await until(() => partFiles().length === 0, 'the empty file to go');
    });
});

describe('how long a conversion may run', () => {
    beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
    afterEach(() => jest.useRealTimers());

    it('one nobody listens to gets ten minutes; one with a listener is only stopped when its source goes quiet', () => {
        prepare('youtube_capaaaaaaaa');
        const unattended = lastChild();
        // Kept alive by its source, so only the unattended limit applies.
        for (let i = 0; i < 10; i++) {
            unattended.stdout.emit('data', Buffer.alloc(10));
            jest.advanceTimersByTime(transcode.MAX_TRANSCODE_MS / 10 - 1000);
        }
        expect(unattended.kill).not.toHaveBeenCalled();
        jest.advanceTimersByTime(20000);
        expect(unattended.kill).toHaveBeenCalledWith('SIGKILL');

        play('youtube_capbbbbbbbb');
        const attended = lastChild();
        for (let minutes = 0; minutes < 30; minutes++) {
            attended.stdout.emit('data', Buffer.alloc(10));
            jest.advanceTimersByTime(59000);
        }
        expect(attended.kill).not.toHaveBeenCalled(); // half an hour in, still wanted
        jest.advanceTimersByTime(transcode.STALL_MS + 1000); // nothing more from the source
        expect(attended.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('a seek is no longer cut off after ten minutes of listening', () => {
        const res = fakeRes();
        transcode.streamTranscoded({ query: { seek: '600' } }, res, { sourceUrl: 'https://media.example/a', cacheKey: 'youtube_seeklongaaa', seekTime: 600 });
        const child = lastChild();
        jest.advanceTimersByTime(45 * 60 * 1000);
        expect(child.kill).not.toHaveBeenCalled();
        jest.advanceTimersByTime(transcode.MAX_ATTENDED_MS);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL'); // the backstop
    });
});

// docs/performance-plan.md, step 2.2.
describe('a source that is MP3 already is passed through, not converted again', () => {
    const argsOf = (n = spawn.mock.calls.length - 1) => spawn.mock.calls[n][1];
    const codec = (args) => args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2).join(' ');
    const mp3 = { sourceCodec: 'mp3' };

    it('copies the audio at standard and high quality, converts for low and for other sources', async () => {
        play('soundcloud_1', fakeRes(), mp3);
        expect(codec(argsOf())).toBe('-c:a copy');
        expect(argsOf()).not.toContain('-b:a');
        expect(argsOf().slice(-3)).toEqual(['-f', 'mp3', '-']);

        const high = fakeRes();
        transcode.streamTranscoded({ query: { quality: 'high' } }, high, { sourceUrl: 'https://media.example/a', cacheKey: 'soundcloud_1_q256', seekTime: 0, ...mp3 });
        expect(codec(argsOf())).toBe('-c:a copy');

        // "low" exists to make the audio smaller.
        transcode.streamTranscoded({ query: { quality: 'low' } }, fakeRes(), { sourceUrl: 'https://media.example/a', cacheKey: 'soundcloud_1_q96', seekTime: 0, ...mp3 });
        expect(codec(argsOf())).toBe('-c:a libmp3lame');
        expect(argsOf()).toEqual(expect.arrayContaining(['-b:a', '96k']));

        play('youtube_notmp3aaaaa');
        expect(codec(argsOf())).toBe('-c:a libmp3lame');
        // A seek (straight to the response) is passed through as well.
        transcode.streamTranscoded({ query: {} }, fakeRes(), { sourceUrl: 'https://media.example/a', cacheKey: 'soundcloud_1', seekTime: 30, ...mp3 });
        expect(codec(argsOf())).toBe('-c:a copy');
        expect(argsOf().slice(argsOf().indexOf('-ss'), argsOf().indexOf('-ss') + 2)).toEqual(['-ss', '30']);
    });

    it('converts after all when ffmpeg cannot pass the source through, once, and without the listener noticing', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const failed = jest.fn();
        const res = play('soundcloud_2', fakeRes(), { ...mp3, onSourceFailed: failed });
        expect(spawn).toHaveBeenCalledTimes(1);
        mockChildren[0].closed = true;
        mockChildren[0].emit('close', 1); // "not an MP3 stream": gave up before writing anything
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(codec(argsOf(0))).toBe('-c:a copy');
        expect(codec(argsOf(1))).toBe('-c:a libmp3lame');
        expect(failed).not.toHaveBeenCalled();
        expect(transcode._activeTranscodes()).toBe(1); // still one conversion, not two
        expect(res.writableEnded).toBe(false);

        const whole = audio(150000);
        await convert(mockChildren[1], whole);
        await until(() => res.writableEnded, 'the end of the response');
        expect(res.body().equals(whole)).toBe(true);
        await until(() => fs.existsSync(cacheFile('soundcloud_2')), 'the cache file');
        expect(warn.mock.calls.some(([line]) => /could not be passed through as MP3/.test(line))).toBe(true);

        // The second try failing too is a failure: no third.
        const again = play('soundcloud_3', fakeRes(), { ...mp3, onSourceFailed: failed });
        const before = spawn.mock.calls.length;
        lastChild().closed = true;
        lastChild().emit('close', 1);
        lastChild().closed = true;
        lastChild().emit('close', 1);
        expect(spawn.mock.calls.length).toBe(before + 1);
        expect(failed).toHaveBeenCalledTimes(1);
        await until(() => again.writableEnded, 'the response to end');
        warn.mockRestore();
    });

    it('does not start again when it was stopped on purpose, or after audio has been sent', async () => {
        // The listener leaves at once and there is no room for another unattended job.
        const max = transcode.MAX_BACKGROUND_TRANSCODES;
        for (let i = 0; i < max; i++) prepare(`youtube_filler${i}aaa`);
        const res = play('soundcloud_4', fakeRes(), mp3);
        const child = lastChild();
        const before = spawn.mock.calls.length;
        res.destroy();
        await until(() => child.kill.mock.calls.length > 0, 'the job to be stopped');
        child.closed = true;
        child.emit('close', 1); // killed before any audio
        expect(spawn.mock.calls.length).toBe(before);

        // Passed through for a while, then the source broke off: that is not "cannot be copied".
        const cut = play('soundcloud_5', fakeRes(), mp3);
        const during = spawn.mock.calls.length;
        await convert(lastChild(), audio(120000), 1);
        lastChild().closed = true;
        await until(() => cut.writableEnded, 'the response to end');
        expect(spawn.mock.calls.length).toBe(during);

        // The same for a seek that goes straight to the response.
        const seek = fakeRes();
        transcode.streamTranscoded({ query: {} }, seek, { sourceUrl: 'https://media.example/a', cacheKey: 'soundcloud_6', seekTime: 30, ...mp3 });
        const direct = lastChild();
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        direct.closed = true;
        direct.emit('close', 1);
        expect(codec(argsOf())).toBe('-c:a libmp3lame'); // tried again as a conversion
        const retry = lastChild();
        retry.stdout.write(audio(5000));
        await until(() => seek.body().length === 5000, 'the audio of the second try');
        retry.closed = true;
        retry.emit('close', 0);
        await until(() => seek.writableEnded, 'the response to end');
        warn.mockRestore();
    });
});

// YouTube's servers refuse ffmpeg (403), so there yt-dlp downloads the audio
// and ffmpeg is handed the bytes: `feed` instead of `sourceUrl`.
describe('a source that yt-dlp downloads is piped into ffmpeg', () => {
    const { fakeProcess } = require('./helpers/fakeProcess');
    const playReport = require('../services/playReport');

    // A downloader the test drives. It fails with `words` unless it ended well or was ended by the conversion.
    function downloader(words = 'yt-dlp: ERROR: [youtube] x: Sign in to confirm you are not a bot') {
        const child = fakeProcess();
        const feed = jest.fn(() => ({ child, failure: (code, signal, { endedByUs }) => (endedByUs || (code === 0 && !signal) ? null : words) }));
        return { child, feed };
    }
    const argsOf = (child) => spawn.mock.calls[mockChildren.indexOf(child)][1];

    it('gives ffmpeg its standard input as the source, and everything the downloader writes', async () => {
        const { child: ytDlp, feed } = downloader();
        const res = play('youtube_pipedaaaaaa', fakeRes(), { sourceUrl: undefined, feed });
        const ffmpeg = lastChild();
        expect(feed).toHaveBeenCalledTimes(1);
        const args = argsOf(ffmpeg);
        expect(args[args.indexOf('-i') + 1]).toBe('pipe:0');
        // Nothing that belongs to an address ffmpeg would fetch itself.
        expect(args).not.toContain('-reconnect_streamed');
        expect(args).not.toContain('-headers');
        expect(args).not.toContain('-ss');

        const received = [];
        ffmpeg.stdin.on('data', (chunk) => received.push(chunk));
        ytDlp.stdout.write(audio(5000));
        ytDlp.stdout.write(audio(7000, 3));
        ytDlp.exit(0);
        await until(() => Buffer.concat(received).length === 12000, 'the audio to reach ffmpeg');
        expect(Buffer.concat(received)).toEqual(Buffer.concat([audio(5000), audio(7000, 3)]));

        await convert(ffmpeg, audio(150000));
        ffmpeg.closed = true;
        await until(() => res.writableEnded, 'the response to end');
        expect(res.body().length).toBe(150000);
        expect(ytDlp.kill).not.toHaveBeenCalled(); // it had finished by itself
        await until(() => fs.existsSync(cacheFile('youtube_pipedaaaaaa')), 'the cache file');
    });

    it('ends the downloader when ffmpeg ends first, and blames ffmpeg', async () => {
        const reasons = jest.spyOn(playReport, 'reason').mockImplementation(() => {});
        const { child: ytDlp, feed } = downloader();
        const res = play('youtube_pipedbbbbbb', fakeRes(), { sourceUrl: undefined, feed });
        lastChild().stderr.write('pipe:0: Invalid data found when processing input\n');
        await wait(20);
        lastChild().closed = true;
        lastChild().emit('close', 1, null);
        await until(() => res.writableEnded, 'the response to end');
        expect(ytDlp.kill).toHaveBeenCalledWith('SIGKILL');
        expect(reasons).toHaveBeenLastCalledWith(res, 'ffmpeg: pipe:0: Invalid data found when processing input (exit code 1)', { failed: true });
        reasons.mockRestore();
    });

    it("gives the downloader's own words when it was the download that failed", async () => {
        const reasons = jest.spyOn(playReport, 'reason').mockImplementation(() => {});
        const { child: ytDlp, feed } = downloader();
        const res = play('youtube_pipedcccccc', fakeRes(), { sourceUrl: undefined, feed });
        const ffmpeg = lastChild();
        ytDlp.exit(1); // refused by YouTube: no audio, its own error
        await wait(20);
        // ffmpeg, given nothing, gives up in its own words; those are not the reason.
        ffmpeg.stderr.write('pipe:0: Invalid data found when processing input\n');
        await wait(20);
        ffmpeg.closed = true;
        ffmpeg.emit('close', 1, null);
        await until(() => res.writableEnded, 'the response to end');
        expect(ytDlp.kill).not.toHaveBeenCalled();
        expect(reasons).toHaveBeenLastCalledWith(res, 'yt-dlp: ERROR: [youtube] x: Sign in to confirm you are not a bot', { failed: true });
        expect(errorSpy.mock.calls.map((c) => c[0])).toContain('youtube_pipedcccccc: no audio. yt-dlp: ERROR: [youtube] x: Sign in to confirm you are not a bot');
        expect(transcode._jobs.size).toBe(0);
        reasons.mockRestore();
    });

    it('says so when the downloader could not be started at all', async () => {
        const reasons = jest.spyOn(playReport, 'reason').mockImplementation(() => {});
        const { child: ytDlp, feed } = downloader();
        const res = play('youtube_pipeddddddd', fakeRes(), { sourceUrl: undefined, feed });
        const ffmpeg = lastChild();
        let inputEnded = false;
        ffmpeg.stdin.on('finish', () => { inputEnded = true; });
        ytDlp.emit('error', new Error('spawn yt-dlp ENOENT'));
        await until(() => inputEnded, "ffmpeg's input to be closed"); // it must not wait for audio for ever
        ffmpeg.closed = true;
        ffmpeg.emit('close', 1, null);
        await until(() => res.writableEnded, 'the response to end');
        expect(reasons).toHaveBeenLastCalledWith(res, 'it could not be started: spawn yt-dlp ENOENT', { failed: true });
        reasons.mockRestore();
    });

    it('a seek reads from the start and drops what comes before, and both end when the listener leaves', async () => {
        const { child: ytDlp, feed } = downloader();
        const res = fakeRes();
        transcode.streamTranscoded({ query: { seek: '120' }, playStartedAt: Date.now() }, res, { feed, cacheKey: 'youtube_pipedeeeeee', seekTime: 120, timing: { label: 'seek' } });
        const ffmpeg = lastChild();
        const args = argsOf(ffmpeg);
        // A pipe cannot be searched: -ss comes after the input here.
        expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 4)).toEqual(['-i', 'pipe:0', '-ss', '120']);
        expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-i'));

        res.emit('close'); // the listener moved on
        expect(ytDlp.kill).toHaveBeenCalledWith('SIGKILL');
        expect(ffmpeg.kill).toHaveBeenCalledWith('SIGKILL');
        ffmpeg.closed = true;
        ffmpeg.emit('close', null, 'SIGKILL');
        await until(() => transcode._activeTranscodes() === 0, 'the slot to be released');
    });

    it('ends the downloader with a conversion that nobody waits for and that goes quiet', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
        try {
            const { child: ytDlp, feed } = downloader();
            transcode.streamTranscoded({ query: { prepare: '1' } }, fakeRes(), { feed, cacheKey: 'youtube_pipedffffff', seekTime: 0, timing: { label: 'prepared' } });
            const ffmpeg = lastChild();
            expect(ytDlp.kill).not.toHaveBeenCalled();
            jest.advanceTimersByTime(transcode.STALL_MS + 1000); // nothing arrived from the source
            expect(ytDlp.kill).toHaveBeenCalledWith('SIGKILL');
            expect(ffmpeg.kill).toHaveBeenCalledWith('SIGKILL');
            ffmpeg.closed = true;
            ffmpeg.emit('close', null, 'SIGKILL');
        } finally {
            jest.useRealTimers();
        }
    });
});

// A seek in a track that is still being converted reads from the conversion
// that is running, at the byte that belongs to the time (128 kbit/s: 16,000
// bytes a second), instead of starting a second download and conversion.
describe('a seek joins the conversion that is already running', () => {
    const BYTES_PER_SECOND = 16000; // the standard quality, 128 kbit/s
    const seek = (key, seconds, res = fakeRes()) => {
        const req = { query: { seek: String(seconds) }, playStartedAt: Date.now() };
        return { res, joined: transcode.serveFromCache(res, key, { req, seekTime: seconds }) };
    };

    // What ffmpeg writes: an ID3 tag, then frames of 384 bytes (128 kbit/s at
    // 48 kHz), each beginning FF FB 94 00. Every third frame also carries those
    // same four bytes in its middle: a place that looks like a frame and is not one.
    const TAG = 45;
    const FRAME = 384;
    function mp3(frames) {
        const tag = Buffer.alloc(TAG);
        tag.write('ID3', 0, 'latin1');
        tag[3] = 4;
        tag[9] = TAG - 10; // the tag's size, without its own ten bytes
        const out = [tag];
        for (let i = 0; i < frames; i++) {
            const frame = Buffer.alloc(FRAME, (i % 200) + 1);
            frame.set([0xff, 0xfb, 0x94, 0x00], 0);
            if (i % 3 === 0) frame.set([0xff, 0xfb, 0x94, 0x00], 150);
            frame.writeUInt32BE(i, 4); // which frame this is
            out.push(frame);
        }
        return Buffer.concat(out);
    }

    it('starts no second ffmpeg, and sends from the frame that begins at that time', async () => {
        const first = play('youtube_seekjoinaaa');
        const child = lastChild();
        const data = mp3(600); // 230 KB: 14.4 s of audio
        child.stdout.write(data);
        await until(() => first.body().length === data.length, 'the listener to have it all');

        const { res, joined } = seek('youtube_seekjoinaaa', 8);
        expect(joined).toBe(true);
        expect(spawn).toHaveBeenCalledTimes(1);
        await until(() => res.body().length > 0, 'the seek to be answered');
        expect(res.headers['Content-Type']).toBe('audio/mpeg');

        // 8 s is byte 128,000: inside a frame, just before that frame's look-alike.
        // The stream begins with the next whole frame, not there.
        const sentFrom = data.length - (await (async () => { child.stdout.end(); await wait(20); child.emit('close', 0); await until(() => res.writableEnded, 'the end'); return res.body().length; })());
        expect(sentFrom).toBeGreaterThanOrEqual(8 * BYTES_PER_SECOND);
        expect(sentFrom).toBeLessThan(8 * BYTES_PER_SECOND + FRAME);
        expect(((8 * BYTES_PER_SECOND - TAG) % FRAME)).toBeLessThan(150); // the look-alike lies between the two
        expect((sentFrom - TAG) % FRAME).toBe(0);
        expect([...res.body().subarray(0, 4)]).toEqual([0xff, 0xfb, 0x94, 0x00]);
        // Not the look-alike in the middle of a frame: the frame's number follows.
        expect(res.body().readUInt32BE(4)).toBe((sentFrom - TAG) / FRAME);
        expect(res.body()).toEqual(data.subarray(sentFrom));
        expect(logSpy.mock.calls.map((c) => c[0]).join('\n')).toMatch(/Play youtube_seekjoinaaa: joined a conversion started \d+ ms earlier \(seek to 8 s\)/);
        lastChild().closed = true;
    });

    it('waits for the conversion to get there when the seek is ahead of it', async () => {
        play('youtube_seekwaitaaa');
        const child = lastChild();
        const data = mp3(600);
        child.stdout.write(data.subarray(0, 50000)); // 3 s converted so far
        await wait(40);

        const { res, joined } = seek('youtube_seekwaitaaa', 10);
        expect(joined).toBe(true);
        await wait(80);
        expect(res.body().length).toBe(0); // nothing yet: byte 160,000 is not written
        expect(res.writableEnded).toBe(false);

        child.stdout.write(data.subarray(50000));
        await until(() => res.body().length > 0, 'the seek to be answered');
        child.stdout.end();
        await wait(20);
        child.closed = true;
        child.emit('close', 0);
        await until(() => res.writableEnded, 'the end');
        const sentFrom = data.length - res.body().length;
        expect(sentFrom).toBeGreaterThanOrEqual(10 * BYTES_PER_SECOND);
        expect((sentFrom - TAG) % FRAME).toBe(0);
        expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('keeps the conversion going for the one who seeked when the first listener leaves', async () => {
        const first = play('youtube_seekkeepaaa');
        const child = lastChild();
        child.stdout.write(mp3(600));
        await until(() => first.body().length > 0, 'the first listener to get audio');
        const { res } = seek('youtube_seekkeepaaa', 2);
        await until(() => res.body().length > 0, 'the seek to be answered');
        first.destroy(); // the player dropped the old request when it seeked
        await wait(30);
        expect(child.kill).not.toHaveBeenCalled();
        expect(transcode._backgroundTranscodes()).toBe(0); // still listened to
        child.closed = true;
        child.emit('close', 0);
        await until(() => res.writableEnded, 'the end');
    });

    it('starts at the calculated byte when no frame can be recognised there', async () => {
        play('youtube_seekrawaaaa');
        const child = lastChild();
        child.stdout.write(audio(150000)); // not MP3 at all
        await wait(40);
        const { res } = seek('youtube_seekrawaaaa', 5);
        child.stdout.end();
        await wait(20);
        child.closed = true;
        child.emit('close', 0);
        await until(() => res.writableEnded, 'the end');
        expect(res.body()).toEqual(audio(150000).subarray(5 * BYTES_PER_SECOND));
    });

    it('ends with nothing for a position past the end, and with an error when the conversion failed', async () => {
        play('youtube_seekpastaaa');
        const child = lastChild();
        child.stdout.write(mp3(600));
        await wait(40);
        const past = seek('youtube_seekpastaaa', 60).res; // the track is 14 s long
        child.stdout.end();
        await wait(20);
        child.closed = true;
        child.emit('close', 0);
        await until(() => past.writableEnded, 'the end');
        expect(past.body().length).toBe(0);
        expect(past.status).not.toHaveBeenCalled();

        play('youtube_seekfailaaa');
        const failing = seek('youtube_seekfailaaa', 30).res;
        lastChild().closed = true;
        lastChild().emit('close', 1, null);
        await until(() => failing.writableEnded, 'the end');
        expect(failing.status).toHaveBeenCalledWith(502);
    });

    it('does not join a source that is passed through as it is: its bitrate is its own', async () => {
        play('soundcloud_seekcopya', fakeRes(), { sourceCodec: 'mp3' });
        lastChild().stdout.write(mp3(600));
        await wait(40);
        expect(seek('soundcloud_seekcopya', 5).joined).toBe(false);
    });

    it('reckons with the quality: the high setting is twice the bytes a second', async () => {
        const high = { query: { quality: 'high' }, playStartedAt: Date.now() };
        transcode.streamTranscoded(high, fakeRes(), { sourceUrl: 'https://media.example/a', cacheKey: 'youtube_seekhighaaa_q256', seekTime: 0, timing: { label: 'high' } });
        const child = lastChild();
        child.stdout.write(audio(200000));
        await wait(40);
        const res = fakeRes();
        expect(transcode.serveFromCache(res, 'youtube_seekhighaaa_q256', { req: { query: { quality: 'high', seek: '5' } }, seekTime: 5 })).toBe(true);
        child.stdout.end();
        await wait(20);
        child.closed = true;
        child.emit('close', 0);
        await until(() => res.writableEnded, 'the end');
        expect(res.body().length).toBe(200000 - 5 * 32000);
    });
});
