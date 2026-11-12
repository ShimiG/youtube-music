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
    res.json = jest.fn();
    res.sendFile = jest.fn();
    return res;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what) => {
    for (let i = 0; i < 200; i++) {
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
    mockChildren.splice(0).forEach((c) => { if (!c.closed) c.emit('close', 1); });
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
        expect(partFiles()).toEqual([]);
        expect(transcode._jobs.size).toBe(0);
        expect(logSpy.mock.calls.filter(([line]) => /^Play .*first audio \d+ ms after starting ffmpeg/.test(line))).toHaveLength(1);
    });

    it('does not wait for a listener who has stopped reading: the cache completes anyway', async () => {
        const res = play('youtube_stuckaaaaaa', fakeRes({ stuck: true }));
        const child = lastChild();
        const whole = audio(400000);
        await convert(child, whole);
        // The player took the first bytes and no more; the track is in the cache regardless.
        await until(() => fs.existsSync(cacheFile('youtube_stuckaaaaaa')), 'the cache file');
        expect(fs.statSync(cacheFile('youtube_stuckaaaaaa')).size).toBe(whole.length);
        expect(res.body().length).toBeLessThan(whole.length);
        expect(child.stdout.isPaused()).toBe(false);
        expect(transcode._activeTranscodes()).toBe(0);

        // When the player reads on, it gets the rest, from the finished file.
        const pump = setInterval(() => res.release(), 1);
        await until(() => res.writableEnded, 'the end of the response');
        clearInterval(pump);
        expect(res.body().equals(whole)).toBe(true);
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
        // A seek cannot be served from a file that is still growing.
        expect(transcode.serveFromCache(fakeRes(), 'youtube_prepskipaaa', { req: { query: { seek: '30' } }, seekTime: 30 })).toBe(false);

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
        expect(partFiles()).toEqual([]);
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

    it('answers 500 and frees its slot when ffmpeg cannot be started', async () => {
        const res = play('youtube_nostartaaaa');
        lastChild().closed = true;
        lastChild().emit('error', new Error('spawn ENOENT'));
        await until(() => res.status.mock.calls.length > 0, 'the error answer');
        expect(res.status).toHaveBeenCalledWith(500);
        expect(transcode._activeTranscodes()).toBe(0);
        expect(transcode._jobs.size).toBe(0);
        expect(partFiles()).toEqual([]);
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
