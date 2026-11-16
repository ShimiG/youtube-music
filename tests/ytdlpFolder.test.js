// docs/performance-plan.md, step 1.5: the app fetches yt-dlp's folder build,
// which does not unpack itself on every start, and uses it only once it has
// proved to run and to start faster (services/ytdlpFolder.js). The network
// and the running of programs are stand-ins here; nothing is downloaded.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { makeZip } = require('./helpers/zip');

let dir;
let folder;
let ytdlp;
let release;      // what "the latest release" holds: { zip, sums }
let downloads;    // names fetched
let startMs;      // how long each program "takes to start": exe path -> ms (null: does not run)
let saved;

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const publish = (version, { sums } = {}) => {
    const zip = makeZip([
        { name: 'yt-dlp_test', data: `#!/bin/sh\necho ${version}\n`, mode: 0o755 },
        { name: '_internal/' },
        { name: '_internal/lib.bin', data: Buffer.alloc(20000, version) }
    ]);
    release = { version, zip, sums: sums ?? `${sha(zip)}  yt-dlp_test.zip\n${'0'.repeat(64)}  yt-dlp_other.zip\n` };
};
const log = () => ({ log: jest.fn(), warn: jest.fn() });
const installedDirs = () => (fs.existsSync(folder.root()) ? fs.readdirSync(folder.root()).filter((f) => f.startsWith('v-')) : []);
const SLOW = '/somewhere/yt-dlp_single_file';

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ytfolder-'));
    saved = { data: process.env.MUSIC_DATA_DIR, auto: process.env.YTDLP_AUTO_UPDATE, pathOf: process.env.YTDLP_PATH };
    process.env.MUSIC_DATA_DIR = dir;
    process.env.YTDLP_AUTO_UPDATE = 'true';
    delete process.env.YTDLP_PATH;
    jest.resetModules();
    folder = require('../services/ytdlpFolder');
    ytdlp = require('../services/ytdlp');
    downloads = [];
    startMs = { [SLOW]: 7800 };
    publish('2026.11.01');
    folder.runner.asset = () => ({ zip: 'yt-dlp_test.zip', exe: 'yt-dlp_test' });
    folder.runner.get = jest.fn(async (url) => {
        const name = url.split('/').pop();
        downloads.push(name);
        if (name === 'SHA2-256SUMS') return Readable.from([Buffer.from(release.sums)]);
        if (name === 'yt-dlp_test.zip') return Readable.from([release.zip.subarray(0, 100), release.zip.subarray(100)]);
        throw new Error(`the download answered 404`);
    });
    folder.runner.version = jest.fn(async (exe) => {
        const ms = exe in startMs ? startMs[exe] : (fs.existsSync(exe) ? 400 : null);
        if (ms === null) return null;
        const version = fs.existsSync(exe) && exe.startsWith(dir) ? fs.readFileSync(exe, 'utf8').match(/echo (\S+)/)[1] : '2026.01.01';
        return { version, ms };
    });
});

afterEach(() => {
    for (const [key, name] of [['data', 'MUSIC_DATA_DIR'], ['auto', 'YTDLP_AUTO_UPDATE'], ['pathOf', 'YTDLP_PATH']]) {
        if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('fetching the folder build', () => {
    it('is fetched, checked and tried when the yt-dlp in use is slow to start, and then used', async () => {
        expect(folder.currentExe()).toBeNull();
        const l = log();
        const result = await folder.ensure({ currentPath: SLOW, log: l });
        expect(result).toMatchObject({ status: 'installed', version: '2026.11.01', startMs: 400 });
        expect(downloads).toEqual(['SHA2-256SUMS', 'yt-dlp_test.zip']);
        expect(l.log).toHaveBeenCalledWith(expect.stringMatching(/now using the folder build 2026\.11\.01: starts in 400 ms instead of 7800 ms/));

        const exe = folder.currentExe();
        expect(exe).toBe(result.exe);
        expect(path.basename(exe)).toBe('yt-dlp_test');
        expect(fs.existsSync(path.join(path.dirname(exe), '_internal', 'lib.bin'))).toBe(true);
        if (process.platform !== 'win32') expect(fs.statSync(exe).mode & 0o111).not.toBe(0);
        // Nothing left over from the download.
        expect(fs.readdirSync(folder.root()).sort()).toEqual(['current.json', path.basename(path.dirname(exe))].sort());
    });

    it('is not fetched when the yt-dlp in use starts quickly, and that is not measured again at every start', async () => {
        startMs[SLOW] = 380; // a Homebrew or pip install
        expect(await folder.ensure({ currentPath: SLOW, log: log() })).toMatchObject({ status: 'kept', startMs: 380 });
        expect(downloads).toEqual([]);
        expect(folder.currentExe()).toBeNull();
        folder.runner.version.mockClear();
        expect(await folder.ensure({ currentPath: SLOW, log: log() })).toMatchObject({ status: 'kept' });
        expect(folder.runner.version).not.toHaveBeenCalled();
        // A week on it is looked at again (the yt-dlp in use may have changed).
        const state = folder._internals.readState();
        folder._internals.writeState({ ...state, keptAt: Date.now() - folder.RETRY_AFTER_MS - 1000 });
        startMs[SLOW] = 7800;
        expect(await folder.ensure({ currentPath: SLOW, log: log() })).toMatchObject({ status: 'installed' });
    });

    it('is fetched when there is no yt-dlp at all', async () => {
        startMs[SLOW] = null;
        expect(await folder.ensure({ currentPath: SLOW, log: log() })).toMatchObject({ status: 'installed' });
        expect(await folder.ensure({ currentPath: undefined, log: log() })).toMatchObject({ status: 'current' });
    });

    it('is left alone when the user named the yt-dlp to use, or switched updates off', async () => {
        process.env.YTDLP_PATH = '/opt/homebrew/bin/yt-dlp';
        expect(await folder.ensure({ currentPath: SLOW, log: log() })).toMatchObject({ status: 'skipped', message: expect.stringMatching(/YTDLP_PATH/) });
        delete process.env.YTDLP_PATH;
        process.env.YTDLP_AUTO_UPDATE = 'false';
        expect(await folder.ensure({ currentPath: SLOW, log: log() })).toMatchObject({ status: 'skipped' });
        process.env.YTDLP_AUTO_UPDATE = 'true';
        folder.runner.asset = () => null; // a platform yt-dlp publishes no folder build for
        expect(await folder.ensure({ currentPath: SLOW, log: log() })).toMatchObject({ status: 'skipped' });
        expect(downloads).toEqual([]);
    });
});

describe('what keeps a bad download from being used', () => {
    const nothingChanged = () => {
        expect(folder.currentExe()).toBeNull();
        expect(installedDirs()).toEqual([]);
        expect(fs.existsSync(path.join(folder.root(), 'download.part'))).toBe(false);
    };

    it('a download that does not match the published checksum', async () => {
        const good = release.zip;
        publish('2026.11.01', { sums: `${'ab'.repeat(32)}  yt-dlp_test.zip\n` });
        release.zip = good;
        const l = log();
        const result = await folder.ensure({ currentPath: SLOW, log: l });
        expect(result.status).toBe('failed');
        expect(result.message).toMatch(/does not match the published checksum/);
        expect(l.warn).toHaveBeenCalled();
        nothingChanged();
        expect(folder.runner.version).toHaveBeenCalledTimes(2); // only the yt-dlp in use was ever run
    });

    it('a release that lists no checksum, a download that fails, an archive without the program', async () => {
        publish('2026.11.01', { sums: 'not a checksum list\n' });
        expect((await folder.ensure({ currentPath: SLOW, log: log() })).message).toMatch(/lists no checksum/);
        nothingChanged();

        publish('2026.11.01');
        folder.runner.get.mockImplementationOnce(async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); });
        expect((await folder.ensure({ currentPath: SLOW, log: log() })).status).toBe('failed');
        nothingChanged();

        const empty = makeZip([{ name: 'readme.txt', data: 'no program here' }]);
        release = { zip: empty, sums: `${sha(empty)}  yt-dlp_test.zip\n` };
        expect((await folder.ensure({ currentPath: SLOW, log: log() })).message).toMatch(/has no yt-dlp_test in it/);
        nothingChanged();
    });

    it('a folder build that does not run here, or is not faster than what is there', async () => {
        folder.runner.version.mockImplementation(async (exe) => (exe === SLOW ? { version: '2026.01.01', ms: 7800 } : null));
        expect((await folder.ensure({ currentPath: SLOW, log: log() })).message).toMatch(/does not run on this computer/);
        nothingChanged();

        folder.runner.version.mockImplementation(async (exe) => ({ version: '2026.11.01', ms: exe === SLOW ? 2000 : 2500 }));
        const result = await folder.ensure({ currentPath: SLOW, log: log() });
        expect(result).toMatchObject({ status: 'declined', startMs: 2500 });
        nothingChanged();
        // And it is not downloaded again tomorrow to find out the same thing.
        downloads.length = 0;
        expect(await folder.ensure({ currentPath: SLOW, log: log() })).toMatchObject({ status: 'kept' });
        expect(downloads).toEqual([]);
    });

    it('downloads only from GitHub, redirects included', async () => {
        const { httpsGet } = folder._internals;
        await expect(httpsGet('https://example.com/yt-dlp.zip')).rejects.toThrow(/refusing to download from example\.com/);
        await expect(httpsGet('http://github.com/yt-dlp/yt-dlp/releases/latest/download/x')).rejects.toThrow(/refusing/);
        await expect(httpsGet('https://github.com.evil.example/x')).rejects.toThrow(/refusing/);
    });
});

describe('keeping it up to date, and the yt-dlp the app runs', () => {
    it('a new release replaces the one in use; the same release downloads nothing', async () => {
        await folder.ensure({ currentPath: SLOW, log: log() });
        const first = folder.currentExe();
        downloads.length = 0;
        expect(await folder.ensure({ currentPath: SLOW, log: log() })).toMatchObject({ status: 'current' });
        expect(downloads).toEqual(['SHA2-256SUMS']); // a kilobyte, not the build

        publish('2026.12.05');
        const l = log();
        expect(await folder.ensure({ currentPath: SLOW, log: l })).toMatchObject({ status: 'installed', version: '2026.12.05' });
        expect(l.log).toHaveBeenCalledWith(expect.stringMatching(/updated to 2026\.12\.05/));
        expect(folder.currentExe()).not.toBe(first);
        expect(installedDirs()).toHaveLength(1); // the old copy is gone

        // A new release that does not run leaves the working one in use.
        publish('2027.01.01');
        folder.runner.version.mockImplementation(async (exe) => (exe.includes(sha(release.zip).slice(0, 12)) ? null : { version: '2026.12.05', ms: 400 }));
        const working = folder.currentExe();
        expect((await folder.ensure({ currentPath: SLOW, log: log() })).status).toBe('failed');
        expect(folder.currentExe()).toBe(working);
    });

    it('the daily look switches the app over at once, and does not also run yt-dlp -U', async () => {
        const health = require('../services/health');
        const reset = jest.spyOn(health, '_resetMemo');
        ytdlp.runner.exec = jest.fn();
        const before = ytdlp.ytDlpPath();
        const stampFile = path.join(dir, 'stamp');
        // `currentPath` is whatever was found at start-up; make it look slow.
        folder.runner.version.mockImplementation(async (exe) => ({ version: '2026.11.01', ms: exe.startsWith(folder.root()) ? 400 : 7800 }));

        const result = await ytdlp.updateYtDlpIfDue({ log: log(), stampFile });
        expect(result).toMatchObject({ skipped: false, updated: true });
        expect(ytdlp.ytDlpPath()).toBe(folder.currentExe());
        expect(ytdlp.ytDlpPath()).not.toBe(before);
        expect(reset).toHaveBeenCalled();
        expect(ytdlp.runner.exec).not.toHaveBeenCalled();
        expect(fs.existsSync(stampFile)).toBe(true);

        // YTDLP_PATH always wins.
        process.env.YTDLP_PATH = '/opt/homebrew/bin/yt-dlp';
        expect(ytdlp.ytDlpPath()).toBe('/opt/homebrew/bin/yt-dlp');
    });

    it('the first look happens at the first start it could help, even if yt-dlp -U ran today already', async () => {
        ytdlp.runner.exec = jest.fn();
        const stampFile = path.join(dir, 'stamp');
        fs.writeFileSync(stampFile, 'looked today');
        folder.runner.version.mockImplementation(async (exe) => ({ version: '2026.11.01', ms: exe.startsWith(folder.root()) ? 400 : 7800 }));
        expect(await ytdlp.updateYtDlpIfDue({ log: log(), stampFile })).toMatchObject({ skipped: false, updated: true });
        expect(ytdlp.ytDlpPath()).toBe(folder.currentExe());
        // From then on it is the once-a-day look.
        downloads.length = 0;
        expect(await ytdlp.updateYtDlpIfDue({ log: log(), stampFile })).toMatchObject({ skipped: true });
        expect(downloads).toEqual([]);
        expect(ytdlp.runner.exec).not.toHaveBeenCalled();
    });

    it('is picked up again after a restart, and a failed look is tried again at the next start', async () => {
        await folder.ensure({ currentPath: SLOW, log: log() });
        const exe = folder.currentExe();
        jest.resetModules();
        expect(require('../services/ytdlp').ytDlpPath()).toBe(exe);

        // Offline: nothing changes, and no "looked today" is recorded.
        const again = require('../services/ytdlp');
        const fresh = require('../services/ytdlpFolder');
        fresh.runner.asset = () => ({ zip: 'yt-dlp_test.zip', exe: 'yt-dlp_test' });
        fresh.runner.get = jest.fn(async () => { throw new Error('offline'); });
        const stampFile = path.join(dir, 'stamp2');
        expect(await again.updateYtDlpIfDue({ log: log(), stampFile })).toMatchObject({ failed: true });
        expect(fs.existsSync(stampFile)).toBe(false);
        expect(again.ytDlpPath()).toBe(exe);
    });
});
