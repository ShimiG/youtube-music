// The installed app has no JavaScript runtime of its own for yt-dlp; where the
// computer has none either, it fetches deno (services/jsRuntimeFetch.js).
// The network and the running of programs are stand-ins; nothing is downloaded.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { makeZip } = require('./helpers/zip');

let dir;
let fetcher;
let release;   // { zip, sum }: what "the latest release" holds
let fetched;   // names asked for
let runs;      // whether the downloaded program "runs": its version, or null
let saved;
const KEYS = ['MUSIC_DATA_DIR', 'YTDLP_AUTO_UPDATE', 'YTDLP_JS_RUNTIME', 'PATH'];

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const publish = (version, { sum } = {}) => {
    const zip = makeZip([{ name: 'deno', data: `#!/bin/sh\necho deno ${version}\n${'x'.repeat(5000)}`, mode: 0o755 }]);
    release = { zip, sum: sum ?? `${sha(zip)}  deno-test.zip\n` };
};
const log = () => ({ log: jest.fn(), warn: jest.fn() });
const installed = () => (fs.existsSync(fetcher.root()) ? fs.readdirSync(fetcher.root()).filter((f) => f.startsWith('v-')) : []);

function load() {
    jest.resetModules();
    fetcher = require('../services/jsRuntimeFetch');
    fetcher.runner.asset = () => ({ zip: 'deno-test.zip', exe: 'deno' });
    fetcher.runner.get = jest.fn(async (url) => {
        const name = url.split('/').pop();
        fetched.push(name);
        if (name === 'deno-test.zip.sha256sum') return Readable.from([Buffer.from(release.sum)]);
        if (name === 'deno-test.zip') return Readable.from([release.zip.subarray(0, 100), release.zip.subarray(100)]);
        throw new Error(`the download answered 404`);
    });
    fetcher.runner.version = jest.fn(async () => runs);
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-deno-'));
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.MUSIC_DATA_DIR = dir;
    process.env.YTDLP_AUTO_UPDATE = 'true';
    delete process.env.YTDLP_JS_RUNTIME;
    fetched = [];
    runs = '2.9.6';
    publish('2.9.6');
    load();
});
afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    jest.dontMock('../services/paths');
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('fetching deno', () => {
    it('downloads it, checks it against the published checksum, unpacks it and tries it', async () => {
        const out = log();
        const result = await fetcher.ensure({ log: out });
        expect(result).toMatchObject({ status: 'installed', version: '2.9.6' });
        expect(fetched).toEqual(['deno-test.zip.sha256sum', 'deno-test.zip']);
        expect(result.exe).toBe(fetcher.currentExe());
        expect(fs.readFileSync(result.exe, 'utf8')).toContain('echo deno 2.9.6');
        if (process.platform !== 'win32') expect(fs.statSync(result.exe).mode & 0o111).not.toBe(0);
        expect(fetcher.runner.version).toHaveBeenCalledWith(result.exe);
        expect(out.log.mock.calls[0][0]).toMatch(/fetched deno 2\.9\.6 for YouTube/);
        // Nothing left over from the download.
        expect(fs.readdirSync(fetcher.root()).sort()).toEqual(['current.json', ...installed()].sort());
        expect(installed()).toHaveLength(1);
    });

    it('refuses a download that is not what the release published', async () => {
        publish('2.9.6', { sum: `${'0'.repeat(64)}  deno-test.zip\n` });
        const out = log();
        const result = await fetcher.ensure({ log: out });
        expect(result.status).toBe('failed');
        expect(result.message).toMatch(/does not match the published checksum/);
        expect(out.warn.mock.calls[0][0]).toMatch(/YouTube tracks may not play until one is installed/);
        expect(fetcher.currentExe()).toBeNull();
        expect(installed()).toEqual([]);
        expect(fetcher.runner.version).not.toHaveBeenCalled(); // never run
    });

    it('does not use one that does not run, or a release with no checksum', async () => {
        runs = null;
        expect(await fetcher.ensure({ log: log() })).toMatchObject({ status: 'failed', message: expect.stringMatching(/does not run on this computer/) });
        expect(fetcher.currentExe()).toBeNull();
        expect(installed()).toEqual([]);

        runs = '2.9.6';
        release.sum = 'not a checksum';
        expect((await fetcher.ensure({ log: log() })).message).toMatch(/gives no checksum/);
        release.zip = makeZip([{ name: 'something-else', data: 'x' }]);
        release.sum = `${sha(release.zip)}  deno-test.zip\n`;
        expect((await fetcher.ensure({ log: log() })).message).toMatch(/has no deno in it/);
        expect(installed()).toEqual([]);
    });

    it('looks for a newer release once a week, and replaces the old one when there is one', async () => {
        await fetcher.ensure({ log: log() });
        const first = fetcher.currentExe();
        fetched = [];
        // The next start, the same day: nothing is asked of the network.
        expect(await fetcher.ensure({ log: log() })).toMatchObject({ status: 'current', exe: first });
        expect(fetched).toEqual([]);

        const aWeekOn = Date.now() + fetcher.CHECK_EVERY_MS + 1000;
        const now = jest.spyOn(Date, 'now').mockReturnValue(aWeekOn);
        // Same release: only the checksum (a few bytes) is fetched.
        expect((await fetcher.ensure({ log: log() })).status).toBe('current');
        expect(fetched).toEqual(['deno-test.zip.sha256sum']);

        now.mockReturnValue(aWeekOn + fetcher.CHECK_EVERY_MS + 1000);
        publish('2.10.0');
        runs = '2.10.0';
        const out = log();
        expect(await fetcher.ensure({ log: out })).toMatchObject({ status: 'installed', version: '2.10.0' });
        expect(out.log.mock.calls[0][0]).toMatch(/updated deno to 2\.10\.0/);
        expect(fetcher.currentExe()).not.toBe(first);
        expect(installed()).toHaveLength(1);

        // A later release that is broken leaves the working one in use.
        now.mockReturnValue(aWeekOn + 3 * fetcher.CHECK_EVERY_MS);
        const working = fetcher.currentExe();
        publish('2.11.0');
        runs = null;
        const broken = await fetcher.ensure({ log: log() });
        expect(broken).toMatchObject({ status: 'failed', exe: working });
        expect(broken.message).toMatch(/Continuing with the deno in use/);
        expect(fetcher.currentExe()).toBe(working);
        now.mockRestore();
    });

    it('is not done when a runtime is named, switched off, or downloads are off', async () => {
        for (const [key, value] of [['YTDLP_JS_RUNTIME', 'node'], ['YTDLP_JS_RUNTIME', 'off'], ['YTDLP_AUTO_UPDATE', 'false']]) {
            process.env[key] = value;
            expect((await fetcher.ensure({ log: log() })).status).toBe('skipped');
            expect(fetcher.currentExe()).toBeNull();
            if (key === 'YTDLP_JS_RUNTIME') delete process.env[key]; else process.env[key] = 'true';
        }
        fetcher.runner.asset = () => null; // a platform deno publishes nothing for
        expect((await fetcher.ensure({ log: log() })).message).toMatch(/publishes no build/);
        expect(fetched).toEqual([]);
    });

    it('never downloads from a test run that forgot its stand-in', async () => {
        jest.resetModules();
        const real = require('../services/jsRuntimeFetch');
        await expect(real.runner.get('https://github.com/denoland/deno/releases/latest/download/x')).rejects.toThrow(/no downloads from a test run/);
    });
});

describe('the installed app, on a computer with no runtime', () => {
    // The installed app: not a Node that runs scripts, and nothing on the PATH.
    function installedApp() {
        jest.resetModules();
        jest.doMock('../services/paths', () => ({ ...jest.requireActual('../services/paths'), isPackaged: () => true }));
        process.env.PATH = dir; // no deno, no node there
        const ytdlp = require('../services/ytdlp');
        ytdlp._setRuntimeDirs([]); // nor in the usual places
        fetcher = require('../services/jsRuntimeFetch');
        fetcher.runner.asset = () => ({ zip: 'deno-test.zip', exe: 'deno' });
        fetcher.runner.get = jest.fn(async (url) => {
            const name = url.split('/').pop();
            fetched.push(name);
            return Readable.from([name.endsWith('.sha256sum') ? Buffer.from(release.sum) : release.zip]);
        });
        fetcher.runner.version = jest.fn(async () => runs);
        return ytdlp;
    }
    it('fetches deno and points yt-dlp at it from then on', async () => {
        const ytdlp = installedApp();
        expect(ytdlp.jsRuntime()).toBeNull();
        expect(ytdlp.jsRuntimeArgs()).toEqual([]);
        const result = await ytdlp.ensureJsRuntime({ log: log() });
        expect(result.status).toBe('installed');
        expect(ytdlp.jsRuntime()).toEqual({ name: 'deno', path: result.exe, from: 'fetched by the app' });
        expect(ytdlp.jsRuntimeArgs()).toEqual(['--js-runtimes', `deno:${result.exe}`]);
        // The next start finds it without the network.
        fetched = [];
        const again = installedApp();
        expect(again.jsRuntime()).toMatchObject({ name: 'deno', from: 'fetched by the app' });
        expect(fetched).toEqual([]);
    });

    it('fetches nothing where the server runs on Node itself', async () => {
        jest.resetModules();
        jest.dontMock('../services/paths');
        const ytdlp = require('../services/ytdlp');
        const result = await ytdlp.ensureJsRuntime({ log: log() });
        expect(result).toMatchObject({ status: 'skipped', message: expect.stringMatching(/uses the node of this server/) });
    });
});
