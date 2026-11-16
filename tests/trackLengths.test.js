// docs/performance-plan.md, step 1.2: track lengths are remembered across
// restarts (services/trackLengths.js), so the app does not start yt-dlp for a
// number it has already seen. Real database; yt-dlp is a counted stand-in.
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let dir;
let db;
let lengths;
const auth = { Authorization: `Bearer ${jwt.sign({ userId: 1, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// A new copy of every module, as after a restart, on the same database file.
async function restart() {
    if (db) await db.close();
    jest.resetModules();
    db = await require('../config/db')(path.join(dir, 'database.sqlite'));
    lengths = require('../services/trackLengths');
    lengths.use(db);
}

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-lengths-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    db = null;
    await restart();
});
afterEach(async () => {
    lengths._reset();
    await db.close();
    console.log.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('the store', () => {
    it('remembers a length across a restart, and only believable ones', async () => {
        lengths.remember('youtube', 'aaaaaaaaaaa', 212.4);
        lengths.remember('soundcloud', 42, 180);
        for (const [source, id, seconds] of [['youtube', 'bad', 0], ['youtube', 'bad', -5], ['youtube', 'bad', NaN], ['youtube', 'bad', 9e9], ['youtube', '', 100], ['deezer', '1', 100], ['local', '1', 100]]) {
            lengths.remember(source, id, seconds);
        }
        await settle();
        await restart();
        expect(lengths.peek('youtube', 'aaaaaaaaaaa')).toBeNull(); // nothing in memory yet
        expect(await lengths.known('youtube', 'aaaaaaaaaaa')).toBe(212);
        expect(await lengths.known('soundcloud', '42')).toBe(180);
        expect(await lengths.known('youtube', 'bad')).toBeNull();
        expect(await lengths.known('deezer', '1')).toBeNull();
        expect((await db.get('SELECT COUNT(*) AS n FROM track_lengths')).n).toBe(2);
        // A corrected length replaces the old one.
        lengths.remember('youtube', 'aaaaaaaaaaa', 215);
        await settle();
        await restart();
        expect(await lengths.known('youtube', 'aaaaaaaaaaa')).toBe(215);
    });

    it('completes a list both ways: learns the lengths it carries, fills the ones it lacks', async () => {
        await lengths.complete([
            { source: 'youtube', id: 'aaaaaaaaaaa', durationSec: 200 },
            { source: 'soundcloud', id: '7', durationSec: 95 },
            // What plays for these is not the catalogue length: not learned.
            { source: 'soundcloud', id: '8', durationSec: 300, preview: true },
            { source: 'deezer', id: '9', durationSec: 224, verifyDuration: true },
            { source: 'local', id: '3', durationSec: 60 }
        ]);
        await settle();
        await restart();
        const list = [
            { source: 'youtube', id: 'aaaaaaaaaaa', durationSec: null, title: 'kept' },
            { source: 'soundcloud', id: '7' },
            { source: 'soundcloud', id: '8', durationSec: null },
            { source: 'youtube', id: 'zzzzzzzzzzz', durationSec: null },
            { source: 'deezer', id: '9', durationSec: null },
            null
        ];
        expect(await lengths.complete(list)).toBe(list);
        expect(list.slice(0, 5).map((t) => t.durationSec)).toEqual([200, 95, null, null, null]);
        expect(list[0].title).toBe('kept');
        expect([...(await lengths.knownMany('youtube', ['aaaaaaaaaaa', 'zzzzzzzzzzz', 'aaaaaaaaaaa']))]).toEqual([['aaaaaaaaaaa', 200]]);
        expect(await lengths.complete([])).toEqual([]);
        expect(await lengths.complete(undefined)).toBeUndefined();
    });

    it('works without a database (memory only), and is trimmed to a bounded size with one', async () => {
        lengths._reset();
        lengths.remember('youtube', 'mmmmmmmmmmm', 100);
        expect(await lengths.known('youtube', 'mmmmmmmmmmm')).toBe(100);
        expect(await lengths.known('youtube', 'nnnnnnnnnnn')).toBeNull();
        expect(await lengths.trim()).toBe(0);

        lengths.use(db);
        await db.transaction(async () => {
            for (let i = 0; i < lengths.KEEP_ROWS + 25; i++) {
                await db.run('INSERT INTO track_lengths (source, external_id, duration_sec, updated_at) VALUES (?, ?, 100, ?)', ['youtube', `v${i}`, i]);
            }
        });
        expect(await lengths.trim()).toBe(25);
        // The oldest went.
        expect(await lengths.known('youtube', 'v0')).toBeNull();
        expect(await lengths.known('youtube', `v${lengths.KEEP_ROWS + 24}`)).toBe(100);
    });
});

describe('what it saves', () => {
    it('a YouTube track played before needs no yt-dlp run for its length, even after a restart', async () => {
        let YouTubeController = require('../controllers/YouTubeController');
        const runs = [];
        const stub = (controller) => {
            controller.runner.execFile = jest.fn((file, args, options, done) => {
                runs.push(args[args.length - 1]);
                setTimeout(() => done(null, '212\nhttps://media.example/audio?expire=9999999999\n', ''), 0);
                return { kill: jest.fn() };
            });
        };
        stub(YouTubeController);
        expect(await YouTubeController.durationOf('aaaaaaaaaaa')).toBe(212);
        expect(runs).toHaveLength(1);
        expect(await YouTubeController.durationOf('aaaaaaaaaaa')).toBe(212);
        expect(runs).toHaveLength(1);

        await settle();
        await restart();
        YouTubeController = require('../controllers/YouTubeController');
        stub(YouTubeController);
        expect(await YouTubeController.durationOf('aaaaaaaaaaa')).toBe(212);
        expect(runs).toHaveLength(1); // straight from the database
        expect(await YouTubeController.durationOf('bbbbbbbbbbb')).toBe(212);
        expect(runs).toHaveLength(2); // a track never seen still asks
    });

    it('Recently Played and a custom playlist carry the lengths that are known', async () => {
        const app = require('../app');
        app.locals.db = db;
        await db.run(`INSERT INTO users (id, username, password) VALUES (1, 'u', 'x')`);
        lengths.remember('youtube', 'aaaaaaaaaaa', 212);
        await request(app).post('/history').set(auth).send({ trackId: 'aaaaaaaaaaa', title: 'Known', artist: 'A', source: 'youtube' });
        await request(app).post('/history').set(auth).send({ trackId: 'bbbbbbbbbbb', title: 'Unknown', artist: 'A', source: 'youtube' });
        const history = (await request(app).get('/history').set(auth)).body;
        expect(history.map((h) => [h.title, h.durationSec])).toEqual([['Unknown', undefined], ['Known', 212]]);

        const playlist = (await request(app).post('/api/custom-playlists').set(auth).send({ name: 'Mix' })).body.id;
        await request(app).post(`/api/custom-playlists/${playlist}/tracks`).set(auth).send({ sourceName: 'youtube', externalId: 'aaaaaaaaaaa', title: 'Known', artist: 'A' });
        const tracks = (await request(app).get(`/api/library/custom/playlists/${playlist}/tracks`).set(auth)).body.items;
        expect(tracks[0]).toMatchObject({ source: 'youtube', id: 'aaaaaaaaaaa', durationSec: 212 });
    });

    it('SoundCloud through yt-dlp: the look-up for the audio also leaves the length behind', async () => {
        const ytdlp = require('../controllers/soundcloud/ytdlp');
        ytdlp.runner.exec = jest.fn().mockResolvedValue('183.4\nhttps://cf-media.sndcdn.com/a.128.mp3\nhttp_mp3_1_0\n');
        await ytdlp.resolveStream('4242');
        // A snippet of a Go+ track is not the track's length.
        ytdlp.runner.exec.mockResolvedValueOnce('30\nhttps://cf-preview-media.sndcdn.com/p.mp3\nhttp_mp3_1_0_preview\n');
        await ytdlp.resolveStream('4343');
        await settle();
        await restart();
        expect(await lengths.known('soundcloud', '4242')).toBe(183);
        expect(await lengths.known('soundcloud', '4343')).toBeNull();
    });
});
