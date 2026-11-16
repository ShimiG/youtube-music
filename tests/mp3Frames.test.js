// Finding where an MP3 frame begins (services/mp3Frames.js), so that a
// stream which starts in the middle of a file starts with a whole frame.
const { headerAt, firstFrame, nextFrame } = require('../services/mp3Frames');

const frame = (header, length, fill = 0x55) => { const f = Buffer.alloc(length, fill); f.set(header, 0); return f; };

describe('reading a frame header', () => {
    it('knows the bitrate, sample rate and length of a frame', () => {
        // MPEG-1 Layer III: 128 kbit/s at 48 kHz, 192 at 44.1 kHz (with and without padding), 320 at 44.1.
        expect(headerAt(Buffer.from([0xff, 0xfb, 0x94, 0x00]), 0)).toEqual({ version: 3, bitrate: 128, sampleRate: 48000, length: 384 });
        expect(headerAt(Buffer.from([0xff, 0xfb, 0xb0, 0x00]), 0)).toEqual({ version: 3, bitrate: 192, sampleRate: 44100, length: 626 });
        expect(headerAt(Buffer.from([0xff, 0xfb, 0xb2, 0x00]), 0).length).toBe(627);
        expect(headerAt(Buffer.from([0xff, 0xfa, 0xe0, 0x00]), 0)).toMatchObject({ bitrate: 320, sampleRate: 44100, length: 1044 });
        // MPEG-2 Layer III (low sample rates): 64 kbit/s at 24 kHz.
        expect(headerAt(Buffer.from([0xff, 0xf3, 0x84, 0x00]), 0)).toEqual({ version: 2, bitrate: 64, sampleRate: 24000, length: 192 });
    });

    it('rejects what is not a Layer III frame header', () => {
        for (const bytes of [
            [0xff, 0xdb, 0x94, 0x00], // the eleven set bits are not all there
            [0xff, 0xfd, 0x94, 0x00], // Layer II
            [0xff, 0xeb, 0x94, 0x00], // a version that does not exist
            [0xff, 0xfb, 0x04, 0x00], // "free" bitrate
            [0xff, 0xfb, 0xf4, 0x00], // a bitrate that does not exist
            [0xff, 0xfb, 0x9c, 0x00], // a sample rate that does not exist
            [0x00, 0x00, 0x00, 0x00]
        ]) expect(headerAt(Buffer.from(bytes), 0)).toBeNull();
        expect(headerAt(Buffer.from([0xff, 0xfb, 0x94]), 0)).toBeNull(); // cut off
        expect(headerAt(Buffer.from([0xff, 0xfb, 0x94, 0x00]), -1)).toBeNull();
    });
});

describe('the first frame of a file', () => {
    const header = [0xff, 0xfb, 0x94, 0x00];

    it('is found after the ID3 tag a converted file begins with', () => {
        const tag = Buffer.alloc(300, 0xff); // a tag full of bytes that look like the start of a frame
        tag.write('ID3', 0, 'latin1');
        tag.set([4, 0, 0, 0, 0, 0x02, 0x22], 3); // size 290, as four seven-bit bytes
        const file = Buffer.concat([tag, frame(header, 384), frame(header, 384)]);
        expect(firstFrame(file)).toEqual({ at: 300, header: { version: 3, bitrate: 128, sampleRate: 48000, length: 384 } });
    });

    it('is found without a tag, past bytes that only look like one', () => {
        const junk = Buffer.from([0x00, 0xff, 0xfb, 0x94, 0x00, 0x11, 0x22]); // a header with no frame after it
        const file = Buffer.concat([junk, frame(header, 384), frame(header, 384)]);
        expect(firstFrame(file).at).toBe(7);
    });

    it('is not invented when there is none', () => {
        expect(firstFrame(Buffer.alloc(2000, 0x41))).toBeNull();
        expect(firstFrame(Buffer.alloc(0))).toBeNull();
    });
});

describe('the next frame from somewhere in the middle', () => {
    const reference = { version: 3, bitrate: 128, sampleRate: 48000, length: 384 };
    const header = [0xff, 0xfb, 0x94, 0x00];

    it('is where a frame of this stream begins and another follows it', () => {
        const frames = Buffer.concat([frame(header, 384), frame(header, 384), frame(header, 384)]);
        expect(nextFrame(frames.subarray(100), reference)).toBe(284);
        expect(nextFrame(frames, reference)).toBe(0);
    });

    it('is not a look-alike inside the audio, nor a frame of another stream', () => {
        // The same four bytes by chance, mid-frame: once, and twice a frame's length apart.
        const lookAlike = (at) => { const f = frame(header, 384); f.set(header, at); return f; };
        const frames = Buffer.concat([lookAlike(150), lookAlike(150), frame(header, 384), lookAlike(90), frame(header, 384), frame(header, 384)]);
        expect(nextFrame(frames.subarray(100), reference)).toBe(284);
        expect(nextFrame(frames.subarray(3 * 384 + 20), reference)).toBe(364);
        // 192 kbit/s frames are not this 128 kbit/s stream's.
        const other = Buffer.concat([frame([0xff, 0xfb, 0xb0, 0x00], 626), frame([0xff, 0xfb, 0xb0, 0x00], 626)]);
        expect(nextFrame(other, reference)).toBe(-1);
    });

    it('is not found in less than two frames, and two will do at the very end', () => {
        expect(nextFrame(frame(header, 384), reference)).toBe(-1);
        expect(nextFrame(Buffer.concat([frame(header, 384), frame(header, 384)]).subarray(10), reference)).toBe(-1);
        expect(nextFrame(Buffer.concat([frame(header, 384), frame(header, 384), frame(header, 384)]).subarray(10), reference)).toBe(374);
        expect(nextFrame(Buffer.alloc(0), reference)).toBe(-1);
    });
});
