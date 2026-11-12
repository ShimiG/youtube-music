# Performance plan

Status: plan from a code review and measurements (12 Nov 2026). **Built so
far: steps 0, 1.1, 1.3, 1.4, 2.1, 3.1, 3.2 and 4.1** (see "Done so far").
Open: 1.2, 1.5, 2.2, 3.3, 4.2, 4.3 and 5.

## What was measured

On the build machine (Linux, fast SSD), against the real server and client
with a 3,003-track local library. Figures marked "review" come from the
server code review's own benchmarks; the rest were measured for this plan.

| What | Result | Verdict |
|---|---|---|
| Server start (from source, warm disk) | 0.16 to 0.21 s to listening | Fine |
| Server start, first run after boot (cold disk) | about 2.3 s; packaged single executable about 2.7 s | Acceptable; see 3.1 |
| App shell in the browser | 0.12 to 0.2 s | Fine |
| Local API calls (sources, playlists, tracks, search, history) | 1 to 6 ms | Fine |
| Local search over 50,000 tracks (review) | 11 to 13 ms | Fine |
| Local file, click to audio | 125 to 180 ms | Fine |
| Conversion (ffmpeg): first audio byte | 50 to 110 ms; a 4-minute track converts in 2 s | Fine; no tuning needed |
| Interface work while a track plays | about 4 re-renders of the whole app per second, costing 1.1% of a processor core (4.6% on a 4x slower one) | Real, small; low priority |
| Interface work while paused / idle | none | Fine |
| Scan of 3,003 local files | 5.5 s | Acceptable; see 4.1 |
| Database write, row by row vs in one transaction (review) | 0.217 ms vs 0.0065 ms per row (33x) | Worth fixing |
| Paging deep into a 50,000-track folder (review) | 9 ms for the first page, 134 ms for the last | Minor |
| Client bundle | 276 KB (86 KB compressed), one file | Fine |

**Not measurable here:** `yt-dlp`, which finds the audio address for every
YouTube, SoundCloud and Deezer track. It is not reachable from the build
environment. Everything else on the way to the first sound was measured and
is fast, so for a streamed track that has not been played before, the wait
is almost entirely `yt-dlp`, and the review found it is run more often than
needed. That is where this plan starts.

## Done so far

Steps 0, 1.1, 1.3 and 1.4, measured in a real browser against a stand-in
`yt-dlp` that takes 2 seconds per lookup (the real one could not be reached
from the build machine; the owner's log now records the real figures):

| | Before | After |
|---|---|---|
| `yt-dlp` runs per play | 2 | 1 |
| Next track in the queue, time to sound | 2.3 s | 0.17 s (prepared, from the disk cache) |
| Next track when skipped to before it is ready | 2.3 s | 0.25 to 0.75 s (the lookup is shared or remembered) |
| Seek in a previously played track | new stream, `yt-dlp` again | instant, in the player; sound and clock agree |
| Seek in a track still being converted | `yt-dlp` again (2 s) | 50 ms, from the remembered address |

Each play now leaves a line in `logs/server.log`, for example:

```
Play youtube dQw4w9WgXcQ: address 1998 ms (yt-dlp), first audio 68 ms after starting ffmpeg, 2067 ms after the request
Play youtube_dQw4w9WgXcQ: from the disk cache, 0 ms after the request
Prepared youtube dQw4w9WgXcQ in 2399 ms
```

"address" is the lookup: `yt-dlp` (a run was started), `shared` (joined a
run another request had started) or `memory` (remembered, no run). Settings →
System also shows how long `yt-dlp` itself takes to start.

How the next track is prepared: 15 seconds into a track (or 25 seconds
before its end, if it is shorter), the client asks the server to get the
next one ready (`/stream?...&prepare=1`). The server looks the address up
and converts the track straight into the disk cache, as one of at most two
background conversions, and answers at once. If the listener skips ahead
before that has finished, the remembered address still saves the lookup.

### Second round: steps 1.1 (SoundCloud), 2.1, 3.1, 3.2, 4.1

Measured on the build machine against the real server, real ffmpeg and a
30-minute test track served from a local address (so the source is as fast
as it can be; a real one may deliver more slowly).

| | Before | After |
|---|---|---|
| 30-minute track, listener reading like a player with a full buffer: converted after 9 s | 4 MB, then waiting for the listener | 13 MB and growing |
| The same track, completely in the cache | only once the listener had read all of it (30 minutes), and cut off at 10 | about 20 s after it started |
| In the browser: 24 s into that track | browser 3 s ahead; cache incomplete | browser 3 s ahead; **cache complete** (27 MB) |
| Playing it again | conversion again | from the cache in 0.3 s, length known, seeking in the player |
| A second request while a track is being converted (skipping to a track being prepared) | a second ffmpeg, from the start | follows the same file: first audio in 4 ms |
| Listening after a seek, on a long track | cut off after 10 minutes | not cut off |
| `yt-dlp` runs per SoundCloud play without API credentials | 2 | 1 |
| First scan of 3,003 local files | 4.3 s | 3.1 s (what is left is reading the tags) |
| Recording a play (HTTP included) | 2.9 ms | 2.0 ms |
| Window opened before the server is up | first screen incomplete, not repaired | "Starting…", then the complete screen |
| Work started the moment the server is up | `yt-dlp -U` and a rescan of every folder | nothing; both 45 s later, the update once a day |

The database figures are from a fast SSD. The change removes a disk sync
per write, so the gain is larger on slower disks (it is what made one test
file take 56 s on the Windows build machine against 8 s on Linux).

How 2.1 works (`controllers/transcode.js`): a full play that may be cached
is a *conversion job*. ffmpeg writes `<key>_<time>.part` as fast as it can;
each response opens that file and sends what is there, then the rest as it
is written, at the pace its client reads. When ffmpeg is done the file
becomes `<key>.mp3`. Anyone who asks for the track meanwhile follows the
same job. Seeks, previews and files that are not cached still go straight
from ffmpeg to the response.

Limits on a job: ten minutes when nobody is listening (a prepared track, or
one whose listener left; at most two such at a time, as before); stopped
when its source sends nothing for a minute; three hours as a backstop. A
straight-to-the-response conversion is stopped when its listener leaves.

Not covered yet: step 1.2.

## Where the time goes

1. **Starting a streamed track**: `yt-dlp` is started twice per play (once
   for the audio address, once for the length), again on most seeks, and
   again for the next track, because nothing remembers its answer.
2. **The next track never starts early**: the "load the next track ahead of
   time" code only fires for tracks that are already files; for a streamed
   track it never runs, so every track change pays the full wait.
3. **Conversion is tied to how fast the player reads**: the converter is
   paused whenever the player's buffer is full, so the disk cache only
   completes when the track ends, and anything longer than ten minutes of
   wall time risks being cut off.
4. Smaller things: work done right at start-up, row-by-row database writes,
   repeated identical requests from the interface.

## The plan

Effort: S = up to half a day, M = about a day, L = several days. Each item
says how it is checked, so a change that does not help can be dropped.

### 0. First: see the real numbers (S)

Write one line per play to the log (already kept in `logs/server.log`):
source, cache hit or miss, milliseconds to resolve the audio address,
milliseconds to the first audio byte, and how many times `yt-dlp` ran. Show
`yt-dlp`'s own start time in Settings → System. Everything below is then
judged against numbers from the owner's Mac, not estimates.

Also fix, found while measuring: **"Load more" ends up hidden behind the
player bar** (the page leaves 20 px at the bottom, the bar is 96 px high).

### 1. Time to first sound (biggest gain)

- **1.1 One lookup per track, remembered (M).** Today
  `controllers/YouTubeController.js` runs `yt-dlp -g` for the address and
  `yt-dlp --print duration` for the length as two processes, and the client
  asks for both at once. Replace with one resolver: a single `yt-dlp` run
  that returns address and length, shared by concurrent requests, and kept
  in memory until the address expires (the address carries its own expiry
  time). `/stream`, `/duration`, seeking and preloading all use it. Same for
  SoundCloud without API credentials (`controllers/soundcloud/ytdlp.js`).
  *Check:* the log shows one `yt-dlp` run per track instead of two or more.
- **1.2 Do not ask for what is already known (S–M).** Store track lengths in
  the database; fill YouTube playlist pages with lengths in one API call per
  50 items; let Deezer use the length the match engine already stored, and
  check the disk cache before calling Deezer's API
  (`controllers/deezerController.js`, `services/matcher/index.js`).
  *Check:* replaying a cached track starts no `yt-dlp` at all.
- **1.3 Make "load the next track early" work (M).** It is gated on the
  audio element's own length, which is unknown for a converted stream
  (`client/src/context/MusicContext.jsx`). Trigger it from the length the
  app already knows, about 20 seconds before the end, and add a server
  "prepare" call that resolves the address and fills the cache without
  playing. *Check:* the gap between two queued tracks drops to well under a
  second.
- **1.4 Seeking (S).** When the audio is a file with a known length (a
  cached track, a local file), set the position in the player directly
  instead of asking the server for a new stream. This also fixes a bug: the
  cache check ignores the seek position, so seeking in a previously played
  track restarts the sound from the beginning while the clock jumps ahead.
  Server-side seeks reuse the remembered address from 1.1.
  *Check:* seek in a cached track; sound and clock agree, no `yt-dlp` run.
- **1.5 How `yt-dlp` is run (S, measure first).** Add `--ignore-config`;
  test whether `--no-check-formats` and narrower extractor options shorten
  the run; and check which build is bundled: the single-file macOS and
  Windows builds unpack themselves on every start, the folder builds do not.
  *Check:* `yt-dlp --version` time before and after.

### 2. Conversion that does not depend on the player

- **2.1 Convert to disk at full speed, play from the growing file (M).**
  Today ffmpeg's output is piped to the response and the cache file at once
  (`controllers/transcode.js`), so a full player buffer pauses ffmpeg. With
  ffmpeg writing the cache file as fast as it can and the response reading
  along behind it, the cache completes within seconds, long tracks are no
  longer at risk from the ten-minute safety limit, and a preloaded track is
  really ready. *Check first:* play a 30-minute video that is not cached and
  watch the cache file grow; this confirms the problem before any change.
- **2.2 Do not re-encode MP3 to MP3 (S–M).** SoundCloud and Audius often
  deliver MP3 already; copying it through instead of re-encoding saves
  processor time and a generation of quality. Only when the chosen audio
  quality allows it. *Check:* processor time per track in the log.

### 3. Start-up and moving around the app

- **3.1 The window should wait for the server (S).** In the installed app
  the window opens while the server is still starting (up to about 2.7 s on
  a cold disk). The first requests then fail, and the list of services is
  not asked for again, which leaves the first screen empty. Retry the first
  requests for a few seconds with a "Starting…" state.
  *Check:* start the app right after a reboot; the first screen is complete.
- **3.2 Do not compete with the first click (S).** `yt-dlp -U` and the
  rescan of local folders start the moment the server is up (`server.js`).
  Start both 30 to 60 seconds later, and check for a `yt-dlp` update once a
  day instead of on every start.
- **3.3 Stop asking twice and forgetting (M).** `/api/sources` is requested
  twice at start-up, and every switch between Search, Library and Settings
  fetches the same data again and drops what was on screen (search results
  included). Keep these answers in one small client-side store: show what
  is known at once, refresh in the background.
  *Check:* switching views makes no request and loses nothing.

### 4. Database

- **4.1 Write in batches (S).** Set `synchronous = NORMAL` (safe with the
  write-ahead log already in use), add a transaction helper to
  `config/sqlite.js`, write scanned files 500 at a time
  (`services/localLibrary.js`) and the three writes of a history entry as
  one. Measured 33 times faster per row. *Check:* scan time for the 3,003
  file test library, before and after.
- **4.2 Deep pages of a large folder (S–M).** Add an index matching the
  sort order and page by "after this row" instead of "skip N rows"
  (`providers/local.js`). 134 ms becomes about 9 ms at 50,000 tracks.
- **4.3 Small things (S).** Drop the index that duplicates a unique one;
  stop creating the data folder on every log line (`services/paths.js`).

### 5. Interface work during playback (low priority)

Measured at about 1% of a core, so this is tidiness, not a fix for anything
a user would feel today. Worth doing before the interface grows further.

- **5.1 Keep the playback clock out of the main state (M).** The position
  updates four times a second and sits in the same context as everything
  else, so the whole app re-renders with it. Give the clock its own small
  store that only the seek bar and the lyrics subscribe to.
- **5.2 Lyrics (S).** With the lyrics tab open every line is re-rendered on
  each tick; only the current line needs to change.
- **5.3 Cover images (S).** Load row images lazily and ask YouTube for the
  small thumbnail in lists instead of the 480-pixel one.

## Checked and left alone

Server start-up when warm; local API speed; the main database queries (all
use an index); local search; ffmpeg's arguments; the cache-hit path; the
client bundle size; memory (every in-memory cache is bounded); third-party
calls in the match engine, lyrics and cover colours (cached, de-duplicated).

## Order

0 → 1.1 → 1.4 → 1.3 → 2.1 → 3.1 → 4.1 (all done), then the rest by what
the numbers from step 0 show on the owner's computer: 1.2 and 1.5 if the
`yt-dlp` time in the log is the larger part of the wait, 3.3 for moving
around the app.

## With cloud sync (Stage 9)

Sync never sits on the path of a request: changes are batched and sent in
the background, and reads stay local, so none of the figures above get
worse. See [cloud-data.md](cloud-data.md).
