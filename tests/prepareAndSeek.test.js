// docs/performance-plan.md, steps 0, 1.3 and 1.4, in controllers/transcode.js:
// getting the next track ready without playing it (?prepare=1), seeking inside
// a track that is already in the disk cache, and the per-play line in the log.
// ffmpeg is a fake child process; the cache is a real folder in a temp dir.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-prepare-'));
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

const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const transcode = require('../controllers/transcode');

function fakeRes() {
    const res = new PassThrough();
    res.writableFinished = false;
    res.headersSent = false;
    res.setHeader = jest.fn();
    res.set = jest.fn();
    res.status = jest.fn(() => res);
    res.json = jest.fn();
    res.sendFile = jest.fn();
    return res;
}

const prepareReq = () => ({ query: { prepare: '1' } });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cacheFile = (key) => path.join(transcode.cacheDir, `${key}.mp3`);
const lastArgs = () => spawn.mock.calls[spawn.mock.calls.length - 1][1];

let logSpy;
beforeEach(() => {
    spawn.mockClear();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
    mockChildren.splice(0).forEach((c) => c.emit('close', 1));
    await wait(300); // the cache finaliser runs 250 ms after ffmpeg exits
    logSpy.mockRestore();
});
afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.MUSIC_DATA_DIR;
});

describe('preparing the next track (?prepare=1)', () => {
    it('answers at once and converts into the cache with no listener', async () => {
        const res = fakeRes();
        transcode.streamTranscoded(prepareReq(), res, { sourceUrl: 'https://media.example/a', cacheKey: 'youtube_prepaaaaaaa', seekTime: 0 });
        expect(res.json).toHaveBeenCalledWith({ prepared: 'started' });
        expect(res.setHeader).not.toHaveBeenCalledWith('Content-Type', 'audio/mpeg');
        expect(spawn).toHaveBeenCalledTimes(1);
        // It is a background conversion from the start, and counted as one.
        expect(transcode._backgroundTranscodes()).toBe(1);

        // The audio goes to the cache file only: nothing is written to the response.
        const sent = [];
        res.on('data', (chunk) => sent.push(chunk));
        mockChildren[0].stdout.write(Buffer.alloc(150000, 1));
        mockChildren[0].stdout.end();
        await wait(30);
        mockChildren[0].emit('close', 0);
        await wait(300);
        expect(sent).toHaveLength(0);
        expect(fs.statSync(cacheFile('youtube_prepaaaaaaa')).size).toBe(150000);
        expect(transcode._backgroundTranscodes()).toBe(0);
        expect(logSpy.mock.calls.some(([line]) => /^Prepared youtube_prepaaaaaaa in \d+ ms$/.test(line))).toBe(true);
    });

    it('does nothing when the track is already cached, being cached, or cannot be cached', () => {
        fs.writeFileSync(cacheFile('youtube_haveaaaaaaa'), Buffer.alloc(200000));
        const cached = fakeRes();
        expect(transcode.serveFromCache(cached, 'youtube_haveaaaaaaa', { req: prepareReq(), seekTime: 0 })).toBe(true);
        expect(cached.json).toHaveBeenCalledWith({ prepared: 'cached' });
        expect(cached.sendFile).not.toHaveBeenCalled();

        // A play is writing the cache right now: a prepare for it starts nothing.
        transcode.streamTranscoded({ query: {} }, fakeRes(), { sourceUrl: 'https://media.example/a', cacheKey: 'youtube_busyaaaaaaa', seekTime: 0 });
        const again = fakeRes();
        transcode.streamTranscoded(prepareReq(), again, { sourceUrl: 'https://media.example/a', cacheKey: 'youtube_busyaaaaaaa', seekTime: 0 });
        expect(again.json).toHaveBeenCalledWith({ prepared: 'in_progress' });

        const preview = fakeRes();
        transcode.streamTranscoded(prepareReq(), preview, { sourceUrl: 'https://media.example/p', cacheKey: 'deezer_1', seekTime: 0, allowCache: false });
        expect(preview.json).toHaveBeenCalledWith({ prepared: 'skipped' });
        const seeked = fakeRes();
        transcode.streamTranscoded({ query: { prepare: '1', seek: '30' } }, seeked, { sourceUrl: 'https://media.example/a', cacheKey: 'youtube_seekaaaaaaa', seekTime: 30 });
        expect(seeked.json).toHaveBeenCalledWith({ prepared: 'skipped' });
        expect(spawn).toHaveBeenCalledTimes(1); // only the play started ffmpeg
    });

    it('never runs more background conversions than the limit', () => {
        const max = transcode.MAX_BACKGROUND_TRANSCODES;
        const answers = [];
        for (let i = 0; i < max + 2; i++) {
            const res = fakeRes();
            transcode.streamTranscoded(prepareReq(), res, { sourceUrl: 'https://media.example/a', cacheKey: `youtube_lim${i}aaaaaaa`, seekTime: 0 });
            answers.push(res.json.mock.calls[0][0].prepared);
        }
        expect(answers).toEqual([...Array(max).fill('started'), 'busy', 'busy']);
        expect(spawn).toHaveBeenCalledTimes(max);
        expect(transcode._backgroundTranscodes()).toBe(max);
    });

    it('only the exact value 1 means prepare', () => {
        for (const value of [undefined, '0', 'true', ['1'], 1]) {
            expect(transcode.isPrepare({ query: { prepare: value } })).toBe(false);
        }
        expect(transcode.isPrepare({ query: { prepare: '1' } })).toBe(true);
        expect(transcode.isPrepare(undefined)).toBe(false);
    });
});

describe('seeking inside a cached track', () => {
    it('converts from the cached file at the asked position instead of sending it from the start', () => {
        fs.writeFileSync(cacheFile('youtube_seekcached1'), Buffer.alloc(200000));
        const res = fakeRes();
        expect(transcode.serveFromCache(res, 'youtube_seekcached1', { req: { query: { seek: '95' } }, seekTime: 95 })).toBe(true);
        expect(res.sendFile).not.toHaveBeenCalled();
        const args = lastArgs();
        expect(args.slice(0, 4)).toEqual(['-ss', '95', '-i', cacheFile('youtube_seekcached1')]);
        // A local file: none of the network-only options.
        expect(args.join(' ')).not.toContain('reconnect');
        // And the seeked output must not replace the cached full track.
        expect(fs.readdirSync(transcode.cacheDir).filter((f) => f.endsWith('.part'))).toHaveLength(0);
    });

    it('still sends the whole file, with range support, for a normal play', () => {
        fs.writeFileSync(cacheFile('youtube_wholeaaaaaa'), Buffer.alloc(200000));
        const res = fakeRes();
        expect(transcode.serveFromCache(res, 'youtube_wholeaaaaaa', { req: { query: {}, playStartedAt: Date.now() }, seekTime: 0 })).toBe(true);
        expect(res.sendFile).toHaveBeenCalledWith(cacheFile('youtube_wholeaaaaaa'));
        expect(spawn).not.toHaveBeenCalled();
        expect(logSpy.mock.calls.some(([line]) => /^Play youtube_wholeaaaaaa: from the disk cache, \d+ ms after the request$/.test(line))).toBe(true);
        // Callers from before this change pass no options: same behaviour.
        const old = fakeRes();
        expect(transcode.serveFromCache(old, 'youtube_wholeaaaaaa')).toBe(true);
        expect(old.sendFile).toHaveBeenCalled();
        expect(transcode.serveFromCache(fakeRes(), 'youtube_missingaaaa', { req: { query: {} }, seekTime: 0 })).toBe(false);
    });
});

describe('the per-play line in the log', () => {
    it('says what the wait was made of, once, when the first audio is ready', async () => {
        const res = fakeRes();
        transcode.streamTranscoded({ query: {}, playStartedAt: Date.now() - 2000 }, res, {
            sourceUrl: 'https://media.example/a',
            cacheKey: 'youtube_logaaaaaaaa',
            seekTime: 0,
            timing: { label: 'youtube logaaaaaaaa', resolveMs: 1840, resolvedBy: 'yt-dlp' }
        });
        res.resume();
        mockChildren[0].stdout.write(Buffer.alloc(1000));
        mockChildren[0].stdout.write(Buffer.alloc(1000));
        await wait(20);
        const lines = logSpy.mock.calls.map(([line]) => line).filter((line) => /^Play /.test(line));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^Play youtube logaaaaaaaa: address 1840 ms \(yt-dlp\), first audio \d+ ms after starting ffmpeg, \d{4,} ms after the request$/);
    });

    it('tells the caller when ffmpeg got no audio out of the address, and only then', async () => {
        const failed = jest.fn();
        transcode.streamTranscoded({ query: {} }, fakeRes(), { sourceUrl: 'https://media.example/gone', cacheKey: 'youtube_goneaaaaaaa', seekTime: 10, onSourceFailed: failed });
        mockChildren[0].emit('close', 1);
        expect(failed).toHaveBeenCalledTimes(1);

        const fine = jest.fn();
        const res = fakeRes();
        res.resume();
        transcode.streamTranscoded({ query: {} }, res, { sourceUrl: 'https://media.example/ok', cacheKey: 'youtube_okaaaaaaaaa', seekTime: 10, onSourceFailed: fine });
        mockChildren[1].stdout.write(Buffer.alloc(1000));
        await wait(20);
        mockChildren[1].emit('close', 1); // the listener left mid-track: not the address's fault
        expect(fine).not.toHaveBeenCalled();
    });
});
