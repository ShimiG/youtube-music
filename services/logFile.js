// Keeps what the server prints in a file as well, so the record of a problem
// survives the terminal (or the desktop app) being closed:
//   <data folder>/logs/server.log        the current log
//   <data folder>/logs/server.log.1      the one before it (rotated at 1 MB)
// The data folder is the project folder when run from source and the per-user
// app-data folder when installed (services/paths.js). LOG_FILE=off disables it.
//
// Lines are written as they are printed, with a time and level, after
// redaction: URL query strings and bearer tokens are cut, because stream URLs
// and API calls can carry signatures and keys.
const fs = require('fs');
const path = require('path');
const util = require('util');
const { dataDir } = require('./paths');

const FILE_NAME = 'server.log';
const MAX_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 4000;
const TAIL_BYTES = 256 * 1024;
const LEVELS = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' };

let installed = false;
let size = 0;
const originals = {};
const onFatal = (err) => append(format('FATAL', [err && err.stack ? err.stack : err]));

const logDir = () => path.join(dataDir(), 'logs');
const logPath = () => path.join(logDir(), FILE_NAME);
const enabled = () => !/^(?:0|false|off|no)$/i.test(String(process.env.LOG_FILE || '').trim());

function redact(text) {
    return String(text)
        .replace(/(\bhttps?:\/\/[^\s?#"']+)\?[^\s"']*/gi, '$1?[cut]')
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [cut]')
        .replace(/\b(access_token|refresh_token|client_secret|token|key|sig|signature)=[^\s&"']+/gi, '$1=[cut]');
}

function format(level, args) {
    // One record per line: a forged or multi-line message cannot fake another.
    const message = redact(util.format(...args)).replace(/\r?\n/g, '\n    ').slice(0, MAX_LINE_CHARS);
    return `${new Date().toISOString()} ${level.padEnd(5)} ${message}\n`;
}

function append(line) {
    try {
        const bytes = Buffer.byteLength(line);
        if (size + bytes > MAX_BYTES) {
            fs.renameSync(logPath(), `${logPath()}.1`);
            size = 0;
        }
        fs.appendFileSync(logPath(), line, { mode: 0o600 });
        size += bytes;
    } catch {
        // A log that cannot be written must never take the server down.
    }
}

/** Starts copying console output to the log file. Safe to call twice. */
function install() {
    if (installed || !enabled()) return false;
    try {
        fs.mkdirSync(logDir(), { recursive: true });
        size = fs.existsSync(logPath()) ? fs.statSync(logPath()).size : 0;
    } catch {
        return false;
    }
    installed = true;
    for (const [method, level] of Object.entries(LEVELS)) {
        const original = console[method];
        originals[method] = original;
        console[method] = (...args) => {
            original.apply(console, args);
            append(format(level, args));
        };
    }
    // Recorded, not handled: the process still ends the way it would have.
    process.on('uncaughtExceptionMonitor', onFatal);
    return true;
}

// Tests only: puts the console back.
function _uninstallForTests() {
    if (!installed) return;
    for (const method of Object.keys(originals)) console[method] = originals[method];
    process.removeListener('uncaughtExceptionMonitor', onFatal);
    installed = false;
}

/** The last `maxLines` lines of the log (current file, then the previous one). */
function readRecent(maxLines = 200) {
    const wanted = Math.max(1, Math.min(1000, Number(maxLines) || 200));
    const tail = (file) => {
        try {
            const stat = fs.statSync(file);
            const start = Math.max(0, stat.size - TAIL_BYTES);
            const fd = fs.openSync(file, 'r');
            try {
                const buf = Buffer.alloc(stat.size - start);
                fs.readSync(fd, buf, 0, buf.length, start);
                const lines = buf.toString('utf8').split('\n');
                if (start > 0) lines.shift(); // a cut first line
                return lines.filter(Boolean);
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return [];
        }
    };
    let lines = tail(logPath());
    if (lines.length < wanted) lines = [...tail(`${logPath()}.1`), ...lines];
    return lines.slice(-wanted);
}

module.exports = { install, readRecent, redact, enabled, FILE_NAME, MAX_BYTES, _format: format, _uninstallForTests };
