# Running Music Manager on Render

Music Manager is a desktop app, but its server and web client can also run
as one website on [Render](https://render.com). `render.yaml` in the
repository describes the service; this page says how to set it up, and what
does and does not work on a host.

## What runs there

One web service: `node server.js`, which also serves the built web client
from the same address (so the client calls the API with addresses on its own
site). The build installs the server and the client, builds the client, and
fetches yt-dlp (its folder build, checked against the release's checksums).
ffmpeg comes from the `ffmpeg-static` package.

Data (the database and the audio cache) is kept in `./data`, which Render
empties on every deploy and restart (the free plan has no disk). Nothing is
lost by that: playlists, recently played and connected services belong to the
cloud account (`cloud/`) and come back at sign-in. The audio cache starts
empty after each restart.

## Set it up

### A. Use the existing service (the one already connected to the repository)

In the Render dashboard, open the service, then **Settings**:

- **Build Command**:

  ```
  npm ci && npm ci --prefix client && VITE_API_BASE= npm run build --prefix client && MUSIC_DATA_DIR=./data node scripts/fetch-ytdlp.js
  ```

- **Start Command**: `node server.js`
- **Health Check Path**: `/api/cloud/info`

Then **Environment**, add:

| Key | Value |
|---|---|
| `NODE_VERSION` | `22` |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `SERVE_CLIENT` | `1` |
| `TRUST_PROXY` | `1` |
| `LOCAL_FILES` | `off` |
| `MUSIC_DATA_DIR` | `./data` |
| `CLOUD_URL` | your Worker's address, e.g. `https://music-manager-cloud.<you>.workers.dev` |

Save, then **Manual Deploy → Deploy latest commit**.

### B. Or start over from the blueprint

Dashboard → **New → Blueprint**, pick this repository. Render reads
`render.yaml` and asks only for `CLOUD_URL`.

## Sign-in and connecting services

- **Signing in** uses the cloud account, as on a computer: the Worker must be
  deployed and `CLOUD_URL` set.
- **Connecting YouTube or SoundCloud** from the website: the Worker sends the
  browser back only to places it knows. Add the site's address to the Worker,
  from `cloud/`:

  ```bash
  npx wrangler secret put WEB_ORIGINS
  ```

  and give it `https://<your-service>.onrender.com` (several sites: separate
  them with commas). A connection made on a computer works on the website
  too, and the other way round: it belongs to the account.

## What does not work on a host

- **YouTube may refuse to play.** YouTube often refuses audio to the
  addresses of data centres ("Sign in to confirm you're not a bot"), and
  Render's servers are in data centres. Search, playlists and the library
  work; playback from YouTube may not. SoundCloud, Audius and Deezer
  previews are less strict. Nothing in the app can change where the server
  is.
- **Local Files** is switched off (`LOCAL_FILES=off`): a website has no
  access to its visitors' music folders.
- **The free plan sleeps** after 15 minutes without visits; the next visit
  waits about a minute while it starts.
- **The audio cache does not last**: it starts empty after every deploy or
  restart, so the first play of each track is a fresh download.

## Settings that only matter on a host

All in `services/hosting.js`:

- `SERVE_CLIENT=1`: serve `client/dist` from `/` (or `SERVE_CLIENT=<folder>`).
  The client must be built with `VITE_API_BASE=` (empty), which makes it call
  the API on its own site; without it, the client calls `http://localhost:3000`
  as the desktop app does.
- `PUBLIC_URL`: the site's address. On Render it is taken from
  `RENDER_EXTERNAL_URL`, which Render sets, so there is nothing to set.
- `TRUST_PROXY=1`: one proxy sits in front, so rate limits count each visitor.
- `LOCAL_FILES=off`: no Local Files.
