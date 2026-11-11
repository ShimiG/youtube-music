// Lyrics (issue #30): the LRC parser, what is asked of the lyrics server, and
// GET /api/lyrics against a real database and real files in a temp folder.
// Tag reading (music-metadata, which Jest cannot load) is stubbed through
// tagReader.runner, and the lyrics server through lyrics.http.fetch.
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let tmp;
let music;
let db;
let app;
let lyrics;
let fetchMock;
let tags; // file name -> what music-metadata would return
const authFor = (userId) => ({ Authorization: `Bearer ${jwt.sign({ userId, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` });

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const notFound = () => json({ message: 'Failed to find specified track', name: 'TrackNotFound', statusCode: 404 }, 404);
const calls = () => fetchMock.mock.calls.map(([url]) => `${url.pathname}?${url.searchParams}`);

const write = (rel, content = 'ID3 fake audio bytes') => {
    const full = path.join(music, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
};

beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-lyrics-'));
    music = path.join(tmp, 'Music');
    fs.mkdirSync(music);
    process.env.MUSIC_DATA_DIR = path.join(tmp, 'data');
    process.env.LOCAL_MUSIC_ROOTS = tmp;
    delete process.env.LYRICS_ONLINE;
    delete process.env.LRCLIB_URL;
    jest.resetModules();
    tags = {};
    require('../services/tagReader').runner.parse = jest.fn(async (file) => tags[path.basename(file)] || { common: {}, format: {} });
    require('../services/localLibrary')._resetForTests();
    lyrics = require('../services/lyrics');
    lyrics._resetForTests();
    fetchMock = jest.fn(async () => notFound());
    lyrics.http.fetch = fetchMock;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    db = await require('../config/db')();
    app = require('../app');
    app.locals.db = db;
    await db.run(`INSERT INTO users (id, username, password) VALUES (1, 'u1', 'x'), (2, 'u2', 'x')`);
});

afterEach(async () => {
    console.log.mockRestore();
    console.warn.mockRestore();
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.MUSIC_DATA_DIR;
    delete process.env.LOCAL_MUSIC_ROOTS;
    delete process.env.LYRICS_ONLINE;
    delete process.env.LRCLIB_URL;
});

const get = (query, userId = 1) => request(app).get('/api/lyrics').query(query).set(authFor(userId));

// Adds the temp music folder for a user and returns { file name -> track id }.
const scan = async (userId = 1) => {
    const lib = require('../services/localLibrary');
    const { id } = await lib.addFolder(db, userId, music);
    await lib.startScan(db, Number(id));
    const rows = await db.all('SELECT id, rel_path FROM local_tracks WHERE folder_id = ?', [Number(id)]);
    return Object.fromEntries(rows.map((r) => [path.basename(r.rel_path), String(r.id)]));
};

describe('parseLrc', () => {
    it('reads times in every usual form and sorts the lines', () => {
        const lrc = '[ar:Someone]\n[00:12.50]Second\n[00:01]First\r\n[01:05.123] Third \n[00:20:75]Colon fraction';
        expect(lyrics.parseLrc(lrc)).toEqual([
            { t: 1, text: 'First' },
            { t: 12.5, text: 'Second' },
            { t: 20.75, text: 'Colon fraction' },
            { t: 65.12, text: 'Third' }
        ]);
    });

    it('repeats a line with several timestamps and drops per-word tags', () => {
        expect(lyrics.parseLrc('[00:10.00][01:10.00]Chorus <00:10.50>again\n[00:30.00]Verse')).toEqual([
            { t: 10, text: 'Chorus again' },
            { t: 30, text: 'Verse' },
            { t: 70, text: 'Chorus again' }
        ]);
    });

    it('applies [offset:] (positive is earlier) without going below zero', () => {
        expect(lyrics.parseLrc('[offset:+1500]\n[00:01.00]A\n[00:10.00]B')).toEqual([{ t: 0, text: 'A' }, { t: 8.5, text: 'B' }]);
        expect(lyrics.parseLrc('[offset: -500]\n[00:10.00]B')).toEqual([{ t: 10.5, text: 'B' }]);
    });

    it('keeps empty timed lines (breaks) but is null without timestamps or without words', () => {
        expect(lyrics.parseLrc('[00:01.00]A\n[00:05.00]\n[00:09.00]B')).toHaveLength(3);
        expect(lyrics.parseLrc('Just words\nno times')).toBeNull();
        expect(lyrics.parseLrc('[00:01.00]\n[00:02.00]  ')).toBeNull();
        expect(lyrics.parseLrc(undefined)).toBeNull();
    });

    it('strips control characters and caps what it keeps', () => {
        const long = `[00:01.00]${'x'.repeat(1000)}\u0007`;
        expect(lyrics.parseLrc(long)[0].text).toHaveLength(300);
        const many = Array.from({ length: 5000 }, (_, i) => `[${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.00]l${i}`).join('\n');
        expect(lyrics.parseLrc(many).length).toBeLessThanOrEqual(2000);
    });
});

describe('lookupCandidates', () => {
    const titles = (t, a, opts) => lyrics.lookupCandidates(t, a, opts).map((c) => `${c.artist} / ${c.title}`);

    it('takes video decoration off the title and keeps the wording', () => {
        expect(titles('Get Lucky (feat. Pharrell Williams) [Official Audio]', 'Daft Punk')).toEqual(['Daft Punk / Get Lucky']);
        expect(titles('Bohemian Rhapsody - Remastered 2011', 'Queen')).toEqual(['Queen / Bohemian Rhapsody']);
        expect(titles('Song | Some Label', 'Band')).toEqual(['Band / Song']);
        expect(titles("Don't Stop Me Now ft. Someone", 'Queen')).toEqual(["Queen / Don't Stop Me Now"]);
    });

    it('uses the name in the title when a channel spells its artist differently', () => {
        expect(titles('Daft Punk - Get Lucky (Official Audio)', 'DaftPunkVEVO')).toEqual(['Daft Punk / Get Lucky']);
        expect(titles('Get Lucky', 'Daft Punk - Topic')).toEqual(['Daft Punk / Get Lucky']);
    });

    it('tries "Artist - Title" from someone else\'s upload: first for YouTube, second otherwise', () => {
        const title = 'Rick Astley - Never Gonna Give You Up (Official Music Video)';
        expect(titles(title, 'Some Channel', { videoTitle: true })[0]).toBe('Rick Astley / Never Gonna Give You Up');
        expect(titles(title, 'Some Channel')[1]).toBe('Rick Astley / Never Gonna Give You Up');
        expect(titles(title, '')).toEqual(['Rick Astley / Never Gonna Give You Up']);
    });

    it('falls back to the title without brackets and to the first credited artist, three at most', () => {
        expect(titles('Me & You (Live)', 'A, B')).toEqual(['A, B / Me & You (Live)', 'A, B / Me & You', 'A / Me & You (Live)']);
    });

    it('asks nothing without both a title and an artist', () => {
        expect(lyrics.lookupCandidates('Song', 'Unknown Artist')).toEqual([]);
        expect(lyrics.lookupCandidates('', 'Band')).toEqual([]);
    });
});

describe('pickSearchResult', () => {
    const wanted = { title: 'Déjà Vu', artist: 'Beyoncé' };
    const row = (over) => ({ trackName: 'Deja Vu', artistName: 'Beyonce feat. Jay-Z', duration: 240, instrumental: false, plainLyrics: 'words', syncedLyrics: null, ...over });

    it('needs the same title and artist, ignoring case, accents and punctuation', () => {
        expect(lyrics.pickSearchResult([row({ trackName: 'Another Song' }), row({ artistName: 'Somebody Else' })], wanted, 240)).toBeNull();
        expect(lyrics.pickSearchResult([row()], wanted, 240)).toMatchObject({ useTimes: true });
    });

    it('prefers timed lyrics among results of the right length', () => {
        const pick = lyrics.pickSearchResult([row({ id: 1 }), row({ id: 2, duration: 242, syncedLyrics: '[00:01.00]x' })], wanted, 240);
        expect(pick).toMatchObject({ track: { id: 2 }, useTimes: true });
    });

    it('uses only the words of another cut, and never its "instrumental" flag', () => {
        const pick = lyrics.pickSearchResult([row({ id: 1, duration: 300, syncedLyrics: '[00:01.00]x' }), row({ id: 2, duration: 200, instrumental: true })], wanted, 240);
        expect(pick).toMatchObject({ track: { id: 1 }, useTimes: false });
        expect(lyrics.pickSearchResult([row({ duration: 200, instrumental: true, plainLyrics: null })], wanted, 240)).toBeNull();
    });
});

describe('GET /api/lyrics', () => {
    it('needs a login and a source', async () => {
        expect((await request(app).get('/api/lyrics').query({ source: 'youtube', title: 'x' })).statusCode).toBe(401);
        expect((await get({ title: 'x' })).statusCode).toBe(400);
        expect((await get({ source: '../etc', title: 'x' })).statusCode).toBe(400);
    });

    describe('the user\'s own files', () => {
        it('reads the .lrc file next to the track without asking anyone', async () => {
            write('Album/Song.mp3');
            write('Album/Song.lrc', '﻿[00:01.00]Hello\n[00:04.50]World');
            const ids = await scan();
            const res = await get({ source: 'local', id: ids['Song.mp3'], title: 'Song', artist: 'Band', online: '1' });
            expect(res.statusCode).toBe(200);
            expect(res.headers['cache-control']).toBe('no-store');
            expect(res.body).toEqual({
                status: 'found',
                synced: [{ t: 1, text: 'Hello' }, { t: 4.5, text: 'World' }],
                plain: 'Hello\nWorld',
                origin: 'file',
                credit: null
            });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('reads a UTF-16 .lrc file and an untimed one', async () => {
            write('a.mp3');
            write('a.lrc', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[00:02.00]שלום', 'utf16le')]));
            write('b.flac');
            write('b.lrc', 'Line one\r\nLine two\r\n');
            const ids = await scan();
            expect((await get({ source: 'local', id: ids['a.mp3'] })).body.synced).toEqual([{ t: 2, text: 'שלום' }]);
            expect((await get({ source: 'local', id: ids['b.flac'] })).body).toMatchObject({ status: 'found', synced: null, plain: 'Line one\nLine two', origin: 'file' });
        });

        it('falls back to lyrics in the tags: timed, LRC text, plain text and TXXX frames', async () => {
            for (const name of ['timed.flac', 'lrc.mp3', 'plain.m4a', 'txxx.mp3', 'none.mp3']) write(name);
            tags['timed.flac'] = { common: { lyrics: [{ timeStampFormat: 2, text: 'A\nB', syncText: [{ timestamp: 2500, text: 'B' }, { timestamp: 1000, text: 'A' }] }] }, format: {} };
            tags['lrc.mp3'] = { common: { lyrics: [{ timeStampFormat: 0, text: '[00:03.00]From USLT', syncText: [] }] }, format: {} };
            tags['plain.m4a'] = { common: { lyrics: ['Old style string'] }, format: {} };
            tags['txxx.mp3'] = { common: {}, format: {}, native: { 'ID3v2.4': [{ id: 'TIT2', value: 'T' }, { id: 'TXXX:lyrics-eng', value: 'User text' }] } };
            const ids = await scan();
            const body = async (name) => (await get({ source: 'local', id: ids[name] })).body;

            expect(await body('timed.flac')).toMatchObject({ status: 'found', origin: 'tags', synced: [{ t: 1, text: 'A' }, { t: 2.5, text: 'B' }], plain: 'A\nB' });
            expect(await body('lrc.mp3')).toMatchObject({ origin: 'tags', synced: [{ t: 3, text: 'From USLT' }] });
            expect(await body('plain.m4a')).toMatchObject({ origin: 'tags', synced: null, plain: 'Old style string' });
            expect(await body('txxx.mp3')).toMatchObject({ origin: 'tags', plain: 'User text' });
            // Nothing in the file and no agreement to look online.
            expect((await get({ source: 'local', id: ids['none.mp3'], title: 'None', artist: 'Band' })).body).toMatchObject({ status: 'online_disabled', reason: 'consent' });
            // Without a title there is nothing to look up at all.
            expect(await body('none.mp3')).toMatchObject({ status: 'not_found' });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('does not follow a link in place of the .lrc file', async () => {
            write('linked.mp3');
            const secret = path.join(tmp, 'secret.txt');
            fs.writeFileSync(secret, '[00:01.00]not yours');
            try {
                fs.symlinkSync(secret, path.join(music, 'linked.lrc'));
            } catch {
                return; // no permission to create links here (Windows without developer mode)
            }
            const ids = await scan();
            const res = await get({ source: 'local', id: ids['linked.mp3'], title: 'Linked', artist: 'Band' });
            expect(res.body).toMatchObject({ status: 'online_disabled', synced: null, plain: null });
        });

        it('never reads another user\'s file, or a made-up id', async () => {
            write('mine.mp3');
            write('mine.lrc', '[00:01.00]private words');
            const ids = await scan(1);
            const other = await get({ source: 'local', id: ids['mine.mp3'] }, 2);
            expect(other.body).toMatchObject({ status: 'not_found', plain: null, synced: null });
            expect((await get({ source: 'local', id: '../../etc/passwd' })).body.status).toBe('not_found');
            expect((await get({ source: 'local', id: '999999', title: 'x' })).body.status).toBe('online_disabled');
        });
    });

    describe('online lookups', () => {
        const track = { source: 'deezer', id: '42', title: 'Get Lucky (feat. Pharrell Williams)', artist: 'Daft Punk', duration: '248' };
        const hit = { id: 7, trackName: 'Get Lucky', artistName: 'Daft Punk', duration: 248, instrumental: false, plainLyrics: 'Like the legend of the phoenix\nAll ends with beginnings', syncedLyrics: '[00:10.00]Like the legend of the phoenix\n[00:14.20]All ends with beginnings' };

        it('sends nothing until the user has agreed', async () => {
            const res = await get(track);
            expect(res.body).toEqual({ status: 'online_disabled', synced: null, plain: null, origin: null, credit: null, reason: 'consent' });
            expect((await get({ ...track, online: 'yes' })).body.status).toBe('online_disabled');
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('can be turned off for the whole installation', async () => {
            process.env.LYRICS_ONLINE = 'off';
            expect((await get({ ...track, online: '1' })).body).toMatchObject({ status: 'online_disabled', reason: 'server' });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('asks LRCLIB for the cleaned title, artist and length, names itself, and credits the answer', async () => {
            fetchMock.mockResolvedValueOnce(json(hit));
            const res = await get({ ...track, online: '1' });
            expect(res.body).toEqual({
                status: 'found',
                synced: [{ t: 10, text: 'Like the legend of the phoenix' }, { t: 14.2, text: 'All ends with beginnings' }],
                plain: 'Like the legend of the phoenix\nAll ends with beginnings',
                origin: 'lrclib',
                credit: { name: 'LRCLIB', url: 'https://lrclib.net' }
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, options] = fetchMock.mock.calls[0];
            expect(url.origin).toBe('https://lrclib.net');
            expect(url.pathname).toBe('/api/get');
            expect(Object.fromEntries(url.searchParams)).toEqual({ track_name: 'Get Lucky', artist_name: 'Daft Punk', duration: '248' });
            expect(options.headers['Lrclib-Client']).toMatch(/^MusicManager\/\d/);
            expect(options.headers['User-Agent']).toBe(options.headers['Lrclib-Client']);
            expect(options.signal).toBeDefined();
        });

        it('remembers the answer: a second request does not ask again', async () => {
            fetchMock.mockResolvedValueOnce(json(hit));
            await get({ ...track, online: '1' });
            const again = await get({ ...track, online: '1' });
            expect(again.body).toMatchObject({ status: 'found', origin: 'lrclib', synced: expect.any(Array) });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            // The cache is keyed by what was asked, not by the track id.
            const row = await db.get('SELECT lookup_key, status, provider FROM lyrics_cache');
            expect(row).toMatchObject({ status: 'found', provider: 'lrclib' });
            expect(row.lookup_key).toMatch(/^[0-9a-f]{64}$/);
            // Still nothing without the user's agreement, cached or not.
            expect((await get(track)).body.status).toBe('online_disabled');
        });

        it('searches when the exact lookup finds nothing, and keeps only the words of a different cut', async () => {
            fetchMock.mockImplementation(async (url) => {
                if (url.pathname === '/api/search') {
                    return json([
                        { ...hit, id: 1, trackName: 'Get Lucky (Radio Edit)' },
                        { ...hit, id: 2, duration: 369 },
                        { ...hit, id: 3, artistName: 'A Cover Band' }
                    ]);
                }
                return notFound();
            });
            const res = await get({ ...track, online: '1' });
            expect(res.body).toMatchObject({ status: 'found', synced: null, plain: hit.plainLyrics, origin: 'lrclib' });
            expect(calls().map((c) => c.split('?')[0])).toEqual(['/api/get', '/api/search']);
            expect(calls()[1]).toBe('/api/search?track_name=Get+Lucky&artist_name=Daft+Punk');
        });

        it('caches "not found" too, and reports an instrumental', async () => {
            const first = await get({ ...track, online: '1' });
            expect(first.body).toMatchObject({ status: 'not_found', credit: null });
            const asked = fetchMock.mock.calls.length;
            expect(asked).toBeGreaterThan(0);
            expect((await get({ ...track, online: '1' })).body.status).toBe('not_found');
            expect(fetchMock).toHaveBeenCalledTimes(asked);

            fetchMock.mockResolvedValueOnce(json({ ...hit, instrumental: true, plainLyrics: null, syncedLyrics: null }));
            const other = await get({ ...track, title: 'Veridis Quo', online: '1' });
            expect(other.body).toMatchObject({ status: 'instrumental', origin: 'lrclib', credit: { name: 'LRCLIB' } });
        });

        it('a "not found" answer is asked again after a day', async () => {
            await get({ ...track, online: '1' });
            const asked = fetchMock.mock.calls.length;
            await db.run('UPDATE lyrics_cache SET fetched_at = ?', [Date.now() - 25 * 60 * 60 * 1000]);
            fetchMock.mockResolvedValueOnce(json(hit));
            expect((await get({ ...track, online: '1' })).body.status).toBe('found');
            expect(fetchMock).toHaveBeenCalledTimes(asked + 1);
        });

        it('reports a failure as "unavailable" and does not cache it', async () => {
            fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND lrclib.net'));
            expect((await get({ ...track, online: '1' })).body).toMatchObject({ status: 'unavailable' });
            fetchMock.mockResolvedValueOnce(json({ message: 'busy' }, 503));
            expect((await get({ ...track, online: '1' })).body.status).toBe('unavailable');
            fetchMock.mockResolvedValueOnce(new Response('<html>not json</html>', { status: 200 }));
            expect((await get({ ...track, online: '1' })).body.status).toBe('unavailable');
            expect(await db.get('SELECT COUNT(*) AS n FROM lyrics_cache')).toEqual({ n: 0 });
            fetchMock.mockResolvedValueOnce(json(hit));
            expect((await get({ ...track, online: '1' })).body.status).toBe('found');
        });

        it('stops asking for a while after the server says "too many requests"', async () => {
            fetchMock.mockResolvedValueOnce(json({}, 429, { 'retry-after': '120' }));
            expect((await get({ ...track, online: '1' })).body.status).toBe('unavailable');
            expect((await get({ ...track, title: 'Another', online: '1' })).body.status).toBe('unavailable');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('asks once when the same track is requested twice at the same moment', async () => {
            let release;
            fetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(json(hit)); }));
            const lookup = { source: 'deezer', id: '42', title: 'Get Lucky', artist: 'Daft Punk', durationSec: 248, online: true };
            const a = lyrics.getLyrics(db, 1, lookup);
            const b = lyrics.getLyrics(db, 2, lookup);
            await new Promise((resolve) => setTimeout(resolve, 20));
            release();
            expect((await a).status).toBe('found');
            expect((await b).status).toBe('found');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('leaves out a length LRCLIB would reject and ignores non-text parameters', async () => {
            await get({ ...track, duration: '7200', online: '1' });
            expect(calls()[0]).toBe('/api/get?track_name=Get+Lucky&artist_name=Daft+Punk');
            fetchMock.mockClear();
            const res = await request(app).get('/api/lyrics?source=deezer&title[]=a&title[]=b&artist[x]=y&online=1').set(authFor(1));
            expect(res.body.status).toBe('not_found');
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('uses LRCLIB_URL for another instance, but only an http(s) one', async () => {
            process.env.LRCLIB_URL = 'http://127.0.0.1:9999/some/path';
            await get({ ...track, online: '1' });
            expect(fetchMock.mock.calls[0][0].href).toMatch(/^http:\/\/127\.0\.0\.1:9999\/api\/get\?/);
            fetchMock.mockClear();
            process.env.LRCLIB_URL = 'file:///etc/passwd';
            await get({ ...track, title: 'Other', online: '1' });
            expect(fetchMock.mock.calls[0][0].origin).toBe('https://lrclib.net');
        });

        it('looks online for a local track with no lyrics of its own, once agreed', async () => {
            write('bare.mp3');
            const ids = await scan();
            fetchMock.mockResolvedValueOnce(json(hit));
            const res = await get({ source: 'local', id: ids['bare.mp3'], title: 'Get Lucky', artist: 'Daft Punk', duration: '248', online: '1' });
            expect(res.body).toMatchObject({ status: 'found', origin: 'lrclib' });
        });
    });
});
