# Music Manager

A desktop music player that plays **YouTube**, **SoundCloud**, **Audius**, **Deezer** and
**music files on your computer** (MP3, M4A, FLAC, WAV, OGG, Opus…). A React UI runs
inside a **Tauri** desktop window and talks to a local **Node/Express** API, which
resolves audio (YouTube via `yt-dlp`, SoundCloud via its official API, Audius via its
open API, no account needed; Deezer tracks through a YouTube match, or Deezer's 30 s
preview), transcodes
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
- **`providers/`** — one file per music source (`youtube.js`, `soundcloud.js`,
  `custom.js`) behind a single interface, registered in `providers/index.js`. Every
  provider returns the same normalised `Playlist` and `Track` shapes and pages with an
  opaque cursor, so the routes and the client never learn service details.
- **`controllers/libraryController.js`** — the generic library API (see below).
- **`controllers/`** — per-endpoint logic. `controllers/transcode.js` is the shared
  ffmpeg pipeline every server-streamed source uses; `controllers/soundcloud/` holds the
  SoundCloud HTTP client (`client.js`) and token persistence (`tokens.js`).
  **`middleware/`** — `requireAuth` (our JWT), `requireExistingUser`, and
  `sourceToken` (attaches the user's stored token for any `:source`, or answers
  `SOURCE_NOT_CONNECTED` / `SOURCE_TOKEN_EXPIRED`; tokens come decrypted and
  refreshed from `services/connections.js`). The legacy alias routes use it too.
  **`config/db.js`** — SQLite schema + indexes (Node's built-in `node:sqlite`).

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

## Library API (one shape for every source)

| Route | Returns |
|---|---|
| `GET /api/sources` | every source: label, capabilities, whether it needs / can be connected, and whether this user has connected it |
| `GET /api/library/:source/playlists?cursor=` | `{ items: Playlist[], nextCursor }`; the virtual `liked` playlist is pinned first when the source supports it |
| `GET /api/library/:source/playlists/:id/tracks?cursor=` | `{ items: Track[], nextCursor, matching? }`; `:id` = `liked` lists liked songs |
| `POST /api/library/:source/liked` `{ trackId }` / `DELETE /api/library/:source/liked/:id` | like / unlike where the source supports it |
| `GET /api/search/:source?q=&cursor=` | `{ items: Track[], nextCursor, matching? }` |

Track lists that hold tracks of a match-mode source (Spotify) drop the ones without a
confirmed YouTube match and add `matching` (see "Matching engine" below).

Shapes: `Playlist { source, id, kind: 'liked' | 'playlist' | 'custom', name, thumbnail, itemCount, readOnly }`
and `Track { source, id, title, artist, album, durationSec, thumbnail, isrc, preview }`.
Errors carry `code` (`SOURCE_NOT_CONNECTED`, `SOURCE_TOKEN_EXPIRED`, `SOURCE_SCOPE_REQUIRED`,
`SOURCE_NOT_FOUND`, `SOURCE_NOT_SUPPORTED`, `SOURCE_RATE_LIMITED`, `SOURCE_NOT_CONFIGURED`)
and `source`, so the client shows one panel for every service.

Adding a service: `providers/<name>.js` implementing the interface, one row in
`sources`, and one entry in `client/src/utils/services.js`. Nothing else changes.

## Matching engine (match-mode sources)

Spotify (later Apple Music, Tidal and Deezer) gives us a catalog and a library but no
audio we can fetch. Tracks from these **match-mode sources** are matched to a YouTube
video *before* they are streamed, and playback then runs through the normal YouTube path.
The engine lives in `services/matcher/` (`normalize.js`, `score.js`, `innertube.js`,
`ytsearch.js`, `index.js`); the HTTP side is `controllers/matchController.js` and
`controllers/matchedStream.js`.

The rules, as the product owner set them:

- **Only official sources count.** YouTube Music classifies every search result itself:
  catalog audio (`MUSIC_VIDEO_TYPE_ATV`, the auto-generated "<Artist> - Topic" uploads) and
  official music videos (`MUSIC_VIDEO_TYPE_OMV`) are accepted; user-generated content
  (`UGC`: fan uploads, lyric channels, covers, re-uploads, compilations) never is, even from
  a verified channel. The yt-dlp fallback has no such field, so there only "<Artist> - Topic"
  channels and verified channels whose name is the track's artist are accepted.
- **The title must match exactly** after normalisation (`services/matcher/normalize.js`):
  case, punctuation, diacritics and `&`/`and` are ignored; noise such as "(Official Audio)",
  "(Remastered 2011)" or "[Lyrics]" is stripped; anything that changes the recording (live,
  acoustic, radio edit, a named remix, sped up, cover, karaoke, ...) has to appear on both
  sides, so a radio edit never stands in for the album version. The artist must match too,
  and the duration must be within `MATCH_DURATION_TOLERANCE_SEC` (default 5 s).
- **Unmatched tracks are hidden.** Every track list (`/api/library/:source/playlists/:id/tracks`
  and `/api/search/:source`, including custom playlists that mix sources) drops match-mode
  tracks without a confirmed match and adds `matching: { total, matched, hidden, pending, errors }`.
  Matched tracks carry `youtubeId` and `match: { status, score, method }`. `nextCursor` is
  untouched, so a page may come back shorter than usual.
- **A user can report a wrong match** (`POST /api/match/report`). The button for it ships
  with the Spotify provider.

A `track_matches` row has one of three statuses: `matched` (final, also for manual
overrides), `not_found` (no acceptable candidate; the track is searched again after
`MATCH_NOT_FOUND_TTL_MS`) or `error` (the search itself failed; retried after
`MATCH_ERROR_TTL_MS`). A resolution that is still running when a request's budget
(`MATCH_REQUEST_BUDGET_MS`) runs out is reported as `pending` and finishes in the background.

A track whose provider supplies an ISRC can reuse the match of another track with the
same ISRC (Spotify and Tidal share them) instead of searching, but only from a row that
was itself a direct search result or a manual choice, and only when the matched video's
recorded length agrees with the track's. The `isrc` field is never taken from the HTTP
client (see below): it is a cross-track identity key, so accepting it from a browser would
let one caller attach any video to any other track.

When YouTube Music answers 429 or 403, the engine backs off for `Retry-After` (60 s when
the header is missing): during that window no YouTube Music search is made, the yt-dlp
fallback does not run either (a rate limit is not an outage), and every match-mode track
that needs a search is recorded as `error` and retried after `MATCH_ERROR_TTL_MS`.

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/match/:source/:id` | JWT | the stored match: `{ source, id, status, videoId, score, method, candidates, checkedAt, manual }`, or 404 `MATCH_NOT_FOUND` |
| `POST /api/match/resolve` `{ tracks: Track[] }` | JWT, 120 req / 15 min per IP | resolve 1-100 tracks (`source`, `id`, `title` required; `artist`/`artists`, `durationSec`, `album` optional; a client `isrc` is ignored) → `{ results: { "<source>:<id>": { status, videoId, score, method } }, summary }` |
| `POST /api/match/override` `{ source, id, videoId }` | JWT (existing user) | pin a YouTube video for a track; automatic resolution never overwrites it |
| `POST /api/match/report` `{ source, id, reason, videoId?, note? }` | JWT (existing user) | `reason` is `wrong_match`, `unavailable` or `other`; a `videoId` also sets the override, `unavailable` also hides the track |
| `DELETE /api/match/:source/:id` | JWT | forget the row so the next read resolves again |
| `GET /stream?source=spotify&videoId=<spotify id>&t=`, `GET /duration?...` | media token, rate-limited | play the matched video; 404 `MATCH_REQUIRED` (call resolve first), 404 `TRACK_UNAVAILABLE`, 503 `MATCH_PENDING` |

Validation errors are 400 `MATCH_BAD_REQUEST`; a source that is not in match mode is 400
`MATCH_BAD_SOURCE` (the name is not echoed); a valid token for a deleted account is 401
`USER_NOT_FOUND` on override and report. The cache key of a matched stream is the
YouTube id, so a Spotify play and a YouTube play of the same video share one cache file.

**Caveat.** The primary candidate source is the YouTube Music search
(`services/matcher/innertube.js`): an internal endpoint of the music.youtube.com web app,
the same kind of endpoint yt-dlp reads, not a public or documented API. It answers in well
under a second and carries YouTube's own official/UGC classification, which is why it is
used, but it can change without notice and may need maintenance when it does. When that
search fails, the yt-dlp `ytsearch` fallback (`services/matcher/ytsearch.js`, about 10 s
per query on the dev machine) takes over; `MATCH_YTDLP_FALLBACK=off` disables it, and
`MATCH_YTDLP_RECALL=true` also runs it when YouTube Music found no acceptable candidate.

## Prerequisites

- **Node.js 22.13+** (the database is Node's built-in `node:sqlite`)
- **Rust + `rustup`** (for the Tauri build)
- A **`yt-dlp` binary** in `bin/` — `bin/yt-dlp_macos` on macOS, `bin/yt-dlp.exe` on Windows
  (or `yt-dlp` on the PATH, e.g. `brew install yt-dlp`; `YTDLP_PATH` overrides).
- **ffmpeg** comes from the `ffmpeg-static` npm package. If its download fails during
  `npm install`, a system ffmpeg is used instead (`brew install ffmpeg`; `FFMPEG_PATH` overrides).
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
| `JWT_SECRET` | Secret for signing login tokens. Optional: when it is not set, one is generated once and kept in the data folder |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth credentials. Can be entered in the app instead (Settings → Accounts); a value set here wins |
| `REDIRECT_URI` | Google OAuth callback, e.g. `http://localhost:3000/auth/google/callback` |
| `SOUNDCLOUD_CLIENT_ID` / `SOUNDCLOUD_CLIENT_SECRET` | SoundCloud app credentials (optional; adds the SoundCloud library). Also enterable under Settings → Accounts |
| `LOG_FILE` | `off` stops the server writing `logs/server.log` (default: on) |
| `SOUNDCLOUD_REDIRECT_URI` | SoundCloud OAuth callback registered on the app, default `http://localhost:3000/auth/soundcloud/callback` |
| `SOUNDCLOUD_PROVIDER` | `auto` (default), `api` or `ytdlp`; see "SoundCloud without API credentials" |
| `YTDLP_AUTO_UPDATE` | Run `yt-dlp -U` at server start (default `true`) |
| `CLIENT_ORIGIN` | Allowed browser origin(s), comma-separated (default `http://localhost:5173`) |
| `MATCH_DURATION_TOLERANCE_SEC` | Largest duration difference, in seconds, between a track and its YouTube match (default `5`) |
| `MATCH_CONCURRENCY` | Concurrent YouTube Music searches (default `4`); the yt-dlp fallback always runs one at a time |
| `MATCH_REQUEST_BUDGET_MS` | How long a library or resolve request waits for matches before reporting the rest as `pending` (default `25000`) |
| `MATCH_NOT_FOUND_TTL_MS` | How long a `not_found` result is trusted before the track is searched again (default `2592000000`, 30 days) |
| `MATCH_ERROR_TTL_MS` | How long a failed search is remembered before it is retried (default `600000`, 10 min) |
| `MATCH_YTDLP_FALLBACK` | `on` (default) runs yt-dlp `ytsearch` when the YouTube Music search fails; `off` disables it |
| `MATCH_YTDLP_RECALL` | `true` also runs yt-dlp when YouTube Music found no acceptable candidate (default `false`; slow) |

No `.env` is needed to start: every value has a default or can be set in the app. Data
(database, cache, log, generated secrets) lives in the per-user data folder, not in the
project folder; see [docs/packaging.md](docs/packaging.md). The `MATCH_*` variables all have
defaults; see "Matching engine".

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
npm run build:server  # the API server as a single executable: bin/music-server-<triple>
npm run tauri:build   # standalone desktop app (bundles that executable, ffmpeg and yt-dlp)
```

The packaged app keeps its data in the per-user app-data folder, not the project folder;
see [docs/packaging.md](docs/packaging.md).

## API overview

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/register`, `POST /api/login` | — | Create/log in a local account → returns a JWT |
| `GET /auth/google`, `GET /auth/google/callback` | — | Connect a Google/YouTube account |
| `GET /search?q=` | Google token | Search YouTube |
| `GET /playlists`, `GET /playlists/:id/tracks` | Google token | The user's YouTube playlists |
| `GET /api/media/token` | JWT | Short-lived media token for the two routes below |
| `GET /stream?videoId=&source=&t=`, `GET /duration?videoId=&source=&t=` | media token (`t`), rate-limited | Audio stream / duration; `source=spotify` plays the matched YouTube video. `&seek=N` starts at N seconds; `&prepare=1` gets the track ready in the disk cache without playing it |
| `GET/DELETE /api/match/:source/:id`, `POST /api/match/resolve`, `.../override`, `.../report` | JWT | Match engine (see "Matching engine") |
| `GET /api/cloud/status`, `PUT`/`DELETE /api/cloud/url`, `POST`/`DELETE /api/cloud/link`, `POST /api/cloud/sync` | JWT; address: owner only | Cloud sync: where the service is, linking this computer, syncing now |
| `GET /api/settings/services`, `PUT`/`DELETE /api/settings/services/:source` | JWT; changes: owner only | Service credentials entered in the app (never returned) |
| `DELETE /api/user/connections/youtube`, `.../soundcloud` | JWT | Disconnect a service account |
| `GET /api/health`, `GET /api/system/log` | JWT; log: owner only | yt-dlp / ffmpeg versions and cache use; the end of the server log |
| `GET /api/lyrics?source=&id=&title=&artist=&duration=&online=1` | JWT, rate-limited | Lyrics for the playing track (see below) |
| `GET /api/artwork/colors?url=` | JWT, rate-limited | Theme colours from a cover image (see below) |
| `GET /history`, `POST /history` | JWT | Play history |
| `GET/POST /api/custom-playlists`, `.../:playlistId/tracks` | JWT | Local playlists |

## Notes & known limitations

- **Cloud sync.** [`cloud/`](cloud/README.md) is a Cloudflare Worker with a D1 database,
  deployed to your own free Cloudflare account. Under Settings → Accounts → Cloud sync you
  point the app at it and sign in; your custom playlists and history are then the same on
  every computer signed in to that account. Reads stay local, so nothing gets slower and
  the app works offline; sync runs in the background. Design:
  [docs/cloud-data.md](docs/cloud-data.md). `CLOUD_URL` in the environment sets the
  address for everyone on the installation.
- **Accounts and the owner.** Settings → Accounts connects and disconnects services and holds
  this installation's own service credentials (encrypted in the database, applied without
  a restart). The first account created on an installation is its owner: only it can change
  those credentials or read the server log.
- **When nothing plays.** Settings → System shows whether `yt-dlp` and `ffmpeg` were found.
  The server keeps its output in `logs/server.log` (in the project folder when run from
  source, in the data folder when installed), rotated at 1 MB, with URL query strings and
  tokens cut; the System section can copy its last lines.
- **Colours from the cover art.** The player bar and the Now Playing view take their colours
  from the playing track's cover (Settings → Appearance turns this off). The server reads
  the image, since a web page may not read another site's pixels, and only fetches plain
  `https` URLs on public addresses; see the header of `services/artworkColors.js`.
- **Lyrics.** For your own files, lyrics come from a `.lrc` file with the same name next to
  the track, or from the file's tags, and nothing is sent anywhere. For everything else the
  app can look lyrics up on [LRCLIB](https://lrclib.net) (free, open, no API key). A lookup
  sends the playing track's title, artist and length, so the app asks before the first one
  and the choice can be changed in Settings; `LYRICS_ONLINE=off` in `.env` turns online
  lookups off entirely, and `LRCLIB_URL` points at a self-hosted instance.

- **Single-instance by design.** In-memory rate limiting, a local file cache, and local
  SQLite mean this runs as one process (correct for a desktop app; would need Redis/object
  storage/Postgres to scale horizontally as a web service).
- **Packaging.** The server ships as a Node single executable (SEA), built per platform; see
  [docs/packaging.md](docs/packaging.md). It replaced `pkg` (abandoned, Node 18 only).
- **`/stream` and `/duration` take a media token in the URL** (`t`), because the browser
  `<audio>` element cannot send an `Authorization` header. The logged-in client gets the
  token from `GET /api/media/token` (valid 6 hours, renewed automatically); it only works
  on these two routes and never as a login. The server also runs at most 6 transcodes at once.

## Tech stack

React (Vite) · Tauri (Rust) · Node.js 22/Express 5 · SQLite (`node:sqlite`) ·
`@googleapis/youtube` · `yt-dlp` + `ffmpeg-static` · `jsonwebtoken` + `bcryptjs` ·
esbuild + Node SEA (packaging) · Jest/Supertest.
