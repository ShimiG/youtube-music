const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_KEYS = ['MUSIC_DATA_DIR', 'FFMPEG_PATH', 'YTDLP_PATH', 'APPDATA', 'XDG_DATA_HOME'];
let saved;
beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    ENV_KEYS.forEach((k) => delete process.env[k]);
    jest.resetModules();
});
afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    jest.dontMock('node:sea');
    jest.resetModules();
});

function loadPaths({ packaged }) {
    jest.doMock('node:sea', () => ({ isSea: () => packaged }), { virtual: true });
    return require('../services/paths');
}

describe('development mode (node server.js)', () => {
    it('keeps data in the project folder, as before', () => {
        const paths = loadPaths({ packaged: false });
        const root = path.resolve(__dirname, '..');
        expect(paths.isPackaged()).toBe(false);
        expect(paths.appRoot()).toBe(root);
        expect(paths.dataDir()).toBe(root);
    });

    it('honours MUSIC_DATA_DIR, FFMPEG_PATH and YTDLP_PATH', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-paths-'));
        process.env.MUSIC_DATA_DIR = path.join(dir, 'nested', 'data');
        process.env.FFMPEG_PATH = '/opt/custom/ffmpeg';
        process.env.YTDLP_PATH = '/opt/custom/yt-dlp';
        const paths = loadPaths({ packaged: false });
        expect(paths.dataDir()).toBe(process.env.MUSIC_DATA_DIR);
        expect(fs.existsSync(process.env.MUSIC_DATA_DIR)).toBe(true); // created on demand
        expect(paths.resolveFfmpeg()).toBe('/opt/custom/ffmpeg');
        expect(paths.resolveYtDlp()).toBe('/opt/custom/yt-dlp');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('falls back to a bare command name when no binary is found', () => {
        process.env.MUSIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-paths-'));
        const paths = loadPaths({ packaged: false });
        const yt = paths.resolveYtDlp();
        // Either the developer's bin/ copy or the PATH fallback; never a crash.
        expect(typeof yt).toBe('string');
        expect(yt.length).toBeGreaterThan(0);
    });
});

describe('packaged mode (single executable)', () => {
    it('stores data in the per-user app-data folder, not next to the executable', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-home-'));
        process.env.APPDATA = home;
        process.env.XDG_DATA_HOME = home;
        const homedir = jest.spyOn(os, 'homedir').mockReturnValue(home);
        const paths = loadPaths({ packaged: true });

        expect(paths.isPackaged()).toBe(true);
        expect(paths.appRoot()).toBe(path.dirname(process.execPath));
        const expected = {
            win32: path.join(home, 'Music Manager'),
            darwin: path.join(home, 'Library', 'Application Support', 'Music Manager')
        }[process.platform] || path.join(home, 'music-manager');
        expect(paths.dataDir()).toBe(expected);
        homedir.mockRestore();
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('never uses ffmpeg-static (its binary does not ship) and prefers FFMPEG_PATH', () => {
        process.env.MUSIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-paths-'));
        const paths = loadPaths({ packaged: true });
        expect(paths.resolveFfmpeg()).not.toContain('node_modules');
        process.env.FFMPEG_PATH = '/x/ffmpeg';
        expect(paths.resolveFfmpeg()).toBe('/x/ffmpeg');
    });
});
