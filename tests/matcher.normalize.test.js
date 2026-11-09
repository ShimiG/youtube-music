// Golden table for the match engine's text rules. Every title string that is
// not synthetic is a real Spotify / YouTube Music / yt-dlp title captured by
// the 2026-10-13 probes, so a rule change that breaks a real pairing fails here.
const {
    normalizeText, parseTitle, titlesMatch, normalizeArtist, sameArtist, artistMatches, artistsOf, primaryArtist
} = require('../services/matcher/normalize');

const DP = ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'];

const match = (a, b, artists = []) => titlesMatch(parseTitle(a, artists), parseTitle(b, artists));
const shape = (title, artists = []) => {
    const p = parseTitle(title, artists);
    return { core: p.core, variants: [...p.variants].sort(), feats: p.feats };
};

// [label, titleA, titleB, mustMatch, artists]
const GOLDEN = [
    // --- the same recording, written differently ----------------------------
    ['Spotify "&" feat list vs YT Music "and" feat list', 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)', true, DP],
    ['Spotify bracketed radio edit vs YT Music combined segment', 'Get Lucky (Radio Edit) [feat. Pharrell Williams & Nile Rodgers]', 'Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)', true, DP],
    ['OMV "(Official Audio)" is noise', 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Get Lucky (Official Audio) (feat. Pharrell Williams & Nile Rodgers)', true, DP],
    ['yt-dlp artist prefix and trailing "ft. A, B"', 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers', true, DP],
    ['yt-dlp "(Official Video) feat. A and B"', 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Daft Punk - Get Lucky (Official Video) feat. Pharrell Williams and Nile Rodgers', true, DP],
    ['feat placement and count differ (feats are not compared)', 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Daft Punk - Get Lucky (Feat. Pharrell Williams)', true, DP],
    ['two credited artists in the prefix', 'Texas Sun', 'Khruangbin & Leon Bridges - Texas Sun (Official Video)', true, ['Khruangbin', 'Leon Bridges']],
    ['"Artist: Title" prefix', 'Maria También', 'Khruangbin: Maria También', true, ['Khruangbin']],
    ['remaster suffix vs remaster bracket', 'Bohemian Rhapsody - Remastered 2011', 'Bohemian Rhapsody (Remastered 2011)', true, ['Queen']],
    ['remaster is noise and matches the plain catalog title', 'Bohemian Rhapsody - Remastered 2011', 'Bohemian Rhapsody', true, ['Queen']],
    ['year-first remaster wording', 'Here Comes The Sun - Remastered 2009', 'Here Comes the Sun (2009 Remaster)', true, ['The Beatles']],
    ['"2004 Remaster" vs plain', 'Dreams - 2004 Remaster', 'Dreams', true, ['Fleetwood Mac']],
    ['bare "Remaster"', 'Stairway to Heaven - Remaster', 'Stairway to Heaven (Remaster)', true, ['Led Zeppelin']],
    ['live suffix vs live bracket', 'About A Girl - Live', 'About a Girl (Live)', true, ['Nirvana']],
    ['live venue and year are dropped', 'Get Lucky - Live', 'Pharrell Williams - Get Lucky (Live from Apple Music Festival, London, 2015)', true, DP],
    ['diacritics', 'Maria También', 'Maria Tambien', true, ['Khruangbin']],
    ['"&" vs "and" inside the title', 'Sisters & Brothers', 'Sisters and Brothers', true, ['Khruangbin']],
    ['curly vs straight apostrophe', 'Don’t Stop Me Now', 'Don\'t Stop Me Now', true, ['Queen']],
    ['apostrophe vs none', 'Don\'t Stop Me Now', 'Dont Stop Me Now', true, ['Queen']],
    ['bracket content that belongs to the title', 'Blue (Da Ba Dee)', 'Blue (Da Ba Dee)', true, ['Eiffel 65']],
    ['Spotify chapter suffix vs YT Music bracket', 'MALAMENTE - Cap.1: Augurio', 'MALAMENTE (Cap.1: Augurio)', true, ['ROSALÍA']],
    ['bare year segment', 'Creep (2011)', 'Creep', true, ['Radiohead']],
    ['soundtrack "From ..." noise', 'Shallow (From "A Star Is Born")', 'Shallow', true, ['Lady Gaga']],
    ['"From the Motion Picture" noise wins over a film name containing "live"', 'Shallow - From the Motion Picture \'Live and Let Die\'', 'Shallow', true, ['Lady Gaga']],
    ['trailing punctuation', 'HUMBLE.', 'HUMBLE', true, ['Kendrick Lamar']],
    ['casing', 'Chamber Of Reflection', 'Chamber of Reflection', true, ['Mac DeMarco']],
    ['feat vs no feat', 'Levitating (feat. DaBaby)', 'Levitating', true, ['Dua Lipa', 'DaBaby']],
    ['Spotify "(with X)" credit', 'Texas Sun (with Leon Bridges)', 'Texas Sun', true, ['Khruangbin', 'Leon Bridges']],
    ['Hebrew title survives', 'ירושלים של זהב', 'ירושלים של זהב', true, ['Ofra Haza']],
    ['Korean title plus noise', '봄날', '봄날 (Official Audio)', true, ['BTS']],
    ['Japanese title plus noise', '夜に駆ける', '夜に駆ける (Official Video)', true, ['YOASOBI']],
    ['"Acoustic Version" vs "Acoustic"', 'Song (Acoustic Version)', 'Song (Acoustic)', true],
    ['"Live Acoustic" vs two separate segments', 'Song - Live Acoustic', 'Song (Acoustic) [Live]', true],
    ['explicit vs album version noise', 'Song (Explicit)', 'Song - Album Version', true],
    ['original mix vs bonus track noise', 'Song (Original Mix)', 'Song (Bonus Track)', true],
    ['producer credit noise', 'Song (prod. Metro Boomin)', 'Song', true],
    ['deluxe edition noise', 'Song (Deluxe Edition)', 'Song', true],
    ['official lyric video noise', 'Dynamite', 'Dynamite (Official Lyric Video)', true, ['BTS']],
    ['the same remix in bracket and suffix form', 'Get Lucky (Soulwax Remix)', 'Get Lucky - Soulwax Remix', true, DP],
    ['"Single Version" vs "Single Edit"', 'Song - Single Version', 'Song (Single Edit)', true],
    ['"Extended Mix" vs "Extended"', 'Song (Extended Mix)', 'Song - Extended', true],
    ['"Orchestral Version" vs "Orchestral"', 'Song (Orchestral Version)', 'Song (Orchestral)', true],
    ['the same generic version in bracket and suffix form', 'Song (Piano Version)', 'Song - Piano Version', true],
    ['diacritics and punctuation in classical titles', 'Gymnopédie No. 1', 'Gymnopedie No. 1', true, ['Erik Satie']],
    ['feat in Spotify title only', 'Lose Yourself to Dance (feat. Pharrell Williams)', 'Lose Yourself to Dance', true, ['Daft Punk', 'Pharrell Williams']],
    ['feat in YT Music title only', 'Cebollas Verdes', 'Cebollas Verdes (feat. Quantic)', true, ['Khruangbin']],
    ['" / " separates qualifiers: live + remaster vs live', 'Song - Live / 2011 Remaster', 'Song (Live)', true],
    ['noise words in an unlisted order: "Official HD Music Video"', 'Song', 'Song (Official HD Music Video)', true],
    ['noise words: "Official 4K Video"', 'Song', 'Song (Official 4K Video)', true],
    ['noise words: "4K Upgrade"', 'Song', 'Song [4K Upgrade]', true],
    ['noise words: "Official Music Video HD"', 'Song', 'Song - Official Music Video HD', true],
    // --- different recordings ------------------------------------------------
    ['" / " separates qualifiers: remaster + naked version vs plain', 'Song - Remastered 2009 / Naked Version', 'Song', false],
    ['" / " inside a bracket: remix + live vs live', 'Song (Remix / Live)', 'Song (Live)', false],
    ['a band called "Live" does not erase its own "(Live)" variant', 'Lightning Crashes (Live)', 'Lightning Crashes', false, ['Live']],
    ['a band called "Demo" does not erase its own "(Demo)" variant', 'Song (Demo)', 'Song', false, ['Demo']],
    ['album version vs radio edit', 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)', false, DP],
    ['radio edit vs plain', 'Around the World', 'Around the World (Radio Edit)', false, ['Daft Punk']],
    ['live vs studio', 'Get Lucky', 'Pharrell Williams - Get Lucky (Live from Apple Music Festival, London, 2015)', false, DP],
    ['live Spotify title vs studio catalog title', 'About A Girl - Live', 'About a Girl', false, ['Nirvana']],
    ['cover', 'Get Lucky', 'Get Lucky (Metal Cover)', false, DP],
    ['a different song sharing the core', 'Get Lucky', 'Get Lucky (We\'re up All Night)', false, DP],
    ['karaoke', 'Get Lucky', 'Get Lucky (Karaoke Version)', false, DP],
    ['instrumental', 'Get Lucky', 'Get Lucky (Instrumental)', false, DP],
    ['sped up', 'Get Lucky', 'Get Lucky (Sped Up)', false, DP],
    ['slowed + reverb', 'Get Lucky', 'Get Lucky (Slowed + Reverb)', false, DP],
    ['nightcore', 'Get Lucky', 'Get Lucky (Nightcore)', false, DP],
    ['8d', 'Get Lucky', 'Get Lucky (8D Audio)', false, DP],
    ['two different remixes', 'Get Lucky (David A Remix)', 'Get Lucky (Soulwax Remix)', false, DP],
    ['remix vs original', 'Get Lucky', 'Daft Punk - Get Lucky (David A Remix)', false, DP],
    ['named mix vs album version of the same length', 'Blue (Da Ba Dee)', 'Blue (Da Ba Dee) - Gabry Ponte Ice Pop Mix', false, ['Eiffel 65']],
    ['bracket content is not dropped', 'Blue (Da Ba Dee)', 'Blue', false, ['Eiffel 65']],
    ['single edit vs plain', 'Song - Single Version', 'Song', false],
    ['extended vs plain', 'Song (Extended Mix)', 'Song', false],
    ['demo vs plain', 'Song (Demo)', 'Song', false],
    ['mono vs stereo', 'Song (Mono)', 'Song (Stereo)', false],
    ['unplugged vs plain', 'Song (Unplugged)', 'Song', false],
    ['piano version vs club mix', 'Song (Piano Version)', 'Song (Club Mix)', false],
    ['piano version vs plain', 'Song (Piano Version)', 'Song', false],
    ['slowed karaoke instrumental upload', 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Daft Punk - Get Lucky ft. Pharrell Williams - LOWER Key Slowed Down (Piano Karaoke Instrumental)', false, DP],
    ['piano tutorial after a pipe', 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Daft Punk - Get Lucky ft. Pharrell Williams, Nile Rodgers | EASY PIano Tutorial', false, DP],
    ['unknown "Bass Boosted" segment stays in the core', 'Get Lucky', 'Daft Punk - Get Lucky (Bass Boosted)', false, DP],
    ['10 minute loop', 'Get Lucky', 'Daft Punk - \'Get Lucky\' (10 min loop)', false, DP],
    ['different songs', 'Get Lucky', 'Lose Yourself to Dance', false, DP]
];

describe('golden title table', () => {
    it('covers at least 40 real-world pairings', () => {
        expect(GOLDEN.length).toBeGreaterThanOrEqual(40);
    });

    it.each(GOLDEN)('%s', (_label, a, b, mustMatch, artists = []) => {
        expect(match(a, b, artists)).toBe(mustMatch);
    });
});

describe('normalizeText', () => {
    it('folds diacritics, case, ampersands and plus signs', () => {
        expect(normalizeText('ROSALÍA')).toBe('rosalia');
        expect(normalizeText('Maria También')).toBe('maria tambien');
        expect(normalizeText('Simon & Garfunkel')).toBe('simon and garfunkel');
        expect(normalizeText('Florence + The Machine')).toBe('florence and the machine');
        expect(normalizeText('Simon+Garfunkel')).toBe('simon and garfunkel');
    });

    it('drops punctuation (curly or straight) and collapses whitespace', () => {
        expect(normalizeText('Don’t   Stop\tMe Now!')).toBe('dont stop me now');
        expect(normalizeText('“HUMBLE.”')).toBe('humble');
        expect(normalizeText('Cap.1: Augurio')).toBe('cap1 augurio');
        expect(normalizeText('Jay-Z')).toBe('jayz');
    });

    it('keeps non-Latin scripts', () => {
        expect(normalizeText('ירושלים של זהב')).toBe('ירושלים של זהב');
        expect(normalizeText('夜に駆ける')).toBe('夜に駆ける');
        // NFKD splits Hangul syllables into conjoining jamo, which are letters, not marks.
        expect(normalizeText('봄날')).toBe('봄날'.normalize('NFKD'));
        expect(normalizeText('봄날').length).toBeGreaterThan(0);
    });

    it('tolerates empty input', () => {
        expect(normalizeText(null)).toBe('');
        expect(normalizeText(undefined)).toBe('');
        expect(normalizeText('   ')).toBe('');
    });
});

describe('parseTitle', () => {
    it('separates core, variants and feats for the YT Music radio edit', () => {
        expect(shape('Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)', DP))
            .toEqual({ core: 'get lucky', variants: ['radio edit'], feats: ['Pharrell Williams', 'Nile Rodgers'] });
    });

    it('collects trailing "ft. A, B" from a yt-dlp title and strips the artist prefix', () => {
        expect(shape('Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers', DP))
            .toEqual({ core: 'get lucky', variants: [], feats: ['Pharrell Williams', 'Nile Rodgers'] });
    });

    it('does not strip a prefix that is not one of the artists', () => {
        expect(shape('MALAMENTE - Cap.1: Augurio', ['ROSALÍA']).core).toBe('malamente cap1 augurio');
        expect(shape('Daft Punk - Get Lucky', []).core).toBe('daft punk get lucky');
    });

    it('emits every specific token in a segment and drops the generic word', () => {
        expect(shape('Daft Punk - Get Lucky ft. Pharrell Williams - LOWER Key Slowed Down (Piano Karaoke Instrumental)', DP))
            .toEqual({ core: 'get lucky', variants: ['instrumental', 'karaoke', 'slowed'], feats: ['Pharrell Williams'] });
        expect(shape('Song (Acoustic Version)').variants).toEqual(['acoustic']);
        expect(shape('Song (Slowed + Reverb)').variants).toEqual(['reverb', 'slowed']);
        expect(shape('Song (Radio Mix)').variants).toEqual(['radio edit']);
    });

    it('keeps the full text of a generic mix with years removed', () => {
        expect(shape('Get Lucky (Soulwax Remix 2010)', DP).variants).toEqual(['soulwax remix']);
        expect(shape('Blue (Da Ba Dee) - Gabry Ponte Ice Pop Mix', ['Eiffel 65']))
            .toEqual({ core: 'blue da ba dee', variants: ['gabry ponte ice pop mix'], feats: [] });
        expect(shape('Song (Club Mix)').variants).toEqual(['club mix']);
    });

    it('treats remasters, years, soundtrack and producer credits as noise', () => {
        expect(shape('Bohemian Rhapsody - Remastered 2011', ['Queen'])).toEqual({ core: 'bohemian rhapsody', variants: [], feats: [] });
        expect(shape('Creep (2011)').variants).toEqual([]);
        expect(shape('Shallow (From "A Star Is Born")').core).toBe('shallow');
        expect(shape('Song (prod. Metro Boomin)').core).toBe('song');
    });

    it('appends unknown bracket text to the core', () => {
        expect(shape('Blue (Da Ba Dee)').core).toBe('blue da ba dee');
        expect(shape('Get Lucky (We\'re up All Night)').core).toBe('get lucky were up all night');
    });

    it('drops a trailing attribution segment equal to an artist', () => {
        expect(shape('Get Lucky - Daft Punk', DP).core).toBe('get lucky');
    });

    it('keeps the variant when the attribution would be a band named like one', () => {
        expect(shape('Lightning Crashes (Live)', ['Live'])).toEqual({ core: 'lightning crashes', variants: ['live'], feats: [] });
        expect(shape('Live - Lightning Crashes (Live)', ['Live'])).toEqual({ core: 'lightning crashes', variants: ['live'], feats: [] });
        expect(shape('Song (Mono)', ['Mono']).variants).toEqual(['mono']);
        expect(shape('Song (Cover)', ['Cover']).variants).toEqual(['cover']);
    });

    it('classifies every " / "-separated piece on its own', () => {
        expect(shape('Song - Remastered 2009 / Naked Version')).toEqual({ core: 'song', variants: ['naked version'], feats: [] });
        expect(shape('Song - Live / 2011 Remaster')).toEqual({ core: 'song', variants: ['live'], feats: [] });
        expect(shape('Song (Remix / Live)')).toEqual({ core: 'song', variants: ['live', 'remix'], feats: [] });
    });

    it('treats a segment made only of upload words as noise, whatever the order', () => {
        for (const noise of ['Official HD Music Video', 'Official 4K Video', '4K Upgrade', 'Official Music Video HD', 'Official Visualizer HD', 'New Official Audio']) {
            expect(shape(`Song (${noise})`)).toEqual({ core: 'song', variants: [], feats: [] });
        }
        // A remaster still goes through its own rule, and unknown words stay in the core.
        expect(shape('Song (Remastered Video)').core).toBe('song');
        expect(shape('Song (Full Album)').core).toBe('song full album');
        expect(shape('Song (Piano Version)').variants).toEqual(['piano version']);
    });

    it('parses a 50 KB nested-bracket title in linear time', () => {
        const depth = 12_000;
        const hostile = `Song ${'(x '.repeat(depth)}Live${') '.repeat(depth)}`;
        expect(hostile.length).toBeGreaterThan(50_000);
        const parsed = parseTitle(hostile, DP);
        expect(parsed.variants.has('live')).toBe(true);
        expect(parsed.core.startsWith('song x')).toBe(true);
        // Best of three, after the warm-up above: the quadratic version took
        // seconds here, so a loaded CI box cannot blur the distinction.
        let bestMs = Infinity;
        for (let i = 0; i < 3; i++) {
            const started = process.hrtime.bigint();
            parseTitle(hostile, DP);
            bestMs = Math.min(bestMs, Number(process.hrtime.bigint() - started) / 1e6);
        }
        expect(bestMs).toBeLessThan(50);
    });

    it('puts an unclosed bracket back as text and ignores a stray closer', () => {
        expect(shape('Song (Live').core).toBe('song live');
        expect(shape('Song (Live').variants).toEqual([]);
        expect(shape('Song Live)')).toEqual({ core: 'song live', variants: [], feats: [] });
        expect(shape('Song [Live (Acoustic] Mix)').variants).toEqual(['acoustic']);
    });

    it('handles empty input', () => {
        expect(shape('')).toEqual({ core: '', variants: [], feats: [] });
        expect(shape(null)).toEqual({ core: '', variants: [], feats: [] });
    });
});

describe('titlesMatch', () => {
    it('compares core and variants but never feats', () => {
        const a = parseTitle('Levitating (feat. DaBaby)');
        const b = parseTitle('Levitating');
        expect(a.feats).toEqual(['DaBaby']);
        expect(b.feats).toEqual([]);
        expect(titlesMatch(a, b)).toBe(true);
        expect(titlesMatch(parseTitle('Song (Live)'), parseTitle('Song'))).toBe(false);
        expect(titlesMatch(null, b)).toBe(false);
    });
});

describe('artists', () => {
    it('artistsOf keeps the unsplit string first and adds the pieces', () => {
        expect(artistsOf({ artist: 'Simon & Garfunkel' })).toEqual(['Simon & Garfunkel', 'Simon', 'Garfunkel']);
        expect(artistsOf({ artist: 'Earth, Wind & Fire' })).toEqual(['Earth, Wind & Fire', 'Earth', 'Wind', 'Fire']);
        expect(artistsOf({ artist: 'Dua Lipa feat. DaBaby' })).toEqual(['Dua Lipa feat. DaBaby', 'Dua Lipa', 'DaBaby']);
        expect(artistsOf({ artist: 'Khruangbin x Leon Bridges' })).toEqual(['Khruangbin x Leon Bridges', 'Khruangbin', 'Leon Bridges']);
    });

    it('artistsOf splits the feature words before the " x " joiner, so "Lil Nas X" keeps its X', () => {
        expect(artistsOf({ artist: 'Lil Nas X feat. Billy Ray Cyrus' })).toEqual(['Lil Nas X feat. Billy Ray Cyrus', 'Lil Nas X', 'Billy Ray Cyrus']);
        expect(artistsOf({ artist: 'Lil Nas X & Billy Ray Cyrus' })).toEqual(['Lil Nas X & Billy Ray Cyrus', 'Lil Nas X', 'Billy Ray Cyrus']);
        expect(artistsOf({ artist: 'Lil Nas X' })).toEqual(['Lil Nas X']);
    });

    it('artistsOf prefers the declared list and still keeps the unsplit artist string', () => {
        expect(artistsOf({ artists: ['Dua Lipa', 'DaBaby'], artist: 'Dua Lipa' })).toEqual(['Dua Lipa', 'DaBaby']);
        expect(artistsOf({ artists: ['Simon', 'Garfunkel'], artist: 'Simon & Garfunkel' })).toEqual(['Simon', 'Garfunkel', 'Simon & Garfunkel']);
        expect(artistsOf({ artists: [], artist: 'Khruangbin' })).toEqual(['Khruangbin']);
        expect(artistsOf({})).toEqual([]);
        expect(artistsOf({ artist: null })).toEqual([]);
    });

    it('primaryArtist is the first entry', () => {
        expect(primaryArtist({ artists: DP })).toBe('Daft Punk');
        expect(primaryArtist({ artist: 'Earth, Wind & Fire' })).toBe('Earth, Wind & Fire');
        expect(primaryArtist({})).toBeNull();
    });

    it('normalizeArtist strips channel decoration but keeps a leading "The"', () => {
        expect(normalizeArtist('DaftPunkVEVO')).toBe('daftpunk');
        expect(normalizeArtist('Daft Punk - Topic')).toBe('daft punk');
        expect(normalizeArtist('Khruangbin')).toBe('khruangbin');
        expect(normalizeArtist('Adele Official')).toBe('adele');
        expect(normalizeArtist('Rhino Records')).toBe('rhino');
        expect(normalizeArtist('The Weeknd')).toBe('the weeknd');
        expect(normalizeArtist('Official')).toBe('official');
    });

    it('sameArtist compares normalised names ignoring spacing', () => {
        expect(sameArtist('DaftPunkVEVO', 'Daft Punk')).toBe(true);
        expect(sameArtist('Daft Punk - Topic', 'Daft Punk')).toBe(true);
        expect(sameArtist('Khruangbin', 'Khruangbin')).toBe(true);
        expect(sameArtist('ROSALÍA', 'Rosalia')).toBe(true);
        expect(sameArtist('Florence + The Machine', 'Florence and the Machine')).toBe(true);
        expect(sameArtist('The Weeknd', 'Weeknd')).toBe(false);
        expect(sameArtist('Funk Punk', 'Daft Punk')).toBe(false);
        expect(sameArtist('7clouds', 'Daft Punk')).toBe(false);
        expect(sameArtist('', '')).toBe(false);
    });

    it('artistMatches finds any pair in a declared list and keeps single acts intact', () => {
        expect(artistMatches(artistsOf({ artist: 'Simon & Garfunkel' }), ['Simon & Garfunkel'])).toBe(true);
        expect(artistMatches(artistsOf({ artist: 'Earth, Wind & Fire' }), ['Earth, Wind & Fire'])).toBe(true);
        expect(artistMatches(artistsOf({ artists: DP }), ['Nile Rodgers'])).toBe(true);
        expect(artistMatches({ artists: DP }, ['Nile Rodgers'])).toBe(true);
        expect(artistMatches(artistsOf({ artists: DP }), ['Funk Punk'])).toBe(false);
    });

    it('artistMatches with only an artist string accepts the unsplit name or the primary act, not a later fragment', () => {
        expect(artistMatches({ artist: 'Earth, Wind & Fire' }, ['Fire'])).toBe(false);
        expect(artistMatches({ artist: 'Earth, Wind & Fire' }, ['Wind'])).toBe(false);
        expect(artistMatches({ artist: 'Earth, Wind & Fire' }, ['Earth, Wind & Fire'])).toBe(true);
        expect(artistMatches({ artist: 'Daft Punk, Pharrell Williams' }, ['Daft Punk', 'Pharrell Williams'])).toBe(true);
        expect(artistMatches('Daft Punk feat. Pharrell Williams', ['Daft Punk'])).toBe(true);
        expect(artistMatches('Daft Punk feat. Pharrell Williams', ['Pharrell Williams'])).toBe(false);
        // A declared list is trusted entry by entry.
        expect(artistMatches({ artist: 'Daft Punk', artists: ['Daft Punk', 'Pharrell Williams'] }, ['Pharrell Williams'])).toBe(true);
    });

    it('artistMatches accepts a memoising comparator', () => {
        const same = jest.fn((a, b) => a === b);
        expect(artistMatches({ artists: ['A', 'B'] }, ['B'], same)).toBe(true);
        expect(same).toHaveBeenCalled();
    });

    it('artistMatches is false for an empty candidate list', () => {
        expect(artistMatches(artistsOf({ artists: DP }), [])).toBe(false);
        expect(artistMatches(artistsOf({ artists: DP }), undefined)).toBe(false);
    });
});
