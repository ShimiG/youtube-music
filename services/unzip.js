// Unpacks a .zip archive. Just enough of the format for the archives this app
// fetches itself (yt-dlp's folder builds, services/ytdlpFolder.js): entries
// that are stored or deflated, with their Unix permissions. Node has no unzip
// of its own, and the system's differs on every platform.
//
// An archive is somebody else's data, so it is not trusted to say where its
// files go or how big they are:
//   - every name must stay inside the destination (no "..", no absolute
//     path, no drive letter); symbolic links are not created;
//   - the number of entries and the total unpacked size are capped, and each
//     entry must unpack to exactly the size the archive states (so a small
//     archive cannot fill the disk);
//   - every file's checksum is verified.
// Anything else (encryption, zip64, another compression method) is refused.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
const MADE_ON_UNIX = 3;
const SYMLINK = 0o120000;

class ZipError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ZipError';
        this.code = 'BAD_ZIP';
    }
}

const inflate = (data, size) => new Promise((resolve, reject) => {
    // maxOutputLength: stop at the stated size instead of trusting the data.
    zlib.inflateRaw(data, { maxOutputLength: Math.max(size, 1) }, (err, out) => (err ? reject(new ZipError(`could not unpack an entry: ${err.message}`)) : resolve(out)));
});

/** Where an entry goes inside `destDir`, or throws when its name would leave it. */
function safeTarget(destDir, name) {
    if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
        throw new ZipError(`refusing the entry name "${String(name).slice(0, 80)}"`);
    }
    const parts = name.split('/').filter((part) => part !== '' && part !== '.');
    if (parts.length === 0 || parts.includes('..')) throw new ZipError(`refusing the entry name "${name.slice(0, 80)}"`);
    const target = path.resolve(destDir, ...parts);
    if (target !== destDir && !target.startsWith(destDir + path.sep)) throw new ZipError(`refusing the entry name "${name.slice(0, 80)}"`);
    return target;
}

/** The archive's table of contents: [{ name, method, crc, packedSize, size, offset, mode, isDir, isLink }]. */
function readDirectory(zip, { maxEntries }) {
    // The end record is the last thing in the file, followed only by a comment.
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
        if (zip.readUInt32LE(i) === END_OF_DIRECTORY) { end = i; break; }
    }
    if (end < 0) throw new ZipError('not a zip archive');
    const count = zip.readUInt16LE(end + 10);
    const dirSize = zip.readUInt32LE(end + 12);
    const dirOffset = zip.readUInt32LE(end + 16);
    if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new ZipError('zip64 archives are not supported');
    if (count > maxEntries) throw new ZipError(`too many entries (${count})`);
    if (dirOffset + dirSize > end) throw new ZipError('the archive is damaged');

    const entries = [];
    let at = dirOffset;
    for (let i = 0; i < count; i++) {
        if (at + 46 > zip.length || zip.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new ZipError('the archive is damaged');
        const madeOn = zip.readUInt8(at + 5);
        const flags = zip.readUInt16LE(at + 8);
        const nameLength = zip.readUInt16LE(at + 28);
        const extraLength = zip.readUInt16LE(at + 30);
        const commentLength = zip.readUInt16LE(at + 32);
        const attributes = zip.readUInt32LE(at + 38);
        const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
        const unixMode = madeOn === MADE_ON_UNIX ? (attributes >>> 16) : 0;
        if (flags & 1) throw new ZipError('encrypted archives are not supported');
        entries.push({
            name,
            method: zip.readUInt16LE(at + 10),
            crc: zip.readUInt32LE(at + 16),
            packedSize: zip.readUInt32LE(at + 20),
            size: zip.readUInt32LE(at + 24),
            offset: zip.readUInt32LE(at + 42),
            mode: unixMode & 0o777,
            isDir: name.endsWith('/'),
            isLink: (unixMode & 0o170000) === SYMLINK
        });
        at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

/**
 * Unpacks `zipPath` into `destDir` (created if needed).
 * Resolves to { files, bytes }. Throws ZipError and leaves what it had
 * written so far; unpack into a folder of its own and remove it on failure.
 */
async function extractZip(zipPath, destDir, { maxEntries = 5000, maxBytes = 600 * 1024 * 1024 } = {}) {
    const zip = await fs.promises.readFile(zipPath);
    if (zip.length < 22) throw new ZipError('not a zip archive');
    const entries = readDirectory(zip, { maxEntries });
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total > maxBytes) throw new ZipError(`the archive unpacks to too much (${total} bytes)`);

    const root = path.resolve(destDir);
    await fs.promises.mkdir(root, { recursive: true });
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
        const target = safeTarget(root, entry.name);
        if (entry.isLink) throw new ZipError(`refusing the symbolic link "${entry.name.slice(0, 80)}"`);
        if (entry.isDir) {
            await fs.promises.mkdir(target, { recursive: true });
            continue;
        }
        if (entry.method !== STORED && entry.method !== DEFLATED) throw new ZipError(`compression method ${entry.method} is not supported`);
        // The data sits after the local header, whose own name and extra
        // field may differ in length from the directory's copy.
        const header = entry.offset;
        if (header + 30 > zip.length || zip.readUInt32LE(header) !== LOCAL_HEADER) throw new ZipError('the archive is damaged');
        const start = header + 30 + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28);
        if (start + entry.packedSize > zip.length) throw new ZipError('the archive is damaged');
        const packed = zip.subarray(start, start + entry.packedSize);
        const data = entry.method === STORED ? packed : await inflate(packed, entry.size);
        if (data.length !== entry.size) throw new ZipError(`"${entry.name.slice(0, 80)}" is not the size the archive says`);
        if (zlib.crc32(data) !== entry.crc) throw new ZipError(`"${entry.name.slice(0, 80)}" is damaged`);

        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        // Only "may be run" is taken from the archive; never more than rwxr-xr-x.
        await fs.promises.writeFile(target, data, { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
        files += 1;
        bytes += data.length;
    }
    return { files, bytes };
}

module.exports = { extractZip, ZipError, _internals: { readDirectory, safeTarget } };
