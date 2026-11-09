// Thin async adapter over Node's built-in SQLite (`node:sqlite`, Node 22.13+).
//
// It keeps the small API the app was written against with the `sqlite` +
// `sqlite3` packages, so no controller changes: get / all / run / exec /
// close, params as an array (or spread), and run() resolving to
// { lastID, changes }. Dropping `sqlite3` removes the app's only native
// addon, which is what lets the server ship as a single executable (see
// scripts/build-sea.mjs).
//
// node:sqlite is synchronous. For this app (one local user, small indexed
// queries) that is fine and avoids sqlite3's threadpool; the methods still
// return promises so callers and test doubles keep working unchanged.

// node:sqlite prints an ExperimentalWarning on first load (Node 22). It is
// expected here and only noise in the logs, so filter exactly that warning.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarning(warning, ...rest) {
    const message = typeof warning === 'string' ? warning : warning && warning.message;
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(message || '')) return;
    return originalEmitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = originalEmitWarning;

// sqlite3 accepted undefined (as NULL) and booleans (as 0/1); node:sqlite throws.
function bindable(value) {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}

function normalizeParams(params) {
    const list = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    return list.map(bindable);
}

// Rows come back with a null prototype; hand callers ordinary objects.
const plain = (row) => (row === undefined ? undefined : { ...row });

class Database {
    constructor(filename) {
        this.raw = new DatabaseSync(filename);
        this.statements = new Map(); // small prepared-statement cache
    }

    prepare(sql) {
        let stmt = this.statements.get(sql);
        if (!stmt) {
            stmt = this.raw.prepare(sql);
            if (this.statements.size >= 200) this.statements.clear();
            this.statements.set(sql, stmt);
        }
        return stmt;
    }

    async get(sql, ...params) {
        return plain(this.prepare(sql).get(...normalizeParams(params)));
    }

    async all(sql, ...params) {
        return this.prepare(sql).all(...normalizeParams(params)).map(plain);
    }

    async run(sql, ...params) {
        const result = this.prepare(sql).run(...normalizeParams(params));
        return { lastID: Number(result.lastInsertRowid), changes: Number(result.changes) };
    }

    async exec(sql) {
        this.raw.exec(sql);
    }

    async close() {
        this.statements.clear();
        this.raw.close();
    }
}

/** Opens (creating if needed) the database file. */
async function open(filename) {
    return new Database(filename);
}

module.exports = { open, Database };
