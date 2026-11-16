// YouTube playback: yt-dlp downloads the audio and ffmpeg converts what it is
// handed (controllers/YouTubeController.js, downloadFeed); the look-up without
// a download that is left, for a track's length; and what is said when either
// fails.
const { EventEmitter } = require('events');
const YouTubeController = require('../controllers/YouTubeController');

const mockStreamTranscoded = jest.fn();
jest.mock('../controllers/transcode', () => ({
    ...jest.requireActual('../controllers/transcode'),
    serveFromCache: () => false,
    streamTranscoded: (...args) => mockStreamTranscoded(...args)
}));

function fakeRes() {
    const res = new EventEmitter();
    res.writableFinished = false;
    res.headersSent = false;
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
}

const { fakeProcess } = require('./helpers/fakeProcess');
const trackLengths = require('../services/trackLengths');
const playReport = require('../services/playReport');
const ytdlp = require('../services/ytdlp');

let originalExecFile;
let originalSpawn;
let errorSpy;
let savedRuntime;
beforeEach(() => {
    originalExecFile = YouTubeController.runner.execFile;
    originalSpawn = YouTubeController.runner.spawn;
    YouTubeController._resetResolver();
    mockStreamTranscoded.mockReset();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    savedRuntime = process.env.YTDLP_JS_RUNTIME;
    delete process.env.YTDLP_JS_RUNTIME;
    ytdlp._forgetRuntime();
});
afterEach(() => {
    YouTubeController.runner.execFile = originalExecFile;
    YouTubeController.runner.spawn = originalSpawn;
    errorSpy.mockRestore();
    if (savedRuntime === undefined) delete process.env.YTDLP_JS_RUNTIME; else process.env.YTDLP_JS_RUNTIME = savedRuntime;
    ytdlp._forgetRuntime();
});

// Lets the promise chain behind a look-up, or a stream's events, run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Starts a play and hands back what the conversion was given.
function play(videoId = 'dQw4w9WgXcQ', query = {}) {
    const res = fakeRes();
    YouTubeController.streamTrack({ query: { videoId, ...query } }, res);
    const options = mockStreamTranscoded.mock.calls.length ? mockStreamTranscoded.mock.calls[mockStreamTranscoded.mock.calls.length - 1][2] : null;
    return { res, options };
}

// A yt-dlp download the test drives: what it was started with, and the process.
function stubDownload() {
    const runs = [];
    YouTubeController.runner.spawn = jest.fn((bin, args, opts) => {
        const child = fakeProcess();
        runs.push({ bin, args, opts, child });
        return child;
    });
    return runs;
}

// --- Playing: yt-dlp downloads the audio, ffmpeg converts what it is handed.
// (YouTube answers 403 when ffmpeg asks for the address itself.)
describe('a play is downloaded by yt-dlp', () => {
    it('gives the conversion a feed, not an address, and starts nothing by itself', () => {
        const runs = stubDownload();
        const { options } = play('dQw4w9WgXcQ', { seek: '90' });
        expect(mockStreamTranscoded).toHaveBeenCalledTimes(1);
        expect(typeof options.feed).toBe('function');
        expect(options.sourceUrl).toBeUndefined();
        expect(options).toMatchObject({ cacheKey: 'youtube_dQw4w9WgXcQ', seekTime: 90, timing: { label: 'youtube dQw4w9WgXcQ' } });
        // The conversion decides whether a process is needed at all (cache, limits).
        expect(runs).toHaveLength(0);
    });

    it('runs yt-dlp to download the best audio to its standard output', () => {
        const runs = stubDownload();
        play().options.feed();
        expect(runs).toHaveLength(1);
        const { args, opts } = runs[0];
        expect(args.slice(0, 3)).toEqual(['-f', 'bestaudio/best', '--no-playlist']);
        expect(args.join(' ')).toContain('-o -');
        // --print alone would only look the video up; this run has to download.
        expect(args).toContain('--no-simulate');
        expect(args[args.length - 1]).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        // It is given nothing to read, and its two outputs are read separately.
        expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    });

    it('points yt-dlp at a JavaScript runtime: the Node this server runs on, or the one named', () => {
        const runs = stubDownload();
        play('aaaaaaaaaa1').options.feed();
        expect(runs[0].args[runs[0].args.indexOf('--js-runtimes') + 1]).toBe(`node:${process.execPath}`);
        process.env.YTDLP_JS_RUNTIME = 'deno:/opt/homebrew/bin/deno';
        play('aaaaaaaaaa2').options.feed();
        expect(runs[1].args[runs[1].args.indexOf('--js-runtimes') + 1]).toBe('deno:/opt/homebrew/bin/deno');
        process.env.YTDLP_JS_RUNTIME = 'off';
        play('aaaaaaaaaa3').options.feed();
        expect(runs[2].args).not.toContain('--js-runtimes');
    });

    it('reads the length, what was chosen and the warnings from what yt-dlp writes beside the audio', async () => {
        const runs = stubDownload();
        const noteSpy = jest.spyOn(playReport, 'note').mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { res, options } = play('bbbbbbbbbb1');
        options.feed();
        const { stderr } = runs[0].child;
        // In pieces, as a pipe delivers it: a line is used once it is whole.
        stderr.write('WARNING: [youtube] Some formats may be mis');
        stderr.write('sing\nlength: 2');
        stderr.write('12\nchosen: format 251, https, opus\n');
        await settle();
        expect(trackLengths.peek('youtube', 'bbbbbbbbbb1')).toBe(212);
        expect(noteSpy.mock.calls.map((c) => [c[0], c[1]])).toEqual([
            [res, 'yt-dlp: WARNING: [youtube] Some formats may be missing'],
            [res, 'yt-dlp chose format 251, https, opus']
        ]);
        expect(warnSpy.mock.calls.filter((c) => /Some formats may be missing/.test(c[0]))).toHaveLength(1);
        noteSpy.mockRestore();
        warnSpy.mockRestore();
    });

    it('times the look-up as the wait for the first audio from yt-dlp', async () => {
        const runs = stubDownload();
        const { options } = play('bbbbbbbbbb2');
        expect(options.timing).toMatchObject({ resolveMs: null, resolvedBy: null });
        options.feed();
        await new Promise((resolve) => setTimeout(resolve, 15));
        runs[0].child.stdout.write(Buffer.alloc(1000));
        await settle();
        expect(options.timing.resolvedBy).toBe('yt-dlp');
        expect(options.timing.resolveMs).toBeGreaterThanOrEqual(10);
    });

    it("gives yt-dlp's own words when the download fails", async () => {
        const runs = stubDownload();
        const failed = play('cccccccccc1').options.feed();
        runs[0].child.stderr.write('WARNING: something minor\nERROR: [youtube] cccccccccc1: Sign in to confirm you’re not a bot\u001b[0m\n');
        await settle();
        const words = failed.failure(1, null);
        expect(words).toBe('yt-dlp: ERROR: [youtube] cccccccccc1: Sign in to confirm you’re not a bot [0m');
        expect(words).not.toContain(String.fromCharCode(27));
        // Its error stands even when the conversion ended first and stopped it.
        expect(failed.failure(null, 'SIGKILL', { endedByUs: true })).toBe(words);
    });

    it('reports no failure for a download that went well or was stopped, and says so when one ends without a word', async () => {
        const runs = stubDownload();
        const fine = play('cccccccccc2').options.feed();
        expect(fine.failure(0, null)).toBeNull();
        expect(fine.failure(null, 'SIGKILL', { endedByUs: true })).toBeNull();
        expect(fine.child).toBe(runs[0].child);

        const silent = play('cccccccccc3').options.feed();
        expect(silent.failure(2, null)).toBe('yt-dlp: unknown error (exit code 2)');
        expect(silent.failure(null, 'SIGSEGV')).toBe('yt-dlp: unknown error (ended by SIGSEGV)');
        expect(silent.failure(-1, null)).toMatch(/^yt-dlp not found at ".*"\. Install it \(brew install yt-dlp\) or set YTDLP_PATH\.$/);
    });

    it('refuses a video id that is not one, before anything is started', () => {
        const runs = stubDownload();
        for (const videoId of ['../../etc/passwd', 'short', 'aaaaaaaaaaaa', '']) {
            const { res } = play(videoId);
            expect(res.status).toHaveBeenCalledWith(400);
        }
        expect(mockStreamTranscoded).not.toHaveBeenCalled();
        expect(runs).toHaveLength(0);
    });

    it('never starts a real download in a test that forgot its stand-in', () => {
        expect(() => play('dddddddddd1').options.feed()).toThrow(/not run in tests/);
    });
});

// --- The look-up without a download: only for a track's length now.
describe("a track's length is looked up once", () => {
    const inAnHour = Math.floor(Date.now() / 1000) + 3600;
    const ADDRESS = `https://rr1.googlevideo.com/videoplayback?expire=${inAnHour}&sig=abc`;

    // A yt-dlp that answers when the test says so.
    function pendingYtDlp() {
        const runs = [];
        YouTubeController.runner.execFile = jest.fn((bin, args, opts, cb) => {
            const child = { exitCode: null, kill: jest.fn(() => { child.exitCode = 137; }) };
            runs.push({ args, opts, child, finish: (stdout, error = null, stderr = '') => { child.exitCode = error ? 1 : 0; cb(error, stdout, stderr); } });
            return child;
        });
        return runs;
    }
    const askLength = (videoId, res = fakeRes()) => { YouTubeController.getDuration({ query: { videoId } }, res); return res; };

    it('asks yt-dlp for the length without downloading, bounded by a timeout', async () => {
        const runs = pendingYtDlp();
        const res = askLength('eeeeeeeeee1');
        const { args, opts } = runs[0];
        expect(args.slice(0, 2)).toEqual(['-f', 'bestaudio/best']);
        expect(args).toContain('--no-playlist');
        expect(args.join(' ')).toContain('--print duration --print urls');
        expect(args).not.toContain('--no-simulate');
        expect(args).not.toContain('-o');
        expect(args[args.indexOf('--js-runtimes') + 1]).toBe(`node:${process.execPath}`);
        expect(args[args.length - 1]).toBe('https://www.youtube.com/watch?v=eeeeeeeeee1');
        expect(opts.timeout).toBe(YouTubeController.YTDLP_TIMEOUT_MS);
        runs[0].finish(`245\n${ADDRESS}\n`);
        await settle();
        expect(res.json).toHaveBeenCalledWith({ duration: 245 });
    });

    it('two requests at the same moment share one run, and the answer is remembered', async () => {
        const runs = pendingYtDlp();
        const first = askLength('eeeeeeeeee2');
        const second = askLength('eeeeeeeeee2');
        expect(runs).toHaveLength(1);
        runs[0].finish(`300\n${ADDRESS}\n`);
        await settle();
        expect(first.json).toHaveBeenCalledWith({ duration: 300 });
        expect(second.json).toHaveBeenCalledWith({ duration: 300 });
        const later = askLength('eeeeeeeeee2');
        await settle();
        expect(runs).toHaveLength(1);
        expect(later.json).toHaveBeenCalledWith({ duration: 300 });
    });

    it('a length learned from a download needs no look-up at all', async () => {
        const downloads = stubDownload();
        const runs = pendingYtDlp();
        play('eeeeeeeeee3').options.feed();
        downloads[0].child.stderr.write('length: 187\n');
        await settle();
        const res = askLength('eeeeeeeeee3');
        await settle();
        expect(runs).toHaveLength(0);
        expect(res.json).toHaveBeenCalledWith({ duration: 187 });
    });

    it('keeps yt-dlp running while anyone still waits, and kills it when the last one leaves', async () => {
        const runs = pendingYtDlp();
        const first = askLength('eeeeeeeeee4');
        const second = askLength('eeeeeeeeee4');
        first.emit('close');
        expect(runs[0].child.kill).not.toHaveBeenCalled();
        second.emit('close');
        expect(runs[0].child.kill).toHaveBeenCalledWith('SIGKILL');
        // A request that arrives now starts its own run instead of joining the dying one.
        askLength('eeeeeeeeee4');
        expect(runs).toHaveLength(2);
        // The killed run ending late starts nothing further.
        runs[0].finish('', Object.assign(new Error('killed'), { killed: true }));
        await settle();
        expect(runs).toHaveLength(2);
    });

    it("logs yt-dlp's own error line when the look-up fails, answers 502, and does not remember the failure", async () => {
        const runs = pendingYtDlp();
        const res = askLength('eeeeeeeeee5');
        const stderr = 'WARNING: something minor\nERROR: [youtube] eeeeeeeeee5: Video unavailable\n';
        runs[0].finish('', Object.assign(new Error('Command failed'), { code: 1 }), stderr);
        await settle();
        expect(errorSpy.mock.calls[0][0]).toContain('ERROR: [youtube] eeeeeeeeee5: Video unavailable');
        expect(res.status).toHaveBeenCalledWith(502);
        askLength('eeeeeeeeee5');
        expect(runs).toHaveLength(2);
    });

    it('knows when a remembered address stops working', () => {
        const now = Date.now();
        const in20min = Math.floor(now / 1000) + 20 * 60;
        // 10 minutes are kept in hand.
        expect(YouTubeController.urlExpiry(`https://x.googlevideo.com/videoplayback?expire=${in20min}&x=1`, now)).toBe(in20min * 1000 - 10 * 60 * 1000);
        expect(YouTubeController.urlExpiry(`https://x.googlevideo.com/api/manifest/hls/expire/${in20min}/id/1`, now)).toBe(in20min * 1000 - 10 * 60 * 1000);
        // No stated time: half an hour. A far-away one: capped at five hours.
        expect(YouTubeController.urlExpiry('https://cdn.example/audio.m4a', now)).toBe(now + 30 * 60 * 1000);
        expect(YouTubeController.urlExpiry(`https://x/videoplayback?expire=${Math.floor(now / 1000) + 86400}`, now)).toBe(now + 5 * 60 * 60 * 1000);
    });
});

describe('putting a yt-dlp failure into words', () => {
    it('says how to fix a missing yt-dlp', () => {
        const msg = YouTubeController.describeYtDlpFailure(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '');
        expect(msg).toMatch(/yt-dlp not found .*brew install yt-dlp.*YTDLP_PATH/);
    });

    it('reports a timeout and strips control characters from yt-dlp output', () => {
        expect(YouTubeController.describeYtDlpFailure({ killed: true }, '')).toMatch(/timed out/);
        expect(YouTubeController.describeYtDlpFailure({}, 'ERROR: bad\u001b[0m stuff')).not.toContain(String.fromCharCode(27));
    });
});
