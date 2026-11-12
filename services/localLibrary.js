// Local files (issue #24): folders a user adds, scanned for audio files whose
// tags go into the database (local_folders, local_tracks; see config/db.js).
//
// Safety rules, because this reads the user's disk on behalf of HTTP requests:
// - A folder is stored by its real path (symlinks resolved) and must be an
//   existing directory; the filesystem root is refused.
// - The scanner never follows symbolic links (no loops, no escapes), skips
//   hidden entries, and stops at MAX_DEPTH / MAX_FILES.
// - Tracks are addressed by row id, never by a client-supplied path. Before a
//   file is served, its real path is resolved again and must still be inside
//   its folder's real path, and its extension must be an audio type.
// - Every lookup is scoped to the requesting user's folders.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTags } = require('./tagReader');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.oga', '.opus', '.aif', '.aiff', '.wma']);
// Played as they are (HTTP range, native seeking) in Chromium and WebKit;
// everything else goes through ffmpeg.
const DIRECT_TYPES = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav'
};

const MAX_FOLDERS_PER_USER = 20;
const MAX_DEPTH = 20;
const MAX_FILES = 50000;
const PARSE_CONCURRENCY = 4;
const WRITE_BATCH = 500; // rows per transaction while scanning
const MAX_PATH_LENGTH = 1024;

class LocalError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'LocalError';
        this.code = code;
        this.status = status;
    }
}

const isAudioFile = (name) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
const directTypeOf = (file) => DIRECT_TYPES[path.extname(file).toLowerCase()] || null;
const isInside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// --- Folders ----------------------------------------------------------------------

function expandHome(input) {
    if (input === '~') return os.homedir();
    if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
    return input;
}

// --- Where folders may be -----------------------------------------------------------
//
// A music folder is, by design, a path the user chooses on their own computer.
// Two rules keep that safe:
//
// 1. Location. The folder must be inside the user's home folder, on another
//    drive or mounted volume, or under a root listed in LOCAL_MUSIC_ROOTS
//    (separated by the platform's path delimiter). System locations and other
//    users' folders are refused, so an abused session cannot make the server
//    index, say, /etc or C:\Windows.
// 2. The typed text never reaches the filesystem. The folder is found by
//    starting at the allowed root (which comes from configuration, not from
//    the request) and walking down one level at a time, matching each typed
//    name against the names the directory listing returns. The path that is
//    opened is therefore built only from the root and from real entry names.
//    Afterwards its real path (symlinks resolved) must still be inside an
//    allowed root, so a link inside a root cannot lead out of it.
//
// Folder names are deliberately not restricted by character: they
// legitimately contain spaces, parentheses, apostrophes, `&` and non-Latin
// letters. Only control characters are refused.

// Windows and macOS file systems are case-insensitive by default.
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const fold = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
const isInsideRoot = (child, root) => isInside(fold(child), fold(root));
// macOS stores names decomposed (NFD) while typed text is usually composed.
const sameName = (a, b) => fold(a.normalize('NFC')) === fold(b.normalize('NFC'));

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** On Windows, the root of a drive other than the system drive, e.g. "D:\\". */
function otherDriveRoot(resolved) {
    if (process.platform !== 'win32') return null;
    const typed = /^([A-Za-z]):[\\/]/.exec(resolved);
    if (!typed) return null;
    // Taken from the constant list, so the root is never the typed text.
    const letter = DRIVE_LETTERS.find((l) => l === typed[1].toUpperCase());
    const system = String(process.env.SystemDrive || 'C:').charAt(0).toUpperCase();
    return letter && letter !== system ? `${letter}:\\` : null;
}

function configuredRoots() {
    const roots = [os.homedir()];
    if (process.platform === 'darwin') roots.push('/Volumes');
    else if (process.platform !== 'win32') roots.push('/media', '/mnt', '/run/media');
    for (const extra of String(process.env.LOCAL_MUSIC_ROOTS || '').split(path.delimiter)) {
        if (extra.trim() && path.isAbsolute(extra.trim())) roots.push(path.resolve(extra.trim()));
    }
    return roots;
}

/**
 * Every allowed root as { typed, real }: the path as configured and its real
 * path. Roots that do not exist are dropped.
 */
async function allowedRoots(resolved) {
    const list = configuredRoots();
    const drive = otherDriveRoot(resolved);
    if (drive) list.push(drive);
    const roots = await Promise.all(list.map(async (typed) => {
        try {
            return { typed, real: await fs.promises.realpath(typed) };
        } catch {
            return null;
        }
    }));
    return roots.filter(Boolean);
}

const NOT_ALLOWED_MESSAGE = 'Choose a folder inside your home folder or on another drive. Other locations can be allowed with LOCAL_MUSIC_ROOTS.';
const notAllowed = () => new LocalError('LOCAL_NOT_ALLOWED', NOT_ALLOWED_MESSAGE, 403);
const notFound = () => new LocalError('LOCAL_NOT_FOUND', 'That folder does not exist or cannot be read.');

/**
 * Walks from `base` down the typed `segments`, choosing at each level the
 * directory entry whose name matches. Returns the path built from those
 * entry names, or null when a level has no such entry.
 */
async function descend(base, segments) {
    let current = base;
    for (const segment of segments) {
        let names;
        try {
            names = await fs.promises.readdir(current);
        } catch {
            return null;
        }
        const entry = names.find((name) => name === segment) || names.find((name) => sameName(name, segment));
        if (!entry) return null;
        current = path.join(current, entry);
    }
    return current;
}

/** Validates a folder the user typed and returns its real path. */
async function resolveFolder(input) {
    if (typeof input !== 'string' || !input.trim() || input.length > MAX_PATH_LENGTH) {
        throw new LocalError('LOCAL_BAD_PATH', 'Enter the full path of a folder.');
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(input)) throw new LocalError('LOCAL_BAD_PATH', 'That path contains invalid characters.');
    const expanded = expandHome(input.trim());
    if (!path.isAbsolute(expanded)) throw new LocalError('LOCAL_BAD_PATH', 'Use a full path, for example ~/Music or /Users/you/Music.');

    // Normalised ("." and ".." folded); used only to decide which allowed
    // root the folder is under and which names lead to it from there.
    const resolved = path.resolve(expanded);
    const roots = await allowedRoots(resolved);
    let base = null;
    let segments = null;
    for (const root of roots) {
        // The user may type the root either as configured or as its real path.
        const prefix = [root.typed, root.real].find((p) => isInsideRoot(resolved, p));
        if (prefix === undefined) continue;
        base = root.real;
        segments = path.relative(prefix, resolved).split(path.sep).filter(Boolean);
        break;
    }
    if (!base || segments.includes('..')) throw notAllowed();

    const found = await descend(base, segments);
    if (!found) throw notFound();

    let real;
    try {
        real = await fs.promises.realpath(found);
        const st = await fs.promises.stat(real);
        if (!st.isDirectory()) throw new LocalError('LOCAL_NOT_A_FOLDER', 'That path is not a folder.');
    } catch (err) {
        if (err instanceof LocalError) throw err;
        throw notFound();
    }
    if (path.parse(real).root === real) throw new LocalError('LOCAL_BAD_PATH', 'Choose a folder, not the whole disk.');
    // A symlink on the way must not lead out of every allowed root.
    if (!roots.some((root) => isInsideRoot(real, root.real))) throw notAllowed();
    return real;
}

async function listFolders(db, userId) {
    const rows = await db.all(
        `SELECT id, path, added_at, last_scan_at, file_count, scan_error, truncated
         FROM local_folders WHERE user_id = ? ORDER BY added_at`,
        [userId]
    );
    return rows.map((r) => ({
        id: String(r.id),
        path: r.path,
        name: path.basename(r.path) || r.path,
        addedAt: r.added_at,
        lastScanAt: r.last_scan_at,
        fileCount: r.file_count,
        error: r.scan_error || null,
        truncated: Boolean(r.truncated),
        scanning: scans.has(r.id),
        progress: scans.has(r.id) ? scans.get(r.id).progress : null
    }));
}

async function addFolder(db, userId, input) {
    const real = await resolveFolder(input);
    const count = await db.get(`SELECT COUNT(*) AS n FROM local_folders WHERE user_id = ?`, [userId]);
    if (count && count.n >= MAX_FOLDERS_PER_USER) {
        throw new LocalError('LOCAL_TOO_MANY', `You can add up to ${MAX_FOLDERS_PER_USER} folders.`);
    }
    const existing = await db.get(`SELECT id FROM local_folders WHERE user_id = ? AND path = ?`, [userId, real]);
    if (existing) throw new LocalError('LOCAL_DUPLICATE', 'That folder is already in your library.', 409);
    const result = await db.run(
        `INSERT INTO local_folders (user_id, path, added_at) VALUES (?, ?, ?)`,
        [userId, real, Date.now()]
    );
    startScan(db, result.lastID);
    return { id: String(result.lastID), path: real };
}

async function ownedFolder(db, userId, folderId) {
    if (!/^[0-9]{1,12}$/.test(String(folderId))) return null;
    return db.get(`SELECT id, path FROM local_folders WHERE id = ? AND user_id = ?`, [Number(folderId), userId]);
}

async function removeFolder(db, userId, folderId) {
    const folder = await ownedFolder(db, userId, folderId);
    if (!folder) throw new LocalError('LOCAL_NOT_FOUND', 'Folder not found.', 404);
    const scan = scans.get(folder.id);
    if (scan) scan.cancelled = true;
    await db.run(`DELETE FROM local_tracks WHERE folder_id = ?`, [folder.id]);
    await db.run(`DELETE FROM local_folders WHERE id = ?`, [folder.id]);
}

async function rescanFolder(db, userId, folderId) {
    const folder = await ownedFolder(db, userId, folderId);
    if (!folder) throw new LocalError('LOCAL_NOT_FOUND', 'Folder not found.', 404);
    startScan(db, folder.id);
}

// --- Scanning --------------------------------------------------------------------

// One scan per folder at a time; folder id -> { progress, cancelled, promise }.
const scans = new Map();

/** Walks a folder: audio files only, no symlinks, no hidden entries, bounded. */
async function walk(root) {
    const files = [];
    let truncated = false;
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length) {
        const { dir, depth } = stack.pop();
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            continue; // unreadable subfolder: skip it, keep the rest
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            if (entry.isSymbolicLink()) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth + 1 <= MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
            } else if (entry.isFile() && isAudioFile(entry.name)) {
                if (files.length >= MAX_FILES) { truncated = true; break; }
                files.push(path.relative(root, full));
            }
        }
        if (truncated) break;
    }
    return { files, truncated };
}

async function mapLimit(items, limit, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            await fn(items[index], index);
        }
    });
    await Promise.all(workers);
}

/** Scans one folder: adds new and changed files, removes vanished ones. */
async function scanFolder(db, folderId, state = { progress: { done: 0, total: 0 }, cancelled: false }) {
    const folder = await db.get(`SELECT id, path FROM local_folders WHERE id = ?`, [folderId]);
    if (!folder) return null;
    try {
        const st = await fs.promises.stat(folder.path);
        if (!st.isDirectory()) throw new Error('not a folder');
    } catch {
        await db.run(`UPDATE local_folders SET scan_error = ?, last_scan_at = ? WHERE id = ?`,
            ['The folder no longer exists or cannot be read.', Date.now(), folderId]);
        return { added: 0, updated: 0, removed: 0, error: true };
    }

    const { files, truncated } = await walk(folder.path);
    const known = new Map((await db.all(
        `SELECT id, rel_path, size, mtime_ms FROM local_tracks WHERE folder_id = ?`, [folderId]
    )).map((r) => [r.rel_path, r]));

    state.progress.total = files.length;
    let added = 0;
    let updated = 0;
    // Rows are written WRITE_BATCH at a time, each batch as one transaction:
    // row by row, a first scan of a large library spent most of its database
    // time waiting for the disk.
    const pending = [];
    const flush = async () => {
        const batch = pending.splice(0);
        if (!batch.length) return;
        await db.transaction(async () => {
            for (const [sql, params] of batch) await db.run(sql, params);
        });
    };
    await mapLimit(files, PARSE_CONCURRENCY, async (rel) => {
        if (state.cancelled) return;
        const full = path.join(folder.path, rel);
        let st;
        try { st = await fs.promises.stat(full); } catch { return; }
        const row = known.get(rel);
        known.delete(rel);
        state.progress.done++;
        if (row && row.size === st.size && row.mtime_ms === Math.round(st.mtimeMs)) return; // unchanged

        let tags = {};
        try {
            tags = await readTags(full);
        } catch {
            tags = {}; // unreadable tags: the file name stands in for the title
        }
        const fallbackTitle = path.basename(rel, path.extname(rel));
        const values = [
            st.size, Math.round(st.mtimeMs),
            tags.title || fallbackTitle, tags.artist || null, tags.album || null,
            tags.trackNo ?? null, tags.durationSec ?? null,
            tags.format || path.extname(rel).slice(1).toLowerCase()
        ];
        if (row) {
            pending.push([
                `UPDATE local_tracks SET size = ?, mtime_ms = ?, title = ?, artist = ?, album = ?, track_no = ?, duration_sec = ?, format = ? WHERE id = ?`,
                [...values, row.id]
            ]);
            updated++;
        } else {
            pending.push([
                `INSERT OR IGNORE INTO local_tracks (size, mtime_ms, title, artist, album, track_no, duration_sec, format, folder_id, rel_path)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [...values, folderId, rel]
            ]);
            added++;
        }
        if (pending.length >= WRITE_BATCH) await flush();
    });
    // What was read before a cancel is kept: it is correct, and saves the next scan the work.
    await flush();
    if (state.cancelled) return null;

    // Whatever is still in `known` was not found on disk this time.
    let removed = 0;
    await db.transaction(async () => {
        for (const row of known.values()) {
            await db.run(`DELETE FROM local_tracks WHERE id = ?`, [row.id]);
            removed++;
        }
    });
    const total = await db.get(`SELECT COUNT(*) AS n FROM local_tracks WHERE folder_id = ?`, [folderId]);
    await db.run(
        `UPDATE local_folders SET last_scan_at = ?, file_count = ?, scan_error = NULL, truncated = ? WHERE id = ?`,
        [Date.now(), total ? total.n : 0, truncated ? 1 : 0, folderId]
    );
    return { added, updated, removed, truncated };
}

/** Starts a background scan unless one is running; resolves when it ends. */
function startScan(db, folderId) {
    if (scans.has(folderId)) return scans.get(folderId).promise;
    const state = { progress: { done: 0, total: 0 }, cancelled: false };
    state.promise = scanFolder(db, folderId, state)
        .catch((err) => {
            console.error(`Local files: scanning folder ${folderId} failed: ${err && err.message}`);
            return db.run(`UPDATE local_folders SET scan_error = ? WHERE id = ?`, ['Scanning failed.', folderId]).catch(() => {});
        })
        .finally(() => scans.delete(folderId));
    scans.set(folderId, state);
    return state.promise;
}

/**
 * Rescans every folder, one after another, in the background (at startup), so
 * files added or removed while the app was closed show up. Unchanged files
 * cost one stat each.
 */
async function rescanAll(db) {
    const rows = await db.all(`SELECT id FROM local_folders ORDER BY id`);
    for (const row of rows) {
        await startScan(db, row.id);
    }
    return rows.length;
}

// --- Tracks ---------------------------------------------------------------------

/**
 * The file to play for track `trackId`, if it belongs to `userId`, still
 * exists, and its real path is still inside its folder. Resolves with
 * { filePath, durationSec, directType } or null.
 */
async function resolvePlayableFile(db, userId, trackId) {
    if (!/^[0-9]{1,12}$/.test(String(trackId))) return null;
    const row = await db.get(
        `SELECT t.rel_path, t.duration_sec, f.path AS folder_path
         FROM local_tracks t JOIN local_folders f ON f.id = t.folder_id
         WHERE t.id = ? AND f.user_id = ?`,
        [Number(trackId), userId]
    );
    if (!row) return null;
    if (path.isAbsolute(row.rel_path) || !isAudioFile(row.rel_path)) return null;
    let folderReal;
    let fileReal;
    try {
        folderReal = await fs.promises.realpath(row.folder_path);
        fileReal = await fs.promises.realpath(path.join(row.folder_path, row.rel_path));
        if (!(await fs.promises.stat(fileReal)).isFile()) return null;
    } catch {
        return null; // gone since the last scan
    }
    if (!isInside(fileReal, folderReal) || fileReal === folderReal) return null;
    if (!isAudioFile(fileReal)) return null;
    return { filePath: fileReal, durationSec: row.duration_sec, directType: directTypeOf(fileReal) };
}

function _resetForTests() { scans.clear(); }

module.exports = {
    LocalError,
    AUDIO_EXTENSIONS,
    MAX_FILES,
    MAX_DEPTH,
    resolveFolder,
    listFolders,
    addFolder,
    removeFolder,
    rescanFolder,
    rescanAll,
    scanFolder,
    startScan,
    walk,
    resolvePlayableFile,
    isInside,
    _resetForTests
};
