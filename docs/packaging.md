# Packaging the server

The desktop app (Tauri) starts the API server as a sidecar. That server is
built as a **Node single executable application (SEA)**: one file that
contains the Node runtime plus the bundled server code, with no
`node_modules` folder and no Node install needed on the user's machine.

## Building

```bash
npm ci
npm run build:server          # -> bin/music-server-<target-triple>[.exe]
npm run tauri:build           # builds the server, the client, then the app
```

`scripts/build-sea.mjs` does the following:

1. Bundles `server.js` and its dependencies with esbuild into one CommonJS
   file. It's about 2.5 MB.
2. Turns that file into a SEA blob with the running Node
   (`node --experimental-sea-config`).
3. Copies the running Node binary and injects the blob with `postject`. On
   macOS it removes the existing signature first and re-signs ad hoc afterwards.
4. Stages `ffmpeg` and `yt-dlp` next to it as `bin/ffmpeg-<triple>` and
   `bin/yt-dlp-<triple>`, from `FFMPEG_PATH` / `YTDLP_PATH`, `ffmpeg-static` and
   `bin/yt-dlp_*`. If one is missing it prints a warning and skips it.

**A SEA only runs on the OS and CPU it was built on.** Build the macOS
binary on a Mac and the Windows binary on Windows. The release workflow
(`.github/workflows/release.yml`) does both and attaches the files to the
GitHub release. You can also run it by hand from the Actions tab
(`workflow_dispatch`).

Requirements: Node 22.13 or later, because the server uses the built-in
`node:sqlite`.

| Platform | Output |
|---|---|
| macOS, Apple Silicon | `bin/music-server-aarch64-apple-darwin` |
| macOS, Intel | `bin/music-server-x86_64-apple-darwin` |
| Windows x64 | `bin/music-server-x86_64-pc-windows-msvc.exe` |
| Linux x64 (CI only) | `bin/music-server-x86_64-unknown-linux-gnu` |

The `<name>-<triple>` names are what Tauri's `externalBin` expects. Tauri
strips the suffix when it bundles the files, so inside the app they are
`music-server`, `ffmpeg` and `yt-dlp`.

## Where the packaged app keeps its data

A packaged app can't write next to its executable: inside an installed
`.app` that folder is read-only and covered by the code signature. So the
server uses a per-user data folder (`services/paths.js`):

| OS | Data folder |
|---|---|
| macOS | `~/Library/Application Support/Music Manager/` |
| Windows | `%APPDATA%\Music Manager\` |
| Linux | `$XDG_DATA_HOME/music-manager/` (default `~/.local/share/music-manager/`) |

It holds `database.sqlite`, the audio `cache/`, `.token-key` (the encryption
key for stored OAuth tokens), `.jwt-secret` and `bin/yt-dlp`. On first run
the bundled yt-dlp is copied there so `yt-dlp -U` can update it in place.
`MUSIC_DATA_DIR` overrides the location.

In development (`node server.js`) nothing changes: all of these stay in the
project folder, as before.

## Configuration in the packaged app

The server reads `.env` from the working directory, and when packaged also
from the data folder. On first run it creates `JWT_SECRET` and the
token-encryption key itself, so the app starts with no setup. To connect
services, put the credentials in the data folder's `.env`:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SOUNDCLOUD_CLIENT_ID=...       # optional
SOUNDCLOUD_CLIENT_SECRET=...   # optional
```

## Finding ffmpeg and yt-dlp

These are checked in order:

- **ffmpeg:**
  1. `FFMPEG_PATH`
  2. next to the executable (packaged)
  3. `ffmpeg-static` (development)
  4. `/opt/homebrew/bin` or `/usr/local/bin` (macOS)
  5. `/usr/bin` (Linux)
  6. `ffmpeg` on the PATH
- **yt-dlp:**
  1. `YTDLP_PATH`
  2. the data folder's `bin/`
  3. the project's `bin/`
  4. Homebrew (macOS)
  5. `yt-dlp` on the PATH

macOS GUI apps don't inherit the shell's PATH, which is why the Homebrew
locations are listed by name.

`GET /api/health` (requires login) reports which versions were found, and
reports `degraded` when one is missing.

## Signing (not automated yet)

- **macOS:** the build is signed ad hoc, which is enough to run locally.
  Distributing outside your own machine needs a Developer ID signature with
  the hardened runtime and notarisation. Tauri can sign the sidecars as part of
  `tauri build` once signing identities are configured.
- **Windows:** the executable is unsigned. Postject invalidates `node.exe`'s
  original signature, so SmartScreen will warn until it's signed with a code
  signing certificate (`signtool sign`).

## Desktop app (Tauri v2)

`src-tauri/` is a Tauri 2 app:

- `src/main.rs`: system tray, hide-on-close, and the server sidecar, started
  with `tauri-plugin-shell` and killed on exit.
- `capabilities/default.json`: what the web content may call. That is
  `core:default`, opening `https://` URLs (`tauri-plugin-opener`), and
  receiving deep links. There is no shell access.

```bash
npx tauri dev                      # dev window; starts `npm run dev` (server + Vite)
npm run tauri:build                # build the server SEA and client, then the app
```

### Connecting services from the app

In the desktop app, "Connect YouTube" / "Connect SoundCloud":

1. The client requests `/auth/<service>/url?return=app` and opens the consent
   page in the system browser.
2. After consent, the server's callback page hands the result to the app
   through a `musicmanager://oauth#<service>=connected|error` link. The
   browser asks before opening the app.
3. The app receives the link (`tauri-plugin-deep-link`; on Windows/Linux
   `tauri-plugin-single-instance` passes it to the running app) and shows the
   result.

The OAuth redirect URIs registered with Google and SoundCloud don't change:
they still point at `http://localhost:3000/auth/<service>/callback`. The
scheme is registered from the app bundle on macOS and at startup on
Windows/Linux. **macOS deep links only work from the built `.app`, not
`tauri dev`.**

### Dependencies

The Tauri crates are pinned exactly (`=`) in `Cargo.toml`, so a build never
picks up an unreviewed release. `Cargo.lock` also pins `rust-ini` 0.21.1,
because `tauri-plugin-deep-link` 2.6.2 doesn't compile against 0.21.3. Remove
that pin when you bump deep-link.
