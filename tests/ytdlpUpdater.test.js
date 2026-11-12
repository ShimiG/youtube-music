const fs = require('fs');
const updater = require('../services/ytdlp');

const silentLog = () => ({ log: jest.fn(), warn: jest.fn() });

let execMock;
let existsSpy;
beforeEach(() => {
    execMock = jest.fn();
    updater.runner.exec = execMock;
    existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    process.env.YTDLP_AUTO_UPDATE = 'true';
});
afterEach(() => {
    existsSpy.mockRestore();
    process.env.YTDLP_AUTO_UPDATE = 'false';
});

describe('yt-dlp self-update at startup', () => {
    it('runs `yt-dlp -U` and reports an up-to-date binary', async () => {
        execMock.mockResolvedValueOnce({ stdout: 'Latest version: stable@2026.09.10 from yt-dlp/yt-dlp\nyt-dlp is up to date (stable@2026.09.10 from yt-dlp/yt-dlp)\n', stderr: '' });
        const log = silentLog();

        const result = await updater.updateYtDlp({ log });

        expect(execMock.mock.calls[0][0]).toEqual(['-U', '--no-warnings']);
        expect(result).toMatchObject({ skipped: false, updated: false });
        expect(log.log).toHaveBeenCalledWith(expect.stringContaining('up to date'));
    });

    it('reports a successful update', async () => {
        execMock.mockResolvedValueOnce({ stdout: 'Current version: stable@2026.01.31\nUpdating to stable@2026.09.10 ...\nUpdated yt-dlp to stable@2026.09.10 from yt-dlp/yt-dlp\n', stderr: '' });
        const result = await updater.updateYtDlp({ log: silentLog() });
        expect(result.updated).toBe(true);
        expect(result.message).toMatch(/^Updated yt-dlp to stable@2026.09.10/);
    });

    it('never rejects when the update fails, and keeps the message', async () => {
        const err = new Error('exit 1');
        err.stderr = 'ERROR: Unable to obtain version info (HTTP Error 403)\n';
        execMock.mockRejectedValueOnce(err);
        const log = silentLog();

        const result = await updater.updateYtDlp({ log });

        expect(result).toMatchObject({ failed: true, updated: false });
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP Error 403'));
    });

    it('skips when disabled through YTDLP_AUTO_UPDATE', async () => {
        process.env.YTDLP_AUTO_UPDATE = 'false';
        const result = await updater.updateYtDlp({ log: silentLog() });
        expect(result.skipped).toBe(true);
        expect(execMock).not.toHaveBeenCalled();
    });

    it('skips with a warning when the binary is missing', async () => {
        existsSpy.mockReturnValue(false);
        const log = silentLog();
        const result = await updater.updateYtDlp({ log });
        expect(result.skipped).toBe(true);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not found'));
        expect(execMock).not.toHaveBeenCalled();
    });
});

// docs/performance-plan.md, step 3.2.
describe('looking for a yt-dlp update once a day', () => {
    const os = require('os');
    const path = require('path');
    let dir;
    let stampFile;
    beforeEach(() => {
        existsSpy.mockRestore();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ytdlp-'));
        stampFile = path.join(dir, '.ytdlp-update-check');
        existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        execMock.mockResolvedValue({ stdout: 'yt-dlp is up to date (stable@2026.09.10)\n', stderr: '' });
    });
    afterEach(() => {
        existsSpy.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
        existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    });

    it('runs the first time, then not again until a day has passed', async () => {
        expect(updater.updateDue(stampFile)).toBe(true);
        expect((await updater.updateYtDlpIfDue({ log: silentLog(), stampFile })).skipped).toBe(false);
        expect(execMock).toHaveBeenCalledTimes(1);

        const again = await updater.updateYtDlpIfDue({ log: silentLog(), stampFile });
        expect(again.skipped).toBe(true);
        expect(execMock).toHaveBeenCalledTimes(1);

        // A day later it is due again.
        const yesterday = new Date(Date.now() - updater.CHECK_EVERY_MS - 1000);
        fs.utimesSync(stampFile, yesterday, yesterday);
        await updater.updateYtDlpIfDue({ log: silentLog(), stampFile });
        expect(execMock).toHaveBeenCalledTimes(2);
    });

    it('a failed look is tried again at the next start', async () => {
        execMock.mockReset();
        execMock.mockRejectedValueOnce(Object.assign(new Error('exit 1'), { stderr: 'ERROR: no network\n' }));
        expect((await updater.updateYtDlpIfDue({ log: silentLog(), stampFile })).failed).toBe(true);
        expect(updater.updateDue(stampFile)).toBe(true);
    });
});
