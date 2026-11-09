// Scoring and hard rejects, driven by the real "daft punk get lucky" probe
// results (YouTube Music songs filter, videos filter and yt-dlp flat search).
const { evaluate, pickBest, durationTolerance } = require('../services/matcher/score');

const DP = ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'];

const song = (videoId, title, artists, album, durationSec, plays, extra = {}) => ({
    videoId, title, artists, album, durationSec, plays, videoType: 'atv', origin: 'ytmusic', ...extra
});

// YouTube Music songs filter for "daft punk get lucky" (2026-10-13).
const SONGS = [
    song('Rgrt_8mXrK8', 'Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)', DP, 'Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)', 249, 1.9e9),
    song('4D7u5KF7SP8', 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)', DP, 'Random Access Memories', 370, 1.9e9),
    song('55pBMXnbqxo', 'Get Lucky (We\'re up All Night)', ['Get Lucky'], 'Get Lucky', 259, 110e3),
    song('2KPIShmFouY', 'Get Lucky', ['Funk Punk'], 'Get Lucky', 250, 7.6e3),
    song('D-cfH1V4RQ0', 'Get Lucky (Metal Cover)', ['Leo'], 'Leo Metal Covers Volume 7', 209, 224e3),
    song('7FhqrDhIgQA', 'Get Lucky', ['Phil A.'], 'Best of 2000\'s: Hits from Decade', 245, 1.3e3),
    song('N9uzbafKyQs', 'Get Lucky', ['Pop Mania'], 'Bbq Bangers', 259, 80e3),
    song('imDKnNvqpq0', 'Get Lucky', ['Helia'], 'Get Lucky', 229, 1e6),
    song('noartist0001', 'Get Lucky', [], null, 249, 0)
];

// YouTube Music videos filter: the one OMV, then UGC uploads.
const OMV = song('5NV6Rdv1a3I', 'Get Lucky (Official Audio) (feat. Pharrell Williams & Nile Rodgers)', ['Daft Punk'], null, 249, 880e6, { videoType: 'omv' });
const UGC = [
    song('CCHdMIEGaaM', 'Daft Punk - Get Lucky (Official Video) feat. Pharrell Williams and Nile Rodgers', ['convar HUN'], null, 248, 58e6, { videoType: 'ugc' }),
    song('RVjRx5ceD2Q', 'Daft Punk & Pharrell Williams - Get Lucky (lyrics)', ['Core lyrics'], null, 249, 2.1e3, { videoType: 'ugc' }),
    song('3fCUH24zWyo', 'Daft Punk - Get Lucky (David A Remix)', ['MA Free'], null, 196, 823e3, { videoType: 'ugc' })
];

// yt-dlp flat `ytsearch8:"Daft Punk" "Get Lucky"` entries, as ytsearch.js maps them.
const flat = (videoId, title, channel, channelIsVerified, durationSec, plays, extra = {}) => ({
    videoId, title, channel, channelIsVerified, isTopic: /\s-\sTopic$/.test(channel), artists: [], durationSec, plays, liveStatus: null, origin: 'ytsearch', ...extra
});
const FLAT = {
    official: flat('5NV6Rdv1a3I', 'Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers', 'Daft Punk', true, 249, 880620019),
    reupload: flat('CCHdMIEGaaM', 'Daft Punk - Get Lucky (Official Video) feat. Pharrell Williams and Nile Rodgers', 'convar HUN', false, 248, 58562329),
    albumReupload: flat('DvE7O3bLQgE', 'Daft Punk - Get Lucky (Feat. Pharrell Williams)', 'EXPO STORY', false, 369, 35407081),
    lyrics: flat('5glDAaCaazc', 'Daft Punk - Get Lucky (Lyrics) ft. Pharrell Williams, Nile Rodgers', '7clouds', true, 246, 53950916),
    live: flat('MrOpYwqAcFk', 'Pharrell Williams - Get Lucky (Live from Apple Music Festival, London, 2015)', 'Pharrell Williams', true, 212, 3033138),
    loop: flat('HCfPhZQz2CE', 'Daft Punk - \'Get Lucky\' (10 min loop)', 'nTOURIST', false, 600, 238371718),
    topic: flat('topic0000001', 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Daft Punk - Topic', false, 369, 12345)
};

// Spotify's catalog entries (golden set g01 / g02 / g27).
const ALBUM_TRACK = { source: 'spotify', id: 'g01', title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', artist: 'Daft Punk', artists: DP, album: 'Random Access Memories', durationSec: 369 };
const RADIO_TRACK = { source: 'spotify', id: 'g02', title: 'Get Lucky (Radio Edit) [feat. Pharrell Williams & Nile Rodgers]', artist: 'Daft Punk', artists: DP, album: 'Get Lucky (Radio Edit)', durationSec: 248 };
const FUNK_PUNK_TRACK = { source: 'spotify', id: 'g27', title: 'Get Lucky', artist: 'Funk Punk', artists: ['Funk Punk'], album: 'Get Lucky', durationSec: 250 };

const byId = (evaluated, id) => evaluated.find(e => e.videoId === id);

afterEach(() => {
    delete process.env.MATCH_DURATION_TOLERANCE_SEC;
});

describe('Get Lucky: album version vs radio edit', () => {
    it('the 369 s album track picks the Random Access Memories catalog entry', () => {
        const { best, evaluated } = pickBest(ALBUM_TRACK, [...SONGS, OMV]);
        expect(best.videoId).toBe('4D7u5KF7SP8');
        // 90 - 10 (one second off) + 10 (all three artists listed) + 5 (same album).
        expect(best.score).toBe(95);
        expect(byId(evaluated, 'Rgrt_8mXrK8').reasons).toEqual(['title', 'duration']);
        expect(byId(evaluated, '5NV6Rdv1a3I').reasons).toEqual(['duration']);
        expect(byId(evaluated, '2KPIShmFouY').reasons).toContain('artist');
        expect(byId(evaluated, 'D-cfH1V4RQ0').reasons).toEqual(['artist', 'title', 'duration']);
        expect(byId(evaluated, 'noartist0001').reasons).toContain('artist');
        expect(evaluated.filter(e => e.ok).map(e => e.videoId)).toEqual(['4D7u5KF7SP8']);
    });

    it('the 248 s radio edit picks the Radio Edit catalog entry and rejects the OMV on title', () => {
        const { best, evaluated } = pickBest(RADIO_TRACK, [...SONGS, OMV]);
        expect(best.videoId).toBe('Rgrt_8mXrK8');
        // 90 - 10 + 10 - 5: Spotify's single album name differs from YT Music's.
        expect(best.score).toBe(85);
        expect(byId(evaluated, '4D7u5KF7SP8').reasons).toEqual(['title', 'duration']);
        expect(byId(evaluated, '5NV6Rdv1a3I').reasons).toEqual(['title']);
        expect(byId(evaluated, '2KPIShmFouY').reasons).toEqual(['artist', 'title']);
    });

    it('a different artist with the same title matches its own entry only', () => {
        const { best, evaluated } = pickBest(FUNK_PUNK_TRACK, [...SONGS, OMV]);
        expect(best.videoId).toBe('2KPIShmFouY');
        expect(best.score).toBe(100);
        expect(byId(evaluated, 'Rgrt_8mXrK8').reasons).toContain('artist');
        expect(byId(evaluated, '4D7u5KF7SP8').reasons).toContain('artist');
        expect(byId(evaluated, '5NV6Rdv1a3I').reasons).toContain('artist');
        // Helia's 3:49 is also 21 s off, so both reasons are reported.
        expect(byId(evaluated, 'imDKnNvqpq0').reasons).toEqual(['artist', 'duration']);
    });

    it('an OMV scores 10 below the identical catalog audio', () => {
        const plain = { title: 'Get Lucky', artists: ['Daft Punk'], durationSec: 249 };
        const atv = song('atv00000001', 'Get Lucky', ['Daft Punk'], null, 249, 1);
        expect(evaluate(plain, atv)).toEqual({ ok: true, reasons: [], score: 100 });
        expect(evaluate(plain, OMV)).toEqual({ ok: true, reasons: [], score: 90 });
    });
});

describe('Levitating: full artist coverage', () => {
    const track = { title: 'Levitating (feat. DaBaby)', artist: 'Dua Lipa', artists: ['Dua Lipa', 'DaBaby'], durationSec: 203 };
    const withFeat = song('feat0000001', 'Levitating (feat. DaBaby)', ['Dua Lipa', 'DaBaby'], null, 203, 1e9);
    const solo = song('solo0000001', 'Levitating', ['Dua Lipa'], null, 203, 2e9);

    it('prefers the catalog entry that lists every track artist over the solo version of identical length', () => {
        const { best, evaluated } = pickBest(track, [solo, withFeat]);
        expect(best.videoId).toBe('feat0000001');
        expect(byId(evaluated, 'feat0000001').score).toBe(100);
        expect(byId(evaluated, 'solo0000001').score).toBe(90);
        expect(byId(evaluated, 'solo0000001').ok).toBe(true);
    });

    it('counts the feats in the candidate title for coverage, but never for the artist check', () => {
        // Live result: YouTube Music credited only Dua Lipa on the featured track.
        const primaryOnly = song('feat0000002', 'Levitating (feat. DaBaby)', ['Dua Lipa'], null, 203, 1e9);
        expect(evaluate(track, primaryOnly).score).toBe(100);
        expect(evaluate(track, solo).score).toBe(90);
        expect(pickBest(track, [solo, primaryOnly]).best.videoId).toBe('feat0000002');
        // A feat credit in the title does not make DaBaby's upload Dua Lipa's.
        const wrongArtist = song('feat0000003', 'Levitating (feat. Dua Lipa)', ['Someone Else'], null, 203, 1);
        expect(evaluate(track, wrongArtist).reasons).toContain('artist');
    });

    it('with only an artist string, a later fragment of the name is not enough', () => {
        const ewf = { title: 'September', artist: 'Earth, Wind & Fire', durationSec: 215 };
        expect(evaluate(ewf, song('ewf00000001', 'September', ['Fire'], null, 215, 1)).reasons).toEqual(['artist']);
        expect(evaluate(ewf, song('ewf00000002', 'September', ['Earth, Wind & Fire'], null, 215, 1)).ok).toBe(true);
        expect(evaluate(ewf, song('ewf00000003', 'September', ['Earth'], null, 215, 1)).ok).toBe(true);
    });

    it('treats an unsplit single act as fully covered', () => {
        const sg = { title: 'The Sound of Silence', artist: 'Simon & Garfunkel', durationSec: 185 };
        expect(evaluate(sg, song('sg000000001', 'The Sound of Silence', ['Simon & Garfunkel'], null, 185, 1)).score).toBe(100);
        expect(evaluate(sg, song('sg000000002', 'The Sound of Silence', ['Simon', 'Garfunkel'], null, 185, 1)).score).toBe(100);
        expect(evaluate(sg, song('sg000000003', 'The Sound of Silence', ['Simon'], null, 185, 1)).score).toBe(90);
    });
});

describe('hard rejects', () => {
    it('rejects UGC and unclassified YouTube Music items even when everything else matches', () => {
        const track = { title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', artists: DP, durationSec: 248 };
        const perfect = song('ugc00000001', 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)', DP, null, 248, 1e6, { videoType: 'ugc' });
        expect(evaluate(track, perfect)).toEqual({ ok: false, reasons: ['unofficial'], score: null });
        expect(evaluate(track, { ...perfect, videoType: 'unknown' }).reasons).toEqual(['unofficial']);
        expect(evaluate(track, { ...perfect, videoType: undefined }).reasons).toEqual(['unofficial']);
        for (const c of UGC) {
            expect(evaluate(track, c).reasons).toContain('unofficial');
        }
    });

    it('collects every failing reason instead of stopping at the first', () => {
        const track = { title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', artists: DP, durationSec: 369 };
        expect(evaluate(track, UGC[2]).reasons).toEqual(['unofficial', 'artist', 'title', 'duration']);
    });

    it('rejects a missing candidate duration but skips the check for an unknown track duration', () => {
        const track = { title: 'Get Lucky', artists: ['Daft Punk'], durationSec: 249 };
        const noDuration = song('nodur000001', 'Get Lucky', ['Daft Punk'], null, null, 1);
        expect(evaluate(track, noDuration).reasons).toEqual(['duration']);
        expect(evaluate({ ...track, durationSec: null }, noDuration).ok).toBe(true);
        // Spotify sends 0 when it does not know the length.
        expect(evaluate({ ...track, durationSec: 0 }, song('long0000001', 'Get Lucky', ['Daft Punk'], null, 600, 1)).ok).toBe(true);
    });

    it('rejects live and upcoming streams', () => {
        const track = { title: 'Get Lucky', artists: ['Daft Punk'], durationSec: 249 };
        expect(evaluate(track, { ...FLAT.official, title: 'Daft Punk - Get Lucky', liveStatus: 'is_live' }).reasons).toEqual(['live']);
        expect(evaluate(track, { ...FLAT.official, title: 'Daft Punk - Get Lucky', liveStatus: 'is_upcoming' }).reasons).toEqual(['live']);
        expect(evaluate(track, { ...FLAT.official, title: 'Daft Punk - Get Lucky', liveStatus: 'not_live' }).ok).toBe(true);
    });
});

describe('ytsearch candidates (channel heuristics)', () => {
    it('an unverified channel is a private upload: unofficial and without an artist', () => {
        expect(evaluate(ALBUM_TRACK, FLAT.albumReupload).reasons).toEqual(['unofficial', 'artist']);
        expect(evaluate(RADIO_TRACK, FLAT.reupload).reasons).toEqual(['unofficial', 'artist', 'title']);
        expect(evaluate(ALBUM_TRACK, FLAT.loop).reasons).toEqual(['unofficial', 'artist', 'title', 'duration']);
    });

    it('a verified channel whose name is not a track artist is still unofficial (7clouds)', () => {
        expect(evaluate(RADIO_TRACK, FLAT.lyrics).reasons).toEqual(['unofficial', 'artist', 'title']);
    });

    it('the verified artist channel is official and pays the ytsearch penalty', () => {
        const plain = { title: 'Get Lucky', artists: ['Daft Punk'], durationSec: 249 };
        // 90 + 10 (coverage) - 15 (ytsearch).
        expect(evaluate(plain, FLAT.official)).toEqual({ ok: true, reasons: [], score: 85 });
        // The same upload is the radio edit, so the album track rejects it on length.
        expect(evaluate(ALBUM_TRACK, FLAT.official).reasons).toEqual(['duration']);
    });

    it('a verified channel of another credited artist is official but the live variant is rejected', () => {
        expect(evaluate(ALBUM_TRACK, FLAT.live).reasons).toEqual(['title', 'duration']);
        expect(evaluate({ ...ALBUM_TRACK, title: 'Get Lucky - Live', durationSec: 212 }, FLAT.live).ok).toBe(true);
    });

    it('a Topic channel is official, names the artist and earns the Topic bonus', () => {
        const result = evaluate(ALBUM_TRACK, FLAT.topic);
        // 90 - 15 (ytsearch) + 5 (Topic) + 10: only Daft Punk is credited by the
        // channel, but the title's "(feat. Pharrell Williams & Nile Rodgers)"
        // completes the coverage.
        expect(result).toEqual({ ok: true, reasons: [], score: 90 });
        const topicFromChannel = { ...FLAT.topic, isTopic: undefined, channel: 'Daft Punk - Topic' };
        expect(evaluate(ALBUM_TRACK, topicFromChannel).score).toBe(90);
        // Without the feats in the title the bonus is gone.
        expect(evaluate(ALBUM_TRACK, { ...FLAT.topic, title: 'Get Lucky' }).score).toBe(80);
    });

    it('derives artists from the channel, ignoring any artists field the entry carries', () => {
        expect(evaluate(ALBUM_TRACK, { ...FLAT.albumReupload, artists: DP }).reasons).toContain('artist');
    });
});

describe('score adjustments', () => {
    const track = { title: 'Around the World', artists: ['Daft Punk'], album: 'Homework', durationSec: 429, explicit: false };
    const base = song('base0000001', 'Around the World', ['Daft Punk'], null, 429, 1);

    it('loses 10 per second of duration delta', () => {
        expect(evaluate(track, base).score).toBe(100);
        expect(evaluate(track, { ...base, durationSec: 431 }).score).toBe(80);
        expect(evaluate(track, { ...base, durationSec: 426 }).score).toBe(70);
    });

    it('applies the album and explicit adjustments only when both sides are known', () => {
        expect(evaluate(track, { ...base, album: 'Homework' }).score).toBe(100);
        expect(evaluate(track, { ...base, album: 'Discovery', durationSec: 431 }).score).toBe(75);
        expect(evaluate(track, { ...base, explicit: false, durationSec: 431 }).score).toBe(83);
        expect(evaluate(track, { ...base, explicit: true, durationSec: 431 }).score).toBe(77);
        expect(evaluate({ ...track, explicit: undefined }, { ...base, explicit: true, durationSec: 431 }).score).toBe(80);
    });

    it('clamps the score to 0..100', () => {
        expect(evaluate(track, { ...base, album: 'Homework', explicit: false }).score).toBe(100);
        process.env.MATCH_DURATION_TOLERANCE_SEC = '30';
        expect(evaluate(track, { ...base, durationSec: 449 }).score).toBe(0);
    });
});

describe('duration tolerance', () => {
    const track = { title: 'Get Lucky', artists: ['Daft Punk'], durationSec: 369 };
    const eightOff = song('eight000001', 'Get Lucky', ['Daft Punk'], null, 377, 1);

    it('defaults to 5 seconds and ignores garbage', () => {
        expect(durationTolerance()).toBe(5);
        process.env.MATCH_DURATION_TOLERANCE_SEC = 'abc';
        expect(durationTolerance()).toBe(5);
        process.env.MATCH_DURATION_TOLERANCE_SEC = '-1';
        expect(durationTolerance()).toBe(5);
        process.env.MATCH_DURATION_TOLERANCE_SEC = '';
        expect(durationTolerance()).toBe(5);
    });

    it('is read from the environment at call time', () => {
        expect(evaluate(track, eightOff).reasons).toEqual(['duration']);
        process.env.MATCH_DURATION_TOLERANCE_SEC = '10';
        expect(durationTolerance()).toBe(10);
        expect(evaluate(track, eightOff).ok).toBe(true);
        process.env.MATCH_DURATION_TOLERANCE_SEC = '5';
        expect(evaluate(track, eightOff).reasons).toEqual(['duration']);
        delete process.env.MATCH_DURATION_TOLERANCE_SEC;
        expect(evaluate(track, eightOff).reasons).toEqual(['duration']);
    });

    it('accepts a per-call override', () => {
        expect(evaluate(track, eightOff, { toleranceSec: 8 }).ok).toBe(true);
    });
});

describe('pickBest ordering', () => {
    const track = { title: 'Get Lucky', artists: ['Daft Punk'], durationSec: 249 };

    it('sorts passing candidates first, then by score, then by plays', () => {
        const candidates = [
            song('rejected001', 'Get Lucky (Metal Cover)', ['Daft Punk'], null, 249, 9e9),
            song('lowplays001', 'Get Lucky', ['Daft Punk'], null, 249, 10),
            song('offbyone001', 'Get Lucky', ['Daft Punk'], null, 250, 5e9),
            song('hiplays0001', 'Get Lucky', ['Daft Punk'], null, 249, 1000),
            { ...OMV, videoId: 'omv00000001' }
        ];
        const { best, evaluated } = pickBest(track, candidates);
        expect(evaluated.map(e => e.videoId)).toEqual(['hiplays0001', 'lowplays001', 'offbyone001', 'omv00000001', 'rejected001']);
        expect(evaluated.map(e => e.ok)).toEqual([true, true, true, true, false]);
        expect(best.videoId).toBe('hiplays0001');
        expect(best).toMatchObject({ ok: true, reasons: [], score: 100, title: 'Get Lucky' });
    });

    it('returns null when nothing passes and keeps every evaluation', () => {
        const { best, evaluated } = pickBest(ALBUM_TRACK, [FLAT.reupload, FLAT.lyrics, FLAT.loop]);
        expect(best).toBeNull();
        expect(evaluated).toHaveLength(3);
        expect(evaluated.every(e => e.ok === false && e.score === null && e.reasons.length > 0)).toBe(true);
    });

    it('tolerates an empty or missing candidate list', () => {
        expect(pickBest(track, [])).toEqual({ best: null, evaluated: [] });
        expect(pickBest(track)).toEqual({ best: null, evaluated: [] });
    });

    it('ranks previously evaluated entries together with the new ones without re-scoring them', () => {
        const first = pickBest(track, [song('first000001', 'Get Lucky (Metal Cover)', ['Daft Punk'], null, 249, 1)]);
        expect(first.best).toBeNull();
        const second = pickBest(track, [song('second00001', 'Get Lucky', ['Daft Punk'], null, 249, 1)], { evaluated: first.evaluated });
        expect(second.best.videoId).toBe('second00001');
        expect(second.evaluated.map(e => e.videoId)).toEqual(['second00001', 'first000001']);
        // The earlier entry is the same object, not a re-evaluated copy.
        expect(second.evaluated[1]).toBe(first.evaluated[0]);
    });

    it('evaluate accepts a pre-parsed track title', () => {
        const { parseTitle } = require('../services/matcher/normalize');
        const parsedTrack = parseTitle('Get Lucky', ['Daft Punk']);
        const candidate = song('pre00000001', 'Get Lucky', ['Daft Punk'], null, 249, 1);
        expect(evaluate(track, candidate, { parsedTrack })).toEqual({ ok: true, reasons: [], score: 100 });
        // A deliberately different pre-parsed title is what gets compared.
        expect(evaluate(track, candidate, { parsedTrack: parseTitle('Something Else') }).reasons).toEqual(['title']);
    });
});
