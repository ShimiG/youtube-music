// The JavaScript runtime yt-dlp is pointed at (services/ytdlp.js). The
// installed app is not a Node that can run a script, so there a deno or node
// on the computer is looked for; a desktop app on macOS is started with a
// short PATH that leaves out where those usually are.
const fs = require('fs');
const os = require('os');
const path = require('path');

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
let tmp;
let savedPath;
let savedRuntime;

function loadPackaged() {
    jest.resetModules();
    jest.doMock('../services/paths', () => ({ ...jest.requireActual('../services/paths'), isPackaged: () => true }));
    return require('../services/ytdlp');
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-runtime-'));
    savedPath = process.env.PATH;
    savedRuntime = process.env.YTDLP_JS_RUNTIME;
    delete process.env.YTDLP_JS_RUNTIME;
});
afterEach(() => {
    process.env.PATH = savedPath;
    if (savedRuntime === undefined) delete process.env.YTDLP_JS_RUNTIME; else process.env.YTDLP_JS_RUNTIME = savedRuntime;
    jest.dontMock('../services/paths');
    fs.rmSync(tmp, { recursive: true, force: true });
});

it('in the installed app, uses a deno found on the computer, before a node', () => {
    fs.writeFileSync(path.join(tmp, exe('node')), '');
    fs.writeFileSync(path.join(tmp, exe('deno')), '');
    process.env.PATH = tmp;
    const ytdlp = loadPackaged();
    expect(ytdlp.jsRuntime()).toEqual({ name: 'deno', path: path.join(tmp, exe('deno')), from: 'this computer' });
    expect(ytdlp.jsRuntimeArgs()).toEqual(['--js-runtimes', `deno:${path.join(tmp, exe('deno'))}`]);
});

it('in the installed app, falls back to a node on the computer', () => {
    fs.writeFileSync(path.join(tmp, exe('node')), '');
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    fs.mkdirSync(path.join(tmp, 'elsewhere', exe('deno'))); // a folder of that name is not a program
    process.env.PATH = [path.join(tmp, 'elsewhere'), tmp].join(path.delimiter);
    const found = loadPackaged().jsRuntime();
    // A deno in one of the usual places on this machine would be right too.
    if (found.name === 'node') expect(found.path).toBe(path.join(tmp, exe('node')));
    else expect(found.name).toBe('deno');
});

it('never offers the installed app itself as the runtime', () => {
    process.env.PATH = tmp; // nothing there
    const ytdlp = loadPackaged();
    const found = ytdlp.jsRuntime();
    if (found) expect(found.path).not.toBe(process.execPath);
    else expect(ytdlp.jsRuntimeArgs()).toEqual([]);
});

it('looks once, and does as it is told when a runtime is named or switched off', () => {
    process.env.PATH = tmp;
    const ytdlp = loadPackaged();
    const first = ytdlp.jsRuntime();
    fs.writeFileSync(path.join(tmp, exe('deno')), '');
    expect(ytdlp.jsRuntime()).toEqual(first); // not searched for again on every play
    process.env.YTDLP_JS_RUNTIME = 'quickjs:/opt/qjs';
    expect(ytdlp.jsRuntimeArgs()).toEqual(['--js-runtimes', 'quickjs:/opt/qjs']);
    process.env.YTDLP_JS_RUNTIME = 'OFF';
    expect(ytdlp.jsRuntimeArgs()).toEqual([]);
});
