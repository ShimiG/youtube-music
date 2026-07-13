# Music Manager

A desktop music player that uses **YouTube as its audio source**. A React UI runs
inside a **Tauri** desktop window and talks to a local **Node/Express** API, which
resolves audio with `yt-dlp`, transcodes it to MP3 with `ffmpeg`, and streams it to
the player. Custom playlists and play history are stored in a local **SQLite** file.

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
- **`controllers/`** — per-endpoint logic. **`middleware/`** — `requireAuth` (our JWT) and
  `googleToken` (Google OAuth pass-through). **`config/db.js`** — SQLite schema + indexes.

### Two kinds of login
- **Local account** (username/password): the API issues a signed **JWT** on register/login.
  The client sends it as `Authorization: Bearer <token>` to our own endpoints
  (`/history`, `/api/custom-playlists`). Identity is read from the token, never from a
  client header.
- **Google OAuth token**: used only to call the YouTube Data API on the user's behalf
  (`/search`, `/playlists`). Google validates this token; we pass it through.

## Prerequisites

- **Node.js 20+**
- **Rust + `rustup`** (for the Tauri build)
- A **`yt-dlp` binary** in `bin/` — `bin/yt-dlp_macos` on macOS, `bin/yt-dlp.exe` on Windows.
  (`ffmpeg` is bundled via the `ffmpeg-static` npm package — no separate install.)
- A **Google Cloud** project with the **YouTube Data API v3** enabled and OAuth credentials.

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
| `REDIRECT_URI` | OAuth callback, e.g. `http://localhost:3000/auth/google/callback` |
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
