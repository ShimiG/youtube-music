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
   - `client-sdk`: the service's DRM player runs inside the webview (Apple MusicKit, Tidal Player, Spotify Web Playback). Blocked on Widevine availability in Tauri; see Stage 3 decision gate.
5. **"Wrong match?" is a feature of the match mode, not of Spotify.** Any track
   played through `match` shows the button. It applies to Spotify free, Apple
   Music and Tidal without subscription, and Deezer.
6. **Tracks carry `source` everywhere.** Search results, playlist rows, history,
   custom playlists, stream URLs and cache filenames all include the source.

## Target service matrix

| Service | Connect | Playlists | Liked songs source | Paid tier playback | Free / no subscription | Stage |
|---|---|---|---|---|---|---|
| YouTube | Google OAuth | Own playlists | `videos.list myRating=like`, music category only. Liking needs the write scope | server-stream (no premium needed) | same | shipped |
| SoundCloud | saved public profile URL | Public playlists via yt-dlp | `soundcloud.com/<user>/likes` via yt-dlp, read-only | n/a | server-stream; Go+ tracks are 30 s snippets | 1 |
| Spotify | OAuth, 1 h token + refresh | Own and followed playlists | `GET /me/tracks`, like via `PUT /me/tracks` | remote (Spotify Connect) | match | 2 |
| Apple Music | MusicKit user token (minted in client) | Library playlists (subscribers only) | No loved-songs endpoint; `me/library/songs` stands in, labelled Library Songs | client-sdk (DRM) | match, catalog search only | 4 |
| Tidal | OAuth PKCE | Own playlists | Favorite tracks endpoint | client-sdk (DRM) | match | 5 |
| Audius | none, or a public handle | Public playlists | `users/{id}/favorites`, read-only | server-stream, free | same | 6 |
| Jamendo | app key | none | none without user OAuth | server-stream, free | same | 6 |
| Deezer | none | none for new apps | none | none supported | match, plus 30 s previews | 6 |
| Navidrome / Subsonic / Jellyfin | server URL + credentials | Own playlists | Starred (Subsonic) or favorites (Jellyfin) | server-stream | same | 6 |
| Amazon Music, Qobuz | partner-only APIs | | | | | parked |
| YouTube Music | covered by YouTube | | | | | n/a |

## Stage 0: Library foundation

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

### Adding a new service after Stage 0

1. `providers/<name>.js` implementing the interface and declaring capabilities.
2. One row in `sources` and one entry in `utils/services.js` with label, icon and connect action.
3. If OAuth: scopes and tier lookup inside the provider's `auth` block. The generic `/auth/:source` routes do the rest.
4. Fixtures and normalisation tests for that provider.

Nothing else changes.

## Stage 1: SoundCloud

Goal: a second audio source with zero credentials.

Server
- SoundCloud provider: search with yt-dlp `scsearch30:<q>` using `--flat-playlist -j`; stream via `https://api.soundcloud.com/tracks/<id>` through the existing yt-dlp to ffmpeg path; duration via yt-dlp. Flag Go+ snippets as `preview: true`.
- Connection kind `profile-url`: the user saves a public SoundCloud profile URL. `getPlaylists` reads the profile's public sets and `getLikedTracks` reads `soundcloud.com/<user>/likes`, both via yt-dlp flat playlists. Read-only, so `like` is not declared.
- Stream endpoint: require `source`, validate the id per provider, and name cache files `<source>_<id>.mp3` so numeric SoundCloud ids cannot collide with YouTube ids.
- History and custom playlists: accept `source` from the client and drop the hardcoded `youtube`.

Client
- Track objects gain `source`. `MusicContext` includes it in play, seek and preload stream URLs and in the history POST.
- Search switch shows SoundCloud. Library dropdown shows SoundCloud once a profile URL is saved; the connect action for this source is a small URL form instead of a redirect.

Tests: stream routing per source, 400 on unknown source, yt-dlp search JSON parsing with fixtures, cache filename prefix, profile likes normalisation.

Exit criteria: search and play a SoundCloud track with no API keys; a saved profile shows its playlists and likes in the Library. YouTube behaves exactly as before. All tests green.

Risks: yt-dlp breaks when SoundCloud changes (Stage 3 adds self-update). Search spawns a process and takes 2 to 4 s; debounce and show a spinner.

Effort: 2 days.

## Stage 2: Spotify and the match engine

Goal: Spotify library for everyone, native playback for Premium, YouTube-backed
playback with honest availability for free accounts.

Server
- Generic OAuth routes `GET /auth/:source/url` and `GET /auth/:source/callback`. The state JWT carries `userId` and `source`.
- Spotify provider: scopes `user-read-private user-read-email playlist-read-private playlist-read-collaborative user-library-read user-read-playback-state user-modify-playback-state`. After callback, call `/me` and store `product` as `tier`. Implement token refresh here (tokens last 1 hour).
- Search, playlists, playlist tracks, liked songs (`/me/tracks`) and like/unlike, all through the Stage 0 provider interface, so the Library tab and the liked playlist work with no client changes. Normalise every track with `isrc` and `duration_ms`.
- Match engine `services/matcher.js` with table `track_matches(source_id, external_id, isrc, yt_video_id, status, score, candidates_json, checked_at, override_by)`.
  - Resolve with yt-dlp `ytsearch5:"<artist> <title>"`. No Google quota, no YouTube connection required.
  - Score: duration within 3 s, artist and title token overlap, prefer auto-generated "Topic" channels and "official audio", penalise live, cover, karaoke, remix and sped-up unless the Spotify title contains the same word.
  - Below threshold: status `not_found`, cached for 30 days. Queue with concurrency 2 for background resolution.
  - `GET /api/match?source=&id=` returns status and candidates; `POST /api/match/report` stores an override and a report.
- Stream: `source=spotify` resolves through the matcher, then the YouTube path.
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
- **DRM decision gate.** Spike the Spotify Web Playback SDK inside WebView2 (Windows) and WKWebView (macOS). Decide one of: client-sdk on Windows only; move the shell to a Widevine-enabled Electron build; or skip client-sdk entirely and rely on remote plus match. Stages 4 and 5 follow this decision.

Effort: 4 to 6 days.

## Stage 4: Apple Music

Prerequisites: Apple Developer Program membership, a MusicKit identifier and private key, Team ID, Key ID.

Server
- Sign the developer token (ES256 JWT, up to 180 days) and cache it. `GET /api/apple/developer-token` for the client.
- `POST /api/connections/apple` stores the Music User Token (long-lived, no refresh token). Tier is detected by attempting a library call.
- Apple Music API: catalog search, library playlists and tracks. Apple has no loved-songs endpoint, so the provider maps `liked` to `me/library/songs` and labels it Library Songs. Responses include ISRC, so Apple and Spotify entries of the same recording share one match row.

Client
- Load MusicKit JS, call `authorize()`, send the user token to the server.
- Subscribers play through the MusicKit player when the Stage 3 decision allows it; otherwise the match engine. Non-subscribers get catalog search plus match only, since Apple Music has no library without a subscription.

Effort: 4 to 5 days plus the Apple account lead time.

## Stage 5: Tidal

- OAuth PKCE via the Tidal developer portal. Catalog v2 API for search, playlists and favorites; ISRC is present.
- Subscribers play through the Tidal Player SDK under the same DRM decision; everyone else through match.
- Everything else is a copy of the Spotify provider.

Effort: 3 to 4 days.

## Stage 6: Open and self-hosted sources

Quick wins that reuse the provider interface unchanged. Any of these can be pulled forward.

- Audius: open API, `GET /v1/tracks/search` and `GET /v1/tracks/{id}/stream`, no auth. Half a day.
- Jamendo: free app key, Creative Commons catalog, direct stream URLs. Half a day.
- Deezer: public search returns 30 s preview MP3s with no auth; there is no user API for new apps. Treat as a catalog source with match; ISRC is present. One day.
- Navidrome, Subsonic, Jellyfin: user enters server URL and credentials as a connection; the server proxies their stream endpoints. One to two days.

## Parked

Amazon Music and Qobuz expose partner-only APIs. YouTube Music is the same catalog the app already plays. Revisit when their programs open.
