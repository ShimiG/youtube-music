# Multi-Service Roadmap

Music Manager today plays YouTube only. This roadmap takes it to "connect any
streaming service that can be connected", in seven stages, starting with a
foundation stage that generalises the Library before any service is added. Each stage ships on its
own and leaves the app working.

## Ground rules (apply to every stage)

1. **One provider interface.** Every service lives in `providers/<name>.js` and
   exposes the same shape: `search`, `getPlaylists`, `getPlaylistTracks`,
   `getLikedTracks`, `likeTrack`, `resolveStream`, optional `auth` (get URL, handle
   callback, refresh, tier) and a `capabilities` block saying which of those it
   supports. `app.js` routes by `source`; it never knows service details. Local
   custom playlists are a provider too (`providers/custom.js` over SQLite), so the
   client has one code path.
2. **One library API, one shape.** `GET /api/library/:source/playlists` and
   `GET /api/library/:source/playlists/:id/tracks` return normalised `Playlist`
   and `Track` objects with cursor pagination for every source. "Liked songs" is a
   virtual playlist with id `liked` and kind `liked`, pinned first, present
   whenever the provider declares the `liked` capability. Each service maps its own
   notion of liked (YouTube rating, Spotify saved tracks, Tidal favorites, Apple
   library songs) inside its provider; nothing outside the provider knows the
   difference.
3. **Login per service unlocks the library. Tier decides playback.** Connecting a
   service stores its token in `user_connections` together with a new `tier`
   column (`free` / `premium`). The library, playlists and likes appear as soon as
   the user connects. The tier only selects how a track is played.
4. **Four playback modes.**
   - `server-stream`: yt-dlp resolves a URL, ffmpeg transcodes, we stream it (YouTube, SoundCloud, Audius, self-hosted).
   - `match`: the track is looked up on YouTube by artist, title, duration and ISRC, then plays via `server-stream` (Spotify free, Apple Music without subscription, Tidal without subscription, Deezer).
   - `remote`: we control the service's own app (Spotify Connect, Premium).
   - `client-sdk`: the service's DRM player runs inside the webview (Apple MusicKit, Tidal Player, Spotify Web Playback). **Not planned** (Stage 3 decision, Nov 2026): Tauri's webviews have no Widevine, and there is no Premium / Apple Music subscription to test or use it. Revisit if one is added.
5. **"Wrong match?" is a feature of the match mode, not of Spotify.** Any track
   played through `match` shows the button. It applies to Spotify free, Apple
   Music and Tidal without subscription, and Deezer.
6. **Tracks carry `source` everywhere.** Search results, playlist rows, history,
   custom playlists, stream URLs and cache filenames all include the source.

## Target service matrix

| Service | Connect | Playlists | Liked songs source | Paid tier playback | Free / no subscription | Stage |
|---|---|---|---|---|---|---|
| YouTube | Google OAuth | Own playlists | `videos.list myRating=like`, music category only. Liking needs the write scope | server-stream (no premium needed) | same | shipped |
| SoundCloud | OAuth 2.1 + PKCE (official API); none needed for yt-dlp search/playback | Own playlists via `/me/playlists` (API only) | `/me/likes/tracks`, read-only for now (API only) | n/a | server-stream from `/tracks/{urn}/streams` or yt-dlp (HLS to ffmpeg); Go+ tracks play the preview snippet | shipped |
| Spotify | OAuth, 1 h token + refresh | Own and followed playlists | `GET /me/tracks`, like via `PUT /me/tracks` | remote (Spotify Connect) | match | 2 |
| Apple Music | MusicKit user token (minted in client) | Library playlists (subscribers only) | No loved-songs endpoint; `me/library/songs` stands in, labelled Library Songs | client-sdk (DRM) | match, catalog search only | 4 |
| Tidal | OAuth PKCE | Own playlists | Favorite tracks endpoint | client-sdk (DRM) | match | 5 |
| Audius | none (search, playback); a public handle or Log in with Audius for the library, later | Public playlists (later) | `users/{id}/favorites`, read-only (later) | server-stream, free | same | **shipped (search + playback)** |
| Jamendo | app key | none | none without user OAuth | server-stream, free | same | 6 |
| Deezer | none | none for new apps | none | none supported | match on play, else 30 s preview | **shipped** |
| Navidrome / Subsonic / Jellyfin | server URL + credentials | Own playlists | Starred (Subsonic) or favorites (Jellyfin) | server-stream | same | 6 |
| Amazon Music, Qobuz | partner-only APIs | | | | | parked |
| YouTube Music | covered by YouTube | | | | | n/a |

## Stage 0: Library foundation (shipped)

Status: shipped after Stage 1 (branch `stage0-library-foundation`, merged
into `main` with Stage 3 in Nov 2026). What
landed, mapped to the plan below:

- `providers/` registry (`index.js`) with `youtube.js`, `soundcloud.js` and
  `custom.js` behind one interface, plus `errors.js` (one `SourceError` type)
  and `normalize.js` (the `Playlist` / `Track` shapes and `{ items, nextCursor }`).
- Library routes in `controllers/libraryController.js`: `GET /api/sources`,
  `GET /api/library/:source/playlists`, `GET /api/library/:source/playlists/:id/tracks`
  (id `liked` -> the provider's liked songs), `POST /api/library/:source/liked`,
  `DELETE /api/library/:source/liked/:id`, and `GET /api/search/:source`.
  Cursor paging everywhere: YouTube pageToken, SoundCloud next_href, SQLite row id.
- `middleware/sourceToken.js` replaces the per-service token middleware and
  returns `SOURCE_NOT_CONNECTED` / `SOURCE_TOKEN_EXPIRED` with the source name.
  The per-service middleware is gone (Stage 3); the alias routes use
  `sourceToken` too and answer with the same SOURCE_* codes.
- YouTube liked songs: `videos.list myRating=like` (music category), paged, plus
  like/unlike via `videos.rate`. The write scope is requested only when a like is
  refused (`SOURCE_SCOPE_REQUIRED` -> `connectGoogle({ scope: 'write' })`), so
  read-only users keep the smaller consent.
- Client: `utils/services.js` is the only file that names a service;
  `hooks/useSources.js` and `hooks/useLibrary.js` (`useLibrary`,
  `usePlaylistTracks`, `useSearch` with `loadMore`); a shared
  `components/SourcePicker.jsx`; `LibraryView` and `SearchView` rewritten on one
  fetch path and one error panel; `PlaylistCard` renders the normalised shape
  with the liked card pinned first; "Load more" driven by `nextCursor`.
- Tests: `tests/library.test.js` (normalisation, registry, `/api/sources`,
  per-source error codes, cursor round-trip, liked-only-when-capable, custom
  ownership, like scope, generic search).

Left for the next release: remove the legacy `/search`, `/playlists` and
`/api/soundcloud/*` aliases (and the two shim middlewares); wire the custom
"Create Playlist" card to a real modal; move history to the normalised shape.


Goal: the Library tab, the liked-songs playlist and the connect flow all work
the same way for every source, so adding a service means writing one provider
file and one client registry entry. Done before any new service is added.

Why now: `LibraryView.jsx` has separate state, fetch paths and error handling
for custom and YouTube playlists, the YouTube likes code in
`playlistController.js` is not routed in `app.js`, and playlist objects reach
the client in raw per-service shapes. Every new service would multiply that.

Server
- Create `providers/` with a registry. Move YouTube search, playlist, likes and stream code into `providers/youtube.js` with no behaviour change. Add `providers/custom.js` over the existing SQLite tables.
- Define the normalised shapes and use them everywhere:
  - `Playlist { source, id, kind: 'liked' | 'playlist' | 'custom', name, thumbnail, itemCount, readOnly }`
  - `Track { source, id, title, artist, album, durationSec, thumbnail, isrc, preview }`
  - Every list call returns `{ items, nextCursor }`. YouTube pages by `pageToken`, Spotify by `offset`, SQLite by row id; the provider hides which.
- Library routes: `GET /api/library/:source/playlists` (prepends the virtual `liked` playlist when the provider declares the capability), `GET /api/library/:source/playlists/:id/tracks?cursor=` (id `liked` routes to `getLikedTracks`), `POST /api/library/:source/liked` and `DELETE /api/library/:source/liked/:id` when `like` is supported.
- Replace `middleware/googleToken.js` with `sourceToken(name)` that reads `user_connections` for any source and returns `SOURCE_NOT_CONNECTED` or `SOURCE_TOKEN_EXPIRED` with the source name, for every source.
- `GET /api/sources`: every provider with label, whether it needs a connect flow and of which kind, its capabilities, and whether this user has connected it (plus tier once Stage 2 adds it). One call drives the connect banner, the Library dropdown and the Search source switch.
- YouTube: wire the existing likes code through the new route, normalise its output, page it. Ask for the `youtube` write scope only when the user first taps like, so read-only users keep the smaller consent.
- Keep the old `/playlists` and `/search` routes as thin aliases for one release, then remove.

Client
- One client-side service registry (`utils/services.js`) with label, icon and connect action per source. The connect banner, the Library error panel and the Search switch all read it. It replaces the list inside `ConnectServices.jsx`.
- `useSources()` hook over `/api/sources`; `useLibrary(source)` hook over the library routes with a `loadMore` for the cursor.
- `LibraryView.jsx`: the dropdown lists `custom` plus every connected source from `useSources()`, with unconnected sources shown greyed and selecting one opens its connect action. One fetch path, one error panel that says "Connect <label>" or "Reconnect <label>" for whichever source is active. Delete the custom/YouTube branches.
- `PlaylistCard` renders the normalised shape only. The `liked` card is pinned first with a heart mark and a count when the provider gives one.
- Track list gets "Load more" or infinite scroll driven by `nextCursor`.
- A shared `SourcePicker` component used by both Library and Search.

Tests: normalisation of YouTube and custom playlists to the shared shape, `liked` virtual playlist appears only for providers with the capability, cursor round-trip, per-source not-connected and expired error codes.

Exit criteria: Library shows Custom Playlists and YouTube with identical behaviour to today, plus a working YouTube Liked Songs playlist. No component in the client mentions a specific service outside the registry file.

Effort: 3 to 4 days.

### Catch-up (issues found after the stage shipped)

- **#28 Source-aware seek bar colour.** The seek bar fills in the colour of the
  playing track's source (YouTube red, SoundCloud orange, Spotify green, the
  app green for local), read from the client registry, `utils/services.js`.
  Nothing else in the player names a service.
- **#27 List virtualization.** Track lists that grow with "Load more" (liked
  songs, long playlists, search) render only the rows on screen, so a
  10,000-track list stays responsive. Short lists render as before.

### Adding a new service after Stage 0

1. `providers/<name>.js` implementing the interface and declaring capabilities.
2. One row in `sources` and one entry in `utils/services.js` with label, icon and connect action.
3. If OAuth: scopes and tier lookup inside the provider's `auth` block. The generic `/auth/:source` routes do the rest.
4. Fixtures and normalisation tests for that provider.

Nothing else changes.

## Stage 1: SoundCloud (shipped: official API, with a yt-dlp fallback)

Goal: a second audio source. Two providers share the same routes and ids:
the official SoundCloud API (connect flow, the user's playlists and likes,
stable stream URLs; needs app credentials, which require Artist Pro) and
yt-dlp (search, playback and duration with no credentials; internal web API,
so it can break when SoundCloud changes). `SOUNDCLOUD_PROVIDER=auto` prefers
the API and falls back to yt-dlp when credentials are missing or the API
returns a rate limit or server error.

Server (done)
- `controllers/soundcloud/client.js`: OAuth 2.1 (PKCE S256), `Authorization: OAuth` header, `linked_partitioning` pagination following `next_href`, bounded exponential back-off on 429/503, track/playlist normalisation with `access` (`playable` / `preview` / `blocked`).
- `controllers/soundcloud/tokens.js`: per-user tokens in `user_connections` (source id 3) refreshed server-side and single-flight (refresh tokens are single-use); one cached app token (client credentials) in `app_tokens`, renewed with its refresh token to stay inside the 50 per 12 h / 30 per hour token limits.
- Routes: `/auth/soundcloud/url`, `/auth/soundcloud/callback`, `DELETE /api/user/connections/soundcloud`, `/api/soundcloud/search` (app token, `cursor` for the next page), `/api/soundcloud/playlists` (virtual `liked` first), `/api/soundcloud/playlists/:id/tracks`.
- Playback: `/stream?source=soundcloud&videoId=<id>` resolves `/tracks/{urn}/streams`, picks HLS MP3, then AAC, then the preview, and pipes it through the shared `controllers/transcode.js`. Cache files are `soundcloud_<id>.mp3`; previews are not cached. `/duration` takes `source` too. History accepts `source`.
- `controllers/soundcloud/ytdlp.js`: `scsearch30:<q>` with `--flat-playlist -j`, stream URL via `-f bestaudio/best --print urls` on `https://api.soundcloud.com/tracks/<id>`, duration via `--print duration`. Formats suffixed `_preview` (and 30 s flat results) are flagged `preview`. `GET /api/soundcloud/status` tells the client which provider is active and whether connecting is possible.
- `services/ytdlp.js`: one shared binary path and a background `yt-dlp -U` on every server start (`YTDLP_AUTO_UPDATE`), the self-update Stage 3 had planned.

Client (done)
- `utils/services.js` registry drives the connect banner, the Search source switch and the Library dropdown. Search results, playlist rows and the player carry `source`. SoundCloud rows link to the track's SoundCloud page and show `Preview` / `Not streamable` badges (attribution and access rules from the API terms).

Still open for this stage
- yt-dlp mode has no library. The original idea still applies: let the user save a public profile URL and read its sets and `soundcloud.com/<user>/likes` through yt-dlp flat playlists.
- Every yt-dlp call pays the bundled binary's start-up cost (about 10 s for the single-file macOS build on the dev machine); search should debounce and show a spinner, or the binary should be replaced with a faster install.
- Like / unlike from the app (`POST` / `DELETE /likes/tracks/{urn}`), and paging beyond 200 tracks in a playlist or in likes.
- Display the "Connect with SoundCloud" branded button and logo assets from the Buttons & Logos page before a public release.

Tests: PKCE challenge, token grants, single-use refresh handling, app-token caching and single-flight, 429 back-off and surfacing, pagination, normalisation, route auth, state replay protection, stream/duration routing per source. See `tests/soundcloud.test.js` and `tests/soundcloudRoutes.test.js`.

## Status and order (updated Nov 2026)

- Stage 0: shipped (provider layer, generic library and search API). Stage 1:
  shipped. Stage 3: done (packaging, Tauri v2, security; see
  `docs/stage-3.md`).
- Stage 2: the **match engine is built** (`services/matcher/`, match routes,
  `track_matches`); the Spotify provider itself is **on hold**.
- **Stages 2 (Spotify), 4 (Apple Music) and 5 (Tidal) are on hold** until there
  is a Spotify Premium or Apple Music subscription. Without one, they add only
  YouTube-matched playback, and Apple Music needs a paid Apple Developer
  Program membership even for catalog search.
- Done since: the catch-up (issues #27, #28), **Stage 6** (Audius, Deezer,
  local files, audio quality) and **Stage 7** (Now Playing view, lyrics,
  colours from the cover). The phone remote (#40) is shelved.
- Next: **Stage 8** (performance; plan in `docs/performance-plan.md`), then
  **Stage 9** (data in the cloud on Cloudflare D1; design in
  `docs/cloud-data.md`).

### Open GitHub issues in this plan

| Issue | Where it lives | Status |
|---|---|---|
| #28 Source-aware seek bar colour | Stage 0, catch-up | next |
| #27 List virtualization | Stage 0, catch-up | next |
| #38 Deezer | Stage 6 | **done** (search; full track via match, else preview) |
| #24 Local file scanning | Stage 6 | **done** (folders, tags, search, direct FLAC/WAV) |
| #39 Lossless audio (FLAC/WAV) | Stage 6 | **done** (local FLAC/WAV as-is; quality setting for streams) |
| #29 Persistent controls in an expanded view | Stage 7 | **done** |
| #30 Lyrics | Stage 7, after #29 | **done** (.lrc / tags for local files; LRCLIB, opt-in, for the rest) |
| #26 Dynamic theming | Stage 7 | **done** (player bar and Now Playing view take the cover's colours) |
| #40 Remote control from a phone | Stage 7 | shelved (owner's decision, Nov 2026) |
| #23 Spotify | Stage 2 | on hold |
| #36 Apple Music | Stage 4 | on hold |

### Leftovers from finished stages (no issue yet)

- Remove a track from a custom playlist; delete a playlist (the API and UI
  only create and add today).
- The Repeat button in the player bar does nothing yet.
- Remove the legacy `/search`, `/playlists` and `/api/soundcloud/*` aliases
  (deprecated in v2.0.0).
- From 16 Nov 2026: require `purpose: 'session'` on every login token (old
  tokens without it have expired by then).
- YouTube playback in the installed app is not yet confirmed on a real Mac.
  Settings → System now shows whether yt-dlp and ffmpeg were found
  and the server keeps a log file, so the next failure can be diagnosed.
- Versions in `package.json`, `client/package.json`, `src-tauri/tauri.conf.json`
  and `src-tauri/Cargo.toml` still say 2.0.1 although v2.1.0 was released;
  bump them with the next release.
- Run from source, yt-dlp is not fetched automatically (`bin/` is not in the
  repository): it must be installed or placed in `bin/` by hand.

## Stage 2: Spotify and the match engine (on hold)

Issue: #23 (Spotify login and metadata, audio via YouTube), which is exactly
the free-account plan below.

Goal: Spotify library for everyone, native playback for Premium, YouTube-backed
playback with honest availability for free accounts.

Status: the match engine shipped first (server side, on branch
`stage0-library-foundation`). The Spotify provider, its OAuth, Premium remote
playback and the client work below are still open. What landed:

- `services/matcher/`: `normalize.js` (title parsing into core + variant
  tokens, artist comparison), `score.js` (`evaluate` / `pickBest`),
  `innertube.js` (YouTube Music song and video search, the primary candidate
  source), `ytsearch.js` (yt-dlp `ytsearch` flat JSON, the fallback) and
  `index.js` (the engine: `track_matches` cache with TTLs, ISRC reuse,
  in-flight de-duplication, bounded queue, `resolve`, `resolveMany` with a
  request budget, `filterPlayable`, overrides and reports).
- `config/db.js`: `track_matches` and `match_reports` tables; `initDB(filename)`
  takes a path so tests can open `:memory:`.
- `controllers/matchController.js`: `GET /api/match/:source/:id`,
  `POST /api/match/resolve`, `POST /api/match/override`, `POST /api/match/report`,
  `DELETE /api/match/:source/:id`, all behind our login (`app.js`).
- `controllers/matchedStream.js`: `/stream` and `/duration` for `source=spotify`
  answer `MATCH_REQUIRED` / `TRACK_UNAVAILABLE` / `MATCH_PENDING` and delegate a
  matched track to `YouTubeController.streamVideo` / `durationOf` (split out of
  `streamTrack` / `getDuration`), so the cache key stays the YouTube id.
  Registered in `controllers/streamingController.js`.
- `controllers/libraryController.js`: every track list (playlist tracks, search,
  custom playlists) runs through `filterPlayable` when it holds match-mode
  tracks, hides the unmatched ones and gains `matching`.
- Config: `MATCH_DURATION_TOLERANCE_SEC`, `MATCH_CONCURRENCY`,
  `MATCH_REQUEST_BUDGET_MS`, `MATCH_NOT_FOUND_TTL_MS`, `MATCH_ERROR_TTL_MS`,
  `MATCH_YTDLP_FALLBACK`, `MATCH_YTDLP_RECALL` (`.env.example`, README
  "Matching engine").
- Tests: `tests/matcher.normalize.test.js`, `tests/matcher.score.test.js`,
  `tests/matcher.sources.test.js`, `tests/matcher.engine.test.js`,
  `tests/matcher.e2e.test.js` (the real modules end-to-end on the fixtures),
  `tests/matchRoutes.test.js`, with fixtures under `tests/fixtures/` captured
  from real YouTube Music and yt-dlp output.

Changes from the plan below, made after probing the real services: the
primary candidate source is the YouTube Music search (about 0.5 s per query,
and it carries YouTube's own ATV / OMV / UGC classification, which is the
official-vs-private rule), with yt-dlp `ytsearch` only as a fallback when that
search fails (about 10 s per query); "official" means ATV or OMV, never UGC,
regardless of channel verification (the verified lyric channel 7clouds is
not official); the title must match exactly after normalisation instead of
scoring token overlap; concurrency is 4 (env). The YouTube Music search is
an internal endpoint like the ones yt-dlp reads, so it may need maintenance;
that is what the fallback is for.

Server
- Generic OAuth routes `GET /auth/:source/url` and `GET /auth/:source/callback`. The state JWT carries `userId` and `source`.
- Spotify provider: scopes `user-read-private user-read-email playlist-read-private playlist-read-collaborative user-library-read user-read-playback-state user-modify-playback-state`. After callback, call `/me` and store `product` as `tier`. Implement token refresh here (tokens last 1 hour).
- Search, playlists, playlist tracks, liked songs (`/me/tracks`) and like/unlike, all through the Stage 0 provider interface, so the Library tab and the liked playlist work with no client changes. Normalise every track with `isrc` and `duration_ms`.
- Match engine (shipped, see the status above): `services/matcher/` with tables `track_matches(source_id, external_id, isrc, status, video_id, score, method, candidates_json, checked_at, override_by)` and `match_reports`.
  - Candidates from the YouTube Music search (songs filter, then videos), yt-dlp `ytsearch` as the fallback. No Google quota, no YouTube connection required.
  - Accept only ATV / OMV items (UGC is a private upload), the same artist, the exact normalised title and a duration within 5 s. The score only orders the survivors (catalog audio over music video, full artist coverage, album match).
  - No acceptable candidate: status `not_found`, cached for 30 days; a failed search: `error`, retried after 10 minutes. Queue with concurrency 4; concurrent requests for one track share one resolution.
  - `GET /api/match/:source/:id` returns status and candidates; `POST /api/match/resolve`, `POST /api/match/override`, `POST /api/match/report`, `DELETE /api/match/:source/:id`.
- Stream (shipped): `source=spotify` reads the match row, then the YouTube path.
- Premium remote playback: `/api/player/spotify/devices|play|pause|seek|state` wrapping the Connect API. Honour 429 `Retry-After`.

Client
- Connect Spotify button and a tier badge on the connection.
- Player abstraction in `MusicContext`: `LocalAudioPlayer` (audio element) and `RemoteSpotifyPlayer` (REST plus state polling), same interface. Choose by `track.source`, tier and whether a Spotify device is active. Fall back to match when no device is available.
- Availability states on every row: resolving, ready, unavailable (greyed with tooltip). The audio error handler marks the track unavailable and advances instead of stopping.
- "Wrong match?" button on the now-playing bar and on matched rows. Opens a picker with the top 5 cached candidates, a paste field for a YouTube link or id, and "Not available on YouTube". Saves the override and a report.

Exit criteria: a Premium user plays a Spotify playlist through their Spotify app from our UI. A free user plays the same playlist via YouTube, sees unavailable tracks greyed out, and can correct a wrong match.

Risks: Spotify Development Mode allows a small allowlist of users, about 25; Extended Quota is out of reach for a hobby app. Scoring quality is unknown until reports come in.

Effort: 5 to 8 days.

## Stage 3: Stabilise and improve the build

Goal: the app survives token expiry, extractor breakage and OS updates, and we
make the DRM decision that shapes Stages 4 and 5.

- Generic token refresh for every OAuth source using the stored refresh token. Auto-logout only when refresh fails.
- yt-dlp self-update on startup, or a bundled updater. Health endpoint reports binary versions.
- Replace `pkg` (Node 18 target, unmaintained) with Node single executable applications or a Tauri-managed Node sidecar. Evaluate Tauri v2 for deep links, so OAuth callbacks land in the app instead of a localhost redirect.
- Cache: size-based eviction (for example 500 MB), source-prefixed keys, negative-match TTL.
- Security: encrypt tokens at rest with a key from the OS keychain or env; set a real CSP in `tauri.conf.json`; tokens never leave the server except the Apple user token which must be minted client-side.
- Unified error codes (`SOURCE_NOT_CONNECTED`, `SOURCE_TOKEN_EXPIRED`, `TRACK_UNAVAILABLE`, `SOURCE_TIER_REQUIRED`) and client toasts.
- Tests and CI: provider fixtures, matcher golden set built from mismatch reports, lint the client, build matrix for macOS and Windows.
- **DRM decision gate: decided (c), skip client-sdk.** Rely on remote (Spotify Connect, Premium only) plus match. WKWebView has no Widevine, WebView2 has PlayReady but not Widevine, and there is no Premium or Apple Music subscription to test or use in-app players with. Revisit, starting with MusicKit on macOS, if a subscription is added.

Effort: 4 to 6 days.

## Stage 4: Apple Music (on hold)

Issue: #36. Its in-app MusicKit playback was ruled out by the Stage 3 DRM
decision (option c); catalog search plus match remains possible.

Prerequisites: Apple Developer Program membership, a MusicKit identifier and private key, Team ID, Key ID.

Server
- Sign the developer token (ES256 JWT, up to 180 days) and cache it. `GET /api/apple/developer-token` for the client.
- `POST /api/connections/apple` stores the Music User Token (long-lived, no refresh token). Tier is detected by attempting a library call.
- Apple Music API: catalog search, library playlists and tracks. Apple has no loved-songs endpoint, so the provider maps `liked` to `me/library/songs` and labels it Library Songs. Responses include ISRC, so Apple and Spotify entries of the same recording share one match row.

Client
- Load MusicKit JS, call `authorize()`, send the user token to the server.
- Subscribers play through the MusicKit player when the Stage 3 decision allows it; otherwise the match engine. Non-subscribers get catalog search plus match only, since Apple Music has no library without a subscription.

Effort: 4 to 5 days plus the Apple account lead time.

## Stage 5: Tidal (on hold)

- OAuth PKCE via the Tidal developer portal. Catalog v2 API for search, playlists and favorites; ISRC is present.
- Subscribers play through the Tidal Player SDK under the same DRM decision; everyone else through match.
- Everything else is a copy of the Spotify provider.

Effort: 3 to 4 days.

## Stage 6: Open and self-hosted sources

Quick wins that reuse the provider interface unchanged. Any of these can be pulled forward.

- **Audius: shipped (search and playback).** `providers/audius.js` and
  `controllers/audiusController.js`: `GET /v1/tracks/search` (offset paging),
  `GET /v1/tracks/{id}`, and `GET /v1/tracks/{id}/stream?no_redirect=true`
  (`&preview=true` for a stream-gated track with a preview; gated tracks
  without one show "Not streamable"). Audio goes through the shared transcode
  pipeline (cache key `audius_<id>`, media token, limits). No account or key;
  `AUDIUS_API_KEY` is optional (higher rate limits). Built against Audius's
  OpenAPI spec and tested against a local stand-in; the live API was not
  reachable from the build environment, so the first real search is on a
  user's machine. Next for Audius: the library (favorites, playlists) via a
  public handle or Log in with Audius.
- Jamendo: free app key, Creative Commons catalog, direct stream URLs. Half a day.
- **Deezer (issue #38): shipped.** Deezer's public catalog for search, no
  account (`providers/deezer.js`: `GET /search` paged by `index`,
  `GET /track/{id}` for the ISRC). Results show at once; nothing is matched
  while searching. On play (`controllers/deezerController.js`) the match
  engine looks the track up on YouTube, using Deezer's ISRC, and plays the full
  video through the YouTube path; with no match (or YouTube Music unreachable)
  it plays Deezer's 30 s preview and the player says so. `/duration` reports
  what will really play (`preview: true` for 30 s), so the progress bar is
  right. The issue's OAuth login and full-track Web SDK are not possible
  (Deezer no longer registers new apps; its player is DRM-protected). Built
  against real recorded Deezer responses and tested against a local stand-in;
  the live API was not reachable from the build environment.
- Navidrome, Subsonic, Jellyfin: user enters server URL and credentials as a connection; the server proxies their stream endpoints. One to two days.
- **Local files (issue #24): shipped.** A `local` source over folders the
  user adds in the Library (folder panel: add by path, rescan, remove).
  Folders must be inside the home folder or on another drive / mounted
  volume (`LOCAL_MUSIC_ROOTS` allows more); folder names are not restricted.
  `services/localLibrary.js` scans in the background (no symlinks followed,
  hidden entries skipped, at most 50,000 files and 20 levels per folder),
  reads tags with `music-metadata` (title, artist, album, track number,
  duration, codec; file name when untagged), rescans incrementally (size +
  mtime) and again at every startup. Each folder is a playlist; search covers
  title, artist and album. Playback (`controllers/localController.js`) is by
  track id, scoped to the user, and re-checks that the file's real path is
  still inside its folder; MP3, M4A, AAC, FLAC and WAV are sent as they are
  (HTTP range, native seeking), other formats (OGG, Opus, AIFF, WMA) and any
  unbuffered seek go through ffmpeg. Not yet: album art (embedded covers are
  skipped for now) and a native folder picker in the desktop app.
- **Lossless and audio quality (issue #39): shipped.** YouTube, SoundCloud,
  Audius and Deezer only provide lossy audio, so lossless means local files:
  FLAC and WAV (and MP3, M4A) are sent as they are, in original quality. For
  streamed sources, Settings has an audio quality choice kept on the device:
  Data Saver (96 kbps), Standard (128 kbps, the default) or High (256 kbps).
  `/stream?quality=low|standard|high` picks the MP3 bitrate of the transcode
  (`controllers/transcode.js`); each quality has its own cache entry
  (`<key>_q96`, `<key>`, `<key>_q256`). High cannot add detail the source
  does not have; it avoids losing more in the conversion. Lossless from
  Navidrome / Jellyfin comes with that source.

## Stage 7: Player experience

Everything around playback that is not a new source.

- **Expanded "Now Playing" view with persistent controls (issue #29):
  shipped.** `components/NowPlayingView.jsx`: a drawer that slides up from
  behind the player bar and fills the rest of the window with the cover art,
  title, artist, source and the queue. The player bar does not move (it
  publishes its height as `--player-height`; the drawer stops at its top
  edge), so play / pause, seek and volume stay where they are. Opened from
  the track area of the bar, closed with its button or Escape; focus moves in
  and back; closed, it is `inert`. One column on narrow windows. Cover art
  falls back to a locally drawn placeholder (no third-party image service).
- **Lyrics (issue #30): shipped.** A "Lyrics" tab next to "Up Next" in the
  Now Playing view. Timed lyrics follow the music (the current line is
  highlighted and kept in the middle; choosing a line jumps to it); lyrics
  without times are shown as text; "No lyrics found" and "Instrumental" have
  their own states. Sources, in order (`services/lyrics.js`,
  `GET /api/lyrics`):
  1. The user's own files: a `.lrc` file with the same name next to the
     track, then lyrics in the file's tags. Nothing leaves the computer.
  2. [LRCLIB](https://lrclib.net), a free, open lyrics database (no API key,
     no account; self-hostable, `LRCLIB_URL`). A lookup sends the title,
     artist and length of the playing track, so the app asks first and the
     choice is a switch in Settings; `LYRICS_ONLINE=off` disables it for the
     whole installation. Nothing is asked until the Lyrics tab is opened.
     Answers are cached in the database (`lyrics_cache`; "not found" for a
     day), and timed lyrics are only used when their length matches the
     track's, otherwise only the words.
  Not done: word-by-word highlighting, editing or contributing lyrics.
- **Dynamic theming (issue #26): shipped.** The player bar and the Now
  Playing view take their colours from the playing track's cover: a dark
  shade behind the drawer, a darker one for the bar, a light accent for the
  tab marker, volume and active controls (the seek bar keeps its per-source
  colour, issue #28). Colours are moved along lightness until text on them
  meets WCAG contrast, and a change fades in (not with reduced motion). On by
  default, with a switch in Settings.
  The browser may not read another site's image, so the server does
  (`services/artworkColors.js`, `GET /api/artwork/colors?url=`): it downloads
  the cover, reduces it to 32 x 32 pixels with the bundled ffmpeg and picks
  the dominant hue; each cover is read once (`artwork_colors` table). Because
  the URL comes from the client, the download is fenced in: https only,
  default port, public addresses only (checked on the addresses the socket
  connects to, so DNS cannot point it inwards), redirects re-checked, 5 MB /
  8 s limits, JPEG / PNG / WebP only, and the caller only ever gets colours.
  Not done: covers for local files (embedded art is not read yet, so they
  keep the standard colours), theming of the rest of the app.
- Remote control from a phone (issue #40): **shelved** (owner's decision,
  Nov 2026). For whoever picks it up: it needs a security design first. The
  server only listens on this computer (127.0.0.1) by design, so a phone on
  the network requires an opt-in setting, pairing (for example a one-time
  code shown on the desktop) and an authenticated WebSocket, rather than
  "same Google account" as the issue suggests. Two to three days.

## Stage 8: Performance (in progress)

From a code review and measurements; the full plan, with the numbers and how
each step is checked, is in
[docs/performance-plan.md](docs/performance-plan.md). In short: the app's
own code is fast (local requests 1 to 6 ms, conversion's first byte in 50 to
110 ms), and the wait before a streamed track starts is almost entirely
`yt-dlp`, which is run more often than needed. In order:

0. **Done.** Real timings per play in the log; "Load more" no longer hidden
   behind the player bar.
1. Time to first sound. **Done:** one remembered `yt-dlp` lookup per track
   instead of two or more (YouTube and the sources matched to it); the next
   track is prepared while the current one plays (2.3 s became 0.17 s in the
   test run); seeking inside cached tracks happens in the player (also fixes
   seeking restarting the sound). **Open:** the same for SoundCloud without
   API credentials; stop looking up lengths already known (1.2); how
   `yt-dlp` is run (1.5).
2. Convert to disk at full speed and play from the growing file, so the
   cache completes at once and long tracks are not cut off.
3. Start-up: the window waits for the server; background jobs wait a
   minute; the interface stops re-asking for the same data.
4. Database: batched writes (33 times faster per row), deep paging of large
   folders.
5. Low priority: keep the playback clock from re-rendering the whole app
   (measured at about 1% of a processor core).

## Stage 9: Data that survives and follows the user (planned)

Today the data is one SQLite file on one computer, and a fresh copy of the
source even starts empty. Research, the options compared and the design are
in [docs/cloud-data.md](docs/cloud-data.md). Decided: **Cloudflare D1**,
reached through a small Worker deployed to the user's own free account, with
the local database kept in charge and synced in the background, so the app
stays as fast as it is and works offline. In order:

1. Keep the database in the per-user data folder when run from source too
   (one-time move of an existing one). No cloud needed; fixes "every new
   copy starts empty".
2. Sync groundwork in the local schema (changed-at / deleted-at, stable row
   ids, an installation id).
3. `cloud/`: D1 migrations and the Worker (accounts with closed sign-up,
   push / pull), with tests in the Workers runtime.
4. The sync module, its settings and status under Settings → Accounts, and
   the first-run flows (upload, download, merge).
5. A two-computer run on a real Cloudflare account (needs the owner).

6. Google sign-in through the Worker, so the Google client secret is a
   Worker secret and the YouTube login is stored once, encrypted, in the
   cloud: nothing to paste in on a new computer, and YouTube stays
   connected everywhere. The Worker's address can then be a build setting.

## Parked

Amazon Music and Qobuz expose partner-only APIs. YouTube Music is the same catalog the app already plays. Revisit when their programs open.
