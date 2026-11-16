-- SoundCloud through the cloud service (docs/cloud-data.md, "Secrets").
-- The Worker holds SoundCloud's client secret, as it holds Google's, so no
-- computer needs it. Two kinds of token are kept, both encrypted with a key
-- that is a Worker secret:
--
--   soundcloud_links   one row per account that connected its SoundCloud
--                      login (for the library: playlists, likes).
--   service_tokens     one row per service for the token that belongs to the
--                      installation as a whole (SoundCloud's "app" token, used
--                      for search and for playing public tracks).
--
-- SoundCloud's refresh tokens work once: each renewal replaces the row's
-- tokens, and devices only ever receive short-lived access tokens.
CREATE TABLE soundcloud_links (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER NOT NULL,
    connected_at INTEGER NOT NULL
);

CREATE TABLE service_tokens (
    service TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER NOT NULL
);
