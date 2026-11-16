// Where an MP3 frame starts.
//
// The audio the server converts is constant-bitrate MP3, so "from 2 minutes
// in" is a byte position that can simply be calculated. That position falls
// in the middle of a frame; a stream that begins there starts with part of a
// frame, which a player has to recognise as noise and skip. This finds the
// next place a frame begins, so the stream starts cleanly.
//
// A frame begins with four bytes: eleven set bits, then the MPEG version, the
// layer, the bitrate, the sample rate and a few flags. Audio data can contain
// the same bit pattern by chance, so a candidate only counts when it matches
// the stream's own first frame and the two frames after it begin where each
// one before says it ends.
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const LAYER_3 = 1;

/** The Layer III frame header at `at`, or null: { version, bitrate (kbit/s), sampleRate, length (bytes) }. */
function headerAt(buffer, at) {
    if (at < 0 || at + 4 > buffer.length) return null;
    if (buffer[at] !== 0xff || (buffer[at + 1] & 0xe0) !== 0xe0) return null;
    const version = (buffer[at + 1] >> 3) & 3; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
    if (version === 1 || ((buffer[at + 1] >> 1) & 3) !== LAYER_3) return null;
    const bitrateIndex = buffer[at + 2] >> 4;
    const sampleRate = SAMPLE_RATES[version][(buffer[at + 2] >> 2) & 3];
    if (bitrateIndex === 0 || bitrateIndex === 15 || !sampleRate) return null;
    const bitrate = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex];
    const padding = (buffer[at + 2] >> 1) & 1;
    return { version, bitrate, sampleRate, length: Math.floor(((version === 3 ? 144000 : 72000) * bitrate) / sampleRate) + padding };
}

const sameStream = (a, b) => a.version === b.version && a.bitrate === b.bitrate && a.sampleRate === b.sampleRate;

/**
 * The first frame of a file, given its beginning: { at, header }, or null.
 * Skips an ID3v2 tag, which is what such a file starts with.
 */
function firstFrame(head) {
    let from = 0;
    if (head.length >= 10 && head.toString('latin1', 0, 3) === 'ID3') {
        from = 10 + ((head[6] & 0x7f) << 21 | (head[7] & 0x7f) << 14 | (head[8] & 0x7f) << 7 | (head[9] & 0x7f));
    }
    for (let at = from; at + 4 <= head.length; at++) {
        const header = headerAt(head, at);
        if (!header) continue;
        const next = headerAt(head, at + header.length);
        // Confirmed by the frame that follows, when that much is there.
        if (next ? sameStream(header, next) : at + header.length + 4 > head.length) return { at, header };
    }
    return null;
}

/**
 * The index in `window` where the next frame of the stream described by
 * `reference` begins, or -1 when none is found in it.
 */
function nextFrame(window, reference) {
    for (let at = 0; at + 4 <= window.length; at++) {
        const header = headerAt(window, at);
        if (!header || !sameStream(header, reference)) continue;
        const second = headerAt(window, at + header.length);
        if (!second || !sameStream(second, reference)) continue;
        // And the one after that, when the window reaches that far: three in
        // a row do not happen by chance.
        const thirdAt = at + header.length + second.length;
        const third = headerAt(window, thirdAt);
        if (third ? sameStream(third, reference) : thirdAt + 4 > window.length) return at;
    }
    return -1;
}

module.exports = { headerAt, firstFrame, nextFrame };
