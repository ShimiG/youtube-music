const fs = require('fs');
const os = require('os');
const path = require('path');
const { enforceCacheLimit, prepareCache, cacheMaxBytes } = require('../controllers/transcode');

let dir;

function writeFile(name, bytes, ageSec) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(bytes));
    const t = new Date(Date.now() - ageSec * 1000);
    fs.utimesSync(p, t, t);
    return p;
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-')); });
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CACHE_MAX_BYTES;
});

describe('size-based cache eviction', () => {
    it('evicts least recently played files until the total fits', async () => {
        writeFile('youtube_aaaaaaaaaaa.mp3', 400, 300); // oldest
        writeFile('soundcloud_1.mp3', 400, 200);
        writeFile('youtube_bbbbbbbbbbb.mp3', 400, 100); // newest

        const result = await enforceCacheLimit(900, dir);
        expect(result).toEqual({ evicted: 1, totalBytes: 800 });
        expect(fs.readdirSync(dir).sort()).toEqual(['soundcloud_1.mp3', 'youtube_bbbbbbbbbbb.mp3']);
    });

    it('does nothing when under the limit and ignores non-audio files', async () => {
        writeFile('youtube_aaaaaaaaaaa.mp3', 100, 10);
        writeFile('notes.txt', 10_000, 10);
        const result = await enforceCacheLimit(1000, dir);
        expect(result.evicted).toBe(0);
        expect(fs.readdirSync(dir)).toHaveLength(2);
    });

    it('defaults to 500 MB and honours CACHE_MAX_BYTES', () => {
        expect(cacheMaxBytes()).toBe(500 * 1024 * 1024);
        process.env.CACHE_MAX_BYTES = '1048576';
        expect(cacheMaxBytes()).toBe(1048576);
        process.env.CACHE_MAX_BYTES = 'nonsense';
        expect(cacheMaxBytes()).toBe(500 * 1024 * 1024);
    });
});

describe('startup cache housekeeping', () => {
    it('removes .part files and renames legacy YouTube files to source-prefixed keys', async () => {
        writeFile('dQw4w9WgXcQ.mp3', 10, 10);          // legacy bare YouTube id
        writeFile('youtube_xxxxxxxxxxx_1700000000.part', 10, 10);
        writeFile('soundcloud_123.mp3', 10, 10);

        await prepareCache(dir);
        expect(fs.readdirSync(dir).sort()).toEqual(['soundcloud_123.mp3', 'youtube_dQw4w9WgXcQ.mp3']);
    });

    it('drops the legacy copy when a prefixed one already exists', async () => {
        writeFile('dQw4w9WgXcQ.mp3', 10, 10);
        writeFile('youtube_dQw4w9WgXcQ.mp3', 20, 10);
        await prepareCache(dir);
        expect(fs.readdirSync(dir)).toEqual(['youtube_dQw4w9WgXcQ.mp3']);
        expect(fs.statSync(path.join(dir, 'youtube_dQw4w9WgXcQ.mp3')).size).toBe(20);
    });
});
