// Unit tests for the credential-free yt-dlp SoundCloud provider. Process
// spawning is stubbed through ytdlp.runner; the fixtures mirror real output
// captured from yt-dlp 2026.01.31.
const ytdlp = require('../controllers/soundcloud/ytdlp');

const flatEntry = (overrides = {}) => ({
    id: '254112221',
    uploader: 'Daft Punk',
    uploader_url: 'https://soundcloud.com/daftpunkofficialmusic',
    title: 'Around the World',
    thumbnails: [
        { id: 'large', url: 'https://i1.sndcdn.com/artworks-x-large.jpg', width: 100, height: 100 },
        { id: 't300x300', url: 'https://i1.sndcdn.com/artworks-x-t300x300.jpg', width: 300, height: 300 },
        { id: 'original', url: 'https://i1.sndcdn.com/artworks-x-original.jpg' }
    ],
    duration: 429.3,
    webpage_url: 'https://soundcloud.com/daftpunkofficialmusic/around-the-world',
    artists: ['Daft Punk'],
    formats: null,
    _type: 'url',
    url: 'https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A254112221',
    ...overrides
});

let execMock;
beforeEach(() => {
    execMock = jest.fn();
    ytdlp.runner.exec = execMock;
});

describe('normalizeEntry', () => {
    it('maps a flat search entry to the shared Track shape with the numeric id', () => {
        const t = ytdlp.normalizeEntry(flatEntry());
        expect(t).toMatchObject({
            id: '254112221',
            source: 'soundcloud',
            title: 'Around the World',
            channelTitle: 'Daft Punk',
            duration: 429,
            preview: false,
            playable: true,
            access: 'playable',
            permalinkUrl: 'https://soundcloud.com/daftpunkofficialmusic/around-the-world',
            provider: 'ytdlp'
        });
        expect(t.thumbnail).toBe('https://i1.sndcdn.com/artworks-x-t300x300.jpg');
    });

    it('flags a 30 second flat entry as a Go+ preview snippet', () => {
        const t = ytdlp.normalizeEntry(flatEntry({ duration: 30.0 }));
        expect(t.preview).toBe(true);
        expect(t.access).toBe('preview');
    });

    it('uses format ids when a full extraction is available', () => {
        const full = flatEntry({ duration: 30.0, formats: [{ format_id: 'hls_mp3_1_0_preview' }, { format_id: 'http_mp3_1_0_preview' }] });
        expect(ytdlp.normalizeEntry(full).preview).toBe(true);

        const fullTrack = flatEntry({ duration: 30.0, formats: [{ format_id: 'hls_aac_1_0' }, { format_id: 'http_mp3_1_0' }] });
        expect(ytdlp.normalizeEntry(fullTrack).preview).toBe(false);
    });

    it('drops entries without a numeric id', () => {
        expect(ytdlp.normalizeEntry({ title: 'x' })).toBeNull();
        expect(ytdlp.normalizeEntry({ id: 'abc' })).toBeNull();
    });
});

describe('search', () => {
    it('runs a flat scsearch and parses one JSON object per line', async () => {
        execMock.mockResolvedValueOnce([
            JSON.stringify(flatEntry()),
            'not json at all',
            JSON.stringify(flatEntry({ id: '99', title: 'Other', duration: 30 })),
            ''
        ].join('\n'));

        const items = await ytdlp.search('daft punk', 30);

        const args = execMock.mock.calls[0][0];
        expect(args).toContain('--flat-playlist');
        expect(args).toContain('-j');
        expect(args).toContain('--no-update');
        expect(args[args.length - 1]).toBe('scsearch30:daft punk');
        expect(items.map(i => i.id)).toEqual(['254112221', '99']);
        expect(items[1].preview).toBe(true);
    });

    it('clamps the result count', async () => {
        execMock.mockResolvedValueOnce('');
        await ytdlp.search('x', 500);
        expect(execMock.mock.calls[0][0].pop()).toBe('scsearch50:x');
    });

    it('propagates a yt-dlp failure', async () => {
        const err = new Error('yt-dlp failed: ERROR: Unable to download JSON metadata');
        err.code = 'YTDLP_FAILED';
        execMock.mockRejectedValueOnce(err);
        await expect(ytdlp.search('x')).rejects.toMatchObject({ code: 'YTDLP_FAILED' });
    });
});

describe('resolveStream', () => {
    it('returns the direct URL and whether it is a preview rendition', async () => {
        execMock.mockResolvedValueOnce('https://cf-preview-media.sndcdn.com/preview/0/30/abc.128.mp3?Policy=x\nhttp_mp3_1_0_preview\n');
        const picked = await ytdlp.resolveStream('254112221');
        expect(picked.url).toMatch(/^https:\/\/cf-preview-media/);
        expect(picked.isPreview).toBe(true);

        const args = execMock.mock.calls[0][0];
        expect(args[args.length - 1]).toBe('https://api.soundcloud.com/tracks/254112221');
        // Prefer an MP3 rendition; ffmpeg fails on SoundCloud's AAC fMP4 HLS.
        expect(args).toEqual(expect.arrayContaining(['-f', 'bestaudio[ext=mp3]/bestaudio/best']));
    });

    it('marks a full-length format as not a preview', async () => {
        execMock.mockResolvedValueOnce('https://cf-hls-media.sndcdn.com/playlist/x.m3u8\nhls_aac_1_0\n');
        const picked = await ytdlp.resolveStream('1');
        expect(picked.isPreview).toBe(false);
        expect(picked.format).toBe('hls_aac_1_0');
    });

    it('fails with YTDLP_NO_URL when no URL comes back', async () => {
        execMock.mockResolvedValueOnce('\n');
        await expect(ytdlp.resolveStream('1')).rejects.toMatchObject({ code: 'YTDLP_NO_URL' });
    });

    it('rejects a non-numeric id before spawning anything', async () => {
        await expect(ytdlp.resolveStream('../x')).rejects.toThrow(/Invalid/);
        expect(execMock).not.toHaveBeenCalled();
    });
});

describe('getDuration', () => {
    it('parses the printed duration into whole seconds', async () => {
        execMock.mockResolvedValueOnce('213.513\n');
        expect(await ytdlp.getDuration('1')).toBe(214);
        expect(execMock.mock.calls[0][0]).toEqual(expect.arrayContaining(['--print', 'duration']));
    });
});
