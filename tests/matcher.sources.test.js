// Unit tests for the two candidate sources of the match engine. No network and
// no process spawning: InnerTube is stubbed through innertube.http.fetch and
// yt-dlp through ytsearch.runner.exec. The fixtures are trimmed copies of real
// responses captured on 2026-10-13 (InnerTube WEB_REMIX, yt-dlp 2026.08.19).
const fs = require('fs');
const path = require('path');
const innertube = require('../services/matcher/innertube');
const ytsearch = require('../services/matcher/ytsearch');

const fixturePath = (name) => path.join(__dirname, 'fixtures', name);
const readFixture = (name) => fs.readFileSync(fixturePath(name), 'utf8');
const songsFixture = JSON.parse(readFixture('innertube-search.json'));
const khruangbinFixture = JSON.parse(readFixture('innertube-songs-khruangbin.json'));
const videosFixture = JSON.parse(readFixture('innertube-videos.json'));
const flatLines = readFixture('ytsearch-flat.jsonl');

const MB = 1024 * 1024;
const { ReadableStream } = globalThis;

// Mirrors the Response surface the module touches (status, headers.get, text).
const response = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

// Builds a minimal musicResponsiveListItemRenderer so edge cases that the real
// fixtures do not contain (no linked artist, no id, unknown type) can be tested.
const run = (text, endpoint) => (endpoint ? { text, navigationEndpoint: endpoint } : { text });
const browse = (browseId) => ({ browseEndpoint: { browseId } });
const watch = (videoId, musicVideoType) => ({
    watchEndpoint: {
        videoId,
        ...(musicVideoType ? { watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType } } } : {})
    }
});
const column = (runs) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs } } });
const item = ({ titleRuns, metaRuns = [], extraRuns, playlistVideoId }) => ({
    musicResponsiveListItemRenderer: {
        flexColumns: [column(titleRuns), column(metaRuns), ...(extraRuns ? [column(extraRuns)] : [])],
        ...(playlistVideoId ? { playlistItemData: { videoId: playlistVideoId } } : {})
    }
});
const shelf = (...items) => ({ contents: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: items } }] } } });

let fetchMock;
beforeEach(() => {
    fetchMock = jest.fn();
    innertube.http.fetch = fetchMock;
});

afterEach(() => {
    jest.useRealTimers();
});

describe('innertube.parseResults on the songs fixture ("daft punk get lucky")', () => {
    const candidates = innertube.parseResults(songsFixture);
    const byId = Object.fromEntries(candidates.map((c) => [c.videoId, c]));

    it('yields all eight items in response order', () => {
        expect(candidates.map((c) => c.videoId)).toEqual([
            'Rgrt_8mXrK8', '4D7u5KF7SP8', '55pBMXnbqxo', '2KPIShmFouY',
            'D-cfH1V4RQ0', '7FhqrDhIgQA', 'N9uzbafKyQs', 'imDKnNvqpq0'
        ]);
    });

    it('reads the radio edit: id, title, three linked artists, album equal to the title, 4:09, 1.9B plays, ATV', () => {
        expect(byId.Rgrt_8mXrK8).toEqual({
            videoId: 'Rgrt_8mXrK8',
            title: 'Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)',
            artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'],
            album: 'Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)',
            durationSec: 249,
            plays: 1.9e9,
            videoType: 'atv',
            origin: 'ytmusic'
        });
    });

    it('reads the album version: 6:10 on Random Access Memories', () => {
        expect(byId['4D7u5KF7SP8']).toMatchObject({
            title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)',
            artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'],
            album: 'Random Access Memories',
            durationSec: 370,
            plays: 1.9e9,
            videoType: 'atv'
        });
    });

    it('keeps covers by other artists as candidates (rejecting them is the scorer\'s job)', () => {
        expect(byId['2KPIShmFouY']).toMatchObject({ title: 'Get Lucky', artists: ['Funk Punk'], album: 'Get Lucky', durationSec: 250, plays: 7600 });
        expect(byId['D-cfH1V4RQ0']).toMatchObject({ title: 'Get Lucky (Metal Cover)', artists: ['Leo'], album: 'Leo Metal Covers Volume 7', durationSec: 209, plays: 224000 });
        expect(byId.N9uzbafKyQs).toMatchObject({ artists: ['Pop Mania'], album: 'Bbq Bangers', durationSec: 259, plays: 80000 });
        expect(byId['7FhqrDhIgQA']).toMatchObject({ artists: ['Phil A.'], album: 'Best of 2000\'s: Hits from Decade', durationSec: 245, plays: 1300 });
        expect(byId.imDKnNvqpq0).toMatchObject({ artists: ['Helia'], durationSec: 229, plays: 1e6 });
    });

    it('takes the artist from the linked run even when it is named like the song', () => {
        // A mislabelled upload whose "artist" entity is literally called "Get Lucky".
        expect(byId['55pBMXnbqxo']).toMatchObject({ title: 'Get Lucky (We\'re up All Night)', artists: ['Get Lucky'], durationSec: 259, plays: 110000 });
    });

    it('classifies every songs-filter item as ATV', () => {
        expect(candidates.every((c) => c.videoType === 'atv' && c.origin === 'ytmusic')).toBe(true);
        expect(candidates.every((c) => typeof c.album === 'string' && c.album.length > 0)).toBe(true);
    });
});

describe('innertube.parseResults on the Khruangbin songs fixture', () => {
    const candidates = innertube.parseResults(khruangbinFixture);

    it('keeps diacritics in titles and reads a single-artist item', () => {
        expect(candidates[0]).toEqual({
            videoId: 'olf4IO9Dx4E',
            title: 'Maria También',
            artists: ['Khruangbin'],
            album: 'Con Todo El Mundo',
            durationSec: 191,
            plays: 8.5e6,
            videoType: 'atv',
            origin: 'ytmusic'
        });
    });

    it('collects two artists joined by " & "', () => {
        const mariella = candidates.find((c) => c.videoId === 'qtz8L-gICzA');
        expect(mariella).toMatchObject({ title: 'Mariella', artists: ['Khruangbin', 'Leon Bridges'], album: 'Texas Moon', durationSec: 311, plays: 22e6 });
    });
});

describe('innertube.parseResults on the videos fixture', () => {
    const candidates = innertube.parseResults(videosFixture);

    it('reads the official audio as OMV with views as plays and no album', () => {
        expect(candidates[0]).toEqual({
            videoId: '5NV6Rdv1a3I',
            title: 'Get Lucky (Official Audio) (feat. Pharrell Williams & Nile Rodgers)',
            artists: ['Daft Punk'],
            album: null,
            durationSec: 249,
            plays: 880e6,
            videoType: 'omv',
            origin: 'ytmusic'
        });
    });

    it('classifies the remaining seven as UGC, including a channel that calls itself "Daft Punk"', () => {
        const ugc = candidates.filter((c) => c.videoType === 'ugc');
        expect(ugc).toHaveLength(7);
        expect(ugc.map((c) => c.videoId)).toEqual(['RG63kLb_Hqo', 'CCHdMIEGaaM', 'w2tPG-SDBSk', 'RVjRx5ceD2Q', '3fCUH24zWyo', 'IJTNk48SaV4', 'Q6qAKQOoBm8']);
        expect(candidates.find((c) => c.videoId === 'IJTNk48SaV4')).toMatchObject({ artists: ['Daft Punk'], videoType: 'ugc', durationSec: 98, plays: 91000 });
        expect(candidates.find((c) => c.videoId === 'RG63kLb_Hqo')).toMatchObject({ artists: ['PianoNest'], plays: 9400, durationSec: 204 });
    });
});

describe('innertube.parseResults edge cases', () => {
    it('leaves artists empty when column 1 has no linked artist run', () => {
        const [c] = innertube.parseResults(shelf(item({
            titleRuns: [run('Get Lucky', watch('AAAAAAAAAAA', 'MUSIC_VIDEO_TYPE_ATV'))],
            metaRuns: [run('Various Artists'), run(' • '), run('Compilation', browse('MPREb_abc')), run(' • '), run('3:33')],
            extraRuns: [run('12K plays')]
        })));
        expect(c).toEqual({
            videoId: 'AAAAAAAAAAA', title: 'Get Lucky', artists: [], album: 'Compilation',
            durationSec: 213, plays: 12000, videoType: 'atv', origin: 'ytmusic'
        });
    });

    it('stops collecting artists at the first bullet, so an album is never mistaken for an artist', () => {
        const [c] = innertube.parseResults(shelf(item({
            titleRuns: [run('Song', watch('BBBBBBBBBBB', 'MUSIC_VIDEO_TYPE_ATV'))],
            metaRuns: [run('A', browse('UC1')), run(' • '), run('Album', browse('MPREb_x')), run(' • '), run('B', browse('UC2')), run(' • '), run('1:00')]
        })));
        expect(c.artists).toEqual(['A']);
        expect(c.album).toBe('Album');
        expect(c.durationSec).toBe(60);
    });

    it('falls back to playlistItemData.videoId when the title run has no watch endpoint', () => {
        const [c] = innertube.parseResults(shelf(item({ titleRuns: [run('Song')], playlistVideoId: 'CCCCCCCCCCC' })));
        expect(c).toMatchObject({ videoId: 'CCCCCCCCCCC', videoType: 'unknown', album: null, durationSec: null, plays: 0 });
    });

    it('maps a musicVideoType named like an Object.prototype member to "unknown", not to a function', () => {
        for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
            const [c] = innertube.parseResults(shelf(item({ titleRuns: [run('T', watch('aaaaaaaaaaa', type))], metaRuns: [run('A', browse('UC1'))] })));
            expect(c.videoType).toBe('unknown');
            expect(typeof c.videoType).toBe('string');
        }
    });

    it('maps an unrecognised musicVideoType to "unknown"', () => {
        const [c] = innertube.parseResults(shelf(item({ titleRuns: [run('Song', watch('DDDDDDDDDDD', 'MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC'))] })));
        expect(c.videoType).toBe('unknown');
    });

    it('skips items without a video id or without a title, and ignores non-item renderers', () => {
        const json = {
            contents: [
                item({ titleRuns: [run('No id anywhere')] }),
                item({ titleRuns: [run('', watch('EEEEEEEEEEE', 'MUSIC_VIDEO_TYPE_ATV'))] }),
                item({ titleRuns: [run('Bad id', watch('short', 'MUSIC_VIDEO_TYPE_ATV'))] }),
                { musicCardShelfRenderer: { title: { runs: [run('Top result')] } } },
                { musicResponsiveListItemRenderer: 'not an object' },
                { musicResponsiveListItemRenderer: { flexColumns: 'nope' } },
                item({ titleRuns: [run('Kept', watch('FFFFFFFFFFF', 'MUSIC_VIDEO_TYPE_OMV'))] })
            ]
        };
        expect(innertube.parseResults(json).map((c) => c.videoId)).toEqual(['FFFFFFFFFFF']);
    });

    it('returns the same video only once when it appears twice in the tree', () => {
        const twice = shelf(
            item({ titleRuns: [run('Song', watch('GGGGGGGGGGG', 'MUSIC_VIDEO_TYPE_ATV'))] }),
            item({ titleRuns: [run('Song', watch('GGGGGGGGGGG', 'MUSIC_VIDEO_TYPE_ATV'))] })
        );
        expect(innertube.parseResults(twice)).toHaveLength(1);
    });

    it('returns an empty list for inputs that are not a response at all', () => {
        expect(innertube.parseResults(null)).toEqual([]);
        expect(innertube.parseResults('string')).toEqual([]);
        expect(innertube.parseResults({})).toEqual([]);
        expect(innertube.parseResults({ error: { code: 400 } })).toEqual([]);
    });
});

describe('innertube text helpers', () => {
    it('parses m:ss and h:mm:ss durations', () => {
        expect(innertube.parseDurationText('4:09')).toBe(249);
        expect(innertube.parseDurationText('6:10')).toBe(370);
        expect(innertube.parseDurationText('10:00')).toBe(600);
        expect(innertube.parseDurationText('1:02:03')).toBe(3723);
        expect(innertube.parseDurationText(' 0:59 ')).toBe(59);
    });

    it('rejects text that is not a duration', () => {
        for (const bad of ['4:9', '249', '4:09:', 'live', '', null, undefined, 249]) {
            expect(innertube.parseDurationText(bad)).toBeNull();
        }
    });

    it('parses K/M/B suffixed play and view counts', () => {
        expect(innertube.parsePlays('1.9B plays')).toBe(1900000000);
        expect(innertube.parsePlays('880M views')).toBe(880000000);
        expect(innertube.parsePlays('9.4K views')).toBe(9400);
        expect(innertube.parsePlays('1M plays')).toBe(1000000);
        expect(innertube.parsePlays('1,234 plays')).toBe(1234);
        expect(innertube.parsePlays('7 plays')).toBe(7);
    });

    it('returns null when there is no count', () => {
        for (const bad of ['No views', '4:09', 'Daft Punk', '', null, 12]) {
            expect(innertube.parsePlays(bad)).toBeNull();
        }
    });
});

describe('innertube.search request shape', () => {
    it('POSTs the WEB_REMIX context, query and songs params with browser-like headers', async () => {
        fetchMock.mockResolvedValueOnce(response(200, songsFixture));

        const result = await innertube.searchSongs('daft punk get lucky');

        expect(result).toHaveLength(8);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://music.youtube.com/youtubei/v1/search?prettyPrint=false');
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({
            'Content-Type': 'application/json',
            'Origin': 'https://music.youtube.com',
            'Referer': 'https://music.youtube.com/'
        });
        expect(init.headers['User-Agent']).toMatch(/^Mozilla\/5\.0 .*Chrome\/\d+/);
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal.aborted).toBe(false);
        expect(JSON.parse(init.body)).toEqual({
            context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240925.01.00', hl: 'en', gl: 'US' } },
            query: 'daft punk get lucky',
            params: innertube.SONGS_PARAMS
        });
    });

    it('exposes YouTube Music\'s filter tokens as constants', () => {
        expect(innertube.SONGS_PARAMS).toBe('EgWKAQIIAWoKEAoQAxAEEAkQBQ%3D%3D');
        expect(innertube.VIDEOS_PARAMS).toBe('EgWKAQIQAWoKEAoQAxAEEAkQBQ%3D%3D');
        expect(innertube.SONGS_PARAMS).not.toBe(innertube.VIDEOS_PARAMS);
    });

    it('searchVideos sends the videos params and returns only ATV/OMV candidates', async () => {
        fetchMock.mockResolvedValueOnce(response(200, videosFixture));

        const result = await innertube.searchVideos('daft punk get lucky');

        expect(JSON.parse(fetchMock.mock.calls[0][1].body).params).toBe(innertube.VIDEOS_PARAMS);
        expect(result.map((c) => c.videoId)).toEqual(['5NV6Rdv1a3I']);
        expect(result[0].videoType).toBe('omv');
    });

    it('search() accepts the filter explicitly and refuses unknown filters and empty queries', async () => {
        fetchMock.mockResolvedValueOnce(response(200, videosFixture));
        const raw = await innertube.search('q', { filter: 'videos' });
        expect(raw).toHaveLength(8); // unfiltered: UGC included

        await expect(innertube.search('q', { filter: 'albums' })).rejects.toThrow(TypeError);
        await expect(innertube.searchSongs('   ')).rejects.toThrow(TypeError);
        await expect(innertube.searchSongs(undefined)).rejects.toThrow(TypeError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('innertube.search failures', () => {
    it('maps 429 to RATE_LIMITED and carries Retry-After in milliseconds', async () => {
        fetchMock.mockResolvedValueOnce(response(429, { error: 'slow down' }, { 'retry-after': '30' }));

        const err = await innertube.searchSongs('x').catch((e) => e);

        expect(err).toBeInstanceOf(innertube.MatchSourceError);
        expect(err).toBeInstanceOf(Error);
        expect(err).toMatchObject({ name: 'MatchSourceError', code: 'RATE_LIMITED', status: 429, retryAfterMs: 30000 });
    });

    it('maps 403 to RATE_LIMITED with a null retryAfterMs when the header is absent', async () => {
        fetchMock.mockResolvedValueOnce(response(403, 'Forbidden'));
        await expect(innertube.searchSongs('x')).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 403, retryAfterMs: null });
    });

    it('maps other non-2xx statuses to UPSTREAM', async () => {
        fetchMock.mockResolvedValueOnce(response(500, 'oops'));
        await expect(innertube.searchSongs('x')).rejects.toMatchObject({ code: 'UPSTREAM', status: 500 });
        fetchMock.mockResolvedValueOnce(response(404, ''));
        await expect(innertube.searchVideos('x')).rejects.toMatchObject({ code: 'UPSTREAM', status: 404 });
    });

    it('maps a network error to UNAVAILABLE and keeps the cause', async () => {
        const boom = new TypeError('fetch failed');
        fetchMock.mockRejectedValueOnce(boom);

        const err = await innertube.searchSongs('x').catch((e) => e);

        expect(err).toMatchObject({ code: 'UNAVAILABLE', status: null, retryAfterMs: null });
        expect(err.cause).toBe(boom);
        expect(err.message).toMatch(/fetch failed/);
    });

    it('aborts the request after 8 s and reports UNAVAILABLE', async () => {
        jest.useFakeTimers();
        let seenSignal;
        fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
            seenSignal = init.signal;
            // Like undici: reject with the abort reason once the signal fires.
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }));

        const pending = innertube.searchSongs('never answers');
        const expectation = expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' });

        await jest.advanceTimersByTimeAsync(7999);
        expect(seenSignal.aborted).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(seenSignal.aborted).toBe(true);

        await expectation;
        await expect(pending).rejects.toThrow(/timed out after 8000 ms/);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('treats a stub that throws a plain AbortError on timeout as UNAVAILABLE too', async () => {
        jest.useFakeTimers();
        fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
        }));

        const pending = innertube.searchSongs('x');
        const expectation = expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        await jest.advanceTimersByTimeAsync(8000);
        await expectation;
    });

    it('clears its timer after a successful response', async () => {
        jest.useFakeTimers();
        fetchMock.mockResolvedValueOnce(response(200, songsFixture));
        await innertube.searchSongs('x');
        expect(jest.getTimerCount()).toBe(0);
    });

    it('forwards a caller-supplied signal and stops when it aborts', async () => {
        const external = new AbortController();
        fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }));

        const pending = innertube.searchSongs('x', { signal: external.signal });
        const expectation = expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        external.abort();
        await expectation;
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    });

    it('rejects a body whose Content-Length exceeds 3 MB without reading it', async () => {
        const text = jest.fn();
        fetchMock.mockResolvedValueOnce({ status: 200, ok: true, headers: { get: (n) => (n === 'content-length' ? String(4 * MB) : null) }, text });

        await expect(innertube.searchSongs('x')).rejects.toMatchObject({ code: 'UPSTREAM' });
        expect(text).not.toHaveBeenCalled();
    });

    it('rejects a body over 3 MB when no Content-Length was sent', async () => {
        fetchMock.mockResolvedValueOnce(response(200, 'x'.repeat(3 * MB + 1)));
        const err = await innertube.searchSongs('x').catch((e) => e);
        expect(err).toMatchObject({ code: 'UPSTREAM', status: 200 });
        expect(err.message).toMatch(/too large/);
    });

    it('stops reading a chunked body the moment the running total passes 3 MB and aborts the request', async () => {
        const chunk = new Uint8Array(256 * 1024).fill(120); // 256 KB of "x"
        let pulled = 0;
        let cancelled = false;
        const body = new ReadableStream({
            pull(ctrl) {
                pulled += 1;
                ctrl.enqueue(chunk);
            },
            cancel() { cancelled = true; }
        });
        const text = jest.fn();
        fetchMock.mockResolvedValueOnce({ status: 200, ok: true, headers: { get: () => null }, body, text });

        const err = await innertube.searchSongs('x').catch((e) => e);

        expect(err).toMatchObject({ code: 'UPSTREAM', status: 200 });
        expect(err.message).toMatch(/too large/);
        // 13 chunks cross the cap; nothing close to "the whole body" was buffered.
        expect(pulled).toBeLessThanOrEqual(14);
        expect(cancelled).toBe(true);
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        expect(text).not.toHaveBeenCalled();
    });

    it('reads a chunked body that stays under the cap and parses it', async () => {
        const bytes = Buffer.from(JSON.stringify(songsFixture));
        const body = new ReadableStream({
            start(ctrl) {
                for (let i = 0; i < bytes.length; i += 64 * 1024) ctrl.enqueue(bytes.subarray(i, i + 64 * 1024));
                ctrl.close();
            }
        });
        fetchMock.mockResolvedValueOnce({ status: 200, ok: true, headers: { get: () => null }, body, text: jest.fn() });
        await expect(innertube.searchSongs('x')).resolves.toHaveLength(8);
    });

    it('a body stream that fails mid-way is UNAVAILABLE', async () => {
        const body = new ReadableStream({
            pull(ctrl) { ctrl.error(new Error('connection reset')); }
        });
        fetchMock.mockResolvedValueOnce({ status: 200, ok: true, headers: { get: () => null }, body, text: jest.fn() });
        await expect(innertube.searchSongs('x')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('accepts a body just under the cap', async () => {
        const padded = { contents: songsFixture.contents, padding: 'y'.repeat(3 * MB - 64 * 1024) };
        fetchMock.mockResolvedValueOnce(response(200, padded));
        await expect(innertube.searchSongs('x')).resolves.toHaveLength(8);
    });

    it('maps a non-JSON body to UPSTREAM', async () => {
        fetchMock.mockResolvedValueOnce(response(200, '<html>consent wall</html>'));
        await expect(innertube.searchSongs('x')).rejects.toMatchObject({ code: 'UPSTREAM', status: 200 });
    });

    it('resolves to an empty list when the JSON has no items', async () => {
        fetchMock.mockResolvedValueOnce(response(200, { contents: { tabbedSearchResultsRenderer: { tabs: [] } } }));
        await expect(innertube.searchSongs('x')).resolves.toEqual([]);
    });

    it('MatchSourceError defaults unknown codes to UPSTREAM', () => {
        const err = new innertube.MatchSourceError('WHATEVER', 'msg');
        expect(err.code).toBe('UPSTREAM');
        expect(err.message).toBe('msg');
        expect(new innertube.MatchSourceError('UNAVAILABLE').message).toBe('UNAVAILABLE');
    });
});

describe('ytsearch.parseJsonLines', () => {
    it('parses the real flat fixture, one entry per line', () => {
        const entries = ytsearch.parseJsonLines(flatLines);
        expect(entries).toHaveLength(8);
        expect(entries.map((e) => e.id)).toEqual(['5NV6Rdv1a3I', 'CCHdMIEGaaM', 'DvE7O3bLQgE', '5glDAaCaazc', 'MrOpYwqAcFk', 'HCfPhZQz2CE', 'of1XzU7-PHk', '0QVOc1aagSE']);
    });

    it('skips malformed, blank and non-object lines', () => {
        const stdout = [
            '',
            JSON.stringify({ id: 'AAAAAAAAAAA', title: 'ok' }),
            'WARNING: not json',
            '{"id": "BBBBBBBBBBB", "title": ',
            '42',
            '"a string"',
            '[1,2,3]',
            '   ',
            JSON.stringify({ id: 'CCCCCCCCCCC', title: 'also ok' }),
            ''
        ].join('\n');
        expect(ytsearch.parseJsonLines(stdout).map((e) => e.id)).toEqual(['AAAAAAAAAAA', 'CCCCCCCCCCC']);
        expect(ytsearch.parseJsonLines('')).toEqual([]);
        expect(ytsearch.parseJsonLines(undefined)).toEqual([]);
    });
});

describe('ytsearch.normalizeEntry', () => {
    const entries = ytsearch.parseJsonLines(flatLines);
    const byId = Object.fromEntries(entries.map((e) => [e.id, ytsearch.normalizeEntry(e)]));

    it('maps the verified artist channel to a candidate with the channel as its artist', () => {
        expect(byId['5NV6Rdv1a3I']).toEqual({
            videoId: '5NV6Rdv1a3I',
            title: 'Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers',
            artists: ['Daft Punk'],
            album: null,
            durationSec: 249,
            plays: 880620019,
            origin: 'ytsearch',
            channel: 'Daft Punk',
            channelIsVerified: true,
            isTopic: false,
            liveStatus: null
        });
    });

    it('gives an unverified channel no artist at all (a private upload by construction)', () => {
        expect(byId.CCHdMIEGaaM).toMatchObject({ channel: 'convar HUN', channelIsVerified: false, isTopic: false, artists: [], durationSec: 248, plays: 58562329 });
        expect(byId.DvE7O3bLQgE).toMatchObject({ channel: 'EXPO STORY', channelIsVerified: false, artists: [], durationSec: 369 });
        expect(byId.HCfPhZQz2CE).toMatchObject({ channel: 'nTOURIST', artists: [], durationSec: 600, plays: 238371718 });
        expect(byId['0QVOc1aagSE']).toMatchObject({ channel: 'pfigueroah', artists: [], durationSec: 1088 });
    });

    it('keeps a verified lyric channel as a named candidate; deciding it is not the artist is the scorer\'s job', () => {
        expect(byId['5glDAaCaazc']).toMatchObject({ channel: '7clouds', channelIsVerified: true, isTopic: false, artists: ['7clouds'], durationSec: 246 });
        expect(byId.MrOpYwqAcFk).toMatchObject({ channel: 'Pharrell Williams', channelIsVerified: true, artists: ['Pharrell Williams'], durationSec: 212 });
    });

    it('recognises a Topic channel and strips the suffix from the artist', () => {
        const topic = ytsearch.normalizeEntry({ id: 'AAAAAAAAAAA', title: 'Get Lucky', channel: 'Daft Punk - Topic', channel_is_verified: null, duration: 369, view_count: 12, live_status: null });
        expect(topic).toMatchObject({ channel: 'Daft Punk - Topic', isTopic: true, channelIsVerified: false, artists: ['Daft Punk'], durationSec: 369, plays: 12 });
        // Only the exact " - Topic" suffix counts, not a channel that merely mentions the word.
        expect(ytsearch.normalizeEntry({ id: 'AAAAAAAAAAA', title: 't', channel: 'Hot Topic' })).toMatchObject({ isTopic: false, artists: [] });
    });

    it('passes live_status through and tolerates a missing duration/view_count', () => {
        const live = ytsearch.normalizeEntry({ id: 'BBBBBBBBBBB', title: 'Live now', channel: 'Some Radio', channel_is_verified: true, duration: null, view_count: null, live_status: 'is_live' });
        expect(live).toMatchObject({ liveStatus: 'is_live', durationSec: null, plays: 0, artists: ['Some Radio'] });
        const upcoming = ytsearch.normalizeEntry({ id: 'BBBBBBBBBBB', title: 'Premiere', uploader: 'X', live_status: 'is_upcoming' });
        expect(upcoming).toMatchObject({ liveStatus: 'is_upcoming', channel: 'X', durationSec: null });
    });

    it('falls back to uploader when channel is missing and rounds fractional durations', () => {
        const e = ytsearch.normalizeEntry({ id: 'CCCCCCCCCCC', title: 't', uploader: 'Uploader Name', channel_is_verified: true, duration: 248.6 });
        expect(e).toMatchObject({ channel: 'Uploader Name', artists: ['Uploader Name'], durationSec: 249 });
    });

    it('drops entries without a valid 11-char id or without a title', () => {
        expect(ytsearch.normalizeEntry({ title: 'no id' })).toBeNull();
        expect(ytsearch.normalizeEntry({ id: 'short', title: 'bad id' })).toBeNull();
        expect(ytsearch.normalizeEntry({ id: 12345678901, title: 'numeric id' })).toBeNull();
        expect(ytsearch.normalizeEntry({ id: 'DDDDDDDDDDD', title: '   ' })).toBeNull();
        expect(ytsearch.normalizeEntry({ id: 'DDDDDDDDDDD' })).toBeNull();
        expect(ytsearch.normalizeEntry(null)).toBeNull();
        expect(ytsearch.normalizeEntry('str')).toBeNull();
        expect(ytsearch.normalizeEntry([])).toBeNull();
    });
});

describe('ytsearch.searchVideos', () => {
    let execMock;
    beforeEach(() => {
        execMock = jest.fn();
        ytsearch.runner.exec = execMock;
    });

    it('runs one flat ytsearch whose query is a single argv element with both phrases quoted', async () => {
        execMock.mockResolvedValueOnce(flatLines);

        const result = await ytsearch.searchVideos('Daft Punk', 'Get Lucky');

        expect(execMock).toHaveBeenCalledTimes(1);
        const args = execMock.mock.calls[0][0];
        expect(args).toEqual(['--no-update', '--no-warnings', '--flat-playlist', '-j', 'ytsearch10:"Daft Punk" "Get Lucky"']);
        expect(result).toHaveLength(8);
        expect(result[0]).toMatchObject({ videoId: '5NV6Rdv1a3I', origin: 'ytsearch', artists: ['Daft Punk'] });
        expect(result.filter((c) => c.artists.length === 0)).toHaveLength(5);
    });

    it('strips double quotes from the embedded strings so the phrases stay balanced', async () => {
        execMock.mockResolvedValueOnce('');

        await ytsearch.searchVideos('Daft "Robot" Punk', '"Get Lucky" (feat. "Pharrell")', { limit: 8 });

        const args = execMock.mock.calls[0][0];
        const query = args[args.length - 1];
        expect(args).toHaveLength(5);
        expect(query).toBe('ytsearch8:"Daft Robot Punk" "Get Lucky (feat. Pharrell)"');
        expect((query.match(/"/g) || []).length % 2).toBe(0);
        expect(query.match(/"/g)).toHaveLength(4);
    });

    it('collapses whitespace and omits an empty artist phrase', async () => {
        execMock.mockResolvedValueOnce('');
        await ytsearch.searchVideos('', '  Get   Lucky\n');
        expect(execMock.mock.calls[0][0].pop()).toBe('ytsearch10:"Get Lucky"');

        await expect(ytsearch.searchVideos('', '""')).rejects.toThrow(TypeError);
        expect(execMock).toHaveBeenCalledTimes(1);
    });

    it('caps the limit at 50 and uses 10 for anything that is not a positive count', async () => {
        execMock.mockResolvedValue('');
        await ytsearch.searchVideos('a', 'b', { limit: 0 });
        await ytsearch.searchVideos('a', 'b', { limit: -5 });
        await ytsearch.searchVideos('a', 'b', { limit: 999 });
        await ytsearch.searchVideos('a', 'b', { limit: 'lots' });
        await ytsearch.searchVideos('a', 'b', { limit: 3.7 });
        await ytsearch.searchVideos('a', 'b');
        expect(execMock.mock.calls.map((c) => c[0].pop().split(':')[0]))
            .toEqual(['ytsearch10', 'ytsearch10', 'ytsearch50', 'ytsearch10', 'ytsearch3', 'ytsearch10']);
    });

    it('skips malformed lines and unusable entries in yt-dlp output', async () => {
        execMock.mockResolvedValueOnce([
            flatLines.split('\n')[0],
            'ERROR: something on stdout',
            JSON.stringify({ id: 'nope', title: 'bad id' }),
            JSON.stringify({ id: 'ZZZZZZZZZZZ', title: 'Daft Punk - Topic upload', channel: 'Daft Punk - Topic', duration: 369 })
        ].join('\n'));

        const result = await ytsearch.searchVideos('Daft Punk', 'Get Lucky');

        expect(result.map((c) => c.videoId)).toEqual(['5NV6Rdv1a3I', 'ZZZZZZZZZZZ']);
        expect(result[1]).toMatchObject({ isTopic: true, artists: ['Daft Punk'], channelIsVerified: false });
    });

    it('wraps a failed yt-dlp run as MatchSourceError UNAVAILABLE', async () => {
        const failure = Object.assign(new Error('yt-dlp failed: ERROR: Unable to download webpage'), { code: 'YTDLP_FAILED', exitCode: 1 });
        execMock.mockRejectedValueOnce(failure);

        const err = await ytsearch.searchVideos('a', 'b').catch((e) => e);

        expect(err).toBeInstanceOf(innertube.MatchSourceError);
        expect(err).toMatchObject({ code: 'UNAVAILABLE' });
        expect(err.cause).toBe(failure);
        expect(err.message).toMatch(/Unable to download webpage/);
    });

    it('passes a MatchSourceError from the runner through unchanged', async () => {
        const limited = new innertube.MatchSourceError('RATE_LIMITED', 'blocked', { status: 429 });
        execMock.mockRejectedValueOnce(limited);
        await expect(ytsearch.searchVideos('a', 'b')).rejects.toBe(limited);
    });
});

describe('ytsearch configuration flags', () => {
    const saved = {};
    beforeEach(() => {
        saved.fallback = process.env.MATCH_YTDLP_FALLBACK;
        saved.recall = process.env.MATCH_YTDLP_RECALL;
        delete process.env.MATCH_YTDLP_FALLBACK;
        delete process.env.MATCH_YTDLP_RECALL;
    });
    afterEach(() => {
        if (saved.fallback === undefined) delete process.env.MATCH_YTDLP_FALLBACK; else process.env.MATCH_YTDLP_FALLBACK = saved.fallback;
        if (saved.recall === undefined) delete process.env.MATCH_YTDLP_RECALL; else process.env.MATCH_YTDLP_RECALL = saved.recall;
    });

    it('isEnabled defaults to on and turns off for off/false/0/no (case-insensitive)', () => {
        expect(ytsearch.isEnabled()).toBe(true);
        for (const on of ['on', 'true', '1', 'yes', 'anything-else', '']) {
            process.env.MATCH_YTDLP_FALLBACK = on;
            expect(ytsearch.isEnabled()).toBe(true);
        }
        for (const off of ['off', 'false', '0', 'no', 'OFF', ' False ']) {
            process.env.MATCH_YTDLP_FALLBACK = off;
            expect(ytsearch.isEnabled()).toBe(false);
        }
    });

    it('recallEnabled defaults to off and turns on only for true/1/on/yes', () => {
        expect(ytsearch.recallEnabled()).toBe(false);
        for (const on of ['true', '1', 'on', 'yes', 'TRUE', ' On ']) {
            process.env.MATCH_YTDLP_RECALL = on;
            expect(ytsearch.recallEnabled()).toBe(true);
        }
        for (const off of ['false', '0', 'off', 'no', '', 'maybe']) {
            process.env.MATCH_YTDLP_RECALL = off;
            expect(ytsearch.recallEnabled()).toBe(false);
        }
    });
});
