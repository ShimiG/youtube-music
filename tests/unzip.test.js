// services/unzip.js: the archives the app fetches itself are unpacked by its
// own code, which trusts nothing the archive says about where files go or
// how big they are.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractZip } = require('../services/unzip');
const { makeZip } = require('./helpers/zip');

let dir;
let n = 0;
const write = (zip) => {
    const file = path.join(dir, `a${n++}.zip`);
    fs.writeFileSync(file, zip);
    return file;
};
const unpack = (entries, options) => extractZip(write(makeZip(entries)), path.join(dir, `out${n}`), options);
const out = () => path.join(dir, `out${n}`);
const listing = (root, at = '') => fs.readdirSync(path.join(root, at), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listing(root, `${at}${e.name}/`) : [`${at}${e.name}`])).sort();

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-unzip-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('unpacking', () => {
    it('writes every file with its contents, folders included, compressed or not', async () => {
        const big = Buffer.alloc(300000, 'yt-dlp ');
        const result = await unpack([
            { name: 'yt-dlp_test', data: '#!/bin/sh\necho hi\n', mode: 0o755 },
            { name: '_internal/' },
            { name: '_internal/lib/deep/data.bin', data: big },
            { name: '_internal/stored.txt', data: 'as it is', store: true },
            { name: '_internal/empty', data: '' },
            { name: 'ünïcödé.txt', data: 'name in UTF-8' }
        ]);
        expect(result).toEqual({ files: 5, bytes: 18 + big.length + 8 + 0 + 13 });
        expect(listing(out())).toEqual(['_internal/empty', '_internal/lib/deep/data.bin', '_internal/stored.txt', 'yt-dlp_test', 'ünïcödé.txt']);
        expect(fs.readFileSync(path.join(out(), '_internal/lib/deep/data.bin')).equals(big)).toBe(true);
        expect(fs.readFileSync(path.join(out(), '_internal/stored.txt'), 'utf8')).toBe('as it is');
    });

    it('keeps "may be run" from the archive, and nothing more than that', async () => {
        if (process.platform === 'win32') return; // no such permission there
        await unpack([
            { name: 'run-me', data: 'x', mode: 0o755 },
            { name: 'plain', data: 'x', mode: 0o644 },
            { name: 'too-open', data: 'x', mode: 0o4777 }, // set-user-id, writable by everyone
            { name: 'from-windows.exe', data: 'x', mode: 0o777, madeOn: 0 } // no Unix permissions in it
        ]);
        const mode = (name) => (fs.statSync(path.join(out(), name)).mode & 0o7777).toString(8);
        expect([mode('run-me'), mode('plain'), mode('too-open'), mode('from-windows.exe')]).toEqual(['755', '644', '755', '644']);
    });
});

describe('what an archive is not trusted with', () => {
    const refuses = async (entries, message, options) => {
        await expect(unpack(entries, options)).rejects.toMatchObject({ code: 'BAD_ZIP', message: expect.stringMatching(message) });
    };

    it('writing outside the folder it is unpacked into', async () => {
        for (const name of ['../evil', 'a/../../evil', '/etc/evil', 'C:/evil', 'a\\..\\..\\evil', '..', 'ok/../../../evil']) {
            await refuses([{ name: 'fine.txt', data: 'x' }, { name, data: 'x' }], /refusing the entry name/);
        }
        // Nothing appeared next to the destination.
        expect(fs.readdirSync(dir).filter((f) => f.includes('evil'))).toEqual([]);
        // Dots that go nowhere are harmless.
        await unpack([{ name: './a/./b.txt', data: 'x' }]);
        expect(listing(out())).toEqual(['a/b.txt']);
    });

    it('creating symbolic links', async () => {
        await refuses([{ name: 'link', data: '/etc/passwd', link: true }], /symbolic link/);
    });

    it('unpacking to more than it states, or more than is allowed', async () => {
        // A deflate stream that grows past its stated size is stopped, not followed.
        await refuses([{ name: 'bomb', data: Buffer.alloc(5000000, 0), size: 10 }], /could not unpack|not the size/);
        await refuses([{ name: 'a', data: Buffer.alloc(2000) }, { name: 'b', data: Buffer.alloc(2000) }], /too much/, { maxBytes: 3000 });
        await refuses([{ name: 'a', data: 'x' }, { name: 'b', data: 'x' }, { name: 'c', data: 'x' }], /too many entries/, { maxEntries: 2 });
        await refuses([{ name: 'short', data: 'hello', store: true, size: 9 }], /not the size|damaged/);
    });

    it('damaged or unsupported archives', async () => {
        await refuses([{ name: 'a', data: 'hello', crc: 12345 }], /is damaged/);
        await refuses([{ name: 'a', data: 'hello', flags: 1 }], /encrypted/);
        await refuses([{ name: 'a', data: 'hello', method: 12 }], /method 12/);
        await expect(extractZip(write(Buffer.from('this is not a zip archive at all')), out())).rejects.toMatchObject({ code: 'BAD_ZIP' });
        await expect(extractZip(write(Buffer.alloc(5)), out())).rejects.toMatchObject({ code: 'BAD_ZIP' });
        const cut = makeZip([{ name: 'a', data: Buffer.alloc(5000, 1), store: true }]);
        cut.writeUInt32LE(0xffffffff, cut.length - 22 + 16); // "the directory is elsewhere" (zip64)
        await expect(extractZip(write(cut), out())).rejects.toMatchObject({ message: expect.stringMatching(/zip64/) });
        // An end record followed by a comment is still found.
        const commented = makeZip([{ name: 'a.txt', data: 'x' }], { comment: 'made by a test' });
        await extractZip(write(commented), out());
        expect(listing(out())).toEqual(['a.txt']);
    });
});
