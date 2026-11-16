// When a conversion ends with no audio, the reason has to reach the app
// whatever ffmpeg's wording, and also when ffmpeg says nothing at all (a
// process ended by a signal). And ffmpeg fetches a source with the request
// headers the source's look-up named. controllers/transcode.js.
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const transcode = require('../controllers/transcode');

function fakeChild() {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    return child;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ffmpeg's last words", () => {
    let errorSpy;
    beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => errorSpy.mockRestore());

    it("puts the source's answer first, drops the noise and the signed address", async () => {
        const child = fakeChild();
        const said = transcode._watchFfmpeg(child);
        child.stderr.write([
            'ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers',
            '  built with Apple clang',
            '[https @ 0x600003c0c000] HTTP error 403 Forbidden',
            "[hls @ 0x14f004a00] Failed to open segment 0 of playlist 0",
            '[in#0 @ 0x600002b0c000] Error opening input: Invalid data found when processing input',
            'Error opening input file https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1790000000&sig=SECRETSIGNATURE&ip=203.0.113.9.',
            'Error opening input files: Invalid data found when processing input',
            ''
        ].join('\n'));
        await flush();
        const words = said.lastWords(183, null);
        expect(words).toBe('ffmpeg: HTTP error 403 Forbidden / Error opening input file https://rr3---sn-abc.googlevideo.com/... / Error opening input files: Invalid data found when processing input (exit code 183)');
        expect(words).not.toMatch(/SECRETSIGNATURE|203\.0\.113/);
        // The log line is scrubbed the same way.
        expect(errorSpy.mock.calls[0][0]).toMatch(/^FFmpeg: /);
        expect(errorSpy.mock.calls[0][0]).not.toMatch(/SECRETSIGNATURE/);
    });

    it('says how the process ended when it wrote nothing of use', async () => {
        const child = fakeChild();
        const said = transcode._watchFfmpeg(child);
        child.stderr.write('ffmpeg version 6.1.1\n  configuration: --enable-gpl\nsize=       0kB time=N/A bitrate=N/A speed=N/A\n');
        await flush();
        expect(said.lastWords(null, 'SIGSEGV')).toBe('ffmpeg: it said nothing (ended by SIGSEGV)');
        expect(said.lastWords(0, null)).toBe('ffmpeg: it said nothing (exit code 0)');
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('reports wording that has no "Error" in it at all', async () => {
        const child = fakeChild();
        const said = transcode._watchFfmpeg(child);
        child.stderr.write('[out#0/mp3 @ 0x1] Output file is empty, nothing was encoded (check -ss / -t / -frames parameters if used)\n');
        await flush();
        expect(said.lastWords(0, null)).toBe('ffmpeg: Output file is empty, nothing was encoded (check -ss / -t / -frames parameters if used) (exit code 0)');
    });

    it('logs the first complaints of a conversion and counts the rest', async () => {
        const child = fakeChild();
        transcode._watchFfmpeg(child);
        for (let i = 0; i < 400; i++) {
            child.stderr.write(`[aac @ 0x1] Number of bands (${i}) exceeds limit (12).\nError while decoding stream #0:0: Invalid data found when processing input\n`);
            await flush();
        }
        expect(errorSpy).toHaveBeenCalledTimes(5);
        expect(errorSpy.mock.calls.every((c) => c[0].length <= 820)).toBe(true);
        child.emit('close', 0, null);
        expect(errorSpy).toHaveBeenCalledTimes(6);
        expect(errorSpy.mock.calls[5][0]).toBe('FFmpeg: 395 more complaints from this conversion were not logged.');
    });
});

describe('the request headers ffmpeg is given', () => {
    const req = { query: {} };

    it('sends them for a network source, before the input, one per line', () => {
        const args = transcode._ffmpegArgsFor(req, 'https://media.example/a', 0, { headers: { 'User-Agent': 'Mozilla/5.0 Safari', Accept: '*/*' } });
        const at = args.indexOf('-headers');
        expect(at).toBeGreaterThan(-1);
        expect(at).toBeLessThan(args.indexOf('-i'));
        expect(args[at + 1]).toBe('User-Agent: Mozilla/5.0 Safari\r\nAccept: */*\r\n');
    });

    it('sends none for a local file, or when there are none', () => {
        expect(transcode._ffmpegArgsFor(req, '/music/a.flac', 0, { headers: { 'User-Agent': 'x' } })).not.toContain('-headers');
        expect(transcode._ffmpegArgsFor(req, 'https://media.example/a', 0, {})).not.toContain('-headers');
        expect(transcode._ffmpegArgsFor(req, 'https://media.example/a', 0, { headers: {} })).not.toContain('-headers');
    });

    it('lets through only plain names and single-line values, and nothing that belongs to the connection', () => {
        const lines = transcode._headerLines({
            'User-Agent': 'Mozilla/5.0',
            'X-Evil\r\nInjected': 'x',
            'Accept-Language': 'en\r\nEvil: 1',
            Cookie: 'session=secret',
            Host: 'elsewhere.example',
            Range: 'bytes=0-1',
            'Accept-Encoding': 'br',
            'Sec-Fetch-Mode': 'navigate',
            Empty: '',
            Number: 5,
            Long: 'x'.repeat(501)
        });
        expect(lines).toBe('User-Agent: Mozilla/5.0\r\nSec-Fetch-Mode: navigate\r\n');
        expect(transcode._headerLines(null)).toBe('');
        expect(transcode._headerLines('User-Agent: x')).toBe('');
        const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`X-H${i}`, 'v']));
        expect(transcode._headerLines(many).split('\r\n').filter(Boolean)).toHaveLength(12);
    });
});
