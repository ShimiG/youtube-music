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
    mockStreamTranscoded.mockReset();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    YouTubeController.runner.execFile = original;
    errorSpy.mockRestore();
});

function play(stdout, { error = null, stderr = '' } = {}) {
    let args;
    YouTubeController.runner.execFile = jest.fn((bin, a, opts, cb) => {
        args = a;
        cb(error, stdout, stderr);
        return { exitCode: 0, kill: jest.fn() };
    });
    const res = fakeRes();
    YouTubeController.streamTrack({ query: { videoId: 'dQw4w9WgXcQ' } }, res);
    return { args, res };
}

it('asks yt-dlp for the audio stream explicitly (one URL, not video+audio)', () => {
    const { args } = play('https://rr1.googlevideo.com/audio\n');
    expect(args.slice(0, 2)).toEqual(['-f', 'bestaudio/best']);
    expect(args).toContain('-g');
    expect(args).toContain('--no-playlist');
});

it('passes only the first URL to ffmpeg even if yt-dlp prints two', () => {
    play('https://rr1.googlevideo.com/video\nhttps://rr1.googlevideo.com/audio\n');
    expect(mockStreamTranscoded).toHaveBeenCalledTimes(1);
    expect(mockStreamTranscoded.mock.calls[0][2].sourceUrl).toBe('https://rr1.googlevideo.com/video');
    expect(mockStreamTranscoded.mock.calls[0][2].sourceUrl).not.toContain('\n');
});

it("logs yt-dlp's own error line when resolving fails, and answers TRACK_UNAVAILABLE", () => {
    const stderr = 'WARNING: something minor\nERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot\n';
    const { res } = play('', { error: Object.assign(new Error('Command failed'), { code: 1 }), stderr });
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

it('logs and answers no_audio_url when yt-dlp prints no URL', () => {
    const { res } = play('\n');
    expect(errorSpy.mock.calls[0][0]).toMatch(/returned no audio URL/);
    expect(res.json.mock.calls[0][0]).toMatchObject({ reason: 'no_audio_url' });
});
