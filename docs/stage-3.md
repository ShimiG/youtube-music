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

## Done: replace `pkg`

`pkg` is gone. The server now ships as a Node single executable application,
built by `scripts/build-sea.mjs` (`npm run build:server`). It followed the
recommendation here: first drop the native `sqlite3` addon for Node's built-in
`node:sqlite`, then bundle with esbuild and build a SEA. Details, data
locations and signing are in [packaging.md](packaging.md).

## Done: Tauri v2 and deep links

The desktop shell runs on Tauri 2.12. Details are in
[packaging.md](packaging.md#desktop-app-tauri-v2).

- **Same behaviour as before:** tray menu, closing the window hides it,
  and the server sidecar is started and stopped with the app.
- **Fewer permissions for the web content:** no shell or process access. It
  can only open https links in the system browser and receive deep links.
- **Connecting a service in the desktop app:** the consent page opens in the
  system browser. The result comes back through a `musicmanager://oauth` deep
  link (`tauri-plugin-deep-link`; `single-instance` forwards the link on
  Windows/Linux).
  - The return target (web or app) is fixed and signed when the flow starts,
    so it can't be used as an open redirect.
  - The web flow is unchanged.
- **Rust dependency alerts:** `tar` (#34, #35, #79) and the old `rand` (#63)
  are gone, and `serde_with` is updated (#135). `glib` #33 remains: it needs
  glib 0.20, which Tauri's Linux webview stack doesn't support yet, and it
  affects Linux builds only.
- **CI:** a `desktop` job runs `cargo clippy -D warnings` on every PR.

## Decided: DRM gate (option c, no in-app DRM players)

The spike wasn't run. It needs a Spotify Premium account and an Apple Music
subscription, and there are none. Without them the in-app DRM players
(Spotify Web Playback SDK, Tidal Player, Apple MusicKit) can't be used
anyway, so the decision is:

- **(c) Skip client-sdk.** Spotify plays through Spotify Connect (Premium) or
  YouTube match (free). Apple Music and Tidal play through YouTube match.
- Stages 2, 4 and 5 are on hold until there is a subscription; see
  `ROADMAP.md`.
- Revisit if a subscription is added. The first thing worth testing is
  MusicKit JS (FairPlay) in WKWebView on macOS, because Tauri's webviews have
  no Widevine (WKWebView: FairPlay only; WebView2: PlayReady only). In-app
  Spotify/Tidal playback would need a Widevine-enabled Electron shell.

## Security hardening

The Exploiter agent tested `main` (8bf79e4) on 2026-11-08, and the Clogger
agent checked each finding against this branch and wrote the fix plan. Files:
`reports/security/2026-11-08.md` (report), `.fixes.md` (remediation plan),
`.findings.json` (findings with status and resolution).

| Finding | Severity | Resolution on this branch |
|---|---|---|
| SoundCloud `cursor` SSRF leaking the OAuth token | high | Fixed: `buildUrl()` pins the API origin for every input form |
| Production dependency advisories | high | Fixed: `npm audit fix`, CI gate |
| Shared track metadata poisoning across users | medium | Fixed: validated input (https thumbnails only), per-user metadata columns |
| yt-dlp processes orphaned, no timeout | medium | Fixed: 60 s timeout, killed on disconnect, no ffmpeg for a dead request |
| Unauthenticated `/stream` transcode DoS | medium | **Partly mitigated**: at most 2 background transcodes, loopback bind. Open: signed short-lived media token |
| Tauri CSP `null`, broad shell allowlist | medium | Fixed: strict CSP, no `execute`, `open` limited to https |
| OAuth `error` parameter log injection | low | Fixed for SoundCloud; the Google part was a false positive |
| JWT without algorithm pin / expiry | low | Fixed: HS256 pinned, `exp` and session purpose required |
| Session accepted the OAuth `state` JWT | (found during Stage 3) | Fixed: `purpose` must be `session` |

SQL injection, IDOR, path traversal, argument injection, CORS and rate
limiting were attempted and held.

Follow-ups: the signed media token for `/stream` and `/duration`; once
pre-upgrade sessions (7-day TTL) have expired, require `purpose: 'session'` on
every token.
