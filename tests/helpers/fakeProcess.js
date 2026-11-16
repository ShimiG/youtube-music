// A stand-in for a child process (yt-dlp, ffmpeg) in tests: streams that can
// be written to and read from, and an exit the test decides on.
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

function fakeProcess() {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    /** Ends the process as if by itself. */
    child.exit = (code = 0, signal = null) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.exitCode = signal ? null : code;
        child.signalCode = signal;
        child.stdout.end();
        child.stderr.end();
        // 'close' comes after the streams have been read to their end.
        setTimeout(() => child.emit('close', signal ? null : code, signal), 0);
    };
    child.kill = jest.fn((signal = 'SIGTERM') => {
        child.killed = true;
        child.exit(null, signal);
        return true;
    });
    return child;
}

module.exports = { fakeProcess };
