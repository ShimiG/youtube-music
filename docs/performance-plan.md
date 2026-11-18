# Performance plan

Status: plan from a code review and measurements (12 Nov 2026). **Built:
every step** (see "Done so far"), plus rounds on what came up afterwards
(the cost of cloud sync, the next track in ordinary use). Of step 1.5 the
larger half is done (a yt-dlp that starts quickly); the flags it is run with
are left, to be judged on the owner's computer.

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

### Third round: steps 3.3, 4.2, 4.3 and 5.1 to 5.3

Measured in a real browser against the real server, old and new client side
by side, with a local folder of 3,004 tracks.

| | Before | After |
|---|---|---|
| Requests for the list of sources at start-up | 2 | 1 |
| Search, go to the Library, come back | results and the typed text gone; 3 requests | still there; 1 request (the Library's first load), none on the way back |
| Library with a playlist open and scrolled, go to Search, come back | playlist closed, back at the top; 3 requests | still open, same scroll position; no request |
| Script work while a track plays, list on screen | 4.2 to 4.3 ms per second | 1.6 to 1.8 ms per second |
| Last page of a 50,000-track folder | 79 ms | 0.6 ms |
| All 250 pages of that folder | 15.1 s | 0.2 s |
| First page of that folder | 9 ms | 3 ms (no sorting step) |

How:

- **3.3** Search, Library and Recently Played stay alive once opened and are
  only hidden while another view shows (`client/src/App.jsx`), each with its
  own scroll position. The list of sources is one shared copy, asked for
  once (`client/src/hooks/useSources.js`). Recently Played asks the server
  only when something was played since it last asked. The Library refreshes
  on its own when a track is added to a playlist or liked elsewhere in the
  app, and when it is opened after more than five minutes.
- **4.2** A folder is paged by "the rows after this one" with an index in
  the listing order (`providers/local.js`, `idx_local_tracks_order`).
- **4.3** The index on `local_tracks(folder_id)` is dropped: two others
  start with the same column. (Creating the data folder on every log line
  was already fixed with the data-folder change.)
- **5.1** The playback position is kept outside the music context
  (`client/src/utils/playbackClock.js`); only the seek bar and the timed
  lyrics follow it.
- **5.2** Timed lyrics render when the line changes, not on every tick.
- **5.3** Row and card images load lazily, and lists ask YouTube for the
  320-pixel cover instead of the 480-pixel one.

### Fourth round: steps 1.2 and 2.2

Measured against the real server and real ffmpeg, with a stand-in `yt-dlp`
that takes 1 second per look-up and counts its runs.

| | Before | After |
|---|---|---|
| `yt-dlp` runs to replay a cached track after the app was restarted | 1 (for the length alone) | 0 |
| The length of a track seen before | a `yt-dlp` run (1 s here, 1 to 3 s in reality) | 3 ms, from the database |
| A YouTube playlist page of 50 tracks | no lengths: one `/duration` request per track played | lengths on the page; one extra API call the first time, none afterwards |
| A Deezer track matched before | one Deezer request per play | none |
| A 4-minute SoundCloud MP3, ready in the cache | 2.26 s (decoded and encoded again) | 0.26 s (passed through), and no second round of lossy compression |

How:

- **1.2** `services/trackLengths.js` keeps track lengths in the database
  (`track_lengths`) as they are learned: from a `yt-dlp` look-up, from the
  lists the services send, from the YouTube API, from the match engine.
  `/duration` reads it before starting `yt-dlp`. Lists are completed from
  it before they are sent (Recently Played, custom playlists, YouTube
  playlists), so the player usually does not ask at all; for a YouTube
  playlist page the lengths still missing come from one `videos.list` call
  (one quota unit) and are remembered. Deezer plays a track that was
  matched before straight from the stored match. Only YouTube and
  SoundCloud lengths are stored: a Deezer track may play as a 30-second
  preview, so its catalogue length says nothing.
- **2.2** A source that is MP3 already (SoundCloud's `http_mp3` and
  `hls_mp3` renditions) is passed through with `-c:a copy`
  (`controllers/transcode.js`), at standard and high quality; `low` still
  converts, since it exists to make the audio smaller. Should ffmpeg be
  unable to pass a source through (it was not MP3 after all), it gives up
  before writing anything and the track is converted instead, once, without
  the listener noticing. Not done for Audius: its streams are not known to
  be MP3 in every case.

### Fifth round: what cloud sync costs

Not in the original plan: cloud sync was built after it. Measured with the
real sync code against a stand-in cloud that answers at once, so the figures
are the work done on this computer.

A sync run read every record the user has (all playlists, all their tracks,
the history), hashed each one and compared it with what the cloud last
agreed on. That ran after every play (four seconds later) and every five
minutes. The database is read on the server's only thread, so while it ran
the server answered nothing else.

| Playlist tracks | Run after a play: before | After | Timed run with nothing to report: before | After |
|---|---|---|---|---|
| 200 | 5 ms | under 1 ms | 6 ms | under 1 ms |
| 6,000 | 102 ms | 2 ms | 84 ms | 1 ms |
| 30,000 | 497 ms | 3 ms | 478 ms | 2 ms |

How (`services/cloud/sync.js`, `services/cloud/records.js`): whoever
changes something says in which collection (`touch(userId, ['history'])`
after a play), and the run that follows reads only that, plus anything
still waiting to be sent from a run that failed. The timed runs in between
only fetch what other computers changed. Everything is still read at
start-up, on "Sync now", on linking, and once an hour, as a safety net for
a change nobody reported; and during that read the comparing is done in
pieces, so other requests get a turn. A partial index answers "is anything
still unsent?" without looking at the records.

Left as it is: a change to a playlist reads all playlists and their tracks
(about 0.1 s at 6,000 tracks). They are read in one piece on purpose: a
track missing from the read is taken for deleted and the deletion is sent
on, so reading them in instalments while they may change would risk data.

### Sixth round: the next track, in ordinary use

Step 1.3 gets the next track ready while the current one plays. It needs a
next track: clicking a song in a playlist made a queue of that one song, so
there was nothing to prepare, the music stopped when the song ended, and
the Next button did nothing. Only "Play All" filled the queue. Measured in
a browser with a stand-in `yt-dlp` that takes 2 seconds:

| | Before | After |
|---|---|---|
| A track clicked in a playlist ends | silence | the next one starts by itself, 0.7 s after the last sound |
| Getting to the following track | a click on it, then 2.4 s | Next: 0.3 s |
| "Play All" on a list of N tracks | N separate updates of the queue | one |

How: a track clicked in a playlist plays as part of it
(`playFrom` in `client/src/context/MusicContext.jsx`). The tracks loaded so
far become the queue, positioned at the clicked one, so playback carries on
down the list and Previous goes back up it. A long queue draws only the
rows near the screen. Search results and Recently Played are unchanged: a
click there still plays that one track.

Also measured and left alone: the packaged server answers 0.2 s after it is
started (warm disk). A V8 code cache made that 0.16 s, but it does not work
together with the two dynamic imports in the bundle, and 40 ms is not worth
that risk. Minifying the bundle made no difference to the start.

### Seventh round: step 1.5, a yt-dlp that starts quickly

The figure from the owner's Mac (Settings → System, 16 Nov 2026): **yt-dlp
starts in 7.8 s**. Every track that is not in the cache waited at least that
long before anything else happened; it is the largest delay there was left.

The cause is the build, not the Mac. Both the installers and a copy placed
in `bin/` use yt-dlp's single-file build (`yt-dlp_macos`, `yt-dlp.exe`),
which unpacks itself into a new temporary folder on every run, and macOS
scans what was unpacked each time. yt-dlp also publishes a folder build of
every release, which is unpacked once and then simply starts.

What the app does now (`services/ytdlpFolder.js`, `services/unzip.js`):

- 45 seconds after start it measures how long the yt-dlp in use takes to
  start. Within 1.5 s (a Homebrew or pip install): nothing is done. Slower,
  or no yt-dlp at all: it downloads the folder build of the latest release
  into the data folder (`bin/yt-dlp-folder/`).
- The download is checked against the checksums the release publishes,
  unpacked by the app's own code (which refuses names that leave the
  folder, symbolic links, and anything larger than it claims to be), and
  then **tried**: it must run, and start faster than what is there. Only
  then is it used, from the next look-up on, without a restart. If it is
  not faster, nothing changes and it is not tried again for a week.
- The folder build cannot update itself, so the daily look compares the
  release's checksum with the installed one (a one-kilobyte request) and
  fetches a new release the same way. A release that does not run leaves
  the working one in use.
- Not done when `YTDLP_PATH` names a yt-dlp, or `YTDLP_AUTO_UPDATE=false`.
  Downloads come from GitHub's own hosts only.

Measured: on the build machine (Linux) the whole path ran against the real
release once: downloaded, checksum matched, unpacked, tried; that folder
build started in 0.56 s. It has **not** been run on a Mac. What to expect
there is the difference between 7.8 s and well under a second per look-up;
Settings → System shows the real figure after the switch, and the log has a
line `yt-dlp: now using the folder build …: starts in … ms instead of … ms`.

Left as it is: the installers still carry the single-file build, as the
copy that works with no connection on the first start; the folder build
replaces it within the first minute. Carrying the folder build in the
installer itself would save that minute and needs trying on a Mac.

### Eighth round: the app says what each play did

The timings were in the log since step 0, and so was the reason when a track
failed. In practice neither reached anyone: a log has to be found and
copied, and what the app itself said was "Failed to load audio. Skipping to
next track." with nothing to tell a video YouTube refuses from a yt-dlp that
is out of date, a full disk or a server that is busy.

Now the server keeps the last 60 plays in memory (`services/playReport.js`):
when each was asked for, how long until the first sound, how much of that
was finding the audio address and where the address came from (a yt-dlp
run, one already under way, memory), whether it came from the cache, and
for a failure the words of whatever failed (yt-dlp's `ERROR:` line, ffmpeg's
complaint, the rate limit). Requests that only prepare the next track and a
browser's follow-up requests for a later part of a file are left out.

- `GET /api/system/plays` hands them out, newest first. An account sees its
  own plays, the first account everyone's.
- The message when a track cannot be played carries the reason, for example
  `"…" could not be played (yt-dlp: ERROR: [youtube] …: Sign in to confirm
  you're not a bot). Skipping to the next track.`
- **Settings → System → Recent plays** lists them with the time each took.

Two kinds of failure leave nothing in the log at all, and both are covered:

- A request that no handler sees: turned away by the rate limit, or with a
  media token that was refused. Each is noted as a failed play.
- A failure on the player's side. The player tells the server what the
  browser said (`POST /api/system/plays/player-error`), and that goes into
  the same entry: "the server sent the audio after 2.0 s; the player
  reported: …" means the browser could not use what it got; "no request for
  this track reached the server" means the request went somewhere else or
  nowhere (another program on the port, something blocking it).

Checked in the browser against a stand-in yt-dlp (2 s per look-up) with a
playlist of four: one refused by "YouTube", one whose audio address was dead
(ffmpeg: `Server returned 404 Not Found`), two that play. Both reasons
appeared in the messages and in the list; the two that played show "Finding
the audio took 2.0 s … Sound after 2.1 s". And with the browser made to
drop one request and to garble the audio of another: "no request for this
track reached the server" and "the server sent the audio, but the player
did not play it: … (media error 4)".

Also checked, because the owner's Mac showed every track failing with an
empty log: the released v2.2.2 with a yt-dlp that takes 12 s per look-up.
It plays (after 12 s) and logs the play, so a slow yt-dlp alone is not what
fails there.

### What the report showed on the owner's Mac (16 Nov 2026)

Every YouTube track: "ffmpeg could not get any audio from the source" after
3 to 4 s, and nothing in the log. yt-dlp answered (in about 3 s, with the
folder build: it starts in 0.2 s there instead of 7.3 s), and ffmpeg then
produced nothing and said nothing the app looked for. Three things followed.

- **yt-dlp had no JavaScript runtime.** Its own source says what that
  means: it only looks for deno, and with none it uses a single limited
  YouTube client ("extraction without a JS runtime has been deprecated, and
  some formats may be missing"). The server now tells it which runtime to
  use: its own Node, or in the installed app a deno or Node found on the
  computer (`services/ytdlp.js`, `YTDLP_JS_RUNTIME`). Settings → System
  shows the runtime, or that there is none.
- **ffmpeg fetched the address without yt-dlp's request headers.** yt-dlp
  names the headers it would use (`http_headers`) and passes them on when it
  runs ffmpeg itself; the app did not. Now it does, for the playlist and for
  every segment of an HLS rendition. Checked with a real ffmpeg against a
  source that answers 403 without the right `User-Agent`: no audio before,
  audio after.
- **The reason no longer depends on ffmpeg's wording.** The app kept a
  complaint only when the text contained "Error" or "Invalid". Now the last
  lines ffmpeg wrote are kept whatever they say, the source's answer first
  ("HTTP error 403 Forbidden"), with how the process ended (exit code, or
  the signal that ended it), and the same goes to the log. Each play also
  shows what yt-dlp chose ("format 234, m3u8_native, mp4a.40.2") and its
  first warning. Signed addresses are cut down to the host in all of it.

Also: a source that decodes badly used to write thousands of ffmpeg lines to
the log (megabytes for one SoundCloud track); now the first five per
conversion and a count of the rest.

Not known yet: whether this is the whole cause on that Mac. It has not been
run against YouTube here (no access from the build machine). If a track
still fails, the list now carries ffmpeg's own answer and the rendition.

Cost: with a runtime yt-dlp asks more of YouTube per look-up. The time per
look-up is in the same list.

### It was not the whole cause: YouTube refuses ffmpeg (16 Nov 2026, later)

With the runtime and the headers in place the list on that Mac said, for
every track: `ffmpeg: https://rr4---sn-….googlevideo.com/... Server returned
403 Forbidden`. YouTube's media servers no longer hand the audio to a
program that simply asks for the address. yt-dlp's source shows how it asks
itself: in ranged pieces (`http_chunk_size`, or the address cut into
`range=` fragments), which a plain request by ffmpeg is not.

So the app stopped fetching YouTube audio with ffmpeg. yt-dlp downloads it
and writes it to its standard output; ffmpeg converts what it reads from
there (`controllers/YouTubeController.js`, `downloadFeed`;
`controllers/transcode.js`, `connectFeed`):

    yt-dlp -f bestaudio/best -o - <video>  |  ffmpeg -i pipe:0 ... -f mp3 -

- What yt-dlp can download, the app can play. When YouTube changes again,
  a newer yt-dlp is the fix, and the app keeps yt-dlp up to date itself.
- One yt-dlp run per play, as before: the look-up is the first thing that
  run does. The length and the rendition it chose come out of the same run.
- The downloader never outlives the conversion: whatever ends ffmpeg (the
  listener leaving, a limit, an error) ends yt-dlp too.
- When the download fails, the reason shown is yt-dlp's own
  (`yt-dlp: ERROR: … HTTP Error 403: Forbidden`), and the request is
  answered with 502 instead of an empty success.

What it cost: a seek in a track that is not in the cache yet started a new
download and read up to the position (a pipe cannot be searched), where it
used to reuse a remembered address. The next round took that cost away.

Checked with real ffmpeg and a stand-in yt-dlp that writes an Opus file to
its output: a whole play (40.0 s of audio out of 40), a seek to 25 s (15.0 s
out), a refused download (502 with yt-dlp's words, in the message and in the
list), in the browser too, and no process left behind afterwards. **Not**
run against YouTube: the build machine cannot reach it. Whether yt-dlp's
own download works on a given computer is what decides now; this command
shows it in a terminal:

    yt-dlp --js-runtimes node -f bestaudio -o test.audio "https://www.youtube.com/watch?v=<id>"

Open: SoundCloud through yt-dlp still hands ffmpeg an address. Its AAC
renditions decode as noise there (the megabytes of ffmpeg errors in the
owner's log); the same pipe would let yt-dlp fetch and unpack them.

### Ninth round: a seek joins the conversion that is running

A play converts the whole track into the cache as fast as the source
delivers it, well ahead of the listener. A seek during that time did not
use it: it started a second yt-dlp and a second ffmpeg, which downloaded
the track again and read through it up to the position. For a two-hour set
that is a long wait, and two downloads of the same thing.

Now such a seek reads from the conversion that is already running
(`controllers/transcode.js`, `follow` with `fromSeconds`). What a
conversion writes is constant-bitrate MP3, so a time is a byte position
(128 kbit/s: 16,000 bytes a second); the stream starts at the next place a
frame begins (`services/mp3Frames.js`), and when the conversion has not got
that far yet, the listener waits for it to arrive there, nothing more.

Measured with real ffmpeg and a stand-in yt-dlp (1 s look-up, a 20-minute
track delivered in 30 s), seeking 6 s after the track started:

| | before | after |
|---|---|---|
| seek to 1:00 (already converted) | 2.56 s | 0.005 s |
| seek to 15:00 (not converted yet) | 23.7 s | 17.6 s |
| yt-dlp downloads for the three requests | 3 | 1 |

Both streams decode without a single error and are exactly as long as they
should be (1140.0 s and 300.0 s). With the real yt-dlp the first figure
includes its look-up, about 3 s on the owner's Mac.

Not for a source that is passed through as it is (SoundCloud's own MP3):
its bitrate is its own and may vary, so there a seek still converts from
the position. Once a track is in the cache, seeks are served from the file
as before.

### Tenth round: SoundCloud's AAC renditions are downloaded by yt-dlp

The owner's log of 15 Nov held thousands of ffmpeg lines for one SoundCloud
track ("channel element 2.12 is not allocated", "Prediction is not allowed
in AAC-LC", ...), megabytes in all, and what played was noise. Without API
credentials SoundCloud goes through yt-dlp, which prefers an MP3 rendition;
where a track has none, it chose an AAC one (`hls_aac_160k`, sometimes
`hls-aes_aac_...`) and the app handed ffmpeg that address. Those renditions
are HLS of MP4 fragments, some encrypted, which yt-dlp's own extractor marks
as needing its handling (`container: m4a_dash`); ffmpeg fetching them itself
decoded them as garbage.

Now an AAC or Opus rendition is downloaded by yt-dlp and piped into ffmpeg,
like YouTube (the pipe moved to `services/ytdlpFeed.js`, which both use).
The look-up still decides which rendition and whether it is a preview, so a
preview stays out of the cache; the download is asked for exactly that
rendition. MP3 renditions are handed over as before and passed through
without conversion: that path works and is the faster one.

Checked with real ffmpeg: MP4 fragments of AAC, as yt-dlp writes them, read
from a pipe: 30.07 s out of 30, no decode errors; through the server with a
stand-in yt-dlp, the same, first byte after 0.07 s, cached, the replay from
the cache in 0.008 s. Not checked against SoundCloud itself (no access from
the build machine). Not changed: the official API path (with credentials),
which picks MP3 first and hands over its AAC address otherwise.

### Still open

- **A JavaScript runtime for the installed app: fetched, not yet seen
  working on a Mac.** The installed app is not a Node that can run a
  script. Where the computer has no deno or Node either, it now fetches deno
  from deno's releases into the data folder (`services/jsRuntimeFetch.js`):
  checked against the published checksum, unpacked by the app's own code,
  tried (`deno --version`) before yt-dlp is pointed at it, and looked at
  again once a week. Tested with stand-ins for the network and the program;
  the real download and the real deno have not been run from here.

- **The flags `yt-dlp` is run with** (the other half of 1.5). Only
  comparable against the real thing. Settings → System → Recent plays now
  shows the time per look-up on the computer that matters, without the
  start-up time hiding everything else and without reading a log.

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

0 → 1.1 → 1.4 → 1.3 → 2.1 → 3.1 → 4.1, then 3.3, 4.2, 5, 1.2 and 2.2 (all
done). What is left is 1.5, which needs the `Play …` lines from the owner's
log: they show how long the real `yt-dlp` takes, and the flags in 1.5 can
only be compared against that. One of them, `--ignore-config`, would also
switch off a `yt-dlp` configuration the owner may rely on (cookies, a
proxy), so it is not something to add unseen.

## With cloud sync (Stage 9)

Sync never sits on the path of a request: changes are batched and sent in
the background, and reads stay local, so none of the figures above get
worse. See [cloud-data.md](cloud-data.md).
