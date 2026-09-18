# Music Manager: Product Discovery Report

Date: 2026-09-07
Repository: `/Users/shimi-g/Developer/Code` (branch `google-login-db-tokens`, HEAD `de67f19`)
Author: product-discovery agent (Claude Code)

## 1. Summary

- Music Manager is a Tauri + React + Express desktop player that streams YouTube audio through yt-dlp and ffmpeg. Playback, queue, shuffle, history and Google-connected YouTube playlists work. Three shipped-looking features are not finished: custom playlists have an API but no create or add UI, the Repeat button has no handler, and the YouTube likes code is not routed.
- Two platform changes from the last year make the current design fragile for anyone but the author. YouTube search is bound to a project-wide cap of 100 `search.list` calls per day, and yt-dlp has required an external JavaScript runtime since 2025.11.12 while the app never passes `--js-runtimes` and bundles no runtime.
- The biggest daily irritant is self-inflicted: Google access tokens expire after about an hour and `App.jsx` logs the user out at expiry, even though a refresh token is already stored in `user_connections` and never used.
- Every comparable (Pear Desktop, Spotube, Nuclear, ytmdesktop2, Feishin) ships full playlist and queue basics, quota-free search, and most ship synced lyrics and scrobbling via free APIs (LRCLIB needs no key; ListenBrainz needs only a user token). Music Manager's differentiators, one local account holding tokens server-side and a planned cross-service match engine with "Wrong match?", are sound and should be kept.
- Recommended next six weeks, in order: token auto-refresh (S), finish custom playlists (M), quota-free search via yt-dlp (M), repeat and queue persistence (S), API client consolidation (S), bundled JS runtime for yt-dlp (M). Spotify's February 2026 Development Mode cap (5 users, Premium-holding owner) means ROADMAP Stage 2 should lead with the matcher and file-based playlist import, not Spotify OAuth.

## 2. Assumptions

Inputs not given in the prompt were inferred from the repository.

- **Product goal**: a free, open-source desktop player for personal use that plays via YouTube today and grows into "connect any streaming service" (README, ROADMAP.md). Not a hosted web service.
- **Target users**: the author plus a small circle of hobbyist users, each running their own instance with their own Google Cloud project, or sharing the author's project. The quota and OAuth findings below assume a shared project; if every user creates their own project, the search quota finding is less severe but onboarding is far harder.
- **Constraints**: solo maintainer; no budget for paid API tiers; stack fixed to React 19 + Vite, Express 5, SQLite, Tauri v1, yt-dlp + ffmpeg-static; macOS and Windows targets; no telemetry today, so all metrics below need an opt-in local event log first.
- **OAuth publishing status**: assumed "Testing" (typical for a hobby project). If the consent screen is already "In production", the 7-day refresh expiry point in item 1 does not apply; the 1-hour auto-logout still does.
- **Scope hint**: none given, so the whole product was reviewed with emphasis on things ROADMAP.md does not already plan.
- `.env` was not read. Secrets and the actual Google project configuration are unknown.

## 3. Current feature inventory

| Capability | Implementation | State |
|---|---|---|
| Local account register/login (JWT 7d, bcrypt cost 12, auth rate limit) | `controllers/UserController.js`, `AuthScreen.jsx` | Shipped |
| Google OAuth connect; tokens stored per user in SQLite; state JWT ties callback to user | `controllers/authController.js`, `client/src/utils/googleAuth.js` | Shipped |
| Connect-services banner | `client/src/components/ConnectServices.jsx` | Shipped, uncommitted |
| Auto-logout when Google token expires (~1 h) | `client/src/App.jsx` | Shipped; UX liability |
| Google token refresh using stored `refresh_token` | none | Missing (column populated, never read) |
| YouTube search (`search.list` + `videos.list`, 30 results, no paging) | `controllers/searchController.js`, `SearchView.jsx` | Shipped; quota-bound |
| YouTube playlists and tracks (max 50, no `pageToken`) | `controllers/playlistController.js`, `LibraryView.jsx` | Partial |
| YouTube liked songs and like action | `playlistController.getYouTubeLikes`, `likeVideo` | Stubbed (not routed in `app.js`; planned in ROADMAP Stage 0) |
| Audio stream: yt-dlp `-g` then ffmpeg 128 kbps MP3, chunked; disk cache max 50 files; `.part` cleanup; 10 min transcode cap | `controllers/YouTubeController.js` | Shipped |
| Seek by re-requesting `?seek=` when outside buffer | `MusicContext.jsx` | Shipped |
| Duration lookup with in-memory cache | `YouTubeController.getDuration` | Shipped |
| Queue: add, remove, jump, preload next | `MusicContext.jsx`, `Queue.jsx` | Shipped; no reorder, play-next, or persistence |
| Shuffle with restore of original order | `MusicContext.jsx` | Shipped |
| Repeat | `PlayerFooter.jsx` | Stubbed (button, no handler, opacity 0.5) |
| Volume and mute | `MusicContext.jsx`, `PlayerFooter.jsx` | Shipped |
| OS media keys and now-playing metadata (MediaSession) | `MusicContext.jsx` | Shipped |
| Recently played (50 most recent, de-duplicated) | `controllers/historyController.js`, `HistoryView.jsx` | Shipped |
| Custom playlists: list and view tracks | `playlistController.js`, `LibraryView.jsx` | Shipped (read side) |
| Create custom playlist UI | `LibraryView.jsx` | Stubbed (`console.log("Open Create Modal")`) |
| Add track to custom playlist UI | none | Missing (API `POST /api/custom-playlists/:id/tracks` exists, no client caller) |
| Rename or delete playlist; remove or reorder track | none | Missing (no API; `sort_order` always 0) |
| System tray, hide on close, Node sidecar lifecycle | `src-tauri/src/main.rs` | Shipped |
| Settings screen | none | Missing |
| Backend tests (Supertest, mocked DB) | `tests/` | Shipped; no client tests |
| CI: backend lint and test, client lint and build, smoke boot | `.github/workflows/ci.yml` | Shipped |
| Release: Windows `pkg` exe only, no Tauri bundle | `.github/workflows/release.yml` | Partial |
| Multi-service providers (SoundCloud, Spotify, Apple, Tidal, open sources) | `ROADMAP.md` | Planned |

Architectural facts that constrain features:

- Single process by design: in-memory rate limiter, local disk cache, local SQLite.
- Tauri v1 with `csp: null`; Node sidecar built by deprecated `pkg` targeting Node 18.
- `/stream` and `/duration` are unauthenticated (rate-limited) because `<audio>` cannot send headers.
- The client hardcodes `http://localhost:3000` in 15 places; `PORT` is configurable on the server only.
- YouTube Data API: 100 `search.list` calls per day and 10,000 units per day per project.
- yt-dlp on this machine is 2026.01.31 and resolves YouTube only because Homebrew Deno is present; nothing in the app guarantees a runtime on a user's machine.

## 4. Gap analysis

Comparables: Pear Desktop (formerly th-ch/youtube-music; Electron; 33.4k stars), Spotube (Flutter; Spotify metadata over YouTube audio), Nuclear (React + Rust + Tauri; multi-source), ytmdesktop2 (Electron; YouTube Music wrapper), Feishin (Electron; Navidrome/Jellyfin/Subsonic client). Soundiiz and TuneMyMusic are referenced for transfer features only.

| Capability | Music Manager | Pear Desktop | Spotube | Nuclear | ytmdesktop2 | Feishin |
|---|---|---|---|---|---|---|
| Audio source | YouTube via yt-dlp | Embedded YT Music web | YouTube, Piped, Invidious, JioSaavn | YouTube, SoundCloud, Jamendo, Audius | Embedded YT Music web | Self-hosted server |
| Search without Data API quota | No | Yes (embedded web) | Yes | Yes | Yes (embedded web) | n/a |
| Create playlist and add tracks in UI | No (API only) | Yes (YT Music) | Yes | Yes | Yes (YT Music) | Yes |
| Rename, delete, reorder playlist | No | Yes | Yes | Yes | Yes | Yes |
| Repeat modes | No (stub) | Yes | Yes | Yes | Yes | Yes |
| Queue drag reorder / play next | No | Yes | Yes | Yes (drag and drop) | Yes | Yes |
| Queue persistence across restarts | No | Yes (web session) | Yes | Unverified | Yes (web session) | Yes, to server (unverified) |
| Synced lyrics | No | Yes (`synced-lyrics` plugin) | Yes (LRCLIB) | Unverified | Yes (LRCLIB and others) | Yes |
| Scrobbling (Last.fm / ListenBrainz) | No | Yes (`scrobbler`) | Via plugin (ListenBrainz) | Unverified | Yes (Last.fm) | Yes (to server) |
| Discord Rich Presence | No | Yes | No | Unverified | Yes | No |
| SponsorBlock non-music skip | No | Yes | No | Yes (README) | No | n/a |
| Sleep timer | No | Requested (#2484), not shipped | No | No | No | No |
| Keyboard shortcuts | Space only via browser default | Yes (`shortcuts`) | Yes | Yes | Yes | Yes |
| Settings: cache size, audio quality | No | Yes (`quality-changer`) | Yes | Yes | Yes | Yes |
| Auto-update | No | Yes | Yes | Yes | Yes | Yes |
| Package-manager distribution | No | Homebrew, Scoop, Winget, AUR | Yes | Yes (deb, rpm, flatpak, dmg, msi) | Yes | Yes |
| Cross-service library under one login | Planned (ROADMAP) | No | Spotify only | Multiple, no login | No | Multiple servers |
| Match engine with user "fix match" | Planned (ROADMAP Stage 2) | n/a | No (top complaint) | n/a | n/a | n/a |
| Server-side token custody | Yes | n/a | No | n/a | n/a | n/a |
| Tray, media keys | Yes | Yes | Yes | Yes | Yes | Yes |
| Download / offline export | No | Yes | Yes | Unverified | No | Yes |

Observations:

1. **Playlist and queue basics are table stakes and Music Manager is below the bar.** All five comparables let a user create a playlist, add to it, reorder it and set repeat. Music Manager has the API half of playlists and none of the UI. This blocks the "library" half of the product's own pitch.
2. **Music Manager is the only product here that spends Google quota to search.** The others embed the YouTube Music web app or use InnerTube-style clients. With 100 `search.list` calls per project per day, one active user can exhaust search for everyone on a shared project by lunchtime.
3. **Lyrics and scrobbling are near-universal and cost nothing.** LRCLIB answers unauthenticated requests with `syncedLyrics` (verified live). ListenBrainz needs a user token. Both slot into the existing `Track` shape (title, artist, duration).
4. **The differentiators are real and should be protected.** No comparable holds provider tokens server-side under one local account, and none offers a user-correctable match. Spotube's issue tracker (#244, #883, #962, #1976, #2399, #2531) shows the match problem is persistent and users ask for exactly the "Fix match" that ROADMAP.md plans.
5. **Spotify's February 2026 rules change the shape of Stage 2.** Development Mode now allows 5 authenticated users and requires the app owner to hold Premium; Extended Quota is organizations-only with a 250k MAU floor. Spotify OAuth cannot be the on-ramp for a hobby app's users. The matcher and file-based import can be.

Out of scope, stated once: offline download or export of YouTube audio as a user feature. YouTube's terms prohibit downloading content without permission; the existing transient transcode cache is an implementation detail and should stay bounded and hidden.

## 5. Feature ideas

Scores are 1 to 5. Risk and Time are inverted (5 is lowest risk, fastest). Weighted score = 0.30 Impact + 0.25 Alignment + 0.20 Feasibility + 0.15 Time + 0.10 Risk.

### 5.1 User value

**F1. Custom playlists end-to-end**
Replace the `console.log` stub with a create dialog; add "Add to playlist" to `TrackRow`, `TrackCard` and the now-playing bar; add rename, delete, remove-track and drag reorder. Server: `PATCH`/`DELETE /api/custom-playlists/:id`, `DELETE .../tracks/:trackId`, `PUT .../order` writing `sort_order`. Bulk-add "Save queue as playlist".
User problem: users cannot build a library at all today; the only way to populate a custom playlist is a raw API call.
Evidence: `LibraryView.jsx` line with `console.log("Open Create Modal")`; no client caller of the write endpoints; every comparable ships this (Nuclear README: playlist creation, import, export).
Relation to ROADMAP: extends Stage 0's `providers/custom.js` with the write side that Stage 0 does not include.
| Impact 5 | Feasibility 5 | Alignment 5 | Risk 5 | Time 3 | **Weighted 4.70** |

**F2. Repeat modes, play next, queue reorder, queue persistence**
Implement Repeat off / all / one on the existing button. Add "Play next" on rows and drag reorder in `Queue.jsx`. Persist `queue`, `queueIndex`, `currentTime` and `isShuffle` to `localStorage` on change and restore on launch (paused).
User problem: a stubbed Repeat button erodes trust; losing the queue on every restart makes long sessions painful.
Evidence: `PlayerFooter.jsx` Repeat button has no handler; Nuclear README lists repeat and drag-and-drop reordering; Feishin advertises save and restore of the play queue (third-party description, unverified against README).
| Impact 4 | Feasibility 5 | Alignment 4 | Risk 5 | Time 4 | **Weighted 4.30** |

**F3. Synced lyrics panel (LRCLIB)**
Server route `GET /api/lyrics?title=&artist=&duration=` proxies LRCLIB `/api/get` then `/api/search`, caches results in SQLite, and returns `syncedLyrics` or `plainLyrics`. Client shows a lyrics pane beside the queue that highlights the current line using `currentTime`. Strip YouTube noise ("Official Video", "Lyrics", "HD") from titles before querying.
User problem: users want to follow along; comparables offer it and Music Manager has the needed fields already.
Evidence: LRCLIB answered an unauthenticated query with `syncedLyrics` in `[mm:ss.xx]` format (verified 2026-09-07); Spotube, ytmdesktop2 and Pear (`synced-lyrics` plugin directory) all ship it.
Risk note: YouTube titles are noisy, so expect misses; show "No lyrics found" rather than guessing.
| Impact 4 | Feasibility 4 | Alignment 3 | Risk 4 | Time 4 | **Weighted 3.75** |

**F4. Keyboard shortcuts**
Global in-app keys: Space play/pause, Left/Right seek 5 s, Shift+Left/Right previous/next, Up/Down volume, M mute, S shuffle, R repeat, `/` focus search, L toggle lyrics. Show a `?` overlay listing them. Ignore keys when an input is focused.
User problem: the player is mouse-only; every comparable is keyboard-driven.
Evidence: Nuclear README lists keyboard shortcuts; Pear has a `shortcuts` plugin.
| Impact 3 | Feasibility 5 | Alignment 3 | Risk 5 | Time 5 | **Weighted 3.90** |

**F5. Sleep timer and "stop after this track"**
Footer menu: stop after 15/30/60 min, after current track, or after N tracks. Fade volume over the last 10 s.
User problem: falling asleep to music without leaving a stream and transcode running all night; also saves the user's quota of yt-dlp calls.
Evidence: th-ch/Pear issue #2484 requests exactly this and it is not shipped there, so it is a small differentiator.
| Impact 2 | Feasibility 5 | Alignment 3 | Risk 5 | Time 5 | **Weighted 3.60** |

**F6. SponsorBlock non-music skip**
For YouTube tracks, fetch `music_offtopic` segments (privacy-preserving hashed-prefix lookup) and auto-skip intros, outros and talking in official videos. Toggle in settings.
User problem: music videos carry non-music sections; comparables skip them.
Evidence: Pear `sponsorblock` plugin directory; Nuclear README mentions SponsorBlock. The SponsorBlock database is CC BY-NC-SA 4.0 (repository README); endpoint details could not be fetched (docs behind an anti-bot wall) and are unverified here.
Risk note: non-commercial license is compatible with an MIT hobby app but must be attributed.
| Impact 2 | Feasibility 4 | Alignment 3 | Risk 3 | Time 4 | **Weighted 3.05** |

### 5.2 Technical feasibility (cheap wins and reliability)

**F7. Google token auto-refresh and consent-screen publishing**
In `middleware/googleToken.js`, when `expires_at` is within 60 s, call `oauth2Client.refreshAccessToken()` with the stored `refresh_token`, write the new `access_token` and `expires_at`, and continue. Remove the client-side timer that logs the user out; only surface "Reconnect" when refresh fails (`invalid_grant`). Publish the OAuth consent screen to "In production" so refresh tokens stop expiring after 7 days.
User problem: users are logged out roughly hourly and must re-consent weekly.
Evidence: `App.jsx` auto-logout effect; `authController.js` stores `refresh_token` with `access_type: 'offline'` but nothing reads it; Google states Testing-status apps get refresh tokens that expire in 7 days.
Relation to ROADMAP: pulls forward the YouTube case of Stage 3 "generic token refresh". Do it now; generalize later.
| Impact 5 | Feasibility 5 | Alignment 5 | Risk 5 | Time 5 | **Weighted 5.00** |

**F8. Quota-free search via yt-dlp, and play before connecting Google**
Add `providers/youtubeSearch.js` that runs `yt-dlp -j --flat-playlist "ytmsearch20:<q>"` (fall back to `ytsearch`), parses one JSON object per line into the `Track` shape (id, title, uploader, duration, thumbnail), caches by query for 24 h in SQLite, and debounces on the client. Keep the Data API path as an optional "official" mode. Because this path needs no Google token, unblock Search and Play for users who have not connected Google; keep Library gated.
User problem: 100 `search.list` calls per day per project is exhausted quickly and fails for everyone at once; today a new user cannot hear anything until OAuth succeeds.
Evidence: Google quota docs (100 search.list calls/day); ROADMAP Stage 2 already commits to `ytsearch5` inside the matcher, so this adds no new dependency; Spotube, Nuclear and Pear all search without the Data API.
Risk note: yt-dlp search takes 2 to 4 s and breaks when YouTube changes (mitigated by F9). Unofficial access carries the same terms risk the app already accepts for streaming.
| Impact 5 | Feasibility 4 | Alignment 5 | Risk 3 | Time 4 | **Weighted 4.45** |

**F9. Bundled JavaScript runtime for yt-dlp, self-update, and version health**
Ship Deno as a second Tauri sidecar (or detect a system Deno or Node 22+) and pass `--js-runtimes deno:<path>` on every yt-dlp call. Run `yt-dlp -U` on startup with a timeout. Extend `GET /` health to report yt-dlp, ffmpeg and runtime versions and whether a runtime was found; show a red banner in the client when it is missing.
User problem: on a machine without Deno, YouTube format availability is "limited, and severely so in some cases", so playback fails with a generic 502.
Evidence: yt-dlp announcement #15012 (runtime required since 2025.11.12); EJS wiki (`--js-runtimes RUNTIME[:PATH]`, Node minimum 22); local check: bundled yt-dlp is 2026.01.31 and only works because Homebrew Deno exists; the `pkg` sidecar embeds Node 18, below the minimum.
Relation to ROADMAP: extends Stage 3 "yt-dlp self-update and health endpoint" with the runtime requirement, which the roadmap does not mention.
| Impact 4 | Feasibility 4 | Alignment 4 | Risk 4 | Time 4 | **Weighted 4.00** |

**F10. One API client with a configurable base URL and dynamic port**
Create `client/src/utils/api.js` exporting `apiUrl(path)` and `apiFetch(path, opts)` that attaches the JWT, parses JSON, and dispatches a `session-expired` event on 401. Replace the 15 hardcoded `http://localhost:3000` strings. Have the Rust sidecar spawn pass a free port and inject it via `window.__MM_PORT__` (or read it from the sidecar stdout), with 3000 as default.
User problem: any port conflict breaks the app silently; error handling is copy-pasted across six components.
Evidence: `grep -rn "localhost:3000" client/src` returns 15 hits; `vite.config.js` proxies stale paths (`/play`, `/playlist`).
| Impact 3 | Feasibility 5 | Alignment 4 | Risk 5 | Time 5 | **Weighted 4.15** |

**F11. Settings screen: cache size, audio bitrate, clear cache, versions**
New Settings view with: cache limit in MB (size-based eviction replacing the 50-file count), bitrate 96/128/192/256 kbps passed to ffmpeg, "Clear cache", cache location, connected services with disconnect, and the versions from F9. Persist in a `settings` table keyed by user.
User problem: no control over disk usage or quality; no way to disconnect a service.
Evidence: 50-file cap in `YouTubeController.manageAudioCache`; Pear `quality-changer` plugin; all comparables have a settings screen.
Relation to ROADMAP: Stage 3 plans size-based eviction; this adds the UI and the bitrate control.
| Impact 3 | Feasibility 4 | Alignment 4 | Risk 5 | Time 3 | **Weighted 3.65** |

### 5.3 Business impact (adoption, retention, differentiation)

**F12. Playlist import from CSV, text or M3U through the match engine**
Accept a file (Exportify or TuneMyMusic CSV, plain "Artist - Title" lines, M3U) and create a custom playlist whose rows are resolved by the Stage 2 matcher, with the "Wrong match?" picker on each row and an import report listing unmatched tracks.
User problem: users arriving from Spotify or Apple cannot bring their library; Spotify OAuth is now capped at 5 users, so an OAuth-based import cannot scale past the author's friends.
Evidence: Spotify quota-modes doc (5 users, owner must hold Premium; Extended Quota organizations-only, 250k MAU); Soundiiz and TuneMyMusic exist because this need is common and both gate volume behind paid tiers; Spotube's issue tracker shows the failure mode to design against.
Dependency: matcher from ROADMAP Stage 2 and F1.
| Impact 4 | Feasibility 3 | Alignment 5 | Risk 3 | Time 2 | **Weighted 3.65** |

**F13. Scrobbling to ListenBrainz and Last.fm**
Settings field for a ListenBrainz user token; on play start send `playing_now`, and at half duration or 4 minutes send a `single` listen. Add Last.fm second, since it needs an API key, signature and session flow. Queue submissions offline in SQLite and flush later.
User problem: listeners who track their history elsewhere lose it when they use this app.
Evidence: ListenBrainz `submit-listens` docs (Token auth; half-track or 4-minute rule); Last.fm `track.scrobble` docs; Pear `scrobbler`, ytmdesktop2 Last.fm, Feishin server scrobbling, Navidrome ListenBrainz.
| Impact 3 | Feasibility 4 | Alignment 3 | Risk 4 | Time 3 | **Weighted 3.30** |

**F14. Auto-update and package-manager distribution**
Enable the Tauri v1 updater with a signed `latest.json` published by the release workflow, and produce the Tauri bundle (dmg, msi) in CI instead of only a `pkg` exe. Add a Homebrew cask and a Winget manifest.
User problem: users cannot get fixes (notably yt-dlp breakages) without re-downloading; the current release ships a server exe with no UI.
Evidence: `.github/workflows/release.yml` builds only `MusicApp.exe` via `pkg`; Nuclear ships auto-update and installers; Pear ships through Homebrew, Scoop, Winget and AUR.
Relation to ROADMAP: Stage 3 plans a build matrix; this adds the updater and distribution channels.
| Impact 3 | Feasibility 3 | Alignment 4 | Risk 3 | Time 3 | **Weighted 3.25** |

**F15. Discord Rich Presence**
Optional setting that publishes title, artist, artwork and elapsed time to Discord via a Rust crate in the Tauri shell, driven by a Tauri event from `MusicContext`.
User problem: social listeners expect it; two of five comparables ship it.
Evidence: Pear `discord` plugin directory; ytmdesktop2 README.
| Impact 2 | Feasibility 3 | Alignment 2 | Risk 4 | Time 4 | **Weighted 2.70** |

## 6. Prioritized roadmap

Rubric: weighted score = user impact 30%, alignment with goals 25%, feasibility 20%, time to delivery 15%, risk 10%. Ties go to the item that unblocks others. Disagree with the weights, not the arithmetic. Sizes: S under 2 days, M under a week, L over a week.

1. **F7 Google token auto-refresh and consent-screen publishing** (S, 5.00). Removes the hourly logout and the weekly re-consent with about 40 lines in one middleware. Nothing else matters if users are logged out mid-song. Depends on: nothing.
2. **F1 Custom playlists end-to-end** (M, 4.70). Turns the library from read-only into usable and fulfils the product's own pitch. Depends on: nothing; do F10 first if touching many components anyway.
3. **F8 Quota-free search via yt-dlp and play-before-connect** (M, 4.45). Removes the 100-searches-per-day ceiling and lets a new user hear music before OAuth. Depends on: F9 for reliability on user machines (can ship first with a "runtime missing" banner).
4. **F2 Repeat, play next, queue reorder, queue persistence** (S, 4.30). Finishes the stubbed control and makes long sessions survivable. Depends on: nothing.
5. **F10 One API client, configurable base URL, dynamic port** (S, 4.15). Enabler: every later client change touches fewer files; fixes port conflicts. Depends on: nothing. Can be folded into the same week as items 1 and 2.
6. **F9 Bundled JS runtime for yt-dlp, self-update, version health** (M, 4.00). Makes YouTube playback work on machines without Deno and surfaces breakages instead of generic 502s. Depends on: nothing; unblocks F8's reliability.
7. **F4 Keyboard shortcuts** (S, 3.90). Cheap parity with every comparable. Depends on: F2 for the repeat key.
8. **F3 Synced lyrics** (M, 3.75). Free, no key, high perceived value. Depends on: F10 for the fetch wrapper; benefits from a title cleaner shared with the Stage 2 matcher.
9. **F11 Settings screen** (M, 3.65). Home for cache size, bitrate, disconnect, versions and the toggles from F3, F6, F13, F15. Depends on: F9 for versions; F10.
10. **F12 Playlist import through the matcher** (M, 3.65). The realistic on-ramp for Spotify and Apple users given Spotify's 5-user Development Mode. Depends on: ROADMAP Stage 2 matcher, F1.
11. **F5 Sleep timer** (S, 3.60). Small differentiator requested in Pear's tracker. Depends on: nothing.
12. **F13 Scrobbling** (M, 3.30). ListenBrainz first (token only), Last.fm second. Depends on: F11 for the token field.
13. **F14 Auto-update and distribution** (M, 3.25). Needed before any wider audience, otherwise yt-dlp breakages strand users. Depends on: ROADMAP Stage 3 build matrix.
14. **F6 SponsorBlock non-music skip** (S, 3.05). Nice-to-have; verify API terms first. Depends on: F11.
15. **F15 Discord Rich Presence** (S, 2.70). Only if users ask. Depends on: F11.

Suggested change to ROADMAP.md: keep Stage 0 and Stage 1 as written. In Stage 2, build the matcher and F12 first and treat Spotify OAuth as an author-only convenience (5 users, Premium owner). Items 1, 4, 5, 6 above should land before Stage 0 because they fix things the Stage 0 refactor would otherwise carry forward. In Stage 3, note that Node SEA is still "Stability 1.1 Active development" in the Node 26 docs; a plain Node binary sidecar with an esbuild bundle is a lower-risk replacement for `pkg` than SEA today.

## 7. Acceptance criteria and success metrics

No usage data exists today. Every metric below assumes a small opt-in local `events` table (event name, timestamp, JSON payload) written by the server and viewable in Settings, plus server log counters. Targets are proposals to be revised after two weeks of data.

**1. F7 Token auto-refresh**
- [ ] A request with a token expiring within 60 s triggers a refresh and succeeds without a 401.
- [ ] Refresh failure (`invalid_grant`) returns `GOOGLE_TOKEN_EXPIRED`; the client shows Reconnect only then.
- [ ] `App.jsx` no longer schedules logout from `googleExpiresAt`.
- [ ] Consent screen is "In production"; a test account's refresh token still works after 8 days.
- [ ] Tests: refresh path, refresh failure path, no client-supplied identity.
- Metrics: `google_reconnect_prompt` events per active user per week, target 0 after publishing (measured from events table); forced logouts per session, target 0 (client event).

**2. F1 Custom playlists end-to-end**
- [ ] Create, rename, delete a playlist from Library; delete asks for confirmation.
- [ ] "Add to playlist" on search rows, history cards, playlist rows and now-playing bar; duplicate add is rejected with a message.
- [ ] Remove track and drag reorder persist `sort_order` and survive reload.
- [ ] "Save queue as playlist" creates one with the current order.
- [ ] Ownership is enforced on every new route; tests cover 404 for foreign playlists.
- Metrics: percentage of active users with at least one custom playlist containing 5 or more tracks, target 60% within 30 days; `playlist_track_added` events per user per week, target 5 or more.

**3. F8 Quota-free search**
- [ ] Search returns results with no Google connection; Library still prompts to connect.
- [ ] Median search latency under 3 s on a warm cache; spinner and debounce (400 ms) present.
- [ ] Zero `search.list` calls in default mode (verified in Google Cloud quota page).
- [ ] Results carry `source: 'youtube'`, duration and thumbnail; identical shape to the Data API path.
- [ ] yt-dlp failure returns 502 with a code the client renders as "Search unavailable, check runtime".
- Metrics: time from first launch to first play for a new local account, target under 2 minutes (events `account_created`, `first_play`); `search_failed` rate, target under 2% of searches; quota-exceeded errors, target 0.

**4. F2 Repeat and queue**
- [ ] Repeat cycles off, all, one; state is visible on the button; `ended` handler respects it.
- [ ] "Play next" inserts after the current index; drag reorder updates `queueIndex` correctly.
- [ ] Killing and relaunching the app restores queue, index and position, paused.
- [ ] Shuffle restore still works after reorder.
- Metrics: sessions that restore a non-empty queue, target over 50% of launches; `repeat_toggled` events, informational.

**5. F10 API client**
- [ ] Zero occurrences of `localhost:3000` in `client/src`.
- [ ] Changing `PORT` and the injected port makes the app work without code edits.
- [ ] 401 from any protected route dispatches one `session-expired` event and shows one message.
- Metrics: bug reports mentioning port conflicts, target 0; number of fetch call sites, informational.

**6. F9 JS runtime and health**
- [ ] `GET /` returns `{ ytdlp, ffmpeg, jsRuntime: { name, version, path } | null }`.
- [ ] yt-dlp is invoked with `--js-runtimes` pointing at the bundled or detected runtime.
- [ ] Startup self-update runs with a 20 s timeout and never blocks the first request.
- [ ] Client banner appears when `jsRuntime` is null.
- Metrics: stream 502 rate per 100 plays, target under 1%; runtime-missing banner impressions, target 0 on release builds.

**7. F4 Keyboard shortcuts**
- [ ] All listed keys work outside inputs and are inert inside inputs.
- [ ] `?` overlay lists them; documented in README.
- Metrics: share of play/pause actions via keyboard, informational.

**8. F3 Synced lyrics**
- [ ] Lyrics pane shows synced lines highlighted within 500 ms of the audio position; falls back to plain lyrics, then "No lyrics found".
- [ ] Results cached; no repeat LRCLIB call for the same track within 30 days.
- [ ] Requests send a descriptive `User-Agent`.
- Metrics: lyrics hit rate on played tracks, target over 60%; pane open rate, informational.

**9. F11 Settings**
- [ ] Cache limit in MB enforced by size-based eviction; "Clear cache" empties `cache/` except in-flight files.
- [ ] Bitrate change applies to the next stream and is reflected in cache filenames (`<id>_<kbps>.mp3`).
- [ ] Disconnect removes the `user_connections` row and the connect banner reappears.
- Metrics: cache directory size never exceeds the limit by more than one file (server log check); settings changed per user, informational.

**10. F12 Import through matcher**
- [ ] CSV with `Track Name, Artist Name(s), Duration (ms)` columns (Exportify format) and plain "Artist - Title" text both import.
- [ ] Import report lists matched, low-confidence and unmatched rows; each row has "Wrong match?".
- [ ] Import of 100 rows completes in the background with progress; app stays usable.
- Metrics: match rate on a 100-track golden set, target over 85% correct without manual fixes; imports per active user in first month, informational.

**11. F5 Sleep timer**
- [ ] Options: after current track, 15, 30, 60 min, after N tracks; visible countdown; cancel.
- [ ] Playback pauses with a 10 s fade; no yt-dlp or ffmpeg process remains.
- Metrics: timers set per week, informational.

**12. F13 Scrobbling**
- [ ] ListenBrainz `playing_now` on start; `single` at half duration or 4 min; offline queue flushes on reconnect.
- [ ] Invalid token shows a clear error in Settings.
- Metrics: scrobble success rate, target over 98%; queued-and-flushed count, informational.

**13. F14 Auto-update and distribution**
- [ ] Release workflow publishes dmg and msi from `tauri build` plus a signed `latest.json`.
- [ ] Running an older build offers the update and installs it.
- [ ] Homebrew cask and Winget manifest install the current release.
- Metrics: share of active installs on the latest version 14 days after release, target over 70% (release-check log count by version).

**14. F6 SponsorBlock**
- [ ] `music_offtopic` segments skipped for YouTube tracks when enabled; attribution shown in Settings.
- [ ] Hashed-prefix lookup only; no raw video ids sent.
- Metrics: skipped seconds per play, informational.

**15. F15 Discord Rich Presence**
- [ ] Off by default; when on, Discord shows title, artist, artwork and elapsed time within 5 s of track change.
- Metrics: enable rate, informational.

## 8. Implementation notes

- **Search provider shape.** Parse `yt-dlp -j --flat-playlist "ytmsearch20:<q>"` output line by line: `id`, `title`, `uploader` or `channel`, `duration`, `thumbnails[0].url`. Filter `duration < 30` or `> 1200` to drop Shorts and full albums. Cache `{ query, results, fetched_at }` in SQLite. Spawn with a 10 s timeout and `--no-warnings`.
- **Runtime detection order.** Bundled Deno sidecar path, then `deno` on PATH, then `node` on PATH if version is 22 or higher, else null. Pass `--js-runtimes` on every yt-dlp invocation via one helper in `YouTubeController.js`.
- **Token refresh.** Use one `google.auth.OAuth2` per request with `setCredentials({ refresh_token })`, then `getAccessToken()`; write back `expires_at = credentials.expiry_date`. Serialize refreshes per user with a small in-memory promise map so concurrent requests do not double-refresh.
- **Queue persistence.** Debounce writes to `localStorage` at 500 ms; store `{ queue, queueIndex, currentTime, isShuffle, repeat }`; on restore set `audio.src` lazily on first user gesture to avoid autoplay blocks in WebKit.
- **Lyrics.** Title cleaner: strip bracketed or parenthesized segments containing official, video, audio, lyrics, HD, 4K, remaster; split "Artist - Title" when `channelTitle` ends in " - Topic". Send `User-Agent: MusicManager/<version> (<repo url>)`.
- **Playlist reorder.** Store `sort_order` as integers with gaps of 1000 so a single move is one `UPDATE`; renumber when gaps run out.
- **Data to gather before committing to lower-ranked items.** Add the opt-in `events` table first; after two weeks, read: searches per user per day (validates F8 urgency), plays per session and session length (validates F2 and F5), tracks added to playlists (validates F1 scope), lyrics hit rate (validates F3). Add a one-question in-app prompt after the tenth session: "What is missing?" with free text stored locally and exported on request.
- **Terms and licenses.** yt-dlp-based search carries the same YouTube terms exposure the app already accepts for streaming; document it in README. SponsorBlock data is CC BY-NC-SA 4.0 and needs attribution. LRCLIB is free to use; keep request volume low with caching.
- **Node SEA vs pkg.** SEA is still marked "Stability 1.1 Active development"; native addons like `sqlite3` need the `process.dlopen` workaround. Consider `better-sqlite3` or `node:sqlite` when replacing `pkg`, or ship an official Node binary as a Tauri sidecar with an esbuild bundle.

## 9. Sources

- Music Manager repository files: `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `app.js`, `server.js`, `config/db.js`, `controllers/*.js`, `middleware/*.js`, `client/src/**`, `src-tauri/**`, `tests/*.js`, `.github/workflows/*.yml` (local, read 2026-09-07)
- YouTube Data API quota overview: https://developers.google.com/youtube/v3/getting-started
- YouTube Data API `search.list` quota impact: https://developers.google.com/youtube/v3/docs/search/list
- Google OAuth 2.0 refresh token expiration (Testing status, 7 days): https://developers.google.com/identity/protocols/oauth2
- Google Cloud "Unverified apps" and 100-user cap: https://support.google.com/cloud/answer/7454865?hl=en
- yt-dlp announcement: external JavaScript runtime required: https://github.com/yt-dlp/yt-dlp/issues/15012
- yt-dlp EJS wiki (`--js-runtimes`, minimum versions): https://github.com/yt-dlp/yt-dlp/wiki/EJS
- Spotify Web API quota modes (5 users in Development Mode; Extended Quota criteria): https://developer.spotify.com/documentation/web-api/concepts/quota-modes
- Spotify community: Updating the Criteria for Web API Extended Access: https://community.spotify.com/t5/Spotify-for-Developers/Updating-the-Criteria-for-Web-API-Extended-Access/td-p/6920661
- Node.js Single Executable Applications (stability index): https://nodejs.org/api/single-executable-applications.html
- vercel/pkg (deprecated): https://github.com/vercel/pkg
- Tauri 2.0 stable release: https://v2.tauri.app/blog/tauri-20/
- Tauri deep linking plugin: https://v2.tauri.app/plugin/deep-linking/
- Pear Desktop (formerly th-ch/youtube-music): https://github.com/th-ch/youtube-music
- Pear Desktop plugin directory listing: https://github.com/pear-devs/pear-desktop/tree/master/src/plugins
- Pear Desktop plugin descriptions (fork README, secondary): https://github.com/iryis/th-ch-ytmusic
- th-ch/youtube-music sleep timer feature request #2484: https://github.com/th-ch/youtube-music/issues/2484
- Spotube: https://github.com/KRTirtho/spotube
- Spotube wrong-match issues: https://github.com/KRTirtho/spotube/issues/244 , https://github.com/KRTirtho/spotube/issues/883 , https://github.com/KRTirtho/spotube/issues/962 , https://github.com/KRTirtho/spotube/issues/1976 , https://github.com/KRTirtho/spotube/issues/2399 , https://github.com/KRTirtho/spotube/issues/2531
- Nuclear: https://github.com/nukeop/nuclear
- ytmdesktop2: https://github.com/Venipa/ytmdesktop2
- Feishin: https://github.com/jeffvli/feishin
- Feishin queue save/restore description (secondary, unverified): https://dev.co/devops/open-source/feishin
- Soundiiz: https://soundiiz.com/
- TuneMyMusic: https://www.tunemymusic.com/
- LRCLIB repository: https://github.com/tranxuanthang/lrclib
- LRCLIB live API check (no key required, `syncedLyrics` present): https://lrclib.net/api/search?track_name=Never+Gonna+Give+You+Up&artist_name=Rick+Astley
- SponsorBlock server and data license: https://github.com/ajayyy/SponsorBlockServer
- ListenBrainz core API (`submit-listens`): https://listenbrainz.readthedocs.io/en/latest/users/api/core.html
- ListenBrainz Last.fm-compatible API: https://listenbrainz.readthedocs.io/en/latest/users/api-compat.html
- Last.fm `track.scrobble`: https://www.last.fm/api/show/track.scrobble
- YouTube.js (InnerTube client, alternative to yt-dlp search): https://github.com/LuanRT/YouTube.js
- Navidrome scrobbling docs: https://www.navidrome.org/docs/usage/features/scrobbling/
