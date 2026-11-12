// Regression tests for the 2026-11-08 Exploiter findings (reports/security/).
const { EventEmitter } = require('events');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const client = require('../controllers/soundcloud/client');
const YouTubeController = require('../controllers/YouTubeController');
const { cleanTrackMeta } = require('../services/trackMeta');

const authHeader = { Authorization: `Bearer ${jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };

describe('soundcloud-cursor-ssrf-token-exfil: buildUrl pins the API origin', () => {
    const bypasses = [
        'http:127.0.0.1:4999/x',
        'http:/127.0.0.1/x',
        ' http://127.0.0.1/x',
        '\thttps://evil.example/x',
        '//evil.example/x',
        '\\\\evil.example/x',
        'https://api.soundcloud.com.evil.example/x',
        'https://api.soundcloud.com@evil.example/x',
        'http://api.soundcloud.com/tracks',
        'file:///etc/passwd',
        'data:text/plain,hi'
    ];

    it.each(bypasses)('rejects %j', (input) => {
        expect(() => client.buildUrl(input)).toThrow(expect.objectContaining({ code: 'BAD_CURSOR' }));
    });

    it('still accepts API paths and full API URLs', () => {
        expect(client.buildUrl('/tracks', { q: 'a b' })).toBe('https://api.soundcloud.com/tracks?q=a+b');
        expect(client.buildUrl('https://api.soundcloud.com/me/likes/tracks?cursor=abc'))
            .toBe('https://api.soundcloud.com/me/likes/tracks?cursor=abc');
    });
});

describe('jwt-verify-no-algorithm-pin: sessions must expire', () => {
    it('rejects a correctly signed token without exp', async () => {
        app.locals.db = { all: jest.fn().mockResolvedValue([]) };
        const forever = jwt.sign({ userId: 1, purpose: 'session' }, process.env.JWT_SECRET);
        const res = await request(app).get('/api/user/connections').set('Authorization', `Bearer ${forever}`);
        expect(res.statusCode).toBe(401);
    });

    it('rejects an HS512 token signed with the real secret', async () => {
        const hs512 = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { algorithm: 'HS512', expiresIn: '1h' });
        const res = await request(app).get('/api/user/connections').set('Authorization', `Bearer ${hs512}`);
        expect(res.statusCode).toBe(401);
    });
});

describe('oauth-error-log-injection', () => {
    it('logs only a sanitised, bounded error code', async () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await request(app).get('/auth/soundcloud/callback').query({ error: 'access_denied\n[INFO] forged line' + 'x'.repeat(200) });
        const logged = spy.mock.calls.find((c) => String(c[0]).includes('SoundCloud authorization denied'))[1];
        spy.mockRestore();
        expect(logged).not.toMatch(/[\r\n\s[\]]/);
        expect(logged.length).toBeLessThanOrEqual(64);
        expect(logged.startsWith('access_denied')).toBe(true);
    });
});

describe('ytdlp-stream-orphan-no-timeout', () => {
    let original;
    beforeEach(() => { original = YouTubeController.runner.execFile; });
    afterEach(() => { YouTubeController.runner.execFile = original; });

    function fakeChild() {
        const child = new EventEmitter();
        child.exitCode = null;
        child.kill = jest.fn(() => { child.exitCode = 137; });
        return child;
    }

    function fakeRes() {
        const res = new EventEmitter();
        res.writableFinished = false;
        res.headersSent = false;
        res.status = jest.fn(() => res);
        res.json = jest.fn(() => res);
        res.setHeader = jest.fn();
        return res;
    }

    it('passes a timeout and kills yt-dlp when the client disconnects, without starting ffmpeg', () => {
        const child = fakeChild();
        let callback;
        YouTubeController.runner.execFile = jest.fn((bin, args, opts, cb) => { callback = cb; return child; });

        const res = fakeRes();
        YouTubeController.streamTrack({ query: { videoId: 'aaaaaaaaaaa' } }, res);

        const opts = YouTubeController.runner.execFile.mock.calls[0][2];
        expect(opts.timeout).toBe(YouTubeController.YTDLP_TIMEOUT_MS);

        res.emit('close'); // client went away mid-resolve
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');

        // yt-dlp's late callback must not answer a dead response or spawn ffmpeg.
        callback(null, 'https://media.example/audio');
        expect(res.setHeader).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
    });

    it('does not kill anything after a normal response', () => {
        const child = fakeChild();
        YouTubeController.runner.execFile = jest.fn(() => child);
        const res = fakeRes();
        YouTubeController.getDuration({ query: { videoId: 'bbbbbbbbbbb' } }, res);
        res.writableFinished = true;
        res.emit('close');
        expect(child.kill).not.toHaveBeenCalled();
    });
});

describe('shared-track-metadata-poisoning: input validation', () => {
    it('keeps only https thumbnails and caps lengths', () => {
        expect(cleanTrackMeta({ title: 'Song', artist: 'A', thumbnail: 'http://tracker.example/p.gif' }))
            .toEqual({ title: 'Song', artist: 'A', thumbnail: null });
        expect(cleanTrackMeta({ title: 'Song', thumbnail: 'javascript:alert(1)' }).thumbnail).toBeNull();
        expect(cleanTrackMeta({ title: 'Song', thumbnail: 'https://i.ytimg.com/vi/x/default.jpg' }).thumbnail)
            .toBe('https://i.ytimg.com/vi/x/default.jpg');
        expect(cleanTrackMeta({ title: 'x'.repeat(10000) }).title).toHaveLength(300);
        expect(cleanTrackMeta({ title: 'a\nb\u0000c' }).title).toBe('a b c');
        expect(cleanTrackMeta({ title: '   ' })).toBeNull();
        expect(cleanTrackMeta({ title: 42 })).toBeNull();
    });
});

describe('shared-track-metadata-poisoning: each user keeps their own metadata', () => {
    beforeEach(() => {
        app.locals.db = {
            get: jest.fn()
                .mockResolvedValueOnce({ id: 1 })   // sources
                .mockResolvedValueOnce({ id: 77 }), // tracks
            run: jest.fn().mockResolvedValue({}),
            transaction: (fn) => fn(),
            all: jest.fn().mockResolvedValue([])
        };
    });

    it('POST /history stores the cleaned metadata on the history row', async () => {
        const res = await request(app).post('/history').set(authHeader).send({
            trackId: 'aaaaaaaaaaa', title: 'Mine', artist: 'Me', thumbnail: 'http://evil.example/x.png', source: 'youtube'
        });
        expect(res.statusCode).toBe(200);
        const insert = app.locals.db.run.mock.calls.find(([sql]) => sql.includes('INSERT INTO history'));
        expect(insert[1]).toEqual([1, 77, 'Mine', 'Me', null]);
    });

    it('GET /history prefers the per-user copy over the shared track row', async () => {
        await request(app).get('/history').set(authHeader);
        expect(app.locals.db.all.mock.calls[0][0]).toContain('COALESCE(h.title, t.title)');
    });

    it('rejects an oversized external id', async () => {
        const res = await request(app).post('/history').set(authHeader).send({ trackId: 'x'.repeat(500), title: 't' });
        expect(res.statusCode).toBe(400);
    });
});
