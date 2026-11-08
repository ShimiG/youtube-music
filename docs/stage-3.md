# Stage 3: Stabilise and improve the build

Status of every Stage 3 item from `ROADMAP.md`, what shipped on the
`stage-3-stabilise` branch, and the decisions that still need a Mac or Windows
machine.

## Shipped

| Roadmap item | What changed | Where |
|---|---|---|
| Generic token refresh, auto-logout only when refresh fails | `getSourceToken(db, userId, source)` renews any OAuth source server-side, single-flight per user. YouTube now uses its Google refresh token (it used to force a logout after ~1 h). The client auto-logs-out only for connections with no refresh token. | `services/connections.js`, `middleware/sourceToken.js`, `client/src/App.jsx` |
| yt-dlp self-update, health reports binary versions | Self-update shipped with Stage 1. New `GET /api/health` (login required) reports app, Node, yt-dlp and ffmpeg versions, cache usage, and `degraded` when a binary is missing. | `services/health.js` |
| Cache: size-based eviction, source-prefixed keys | 500 MB cap (`CACHE_MAX_BYTES`), least recently played evicted first. Keys are `youtube_<id>` / `soundcloud_<id>`; legacy files are renamed and stale `.part` files removed at startup. | `controllers/transcode.js` |
| Cache: negative-match TTL | Not applicable yet: it belongs to the Stage 2 match engine, which was skipped. | n/a |
| Encrypt tokens at rest | AES-256-GCM for every access/refresh token in `user_connections` and `app_tokens`. Key from `TOKEN_ENCRYPTION_KEY` or a generated owner-only `.token-key`. Existing rows are migrated at startup. | `services/tokenCrypto.js` |
| Real CSP in `tauri.conf.json` | Strict CSP (scripts from the app only; media and fetch only to the local API). `shell.execute` removed, `shell.open` limited to `https://`. | `src-tauri/tauri.conf.json` |
| Unified error codes and client toasts | `SOURCE_NOT_CONNECTED`, `SOURCE_TOKEN_EXPIRED`, `TRACK_UNAVAILABLE`, `SOURCE_TIER_REQUIRED`, always with `source`. Client toasts; an unplayable track skips to the next one. | `services/errors.js`, `client/src/utils/errors.js`, `client/src/components/Toaster.jsx` |
| Tests and CI | Backend tested on Linux, macOS and Windows; client lint and build; production `npm audit` gate. | `.github/workflows/ci.yml` |
| Security findings | Exploiter and Clogger reports for this stage are in `reports/security/`; fixes are listed in the "Security hardening" section below. | `reports/security/` |

Matcher golden-set tests wait for Stage 2.

## Open: replace `pkg`

`pkg` is archived and its newest target is Node 18 (end of life). The server
bundles two things that make a single-file build hard: the native `sqlite3`
addon and the `ffmpeg-static` binary.

Options:

1. **Node single executable application (SEA).** Needs the app bundled into one
   script (esbuild) and cannot embed native addons, so `sqlite3` would have to
   ship next to the binary and be loaded with `process.dlopen`.
2. **Tauri-managed Node sidecar.** Ship the official Node binary per target as
   the sidecar and the server folder as a bundle resource; run `node server.js`.
   No bundling, about 40 MB per architecture.
3. **Drop the native addon first.** Node 22.13+ ships `node:sqlite` without a
   flag. Moving `config/db.js` and the query helpers to it removes the only
   native addon, after which option 1 is a clean esbuild + SEA build.

Recommendation: do 3, then 1, in a follow-up branch. Each step can be checked
by the CI matrix that now runs on macOS and Windows. Keep `pkg` until the SEA
build has been run on both platforms.

## Open: Tauri v2 and deep links

Tauri v1 is in maintenance. v2 brings `tauri-plugin-deep-link`, so OAuth
callbacks can land in the app (`musicmanager://callback`) instead of a
localhost redirect.

- Google's desktop OAuth flow uses loopback redirects, which already work.
  Deep links matter for SoundCloud and Spotify, whose app settings can register
  a custom scheme.
- The migration touches the config schema (allowlist becomes capabilities),
  the system tray API and the shell plugin. The CSP and the narrowed shell
  permissions from this stage carry over directly as v2 capabilities.

Recommendation: migrate in its own branch before Stage 4. Apple's MusicKit
flow is the first that benefits.

## Open: DRM decision gate (needs a spike on real machines)

This cannot be run from a Linux container. What is known in advance:

- **Spotify Web Playback SDK** and **Tidal Player** need Widevine.
- **WKWebView (macOS)** has no Widevine; it supports FairPlay only.
- **WebView2 (Windows)** supports PlayReady, not Widevine.

So the expected result is that client-sdk playback does not work in either
Tauri webview. MusicKit JS (FairPlay) in WKWebView is the only candidate worth
testing.

Spike checklist (about half a day):

1. In the Tauri dev build on Windows and macOS, load the Spotify Web Playback
   SDK with a Premium test account and record whether `ready` fires and audio
   plays.
2. On macOS, run MusicKit JS `authorize()` and play one catalog track in
   WKWebView.
3. Record the outcome here and pick one option:
   - (a) client-sdk on the platforms where the spike passed;
   - (b) move the shell to a Widevine-enabled Electron build (for example
     Castlabs ECS, which needs VMP signing);
   - (c) skip client-sdk and rely on remote (Spotify Connect) plus match.

Provisional recommendation: **(c)**, with MusicKit on macOS as an exception
only if step 2 passes. Stages 4 and 5 already fall back to match.

## Security hardening

See `reports/security/` for the Exploiter report, the Clogger remediation plan
and the findings file. The fixes applied on this branch are listed in the
commit history under "Stage 3 security".
