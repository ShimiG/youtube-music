// Where the server keeps its files and finds its helper binaries.
//
// Two modes:
//   - Development (`node server.js`): everything lives in the project folder,
//     exactly as before (database.sqlite, cache/, .token-key, bin/yt-dlp_*).
//   - Packaged (single executable, see scripts/build-sea.mjs): the executable's
//     folder is read-only inside an installed app, so writable data goes to the
//     per-user app-data folder, and helper binaries are looked up next to the
//     executable, then in well-known system locations.
//
// MUSIC_DATA_DIR, FFMPEG_PATH and YTDLP_PATH override the defaults in both modes.
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'Music Manager';
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function isPackaged() {
    try {
        return require('node:sea').isSea();
    } catch {
        return false; // Node without the sea module: never packaged
    }
}

/** The project folder in development; the executable's folder when packaged. */
function appRoot() {
    return isPackaged() ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
}

function osDataDir() {
    if (isWindows) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
    if (isMac) return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
    return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'music-manager');
}

/** Writable folder for the database, audio cache, token key and yt-dlp. */
function dataDir() {
    const dir = process.env.MUSIC_DATA_DIR
        ? path.resolve(process.env.MUSIC_DATA_DIR)
        : (isPackaged() ? osDataDir() : appRoot());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const firstExisting = (candidates) => candidates.find((p) => p && fs.existsSync(p));

// --- yt-dlp -------------------------------------------------------------------

function ytDlpFileName() {
    if (isWindows) return 'yt-dlp.exe';
    if (isMac) return 'yt-dlp_macos';
    return 'yt-dlp';
}

/**
 * yt-dlp must sit somewhere writable, because `yt-dlp -U` replaces its own
 * file. When packaged, a copy shipped next to the executable is copied into
 * the data folder on first run and updated there.
 */
function resolveYtDlp() {
    if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
    const name = ytDlpFileName();
    const writable = path.join(dataDir(), 'bin', name);
    if (isPackaged() && !fs.existsSync(writable)) {
        const bundled = path.join(appRoot(), name);
        if (fs.existsSync(bundled)) {
            try {
                fs.mkdirSync(path.dirname(writable), { recursive: true });
                fs.copyFileSync(bundled, writable);
                fs.chmodSync(writable, 0o755);
            } catch (err) {
                console.warn(`Could not copy bundled yt-dlp to ${writable}: ${err.message}`);
                return bundled;
            }
        }
    }
    return firstExisting([writable, path.join(appRoot(), 'bin', name)])
        // Not installed by us: fall back to one on the PATH (Homebrew, pip, winget).
        || (isMac ? firstExisting(['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp']) : null)
        || 'yt-dlp';
}

// --- ffmpeg -------------------------------------------------------------------

function ffmpegStaticPath() {
    if (isPackaged()) return null; // its binary lives in node_modules, which does not ship
    try {
        return require('ffmpeg-static');
    } catch {
        return null;
    }
}

/**
 * ffmpeg: FFMPEG_PATH, then a copy next to the packaged executable, then the
 * ffmpeg-static download (development), then a system install. macOS GUI apps
 * do not inherit the shell PATH, so Homebrew's locations are checked by name.
 */
function resolveFfmpeg() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    const exe = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
    return firstExisting([
        isPackaged() ? path.join(appRoot(), exe) : null,
        ffmpegStaticPath(),
        ...(isMac ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'] : []),
        ...(!isWindows && !isMac ? ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'] : [])
    ]) || exe; // last resort: let the OS find it on the PATH
}

module.exports = { isPackaged, appRoot, dataDir, osDataDir, resolveYtDlp, resolveFfmpeg, ytDlpFileName };
