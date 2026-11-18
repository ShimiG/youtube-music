// SoundCloud through yt-dlp: an MP3 rendition is handed to ffmpeg as an
// address (passed through as it is); an AAC or Opus one is downloaded by
// yt-dlp and piped into ffmpeg, because ffmpeg fetching it itself decodes it
// as noise (controllers/soundcloud/ytdlp.js, controllers/soundcloudController.js).
const ytdlp = require('../controllers/soundcloud/ytdlp');
const trackLengths = require('../services/trackLengths');
const { fakeProcess } = require('./helpers/fakeProcess');

const mockStreamTranscoded = jest.fn();
jest.mock('../controllers/transcode', () => ({
    ...jest.requireActual('../controllers/transcode'),
    serveFromCache: () => false,
    streamTranscoded: (...args) => mockStreamTranscoded(...args)
}));
const soundcloudController = require('../controllers/soundcloudController');

const { EventEmitter } = require('events');
function fakeRes() {
    const res = new EventEmitter();
    res.writableFinished = false;
    res.headersSent = false;
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const KEYS = ['SOUNDCLOUD_CLIENT_ID', 'SOUNDCLOUD_CLIENT_SECRET', 'SOUNDCLOUD_PROVIDER'];
let saved;
let originalExec;
let originalSpawn;

beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k]; // no API credentials: yt-dlp
    originalExec = ytdlp.runner.exec;
    originalSpawn = ytdlp.runner.spawn;
    ytdlp._reset();
    mockStreamTranscoded.mockReset();
});
afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    ytdlp.runner.exec = originalExec;
    ytdlp.runner.spawn = originalSpawn;
});

async function play(id, lookupAnswer, query = {}) {
    ytdlp.runner.exec = jest.fn(async () => lookupAnswer);
    const res = fakeRes();
    await soundcloudController.streamTrack({ query: { videoId: id, ...query }, app: { locals: { db: null } } }, res);
    await settle();
    return { res, options: mockStreamTranscoded.mock.calls.length ? mockStreamTranscoded.mock.calls[0][2] : null };
}

describe('which renditions are downloaded by yt-dlp', () => {
    it('hands ffmpeg the address of an MP3 rendition, passed through as it is', async () => {
        for (const format of ['http_mp3_1_0', 'hls_mp3_1_0']) {
            mockStreamTranscoded.mockReset();
            ytdlp._reset();
            const { options } = await play('1001', `183\nhttps://cf-media.sndcdn.com/a.128.mp3\n${format}\n`);
            expect(options).toMatchObject({ sourceUrl: 'https://cf-media.sndcdn.com/a.128.mp3', sourceCodec: 'mp3', allowCache: true });
            expect(options.feed).toBeUndefined();
        }
    });

    it('has yt-dlp download an AAC or Opus rendition, in exactly the rendition chosen', async () => {
        const spawned = [];
        ytdlp.runner.spawn = jest.fn((bin, args, opts) => { const child = fakeProcess(); spawned.push({ args, opts, child }); return child; });
        for (const format of ['hls_aac_160k', 'hls-aes_aac_160k', 'hls_opus_64']) {
            mockStreamTranscoded.mockReset();
            ytdlp._reset();
            const { options, res } = await play('2002', `200\nhttps://cf-hls-media.sndcdn.com/playlist/x.m3u8\n${format}\n`);
            expect(options.sourceUrl).toBeUndefined();
            expect(options.sourceCodec).toBeUndefined(); // converted, not passed through
            expect(options).toMatchObject({ cacheKey: 'soundcloud_2002', seekTime: 0, allowCache: true, timing: { label: 'soundcloud 2002', resolvedBy: 'yt-dlp' } });
            expect(typeof options.feed).toBe('function');
            expect(ytdlp.runner.spawn).toHaveBeenCalledTimes(spawned.length); // nothing started until the conversion asks
            options.feed();
            const { args, opts } = spawned[spawned.length - 1];
            expect(args.slice(0, 2)).toEqual(['-f', format]);
            expect(args.join(' ')).toContain('-o -');
            expect(args).not.toContain('--js-runtimes'); // only YouTube needs one
            expect(args[args.length - 1]).toBe('https://api.soundcloud.com/tracks/2002');
            expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
            expect(res.json).not.toHaveBeenCalled();
        }
    });

    it('keeps a preview out of the cache and its length out of the remembered lengths', async () => {
        trackLengths._reset();
        let child;
        ytdlp.runner.spawn = jest.fn(() => { child = fakeProcess(); return child; });
        const { options } = await play('3003', '30\nhttps://cf-hls-media.sndcdn.com/playlist/0/30/x.m3u8\nhls_aac_160k_preview\n');
        expect(options.allowCache).toBe(false);
        options.feed();
        child.stderr.write('length: 30\n');
        await settle();
        expect(trackLengths.peek('soundcloud', '3003')).toBeFalsy();
    });

    it("says why in yt-dlp's own words when the download fails", async () => {
        let child;
        ytdlp.runner.spawn = jest.fn(() => { child = fakeProcess(); return child; });
        const { options } = await play('4004', '200\nhttps://cf-hls-media.sndcdn.com/x.m3u8\nhls_aac_160k\n');
        const feed = options.feed();
        child.stderr.write('ERROR: [soundcloud] 4004: Unable to download JSON metadata: HTTP Error 401\n');
        await settle();
        expect(feed.failure(1, null)).toBe('yt-dlp: ERROR: [soundcloud] 4004: Unable to download JSON metadata: HTTP Error 401');
        expect(feed.failure(0, null)).toBe('yt-dlp: ERROR: [soundcloud] 4004: Unable to download JSON metadata: HTTP Error 401');
    });

    it('accepts only a track id and a format id that are plain', () => {
        expect(() => ytdlp.downloadFeed('12ab', 'hls_aac_160k')).toThrow(/Invalid SoundCloud id/);
        expect(() => ytdlp.downloadFeed('5005', '-o /etc/passwd')).toThrow(/Invalid SoundCloud format/);
        expect(() => ytdlp.downloadFeed('5005', '')).toThrow(/Invalid SoundCloud format/);
        expect(ytdlp.handsOverAddress('http_mp3_1_0')).toBe(true);
        expect(ytdlp.handsOverAddress('hls_aac_160k')).toBe(false);
        expect(ytdlp.handsOverAddress(undefined)).toBe(false);
    });

    it('never starts a real download from a test that forgot its stand-in', () => {
        expect(() => ytdlp.downloadFeed('6006', 'hls_aac_160k')()).toThrow(/not run in tests/);
    });
});
