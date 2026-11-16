// What the app can say about recent plays (services/playReport.js): how long
// each took, what the wait was made of, and why one failed. First the record
// keeping on its own, then through the server: a play that yt-dlp refuses must
// leave yt-dlp's own words where the app can show them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('keeping the record', () => {
    const playReport = require('../services/playReport');

    function fakeRes() {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.writableFinished = false;
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = jest.fn();
        return res;
    }
    const reqFor = (query = {}, { userId = 1, range } = {}) => ({ query, userId, headers: range ? { range } : {} });
    const start = (id = 'aaaaaaaaaaa', opts) => {
        const req = reqFor({ videoId: id }, opts);
        const res = fakeRes();
        playReport.begin(req, res, { source: 'youtube', id });
        return res;
    };

    beforeEach(() => playReport._reset());

    it('notes a play that produced sound, with what the wait was made of', async () => {
        const res = start();
        await wait(15);
        playReport.playing(res, { addressMs: 1234.4, addressFrom: 'yt-dlp', how: 'conversion' });
        res.writableFinished = true;
        res.emit('finish');
        const [play] = playReport.recent();
        expect(play).toMatchObject({ source: 'youtube', id: 'aaaaaaaaaaa', status: 'playing', addressMs: 1234, addressFrom: 'yt-dlp', how: 'conversion', reason: null });
        expect(play.ms).toBeGreaterThanOrEqual(10);
        // Whose play it was is used for filtering and not handed out.
        expect(play).not.toHaveProperty('userId');
    });

    it("takes the reason from the handler when there is one, and otherwise from the error answer", () => {
        const told = start('bbbbbbbbbbb');
        playReport.reason(told, 'yt-dlp: ERROR: Sign in to confirm you are not a bot');
        told.status(502).json({ error: 'This track is unavailable', reason: 'resolve_failed' });
        told.emit('finish');

        const untold = start('ccccccccccc');
        untold.status(503).json({ error: 'The server is busy', reason: 'too_many' });
        untold.emit('finish');

        const [second, first] = playReport.recent();
        expect(first).toMatchObject({ id: 'bbbbbbbbbbb', status: 'failed', reason: 'yt-dlp: ERROR: Sign in to confirm you are not a bot' });
        expect(second).toMatchObject({ id: 'ccccccccccc', status: 'failed', reason: 'The server is busy (too_many)' });
    });

    it('counts an empty stream as a failure when the conversion said so', () => {
        const res = start();
        playReport.reason(res, 'ffmpeg: Server returned 404 Not Found', { failed: true });
        res.writableFinished = true; // the response itself ended normally
        res.emit('finish');
        expect(playReport.recent()[0]).toMatchObject({ status: 'failed', reason: 'ffmpeg: Server returned 404 Not Found' });
        expect(playReport.recent()[0]).not.toHaveProperty('failed');
    });

    it('tells a listener who moved on from a failure, and a file sent as it is from a conversion', () => {
        const left = start('ddddddddddd');
        left.emit('close'); // nothing sent, nothing finished
        const file = start('eeeeeeeeeee');
        file.writableFinished = true;
        file.emit('finish');
        const [second, first] = playReport.recent();
        expect(first).toMatchObject({ id: 'ddddddddddd', status: 'left', reason: null });
        expect(second).toMatchObject({ id: 'eeeeeeeeeee', status: 'playing', how: 'file' });
    });

    it('settles once: what happens after the first sound does not change the entry', () => {
        const res = start();
        playReport.playing(res, { how: 'cache' });
        playReport.reason(res, 'too late', { failed: true });
        res.emit('close');
        expect(playReport.recent()[0]).toMatchObject({ status: 'playing', how: 'cache', reason: null });
    });

    it('keeps no entry for preparing the next track or for a later part of a file', () => {
        expect(playReport.begin(reqFor({ videoId: 'x', prepare: '1' }), fakeRes(), { source: 'youtube', id: 'x' })).toBeNull();
        expect(playReport.begin(reqFor({ videoId: 'x' }, { range: 'bytes=65536-' }), fakeRes(), { source: 'youtube', id: 'x' })).toBeNull();
        expect(playReport.begin(reqFor({ videoId: 'x' }, { range: 'bytes=0-' }), fakeRes(), { source: 'youtube', id: 'x' })).not.toBeNull();
        expect(playReport.recent()).toHaveLength(1);
        // And reporting on a response that has no entry is harmless.
        expect(() => playReport.playing(fakeRes(), {})).not.toThrow();
        expect(() => playReport.reason(undefined, 'x')).not.toThrow();
    });

    it('holds a fixed number of entries, newest first, and cleans what it is told', () => {
        for (let i = 0; i < playReport.MAX_ENTRIES + 5; i++) start(`id${i}`).emit('close');
        expect(playReport.recent({ limit: 500 })).toHaveLength(playReport.MAX_ENTRIES);
        expect(playReport.recent({ limit: 1 })[0].id).toBe(`id${playReport.MAX_ENTRIES + 4}`);
        expect(playReport.recent()).toHaveLength(20);

        const res = start('messy');
        playReport.reason(res, `ERROR:\u001b[0m line one\nline two ${'x'.repeat(1000)}`);
        res.status(502).emit('finish');
        const { reason } = playReport.recent({ limit: 1 })[0];
        expect(reason.startsWith('ERROR: [0m line one line two')).toBe(true);
        expect(reason.length).toBeLessThanOrEqual(300);
    });

    it("shows an account its own plays and those that are nobody's; everything when asked for all", () => {
        start('mine', { userId: 1 }).emit('close');
        start('theirs', { userId: 2 }).emit('close');
        playReport.rejected({ query: { source: 'soundcloud', videoId: '42' } }, 'too many requests');
        expect(playReport.recent({ userId: 1 }).map((p) => p.id)).toEqual(['42', 'mine']);
        expect(playReport.recent({ userId: 2 }).map((p) => p.id)).toEqual(['42', 'theirs']);
        expect(playReport.recent().map((p) => p.id)).toEqual(['42', 'theirs', 'mine']);
        expect(playReport.recent({ source: 'soundcloud', id: '42' })).toEqual([expect.objectContaining({ status: 'failed', reason: 'too many requests', ms: 0 })]);
        expect(playReport.recent({ userId: 1, source: 'youtube', id: 'theirs' })).toEqual([]);
    });

    it('keeps one entry for a burst of requests turned away, so it cannot push the plays out', () => {
        start('real').emit('close');
        for (let i = 0; i < 200; i++) playReport.rejected({ query: { videoId: `junk${i}` } }, 'too many requests');
        expect(playReport.recent({ limit: 60 }).map((p) => p.id)).toEqual(['junk199', 'real']);
        expect(playReport.recent()[0]).toMatchObject({ source: 'youtube' });
        expect(playReport.recent()[0]).not.toHaveProperty('turnedAway');
    });
});

describe('through the server', () => {
    let tmp;
    let db;
    let app;
    let YouTubeController;
    let withMedia;
    const authFor = (userId) => ({ Authorization: `Bearer ${jwt.sign({ userId, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` });
    const plays = async (userId, query = '') => (await request(app).get(`/api/system/plays${query}`).set(authFor(userId))).body.plays;

    beforeAll(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-plays-'));
        process.env.MUSIC_DATA_DIR = tmp;
        jest.resetModules();
        db = await require('../config/db')();
        app = require('../app');
        app.locals.db = db;
        YouTubeController = require('../controllers/YouTubeController');
        ({ withMedia } = require('./helpers/media'));
        await db.run(`INSERT INTO users (id, username, password) VALUES (1, 'first', 'x'), (2, 'second', 'x')`);
        jest.spyOn(console, 'error').mockImplementation(() => {});
        // yt-dlp refuses every video, the way YouTube's bot check makes it.
        YouTubeController.runner.execFile = jest.fn((bin, args, opts, cb) => {
            cb(Object.assign(new Error('Command failed'), { code: 1 }), '', 'ERROR: [youtube] xxxxxxxxxxx: Sign in to confirm you are not a bot\n');
            return { exitCode: 1, kill: jest.fn() };
        });
    });
    afterAll(async () => {
        console.error.mockRestore();
        await db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        delete process.env.MUSIC_DATA_DIR;
    });

    it('needs a login', async () => {
        expect((await request(app).get('/api/system/plays')).statusCode).toBe(401);
    });

    it("keeps yt-dlp's own words for a play that failed", async () => {
        const res = await request(app).get(withMedia('/stream?videoId=aaaaaaaaaaa', 2));
        expect(res.statusCode).toBe(502);
        const answer = await request(app).get('/api/system/plays?limit=1&source=youtube&id=aaaaaaaaaaa').set(authFor(2));
        expect(answer.headers['cache-control']).toBe('no-store');
        expect(answer.body.plays).toHaveLength(1);
        expect(answer.body.plays[0]).toMatchObject({ source: 'youtube', id: 'aaaaaaaaaaa', status: 'failed' });
        expect(answer.body.plays[0].reason).toMatch(/^yt-dlp: ERROR: \[youtube\] xxxxxxxxxxx: Sign in to confirm you are not a bot/);
        expect(answer.body.plays[0]).not.toHaveProperty('userId');
    });

    it('shows each account its own plays, and the first account everything', async () => {
        await request(app).get(withMedia('/stream?videoId=bbbbbbbbbbb', 1));
        expect((await plays(2)).map((p) => p.id)).toEqual(['aaaaaaaaaaa']);
        expect((await plays(1)).map((p) => p.id)).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa']);
        expect(await plays(2, '?id=bbbbbbbbbbb')).toEqual([]);
    });

    it('ignores filters that are not plain short text', async () => {
        expect(await plays(1, '?id=a&id=b')).toHaveLength(2);
        expect(await plays(1, `?source=${'y'.repeat(100)}`)).toHaveLength(2);
        expect(await plays(1, '?limit=abc')).toHaveLength(2);
    });

    it('keeps no entry for a request that only prepares the next track', async () => {
        await request(app).get(withMedia('/stream?videoId=ccccccccccc&prepare=1', 1));
        expect(await plays(1, '?id=ccccccccccc')).toEqual([]);
    });

    // Last on purpose: it uses up the address's allowance for this file's app.
    it('notes a request turned away by the rate limit, for whoever looks', async () => {
        let limited = null;
        for (let i = 0; i < 70 && !limited; i++) {
            const res = await request(app).get(withMedia('/stream?videoId=ddddddddddd&prepare=1', 1));
            if (res.statusCode === 429) limited = res;
        }
        expect(limited).not.toBeNull();
        expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });
        const [latest] = await plays(2, '?limit=1');
        expect(latest).toMatchObject({ source: 'youtube', id: 'ddddddddddd', status: 'failed', ms: 0 });
        expect(latest.reason).toMatch(/too many requests for audio/);
    });
});
