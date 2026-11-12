// YouTube playback: how the server asks yt-dlp for the audio stream, and what
// it logs when that fails (the terminal used to show nothing at all).
const { EventEmitter } = require('events');
const YouTubeController = require('../controllers/YouTubeController');

const mockStreamTranscoded = jest.fn();
jest.mock('../controllers/transcode', () => ({
    ...jest.requireActual('../controllers/transcode'),
    serveFromCache: () => false,
    streamTranscoded: (...args) => mockStreamTranscoded(...args)
}));

function fakeRes() {
    const res = new EventEmitter();
    res.writableFinished = false;
    res.headersSent = false;
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
}

let original;
let errorSpy;
beforeEach(() => {
    original = YouTubeController.runner.execFile;
    YouTubeController._resetResolver();
    mockStreamTranscoded.mockReset();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    YouTubeController.runner.execFile = original;
    errorSpy.mockRestore();
});

// Lets the promise chain behind a resolve run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function play(stdout, { error = null, stderr = '', videoId = 'dQw4w9WgXcQ' } = {}) {
    let args;
    YouTubeController.runner.execFile = jest.fn((bin, a, opts, cb) => {
        args = a;
        cb(error, stdout, stderr);
        return { exitCode: 0, kill: jest.fn() };
    });
    const res = fakeRes();
    YouTubeController.streamTrack({ query: { videoId } }, res);
    await settle();
    return { args, res };
}

it('asks yt-dlp once for both the audio address and the length (one URL, not video+audio)', async () => {
    const { args } = await play('212\nhttps://rr1.googlevideo.com/audio\n');
    expect(args.slice(0, 2)).toEqual(['-f', 'bestaudio/best']);
    expect(args).toContain('--no-playlist');
    // One run prints the length and the address; -g alone printed only the address.
    expect(args.join(' ')).toContain('--print duration --print urls');
    expect(args).not.toContain('-g');
    expect(args[args.length - 1]).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

it('passes only the first URL to ffmpeg even if yt-dlp prints two', async () => {
    await play('212\nhttps://rr1.googlevideo.com/video\nhttps://rr1.googlevideo.com/audio\n');
    expect(mockStreamTranscoded).toHaveBeenCalledTimes(1);
    expect(mockStreamTranscoded.mock.calls[0][2].sourceUrl).toBe('https://rr1.googlevideo.com/video');
    expect(mockStreamTranscoded.mock.calls[0][2].sourceUrl).not.toContain('\n');
});

it("logs yt-dlp's own error line when resolving fails, and answers TRACK_UNAVAILABLE", async () => {
    const stderr = 'WARNING: something minor\nERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot\n';
    const { res } = await play('', { error: Object.assign(new Error('Command failed'), { code: 1 }), stderr });
    expect(errorSpy.mock.calls[0][0]).toContain("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot");
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: 'TRACK_UNAVAILABLE', source: 'youtube' });
    expect(mockStreamTranscoded).not.toHaveBeenCalled();
});

it('says how to fix a missing yt-dlp', () => {
    const msg = YouTubeController.describeYtDlpFailure(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '');
    expect(msg).toMatch(/yt-dlp not found .*brew install yt-dlp.*YTDLP_PATH/);
});

it('reports a timeout and strips control characters from yt-dlp output', () => {
    expect(YouTubeController.describeYtDlpFailure({ killed: true }, '')).toMatch(/timed out/);
    expect(YouTubeController.describeYtDlpFailure({}, 'ERROR: bad\u001b[0m stuff')).not.toContain(String.fromCharCode(27));
});

it('logs and answers no_audio_url when yt-dlp prints no URL', async () => {
    const { res } = await play('212\n');
    expect(errorSpy.mock.calls[0][0]).toMatch(/returned no audio URL/);
    expect(res.json.mock.calls[0][0]).toMatchObject({ reason: 'no_audio_url' });
});

// docs/performance-plan.md, step 1.1: one yt-dlp run per track, shared and remembered.
describe('one yt-dlp run per track', () => {
    const inAnHour = Math.floor(Date.now() / 1000) + 3600;
    const ADDRESS = `https://rr1.googlevideo.com/videoplayback?expire=${inAnHour}&sig=abc`;

    // A yt-dlp that answers when the test says so.
    function pendingYtDlp() {
        const runs = [];
        YouTubeController.runner.execFile = jest.fn((bin, args, opts, cb) => {
            const child = { exitCode: null, kill: jest.fn(() => { child.exitCode = 137; }) };
            runs.push({ args, child, finish: (stdout, error = null) => { child.exitCode = error ? 1 : 0; cb(error, stdout, ''); } });
            return child;
        });
        return runs;
    }

    it('a play asks for the stream and the length at the same moment: yt-dlp starts once', async () => {
        const runs = pendingYtDlp();
        const streamRes = fakeRes();
        const durationRes = fakeRes();
        YouTubeController.streamTrack({ query: { videoId: 'aaaaaaaaaaa' } }, streamRes);
        YouTubeController.getDuration({ query: { videoId: 'aaaaaaaaaaa' } }, durationRes);
        expect(runs).toHaveLength(1);

        runs[0].finish(`245\n${ADDRESS}\n`);
        await settle();
        expect(durationRes.json).toHaveBeenCalledWith({ duration: 245 });
        expect(mockStreamTranscoded).toHaveBeenCalledTimes(1);
        const options = mockStreamTranscoded.mock.calls[0][2];
        expect(options.sourceUrl).toBe(ADDRESS);
        expect(options.timing).toMatchObject({ label: 'youtube aaaaaaaaaaa', resolvedBy: 'yt-dlp' });
    });

    it('remembers the address: a seek, a replay and the length cost no further run', async () => {
        const runs = pendingYtDlp();
        YouTubeController.streamTrack({ query: { videoId: 'bbbbbbbbbbb' } }, fakeRes());
        runs[0].finish(`300\n${ADDRESS}\n`);
        await settle();

        YouTubeController.streamTrack({ query: { videoId: 'bbbbbbbbbbb', seek: '120' } }, fakeRes());
        const durationRes = fakeRes();
        YouTubeController.getDuration({ query: { videoId: 'bbbbbbbbbbb' } }, durationRes);
        await settle();
        expect(runs).toHaveLength(1);
        expect(mockStreamTranscoded).toHaveBeenCalledTimes(2);
        expect(mockStreamTranscoded.mock.calls[1][2]).toMatchObject({ sourceUrl: ADDRESS, seekTime: 120, timing: { resolvedBy: 'memory', resolveMs: 0 } });
        expect(durationRes.json).toHaveBeenCalledWith({ duration: 300 });
    });

    it('does not reuse an address past the time YouTube says it stops working', async () => {
        const now = Date.now();
        const in20min = Math.floor(now / 1000) + 20 * 60;
        // 10 minutes are kept in hand so a track can finish playing.
        expect(YouTubeController.urlExpiry(`https://x.googlevideo.com/videoplayback?expire=${in20min}&x=1`, now)).toBe(in20min * 1000 - 10 * 60 * 1000);
        expect(YouTubeController.urlExpiry(`https://x.googlevideo.com/api/manifest/hls/expire/${in20min}/id/1`, now)).toBe(in20min * 1000 - 10 * 60 * 1000);
        // No stated time: half an hour. A far-away one: capped at five hours.
        expect(YouTubeController.urlExpiry('https://cdn.example/audio.m4a', now)).toBe(now + 30 * 60 * 1000);
        expect(YouTubeController.urlExpiry(`https://x/videoplayback?expire=${Math.floor(now / 1000) + 86400}`, now)).toBe(now + 5 * 60 * 60 * 1000);

        const runs = pendingYtDlp();
        const almostExpired = `https://rr1.googlevideo.com/videoplayback?expire=${Math.floor(Date.now() / 1000) + 60}`;
        YouTubeController.streamTrack({ query: { videoId: 'ccccccccccc' } }, fakeRes());
        runs[0].finish(`100\n${almostExpired}\n`);
        await settle();
        YouTubeController.streamTrack({ query: { videoId: 'ccccccccccc' } }, fakeRes());
        expect(runs).toHaveLength(2); // not remembered: asked again
    });

    it('forgets an address that ffmpeg could not open', async () => {
        const runs = pendingYtDlp();
        YouTubeController.streamTrack({ query: { videoId: 'ddddddddddd' } }, fakeRes());
        runs[0].finish(`100\n${ADDRESS}\n`);
        await settle();
        mockStreamTranscoded.mock.calls[0][2].onSourceFailed();
        YouTubeController.streamTrack({ query: { videoId: 'ddddddddddd' } }, fakeRes());
        expect(runs).toHaveLength(2);
    });

    it('keeps yt-dlp running while anyone still waits, and kills it when the last one leaves', async () => {
        const runs = pendingYtDlp();
        const first = fakeRes();
        const second = fakeRes();
        YouTubeController.streamTrack({ query: { videoId: 'eeeeeeeeeee' } }, first);
        YouTubeController.getDuration({ query: { videoId: 'eeeeeeeeeee' } }, second);

        first.emit('close'); // the stream request is dropped; the length is still wanted
        expect(runs[0].child.kill).not.toHaveBeenCalled();
        second.emit('close');
        expect(runs[0].child.kill).toHaveBeenCalledWith('SIGKILL');

        // A request that arrives now starts its own run instead of joining the dying one.
        YouTubeController.streamTrack({ query: { videoId: 'eeeeeeeeeee' } }, fakeRes());
        expect(runs).toHaveLength(2);

        // The killed run's late answer reaches nobody and starts no ffmpeg.
        runs[0].finish('', Object.assign(new Error('killed'), { killed: true }));
        await settle();
        expect(first.json).not.toHaveBeenCalled();
        expect(mockStreamTranscoded).not.toHaveBeenCalled();
    });

    it('a failed run fails every waiter once, and is not remembered', async () => {
        const runs = pendingYtDlp();
        const streamRes = fakeRes();
        const durationRes = fakeRes();
        YouTubeController.streamTrack({ query: { videoId: 'fffffffffff' } }, streamRes);
        YouTubeController.getDuration({ query: { videoId: 'fffffffffff' } }, durationRes);
        runs[0].finish('', Object.assign(new Error('Command failed'), { code: 1 }));
        await settle();
        expect(streamRes.json.mock.calls[0][0]).toMatchObject({ code: 'TRACK_UNAVAILABLE', reason: 'resolve_failed' });
        expect(durationRes.status).toHaveBeenCalledWith(502);
        YouTubeController.getDuration({ query: { videoId: 'fffffffffff' } }, fakeRes());
        expect(runs).toHaveLength(2);
    });
});
