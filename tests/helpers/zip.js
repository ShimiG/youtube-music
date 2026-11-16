// Builds a .zip archive in memory, for tests of services/unzip.js and
// services/ytdlpFolder.js. Entries: { name, data?, mode?, store?, link?,
// madeOn?, crc?, size? } (a name ending in "/" is a folder; crc and size
// override the true values, to make a damaged archive).
const zlib = require('zlib');

function makeZip(entries, { comment = '' } = {}) {
    const locals = [];
    const directory = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
        const method = entry.store || entry.name.endsWith('/') ? 0 : 8;
        const packed = method === 8 ? zlib.deflateRawSync(data) : data;
        const crc = entry.crc ?? zlib.crc32(data);
        const size = entry.size ?? data.length;
        const type = entry.link ? 0o120000 : (entry.name.endsWith('/') ? 0o040000 : 0o100000);
        const attributes = (((type | (entry.mode ?? 0o644)) << 16) >>> 0);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(entry.flags || 0, 6);
        local.writeUInt16LE(entry.method ?? method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, packed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt8(20, 4);
        central.writeUInt8(entry.madeOn ?? 3, 5); // 3: Unix
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(entry.flags || 0, 8);
        central.writeUInt16LE(entry.method ?? method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(attributes, 38);
        central.writeUInt32LE(offset, 42);
        directory.push(central, name);
        offset += 30 + name.length + packed.length;
    }
    const dir = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(Buffer.byteLength(comment), 20);
    return Buffer.concat([...locals, dir, end, Buffer.from(comment)]);
}

module.exports = { makeZip };
