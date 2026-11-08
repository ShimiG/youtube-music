// media-endpoints-unauthenticated-transcode-dos: abandoned transcodes that are
// writing the cache may finish in the background, but only a bounded number.
const { PassThrough } = require('stream');

const mockChildren = [];
const children = mockChildren;
jest.mock('child_process', () => ({
    ...jest.requireActual('child_process'),
    spawn: jest.fn(() => {
        const { EventEmitter } = require('events');
        const { PassThrough } = require('stream');
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = jest.fn(() => { child.killed = true; });
        mockChildren.push(child);
        return child;
    })
}));

const transcode = require('../controllers/transcode');

function fakeRes() {
    const res = new PassThrough();
    res.writableFinished = false;
    res.headersSent = false;
    res.setHeader = jest.fn();
    res.status = jest.fn(() => res);
    res.json = jest.fn();
    return res;
}

afterEach(() => {
    // Let every fake ffmpeg "exit" so the background counter resets.
    children.splice(0).forEach((c) => c.emit('close', 1));
});

it('lets at most MAX_BACKGROUND_TRANSCODES cache-writing transcodes outlive their client', () => {
    const max = transcode.MAX_BACKGROUND_TRANSCODES;
    const responses = [];
    for (let i = 0; i < max + 3; i++) {
        const res = fakeRes();
        transcode.streamTranscoded({}, res, { sourceUrl: 'https://media.example/a', cacheKey: `youtube_k${i}aaaaaaa`, seekTime: 0 });
        responses.push(res);
    }
    responses.forEach((res) => res.emit('close')); // every client disconnects

    const killed = children.filter((c) => c.kill.mock.calls.length > 0).length;
    expect(transcode._backgroundTranscodes()).toBe(max);
    expect(killed).toBe(3);
});

it('kills a non-caching (seek) transcode as soon as its client leaves', () => {
    const res = fakeRes();
    transcode.streamTranscoded({}, res, { sourceUrl: 'https://media.example/a', cacheKey: 'youtube_seekaaaaaaa', seekTime: 30 });
    res.emit('close');
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(transcode._backgroundTranscodes()).toBe(0);
});

it('frees the background slot when ffmpeg exits', () => {
    const res = fakeRes();
    transcode.streamTranscoded({}, res, { sourceUrl: 'https://media.example/a', cacheKey: 'youtube_freeaaaaaaa', seekTime: 0 });
    res.emit('close');
    expect(transcode._backgroundTranscodes()).toBe(1);
    children[0].emit('close', 1);
    expect(transcode._backgroundTranscodes()).toBe(0);
});
