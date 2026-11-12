-- YouTube sign-in through the cloud service (docs/cloud-data.md, "Secrets").
-- The Worker holds the Google client secret and does the sign-in, so no
-- computer needs it. What Google issues to keep the account connected (the
-- refresh token) is stored here, encrypted with a key that is a Worker
-- secret; devices only ever receive short-lived access tokens.
CREATE TABLE google_links (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    refresh_token TEXT NOT NULL,
    scope TEXT,
    connected_at INTEGER NOT NULL
);
