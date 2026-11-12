-- Music Manager cloud: accounts and the synced records (docs/cloud-data.md).

-- One row per account. The password itself never reaches the cloud: the
-- device stretches it into a key (scrypt) and sends that; what is stored here
-- is a hash of that key (src/auth.ts).
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    auth_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    -- The highest change number handed out for this account (see records.seq).
    last_seq INTEGER NOT NULL DEFAULT 0,
    -- Failed sign-ins in a row, and until when sign-in is refused after too many.
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
);

-- Every synced thing (a playlist, a playlist entry, a history entry, ...) is
-- one record: which collection it belongs to, its id (the same on every
-- device), its content as JSON, and when it last changed on a device.
-- A deleted record stays as a marker (deleted = 1, data NULL) so the deletion
-- reaches the other devices too.
CREATE TABLE records (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    collection TEXT NOT NULL,
    record_id TEXT NOT NULL,
    data TEXT,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    -- The order in which the cloud accepted changes for this account. A device
    -- remembers the last number it has seen and asks for everything after it.
    seq INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    PRIMARY KEY (user_id, collection, record_id)
);

-- "Everything after change N for this account" must read only those rows:
-- D1 bills and limits by rows scanned, not rows returned.
CREATE INDEX idx_records_user_seq ON records (user_id, seq);
