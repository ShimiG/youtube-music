// Pure text rules for the match engine: how a Spotify title and a YouTube
// Music title are reduced to a comparable core, which bracketed qualifiers
// change the recording (variants) and which are presentation noise, and how
// artist names are compared. No I/O, no state; every helper is exported so
// the golden-table tests can pin each rule down on its own.

// Typographic punctuation is folded to its ASCII form before punctuation is
// dropped, so every later rule sees one spelling of a quote or a dash.
const PUNCT_MAP = {
    '‘': '\'', '’': '\'', '‚': '\'', '‛': '\'', '′': '\'',
    '“': '"', '”': '"', '„': '"', '‟': '"',
    '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-'
};
const PUNCT_RE = /[‘’‚‛′“”„‟‐-―−]/g;

function normalizeText(s) {
    if (s === null || s === undefined) {
        return '';
    }
    // NFKD splits "é" into "e" + combining acute, so stripping marks removes
    // diacritics while leaving Hebrew, Korean and Japanese letters intact.
    let t = String(s).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
    t = t.replace(PUNCT_RE, ch => PUNCT_MAP[ch]);
    t = t.replace(/&/g, ' and ');
    // "Florence + The Machine" is the same name as "Florence and the Machine".
    t = t.replace(/(?<=[\p{L}\p{N}])\s*\+\s*(?=[\p{L}\p{N}])/gu, ' and ');
    t = t.replace(/[^\p{L}\p{N}\s]/gu, '');
    return t.replace(/\s+/g, ' ').trim();
}

// --- Artists ----------------------------------------------------------------

// Joiners that separate several credited artists in one string, applied in
// passes: the feature words first, then the plain separators, and " x " last
// on its own. In a single pass the " x " joiner eats the last letter of
// "Lil Nas X feat. Billy Ray Cyrus" ("Lil Nas" + "feat. Billy Ray Cyrus") and
// of "Lil Nas X & Billy Ray Cyrus". The unsplit string is always kept as
// well: "Simon & Garfunkel" is one act.
const FEAT_SPLIT = /\s+(?:feat\.?|ft\.?|featuring|with)\s+/i;
const PLAIN_SPLIT = /\s*,\s*|\s+&\s+|\s+and\s+/i;
const X_SPLIT = /\s+x\s+/i;

function splitArtistString(s) {
    return String(s)
        .split(FEAT_SPLIT)
        .flatMap(p => p.split(PLAIN_SPLIT))
        .flatMap(p => p.split(X_SPLIT))
        .map(p => p.trim())
        .filter(Boolean);
}

function dedupe(names) {
    const seen = new Set();
    const out = [];
    for (const name of names) {
        if (typeof name !== 'string' || !name.trim()) {
            continue;
        }
        const key = normalizeText(name);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(name.trim());
    }
    return out;
}

function artistsOf(track) {
    if (!track) {
        return [];
    }
    const declared = Array.isArray(track.artists) ? track.artists : [];
    if (declared.length) {
        // Keep the provider's unsplit string too, in case it split a single
        // act like "Earth, Wind & Fire" into several names.
        return dedupe([...declared, track.artist]);
    }
    if (typeof track.artist !== 'string' || !track.artist.trim()) {
        return [];
    }
    return dedupe([track.artist, ...splitArtistString(track.artist)]);
}

function primaryArtist(track) {
    const list = artistsOf(track);
    return list.length ? list[0] : null;
}

// Channel-name decoration that is not part of the artist's name. VEVO glues
// its suffix on without a space ("DaftPunkVEVO"), so it is stripped either
// way; the other words are only stripped as a separate trailing token.
const CHANNEL_SUFFIX = /\s+(official|music|tv|records|topic)$/;

function normalizeArtist(name) {
    let t = normalizeText(name);
    for (;;) {
        const next = t.replace(/\s*vevo$/, '').replace(CHANNEL_SUFFIX, '').trim();
        if (!next || next === t) {
            break;
        }
        t = next;
    }
    return t;
}

// Spaces are ignored in the comparison because channel names run words
// together ("DaftPunkVEVO" -> "daftpunk" must equal "Daft Punk").
function artistKey(name) {
    return normalizeArtist(name).replace(/\s+/g, '');
}

function sameArtist(a, b) {
    const x = artistKey(a);
    return x.length > 0 && x === artistKey(b);
}

// The names that, on their own, prove a candidate is by this track's artist.
// A provider's declared list is trusted entry by entry. A bare `artist`
// string is only split for its primary act: "Earth, Wind & Fire" must not be
// claimed by a candidate credited to "Fire", while "Daft Punk, Pharrell
// Williams" is still found under "Daft Punk".
function sufficientArtists(track) {
    const declared = Array.isArray(track.artists) && track.artists.length > 0;
    const list = artistsOf(track);
    return declared ? list : list.slice(0, 2);
}

// `trackArtists` is the track itself ({ artist, artists }), its bare artist
// string, or a caller-prepared list of names (every entry is then trusted).
// `same` lets a caller memoise the normalisation across many candidates.
function artistMatches(trackArtists, candidateArtists, same = sameArtist) {
    if (!Array.isArray(candidateArtists) || candidateArtists.length === 0) {
        return false;
    }
    let mine;
    if (Array.isArray(trackArtists)) {
        mine = trackArtists;
    } else if (typeof trackArtists === 'string') {
        mine = sufficientArtists({ artist: trackArtists });
    } else {
        mine = sufficientArtists(trackArtists || {});
    }
    return mine.some(t => candidateArtists.some(c => same(t, c)));
}

// --- Titles -----------------------------------------------------------------

// " - ", " – ", " — ", " | " and " / " all introduce a trailing qualifier
// ("Song - Live", "Song | Official Video"), and separate the qualifiers inside
// one segment: Spotify writes "Song - Remastered 2009 / Naked Version" and
// "Song - Live / 2011 Remaster", so every piece must be classified on its own.
const SUFFIX_SEP = /\s+[-–—|/]\s+/;
const OPENERS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);
const FEAT_START = /^(?:feat\.?|ft\.?|featuring|with)\s+(.+)$/i;
const TRAILING_FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$/i;
const FEAT_JOINERS = /\s*,\s*|\s+&\s+|\s+and\s+|\s+x\s+|\s*\+\s*/i;

// Segments that describe the upload, not the recording (compared after
// normalizeText, so "Official Video" and "official video" are one entry).
const NOISE = new Set([
    'official audio', 'official video', 'official music video', 'official lyric video', 'official lyrics video',
    'official visualizer', 'official visualiser', 'official hd video', 'official video hd', 'official',
    'music video', 'lyric video', 'lyrics video', 'lyrics', 'with lyrics', 'audio', 'video', 'visualizer', 'visualiser',
    'hd', 'hq', '4k', 'full hd', 'hd video', 'high quality',
    'explicit', 'explicit version', 'clean', 'clean version',
    'album version', 'original mix', 'original version', 'bonus track', 'deluxe', 'deluxe edition'
]);

// Specific variant tokens, in evaluation order. Every rule that matches a
// segment emits its token, so "Live Acoustic" yields both.
const VARIANT_RULES = [
    [/\blive\b/, 'live'],
    [/acoustic/, 'acoustic'],
    [/instrumental/, 'instrumental'],
    [/karaoke/, 'karaoke'],
    [/\bcover\b/, 'cover'],
    [/sped.?up/, 'sped up'],
    [/slowed/, 'slowed'],
    [/reverb/, 'reverb'],
    [/nightcore/, 'nightcore'],
    [/\b8d\b/, '8d'],
    [/extended/, 'extended'],
    [/radio (edit|version|mix)/, 'radio edit'],
    [/single (edit|version)/, 'single edit'],
    [/\bdemo\b/, 'demo'],
    [/unplugged/, 'unplugged'],
    [/orchestral/, 'orchestral'],
    [/\bmono\b/, 'mono'],
    [/\bstereo\b/, 'stereo']
];

// Words that only ever describe the upload. A segment made of nothing but
// these ("Official HD Music Video", "4K Upgrade") is noise even when that
// exact phrasing is not in the set above. "remaster" is deliberately absent:
// a remaster segment carries a year and is handled on its own.
const NOISE_WORDS = new Set([
    'official', 'hd', 'hq', '4k', 'full', 'high', 'quality', 'video', 'audio', 'music',
    'lyric', 'lyrics', 'visualizer', 'visualiser', 'explicit', 'clean', 'version', 'mv',
    'new', 'premiere', 'upgrade'
]);

// A segment with none of the specific tokens is still a different recording
// when it names a mix; its full text is kept so two remixes never collide.
const GENERIC_VARIANT = /\b(remix|mix|edit|version|dub|bootleg|flip|rework|vip)\b/;

function isNoise(norm) {
    if (NOISE.has(norm) || /^\d{4}$/.test(norm)) {
        return true;
    }
    return norm.split(' ').every(word => NOISE_WORDS.has(word));
}

function isArtistPrefix(prefix, artists) {
    const p = prefix.trim();
    if (!p || !artists.length) {
        return false;
    }
    if (artists.some(a => sameArtist(p, a))) {
        return true;
    }
    // "Khruangbin & Leon Bridges - Texas Sun": every credited name is known.
    const pieces = splitArtistString(p);
    return pieces.length > 1 && pieces.every(piece => artists.some(a => sameArtist(piece, a)));
}

// yt-dlp titles look like "Daft Punk - Get Lucky (Official Audio)"; the
// artist prefix is only removed when it is one of the track's artists so a
// song called "Something - Else" is left alone.
function stripArtistPrefix(title, artists) {
    if (!artists.length) {
        return title;
    }
    // A prefix can be at most every known artist joined together; stopping
    // there keeps the scan linear for a hostile title full of separators.
    const maxPrefix = artists.reduce((n, a) => n + a.length + 3, 8);
    const sep = /\s+[-–—]\s+|:\s+/g;
    let m;
    while ((m = sep.exec(title)) !== null && m.index <= maxPrefix) {
        if (isArtistPrefix(title.slice(0, m.index), artists)) {
            return title.slice(m.index + m[0].length);
        }
    }
    return title;
}

function splitFeatNames(s) {
    return s.split(FEAT_JOINERS).map(p => p.trim()).filter(Boolean);
}

// Splits a title into the text outside brackets (`rest`) and the content of
// every bracketed group (`segments`, innermost first, as a nested group's
// inner text is removed before the outer one is read). A closer that does not
// match the innermost opener is ordinary text, and an unclosed opener is put
// back as text, so a lone "(" never swallows the rest of the title.
function extractBrackets(title) {
    const segments = [];
    const stack = [];
    let base = '';
    const append = (text) => {
        if (stack.length) {
            stack[stack.length - 1].text += text;
        } else {
            base += text;
        }
    };
    for (const ch of title) {
        if (OPENERS[ch]) {
            stack.push({ opener: ch, closer: OPENERS[ch], text: '' });
        } else if (CLOSERS.has(ch) && stack.length && stack[stack.length - 1].closer === ch) {
            segments.push(stack.pop().text);
            // The group is replaced by a space, like the regex version did.
            append(' ');
        } else {
            append(ch);
        }
    }
    while (stack.length) {
        const open = stack.pop();
        append(open.opener + open.text);
    }
    return { rest: base, segments };
}

function parseTitle(rawTitle, artists = []) {
    const known = Array.isArray(artists) ? artists.filter(a => typeof a === 'string' && a.trim()) : [];
    // Normalised once here rather than once per segment: a title can hold
    // thousands of segments and the artist list is the same for all of them.
    const knownKeys = new Set(known.map(artistKey));
    knownKeys.delete('');
    const isKnownArtist = (text) => knownKeys.size > 0 && knownKeys.has(artistKey(text));
    const variants = new Set();
    const feats = [];
    const unknown = [];

    // Whitespace is collapsed up front: every later rule starts with `\s+`,
    // and a long run of spaces makes those regexes backtrack quadratically.
    const text = String(rawTitle === null || rawTitle === undefined ? '' : rawTitle).replace(/\s+/g, ' ');
    const title = stripArtistPrefix(text, known);

    // Pull every bracketed group out (innermost first), leaving the base text.
    // One pass with a stack of open brackets: titles are untrusted input, and
    // re-scanning the string after each extraction was quadratic in its length.
    const { rest, segments } = extractBrackets(title);
    const parts = rest.replace(/\s+/g, ' ').split(SUFFIX_SEP);
    let base = parts[0];
    segments.push(...parts.slice(1));

    // "Get Lucky ft. Pharrell Williams, Nile Rodgers" credits the features
    // inside the base; they are artists, not title words.
    const trailing = TRAILING_FEAT.exec(base);
    if (trailing) {
        feats.push(...splitFeatNames(trailing[1]));
        base = base.slice(0, trailing.index);
    }

    // A plain qualifier is noise, a remaster, a mix, or an unknown word that
    // belongs to the title ("Da Ba Dee").
    const classifyPlain = (piece) => {
        const norm = normalizeText(piece);
        if (!norm || isNoise(norm)) {
            return;
        }
        // A remaster is the same recording; the duration check guards it.
        if (/remaster/.test(norm)) {
            return;
        }
        if (GENERIC_VARIANT.test(norm)) {
            const token = norm.replace(/\b\d{4}\b/g, '').replace(/\s+/g, ' ').trim();
            if (token) {
                variants.add(token);
            }
            return;
        }
        unknown.push(norm);
    };

    const classifySegment = (piece) => {
        const raw = piece.trim();
        if (!raw) {
            return;
        }
        const norm = normalizeText(raw);
        if (!norm || isNoise(norm)) {
            return;
        }
        const feat = FEAT_START.exec(raw);
        if (feat) {
            feats.push(...splitFeatNames(feat[1]));
            return;
        }
        // Soundtrack and producer credits are checked before the variant
        // tokens because a film title may contain "live" or "mix".
        if (/^from\b/.test(norm) || /^prod\b/.test(norm)) {
            return;
        }
        const tokens = VARIANT_RULES.filter(([re]) => re.test(norm)).map(([, token]) => token);
        if (tokens.length) {
            // The whole segment is consumed: venue, year and the generic
            // "version"/"edit" word next to a specific token are dropped.
            tokens.forEach(t => variants.add(t));
            return;
        }
        // A trailing "- Daft Punk" is attribution, not part of the title. It
        // is checked after the variant rules so that a band called "Live" (or
        // "Demo", "Mono", "Cover") cannot erase the "(Live)" of its own songs.
        if (!GENERIC_VARIANT.test(norm) && isKnownArtist(raw)) {
            return;
        }
        // "Remastered 2011, Deluxe": several plain qualifiers in one segment.
        raw.split(/\s*,\s*/).forEach(classifyPlain);
    };

    for (const segment of segments) {
        segment.split(SUFFIX_SEP).forEach(classifySegment);
    }

    const core = normalizeText([base, ...unknown].join(' '));
    return { core, variants, feats };
}

function setsEqual(a, b) {
    if (a.size !== b.size) {
        return false;
    }
    for (const v of a) {
        if (!b.has(v)) {
            return false;
        }
    }
    return true;
}

// Feats are deliberately not compared: Spotify and YouTube Music place and
// spell them differently, and the artist check already covers them.
function titlesMatch(a, b) {
    if (!a || !b) {
        return false;
    }
    return a.core === b.core && setsEqual(a.variants, b.variants);
}

module.exports = { normalizeText, parseTitle, titlesMatch, normalizeArtist, artistKey, sameArtist, artistMatches, artistsOf, primaryArtist };
