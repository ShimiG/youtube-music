# Music Manager

A desktop music player that plays **YouTube** and **SoundCloud**. A React UI runs
inside a **Tauri** desktop window and talks to a local **Node/Express** API, which
resolves audio (YouTube via `yt-dlp`, SoundCloud via its official API), transcodes
it to MP3 with `ffmpeg`, and streams it to the player. Custom playlists and play
history are stored in a local **SQLite** file.

## Architecture

```
┌────────────────────┐      HTTP (localhost:3000)      ┌───────────────────────────┐
│  React client       │  ───────────────────────────▶  │  Express API (server.js)   │
│  (Vite, in Tauri)   │                                 │  routes → controllers      │
└────────────────────┘                                 │  SQLite (database.sqlite)  │
        ▲                                               │  yt-dlp + ffmpeg (stream)  │
        │ native webview + Node sidecar                 └───────────────────────────┘
┌────────────────────┐
│  Tauri shell (Rust) │
└────────────────────┘
```

- **`server.js`** — entry point: loads env, validates it, opens the DB, starts listening.
- **`app.js`** — the single Express app (middleware + routes). Exported so tests import
  the exact app that ships.
- **`controllers/`** — per-endpoint logic. `controllers/transcode.js` is the shared
  ffmpeg pipeline every server-streamed source uses; `controllers/soundcloud/` holds the
  SoundCloud HTTP client (`client.js`) and token persistence (`tokens.js`).
  **`middleware/`** — `requireAuth` (our JWT), `googleToken` (stored Google token) and
  `soundcloudToken` (stored SoundCloud token, refreshed server-side).
  **`config/db.js`** — SQLite schema + indexes.

### Two kinds of login
- **Local account** (username/password): the API issues a signed **JWT** on register/login.
  The client sends it as `Authorization: Bearer <token>` to our own endpoints
  (`/history`, `/api/custom-playlists`). Identity is read from the token, never from a
  client header.
- **Google OAuth token**: used only to call the YouTube Data API on the user's behalf
  (`/search`, `/playlists`). Google validates this token; we pass it through.
- **SoundCloud OAuth 2.1 token** (authorization code + PKCE): stored per user and used
  for `/api/soundcloud/playlists` and likes. Access tokens last about an hour; the
  server renews them with the single-use refresh token, so the client never sees them.
  Public search and stream resolution use one cached app-level (client credentials)
  token in the `app_tokens` table, renewed with its refresh token to stay inside
  SoundCloud's token rate limits.

### SoundCloud without API credentials

Registering a SoundCloud app requires an Artist Pro subscription. Until you have one,
leave `SOUNDCLOUD_CLIENT_ID` / `SECRET` blank and the server routes SoundCloud
**search, playback and duration through yt-dlp** instead (`controllers/soundcloud/ytdlp.js`).
Track ids are the same numeric ids the official API uses, so cache files, history and
custom playlists are interchangeable between the two paths.

`SOUNDCLOUD_PROVIDER` controls this: `auto` (default) prefers the official API when
credentials exist and falls back to yt-dlp when they are missing or when the API returns
a rate limit or server error; `api` and `ytdlp` force one path. Connecting an account
and the SoundCloud tab in the Library always need the official API, because yt-dlp has
no user session. Note that yt-dlp reads SoundCloud's internal web API, which is outside
the API Terms of Use and can break when SoundCloud changes its site.

### yt-dlp self-update

`yt-dlp` breaks whenever YouTube or SoundCloud change their sites, so the server runs
`yt-dlp -U` in the background every time it starts (`services/ytdlp.js`). Startup never
waits on it and a failed update just logs a warning. Set `YTDLP_AUTO_UPDATE=false` to
turn it off (CI and tests do).

## Prerequisites

- **Node.js 20+**
- **Rust + `rustup`** (for the Tauri build)
- A **`yt-dlp` binary** in `bin/` — `bin/yt-dlp_macos` on macOS, `bin/yt-dlp.exe` on Windows.
  (`ffmpeg` is bundled via the `ffmpeg-static` npm package — no separate install.)
- A **Google Cloud** project with the **YouTube Data API v3** enabled and OAuth credentials.
- Optional: a **SoundCloud app** (Client ID + secret) from
  [developers.soundcloud.com](https://developers.soundcloud.com/docs/api/register-app);
  registering one requires an Artist Pro account. Without it the app runs YouTube-only.

## Setup

```bash
npm install
cp .env.example .env      # then fill in the values (see below)
```

Required environment variables (see `.env.example`):

| Variable | Purpose |
|---|---|
| `PORT` | API port (default 3000) |
| `JWT_SECRET` | Secret for signing login tokens — use a long random string |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth credentials |
| `REDIRECT_URI` | Google OAuth callback, e.g. `http://localhost:3000/auth/google/callback` |
| `SOUNDCLOUD_CLIENT_ID` / `SOUNDCLOUD_CLIENT_SECRET` | SoundCloud app credentials (optional; enables SoundCloud) |
| `SOUNDCLOUD_REDIRECT_URI` | SoundCloud OAuth callback registered on the app, default `http://localhost:3000/auth/soundcloud/callback` |
| `SOUNDCLOUD_PROVIDER` | `auto` (default), `api` or `ytdlp`; see "SoundCloud without API credentials" |
| `YTDLP_AUTO_UPDATE` | Run `yt-dlp -U` at server start (default `true`) |
| `CLIENT_ORIGIN` | Allowed browser origin(s), comma-separated (default `http://localhost:5173`) |

The server refuses to start if `JWT_SECRET` is missing.

## Running

```bash
npm run dev          # runs the API (:3000) and the Vite client (:5173) together
npm start            # API only
npm test             # Jest + Supertest against the real app
npm run lint         # ESLint (backend)
```

Desktop dev/build (Tauri):

```bash
npx tauri dev        # native window in development
npm run tauri:build  # standalone desktop app (bundles the pkg-compiled server)
```

## API overview

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/register`, `POST /api/login` | — | Create/log in a local account → returns a JWT |
| `GET /auth/google`, `GET /auth/google/callback` | — | Connect a Google/YouTube account |
| `GET /search?q=` | Google token | Search YouTube |
| `GET /playlists`, `GET /playlists/:id/tracks` | Google token | The user's YouTube playlists |
| `GET /stream?videoId=`, `GET /duration?videoId=` | rate-limited | Audio stream / duration |
| `GET /history`, `POST /history` | JWT | Play history |
| `GET/POST /api/custom-playlists`, `.../:playlistId/tracks` | JWT | Local playlists |

## Notes & known limitations

- **Single-instance by design.** In-memory rate limiting, a local file cache, and local
  SQLite mean this runs as one process (correct for a desktop app; would need Redis/object
  storage/Postgres to scale horizontally as a web service).
- **`pkg` is legacy.** It bundles the server to a Node 18 target and is no longer maintained;
  a future migration to Node's built-in SEA (single executable applications) is advisable.
- **`/stream` is not per-user authenticated** because the browser `<audio>` element cannot
  send an `Authorization` header. It is protected by input validation + rate limiting instead.

## Tech stack

React (Vite) · Tauri (Rust) · Node.js/Express 5 · SQLite (`sqlite`/`sqlite3`) ·
`googleapis` · `yt-dlp` + `ffmpeg-static` · `jsonwebtoken` + `bcryptjs` · Jest/Supertest.
