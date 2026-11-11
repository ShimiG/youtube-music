// Theme colours from cover art (issue #26): which URLs and addresses may be
// fetched, how the dominant colour is chosen, that the theme is readable, and
// GET /api/artwork/colors on a real database. The network and ffmpeg are
// stubbed through artworkColors.runner; one test runs the real ffmpeg when
// this machine has it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let tmp;
let db;
let app;
let artwork;
const auth = () => ({ Authorization: `Bearer ${jwt.sign({ userId: 1, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` });

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fakePng = Buffer.concat([PNG_MAGIC, Buffer.alloc(32)]);
const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

// SIDE x SIDE pixels: `parts` is [[r, g, b], share] pairs filling the image.
const pixels = (...parts) => {
    const count = 32 * 32;
    const out = Buffer.alloc(count * 3);
    let at = 0;
    for (const [rgb, share] of parts) {
        const until = Math.min(count, at + Math.round(count * share));
        for (; at < until; at++) out.set(rgb, at * 3);
    }
    return out;
};
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-art-'));
    process.env.MUSIC_DATA_DIR = tmp;
    jest.resetModules();
    artwork = require('../services/artworkColors');
    artwork._resetForTests();
    artwork.runner.download = jest.fn(async () => ({ status: 200, location: null, body: fakePng }));
    artwork.runner.decode = jest.fn(async () => pixels([[200, 30, 30], 1]));
    artwork.runner.dnsLookup = jest.fn((host, options, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    db = await require('../config/db')();
    app = require('../app');
    app.locals.db = db;
    await db.run(`INSERT INTO users (id, username, password) VALUES (1, 'u1', 'x')`);
});

afterEach(async () => {
    console.log.mockRestore();
    console.warn.mockRestore();
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.MUSIC_DATA_DIR;
});

const get = (url) => request(app).get('/api/artwork/colors').query({ url }).set(auth());
const COVER = 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg';

describe('which addresses may be contacted', () => {
    it('accepts public addresses and refuses loopback, private, link-local and reserved ones', () => {
        for (const ip of ['8.8.8.8', '142.250.74.14', '2606:4700::1111', '2a00:1450:4001::200e']) {
            expect([ip, artwork.isPublicAddress(ip)]).toEqual([ip, true]);
        }
        for (const ip of [
            '127.0.0.1', '127.8.9.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1',
            '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
            '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
            '::ffff:127.0.0.1', '::ffff:8.8.8.8', '0:0:0:0:0:ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::1',
            'localhost', '', 'not-an-ip'
        ]) {
            expect([ip, artwork.isPublicAddress(ip)]).toEqual([ip, false]);
        }
    });

    it('checks the addresses the socket will use, in both lookup styles', (done) => {
        artwork.guardedLookup('covers.example.com', { all: true }, (err, list) => {
            expect(err).toBeNull();
            expect(list).toEqual([{ address: '93.184.216.34', family: 4 }]);
            artwork.guardedLookup('covers.example.com', { family: 0 }, (err2, address, family) => {
                expect([err2, address, family]).toEqual([null, '93.184.216.34', 4]);
                expect(artwork.runner.dnsLookup.mock.calls[1][1]).toMatchObject({ all: true });
                done();
            });
        });
    });

    it('refuses a host when any of its addresses is private (DNS pointing inwards)', (done) => {
        artwork.runner.dnsLookup = jest.fn((host, options, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.10', family: 4 }]));
        artwork.guardedLookup('rebind.example.com', { all: true }, (err, list) => {
            expect(err).toMatchObject({ code: 'BLOCKED' });
            expect(list).toBeUndefined();
            artwork.runner.dnsLookup = jest.fn((host, options, cb) => cb(null, []));
            artwork.guardedLookup('empty.example.com', {}, (err2) => {
                expect(err2).toMatchObject({ code: 'BLOCKED' });
                const failure = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
                artwork.runner.dnsLookup = jest.fn((host, options, cb) => cb(failure));
                artwork.guardedLookup('missing.example.com', {}, (err3) => {
                    expect(err3).toBe(failure);
                    done();
                });
            });
        });
    });
});

describe('checkUrl', () => {
    it('accepts a plain https URL and drops the fragment', () => {
        expect(artwork.checkUrl('https://i1.sndcdn.com/artworks-abc-t300x300.jpg?x=1#frag').href).toBe('https://i1.sndcdn.com/artworks-abc-t300x300.jpg?x=1');
        expect(artwork.checkUrl('https://8.8.8.8/a.png').hostname).toBe('8.8.8.8');
    });

    it('refuses anything else: other schemes, ports, credentials, junk', () => {
        for (const bad of [
            'http://i.ytimg.com/a.jpg', 'file:///etc/passwd', 'ftp://example.com/a.jpg', 'data:image/png;base64,AAAA',
            'https://example.com:8443/a.jpg', 'https://example.com:22/', 'https://user:pass@example.com/a.jpg',
            'https://', 'not a url', '', undefined, null, 42, ['https://example.com/a.jpg'], { url: 'x' },
            `https://example.com/${'a'.repeat(3000)}`
        ]) {
            expect(() => artwork.checkUrl(bad)).toThrow(expect.objectContaining({ code: 'BAD_URL' }));
        }
    });

    it('refuses addresses of this computer or its network, however they are written', () => {
        for (const inward of [
            'https://127.0.0.1/a.jpg', 'https://2130706433/a.jpg', 'https://0x7f.0.0.1/a.jpg', 'https://127.1/a.jpg',
            'https://[::1]/a.jpg', 'https://[::ffff:127.0.0.1]/a.jpg', 'https://169.254.169.254/latest/meta-data/',
            'https://192.168.0.1/cover.png', 'https://10.0.0.5/cover.png', 'https://[fd00::1]/cover.png', 'https://0.0.0.0/'
        ]) {
            expect(() => artwork.checkUrl(inward)).toThrow(expect.objectContaining({ code: 'BLOCKED' }));
        }
    });
});

describe('imageFormat', () => {
    it('recognises JPEG, PNG and WebP by their first bytes and nothing else', () => {
        expect(artwork.imageFormat(fakeJpeg)).toBe('jpeg_pipe');
        expect(artwork.imageFormat(fakePng)).toBe('png_pipe');
        expect(artwork.imageFormat(Buffer.concat([Buffer.from('RIFF\u0010\u0000\u0000\u0000WEBPVP8 '), Buffer.alloc(16)]))).toBe('webp_pipe');
        expect(artwork.imageFormat(Buffer.from('<!doctype html><html><body>not an image</body></html>'))).toBeNull();
        expect(artwork.imageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
        expect(artwork.imageFormat(Buffer.from('GIF89a' + '\u0000'.repeat(20)))).toBeNull();
        expect(artwork.imageFormat(Buffer.alloc(4))).toBeNull();
        expect(artwork.imageFormat('ÿØÿ')).toBeNull();
    });
});

describe('dominantColor', () => {
    it('finds the colour of a one-colour image', () => {
        expect(artwork.dominantColor(pixels([[200, 30, 30], 1]))).toEqual([200, 30, 30]);
    });

    it('lets colour win over a larger grey, black or white area', () => {
        expect(artwork.dominantColor(pixels([[128, 128, 128], 0.7], [[30, 60, 200], 0.3]))).toEqual([30, 60, 200]);
        expect(artwork.dominantColor(pixels([[5, 5, 5], 0.5], [[250, 250, 250], 0.3], [[20, 160, 80], 0.2]))).toEqual([20, 160, 80]);
    });

    it('prefers the larger of two coloured areas, and a vivid one over a dull one of the same size', () => {
        expect(artwork.dominantColor(pixels([[200, 30, 30], 0.7], [[30, 60, 200], 0.3]))).toEqual([200, 30, 30]);
        expect(artwork.dominantColor(pixels([[120, 100, 80], 0.5], [[20, 200, 220], 0.5]))).toEqual([20, 200, 220]);
    });

    it('treats neighbouring hues as one colour (reds on both sides of 0 degrees)', () => {
        const [r, g, b] = artwork.dominantColor(pixels([[220, 20, 40], 0.3], [[220, 40, 20], 0.3], [[20, 60, 220], 0.4]));
        expect(r).toBeGreaterThan(200);
        expect(Math.max(g, b)).toBeLessThan(60);
    });

    it('is null for an image without colour', () => {
        expect(artwork.dominantColor(pixels([[128, 128, 128], 1]))).toBeNull();
        expect(artwork.dominantColor(pixels([[0, 0, 0], 0.5], [[255, 255, 255], 0.5]))).toBeNull();
        expect(artwork.dominantColor(pixels([[90, 90, 90], 0.98], [[255, 0, 0], 0.02]))).toBeNull();
        expect(artwork.dominantColor(Buffer.alloc(0))).toBeNull();
    });
});

describe('themeFrom', () => {
    it('keeps text readable on every colour: white 7:1 and grey 4.5:1 on the backgrounds, accent 4.5:1', () => {
        const WHITE = [255, 255, 255];
        const GREY = [179, 179, 179];
        const samples = [];
        for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) samples.push([r, g, b]);
        for (const rgb of samples) {
            const theme = artwork.themeFrom(rgb);
            for (const key of ['color', 'background', 'surface', 'accent']) expect(theme[key]).toMatch(/^#[0-9a-f]{6}$/);
            for (const key of ['background', 'surface']) {
                expect(artwork.contrast(WHITE, rgbOf(theme[key]))).toBeGreaterThanOrEqual(7);
                expect(artwork.contrast(GREY, rgbOf(theme[key]))).toBeGreaterThanOrEqual(4.5);
            }
            expect(artwork.contrast(rgbOf(theme.accent), [24, 24, 24])).toBeGreaterThanOrEqual(4.5);
            expect(artwork.contrast(rgbOf(theme.accent), rgbOf(theme.surface))).toBeGreaterThanOrEqual(4.5);
            expect(artwork.contrast(rgbOf(theme.accent), rgbOf(theme.background))).toBeGreaterThanOrEqual(3);
            // Black text on an accent-coloured button.
            expect(artwork.contrast([0, 0, 0], rgbOf(theme.accent))).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('keeps the hue of the cover', () => {
        const theme = artwork.themeFrom([30, 60, 200]);
        for (const key of ['background', 'surface', 'accent']) {
            const [r, g, b] = rgbOf(theme[key]);
            expect(b).toBeGreaterThan(r);
            expect(b).toBeGreaterThan(g);
        }
    });
});

describe('GET /api/artwork/colors', () => {
    it('needs a login and an https image URL', async () => {
        expect((await request(app).get('/api/artwork/colors').query({ url: COVER })).statusCode).toBe(401);
        expect((await request(app).get('/api/artwork/colors').set(auth())).statusCode).toBe(400);
        expect((await get('http://i.ytimg.com/vi/a/hq.jpg')).statusCode).toBe(400);
        expect((await request(app).get('/api/artwork/colors?url[]=https://a.example/x.jpg').set(auth())).statusCode).toBe(400);
        expect(artwork.runner.download).not.toHaveBeenCalled();
    });

    it('answers with the cover\'s colours and reads each cover once', async () => {
        const res = await get(COVER);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toEqual({ status: 'ok', ...artwork.themeFrom([200, 30, 30]) });
        expect(res.body.color).toBe('#c81e1e');
        expect(artwork.runner.download.mock.calls[0][0].href).toBe(COVER);
        expect(artwork.runner.decode).toHaveBeenCalledWith(fakePng, 'png_pipe');

        expect((await get(COVER)).body).toEqual(res.body);
        expect(artwork.runner.download).toHaveBeenCalledTimes(1);
        const row = await db.get('SELECT url_hash, status, color FROM artwork_colors');
        expect(row).toMatchObject({ status: 'ok', color: '#c81e1e' });
        expect(row.url_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('follows a redirect to another public https host', async () => {
        artwork.runner.download
            .mockResolvedValueOnce({ status: 302, location: 'https://cdn.example.com/covers/b.jpg', body: null })
            .mockResolvedValueOnce({ status: 301, location: '/covers/c.jpg', body: null })
            .mockResolvedValueOnce({ status: 200, location: null, body: fakeJpeg });
        expect((await get(COVER)).body.status).toBe('ok');
        expect(artwork.runner.download.mock.calls.map(([u]) => String(u))).toEqual([COVER, 'https://cdn.example.com/covers/b.jpg', 'https://cdn.example.com/covers/c.jpg']);
        expect(artwork.runner.decode).toHaveBeenCalledWith(fakeJpeg, 'jpeg_pipe');
    });

    it('does not follow a redirect to this computer, to plain http, or for ever', async () => {
        for (const location of ['https://127.0.0.1/secret', 'http://cdn.example.com/b.jpg', 'https://169.254.169.254/latest/meta-data/', 'https://cdn.example.com:8080/b.jpg', 'file:///etc/passwd']) {
            artwork._resetForTests();
            artwork.runner.download.mockClear();
            artwork.runner.download.mockResolvedValueOnce({ status: 302, location, body: null });
            const res = await get(`${COVER}?to=${encodeURIComponent(location)}`);
            expect([location, res.statusCode, res.body]).toEqual([location, 200, { status: 'none' }]);
            expect(artwork.runner.download).toHaveBeenCalledTimes(1);
        }
        artwork._resetForTests();
        artwork.runner.download.mockReset();
        artwork.runner.download.mockResolvedValue({ status: 302, location: 'https://cdn.example.com/again.jpg', body: null });
        expect((await get(`${COVER}?loop=1`)).body).toEqual({ status: 'none' });
        expect(artwork.runner.download).toHaveBeenCalledTimes(4);
        expect(artwork.runner.decode).not.toHaveBeenCalled();
    });

    it('says "none" for an address of this computer without contacting it', async () => {
        for (const inward of ['https://127.0.0.1/a.jpg', 'https://[::1]/a.jpg', 'https://192.168.1.1/a.jpg', 'https://169.254.169.254/x']) {
            expect((await get(inward)).body).toEqual({ status: 'none' });
        }
        expect(artwork.runner.download).not.toHaveBeenCalled();
    });

    it('says "none" when the download fails, and does not retry at once', async () => {
        artwork.runner.download.mockRejectedValueOnce(new artwork.ArtworkError('BLOCKED', 'That host is not on the public internet.'));
        expect((await get(COVER)).body).toEqual({ status: 'none' });
        expect((await get(COVER)).body).toEqual({ status: 'none' });
        expect(artwork.runner.download).toHaveBeenCalledTimes(1);

        artwork.runner.download.mockRejectedValueOnce(new Error('socket hang up'));
        expect((await get(`${COVER}?2`)).body).toEqual({ status: 'none' });
        artwork.runner.download.mockResolvedValueOnce({ status: 404, location: null, body: null });
        expect((await get(`${COVER}?3`)).body).toEqual({ status: 'none' });
        // Failures are not written to the database.
        expect(await db.get('SELECT COUNT(*) AS n FROM artwork_colors')).toEqual({ n: 0 });
    });

    it('never hands anything but JPEG, PNG or WebP to ffmpeg', async () => {
        artwork.runner.download.mockResolvedValueOnce({ status: 200, location: null, body: Buffer.from('<html><body>login page of some router</body></html>') });
        expect((await get(COVER)).body).toEqual({ status: 'none' });
        expect(artwork.runner.decode).not.toHaveBeenCalled();
    });

    it('says "none" for an unreadable image and for one without colour (remembered in the database)', async () => {
        artwork.runner.decode.mockRejectedValueOnce(new artwork.ArtworkError('UNSUPPORTED', 'The image could not be read.'));
        expect((await get(COVER)).body).toEqual({ status: 'none' });

        artwork.runner.decode.mockResolvedValueOnce(pixels([[120, 120, 120], 1]));
        const grey = 'https://cdn.example.com/grey.png';
        expect((await get(grey)).body).toEqual({ status: 'none' });
        expect(await db.get('SELECT status, color FROM artwork_colors')).toEqual({ status: 'none', color: null });
        artwork._resetForTests();
        artwork.runner.download.mockClear();
        expect((await get(grey)).body).toEqual({ status: 'none' });
        expect(artwork.runner.download).not.toHaveBeenCalled();
    });

    it('reads a cover once when it is asked for twice at the same moment, and again after 90 days', async () => {
        let release;
        artwork.runner.download.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ status: 200, location: null, body: fakePng }); }));
        const a = artwork.getColors(db, COVER);
        const b = artwork.getColors(db, COVER);
        await new Promise((resolve) => setTimeout(resolve, 20));
        release();
        expect((await a).status).toBe('ok');
        expect((await b).status).toBe('ok');
        expect(artwork.runner.download).toHaveBeenCalledTimes(1);

        await db.run('UPDATE artwork_colors SET fetched_at = ?', [Date.now() - 91 * 24 * 60 * 60 * 1000]);
        expect((await artwork.getColors(db, COVER)).status).toBe('ok');
        expect(artwork.runner.download).toHaveBeenCalledTimes(2);
    });

    it('runs at most two covers at a time', async () => {
        let active = 0;
        let peak = 0;
        artwork.runner.download.mockImplementation(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 15));
            active--;
            return { status: 200, location: null, body: fakePng };
        });
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) => artwork.getColors(db, `https://cdn.example.com/${i}.png`)));
        expect(results.every((r) => r.status === 'ok')).toBe(true);
        expect(peak).toBe(2);
    });
});

// A real PNG, built by hand: `size` x `size` pixels of one colour.
function makePng(size, [r, g, b]) {
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const out = Buffer.alloc(body.length + 8);
        out.writeUInt32BE(data.length, 0);
        body.copy(out, 4);
        out.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header.set([8, 2, 0, 0, 0], 8); // 8 bits per channel, RGB
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3)]);
    for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
    const raw = Buffer.concat(Array.from({ length: size }, () => row));
    return Buffer.concat([PNG_MAGIC, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('with the real ffmpeg', () => {
    const ffmpeg = require('../services/paths').resolveFfmpeg();
    const available = typeof zlib.crc32 === 'function' && spawnSync(ffmpeg, ['-version']).status === 0;
    const maybe = available ? it : it.skip;

    maybe('reduces a PNG to 32 x 32 pixels and finds its colour; a broken image is refused', async () => {
        const png = makePng(64, [30, 60, 200]);
        expect(artwork.imageFormat(png)).toBe('png_pipe');
        const out = await artwork.decodeWithFfmpeg(png, 'png_pipe');
        expect(out).toHaveLength(32 * 32 * 3);
        expect(artwork.dominantColor(out)).toEqual([30, 60, 200]);
        await expect(artwork.decodeWithFfmpeg(png.subarray(0, 60), 'png_pipe')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
        await expect(artwork.decodeWithFfmpeg(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not really a jpeg at all')]), 'jpeg_pipe')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    });
});
