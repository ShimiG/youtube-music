# Case study: putting numbers on the match engine

November 2026. Covers `services/matcher/`, `services/usage.js`, `evals/matcher/`.

Music Manager plays a Deezer track by finding the same recording on YouTube. The part
that picks the video, the match engine, had 302 unit tests and no answer to three
questions: how often does it pick the right video, what does a pick cost, and why did it
pick this one. This work adds an eval, a decision log and a usage meter that answer them.
No matching rule was changed.

## The numbers

| | Result |
|---|---|
| Labelled cases | 86 of 94 pass: 65 right video, 21 rightly refused, 6 missed, 2 wrong video |
| Precision (of what it played, how much was right) | 97.0% (65 of 67) |
| Recall (of what could be found, how much it found) | 91.5% (65 of 71) |
| Generated robustness checks | 1,975 of 1,976 pass, over 71 (track, right video) pairs |
| Bugs planted in the engine that the eval catches | 12 of 12 |
| Searches per track that ended in a match | 1.22 |
| Searches per track that ended in "not found" | 3.26 |
| Tracks answered with one search | 62 of 94 |
| Cost of logging a decision | 77 µs (262 µs to 339 µs per fresh decision) |
| Cost of metering a cached answer | 0.4 µs (10.1 µs to 10.5 µs) |
| Log size | 2.6 KB per decision at 8 results per search |
| YouTube Data API cost of one search in the app | 101 quota units, so 99 searches a day per Google project |
| Test suite | 795 tests to 825, all passing; the eval runs in 4.3 s |

### What these numbers are, and are not

The 94 labelled cases are of two kinds. Eight replay real responses captured from YouTube
Music and yt-dlp; all eight pass. The other 86 were written by hand: mostly real song
titles, with result lists modelled on what the services return. Of those, 78 pass.

The eight that fail were written to probe places where reading the code suggested the
rules stop. So **91.5% is the share of situations I thought to test that the engine
handles. It is not the share of a real library that matches correctly.** That number
needs decisions from real use with a person's verdict on them, and the tooling for it is
part of this work (see "From real use to a test"). This session had no network access to
YouTube or Deezer, so nothing here was measured against the live services.

The robustness suite and the planted-bug check are there because of that weakness. Their
expected answers are mechanical, not my judgement, and I could not predict their results.

## What was built

**1. An eval** (`evals/matcher/`). A case is a track, what each search would return for
it, and which result is the right recording. The runner puts those results behind the
engine's two network seams and calls the real `matcher.resolve()` against a real
in-memory SQLite, so the response parser, the query sequence, the scorer, the cache table
and the log all run as shipped. The results are compared with a committed baseline, and
`npm test` fails when they differ in either direction. A change to a matching rule now
has to show what it did to every case.

**2. A decision log** (`services/matcher/journal.js`). One JSON line per fresh decision
in `logs/matches.jsonl`: the track as received, every search with its query, time and
results, the verdict and reasons for every candidate, and the cost. Before this, a wrong
match left a single row with five candidates and no record of what was searched. The eval
reads its outcomes from this same log entry, so the log format is tested on every run.

**3. A usage meter** (`services/usage.js`). Nothing in this app is billed in money. What
runs out is allowance: 10,000 YouTube Data API units a day per Google project, YouTube
Music's tolerance for anonymous searches, and the user's patience during a yt-dlp run. The
meter counts each of those calls with the time it took, per day, in SQLite, and
`GET /api/system/usage` reports the totals, today's quota position, the cache hit rate and
searches per track.

## What the eval found

### Eight labelled cases do not pass

| Case | What happens | Why |
|---|---|---|
| Same master with 7 s of trailing silence | Missed | Past the 5 s length tolerance |
| Remaster whose fade runs 8 s longer | Missed | Same |
| "(Single Version)" on the track, no tag on the catalog entry | Missed | A version tag must appear on both sides |
| "(Edit)" on the track, "(Radio Edit)" in the catalog | Missed | The two tags are compared as different versions |
| A duo credited as one name on the track and as two artists in the catalog | Missed | A listed contributor is compared whole, never split |
| Official video titled `ARTIST 'Title' Official MV` | Missed | No separator to split the artist from the title |
| Only an untagged re-recording exists, 2 s apart | **Wrong video** | Title, artist and length all agree; only the album differs |
| Only a different song of the same title by the track's guest artist exists | **Wrong video** | Any listed contributor counts as proof of authorship |

Six misses and two wrong videos. A miss costs the user a 30 second preview in place of
the full track. A wrong video plays the wrong recording with no warning, which is why the
gate test fails if a wrong video ever appears outside the two cases tagged as known
limits.

The two wrong videos differ in kind. The untagged re-recording cannot be told apart from
metadata at all; the fix for it is the "Wrong match?" correction, not a rule. The guest
artist case can be fixed by a rule: require the lead artist, or accept a guest-only credit
only when the candidate's title names the lead.

### One robustness check fails

Of 1,976 generated checks, one fails. When a classical track's three contributors arrive
as a single "Composer & Orchestra & Conductor" string and the catalog lists only the
performers, the engine trusts just the first name in the string and misses. The same pair
passes when the contributors arrive as a list.

Everything else held: 920 of 921 rewrites that keep the recording still matched, and all
1,055 that change it stopped matching. That covers remaster tags in both spellings, upper
case, missing accents, typographic apostrophes, square brackets, 3 s and 5 s of drift;
and on the other side live, acoustic, instrumental, sped up, demo, mono, radio edit,
karaoke, a named remix, another artist, another title, and 6 s of drift.

### A miss costs 2.7 times a hit

| How the case ended | Cases | Searches per case |
|---|---|---|
| Matched | 67 | 1.22 |
| Not found | 23 | 3.26 |
| Error (retry later) | 4 | 1.00 |

The engine stops at the first search that yields an acceptable video, so 62 of 94 cases
took one search. A track that is not on YouTube runs the whole sequence: three or four
searches to learn nothing. At the half second per search the project documents (not
measured here), that is about 0.6 s for a hit and 1.6 s for a miss. The 30 day
"not found" memory is what keeps this from being paid on every page load.

Copying an answer by ISRC cost no search, and a 429 from YouTube Music cost exactly one
request before the back-off refused the rest.

### The Data API budget is 99 searches a day

A search in the YouTube tab makes two Data API calls: `search.list` at 100 units and
`videos.list` at 1. On the default 10,000 units, one Google project affords 99 searches a
day across everyone using it, while a playlist page costs 1 unit. The meter now shows
that position live. The unit costs are Google's published ones as I know them; I could not
re-check them against Google's page from this session.

## How the eval was checked

An eval that passes proves little until it has been seen to fail.

**Planted bugs.** `npm run eval:mutants` changes one line of the engine in memory and
runs both suites, twelve times: the length tolerance widened to 15 s, the artist check
removed, variants ignored, accents not folded, the videos search skipped, the ISRC length
check removed, and six more. All twelve changed the results. The two suites cover
different ground: "variants ignored" changed 8 labelled cases and 702 robustness checks,
while "yt-dlp runs during a rate limit" changed one labelled case and no robustness check.

**A bug in the harness.** The first run reported nine failures. One was mine: every case
shared a database, so a row seeded for one ISRC case answered the next. Each case now gets
its own database.

**Overhead.** Measured as the median of 7 rounds of 3,000 decisions, three runs each,
against the commit before this work, replaying a real response with the network stubbed.
A fresh decision went from 262 µs to 264 µs with the log off and 339 µs with it on. A
cached answer went from 10.1 µs to 10.5 µs; it was 12.5 µs until the meter stopped
formatting a date on every call. Against a search that takes half a second, 77 µs is
0.015%.

## From real use to a test

The decision log holds what the engine saw. A correction made in the app ("Wrong match?",
or "not available") holds what a person says is right. `evals/matcher/from-journal.js`
joins them:

```bash
node evals/matcher/from-journal.js --db <data folder>/database.sqlite > evals/matcher/cases/reported.json
```

Each corrected decision becomes a case that replays exactly the results the engine saw,
labelled by the correction. These are the only cases whose label does not come from
whoever wrote the case, and the route to the number this study could not give: accuracy
on a real library.

## Not done

- **No live measurement.** YouTube and Deezer were unreachable from the session that did
  this work. Real accuracy, real search latency and the Data API unit table are unverified
  here.
- **No fixes.** The nine findings are reported, not repaired. The matching rules are the
  product owner's, and three of the misses (length tolerance, version tags) trade misses
  against wrong videos.
- **No screen.** Usage and the decision log are API routes; Settings does not show them yet.
- **Partial metering.** The meter covers the match engine, YouTube stream lookups and the
  YouTube Data API. SoundCloud, Deezer, Audius, lyrics and ffmpeg are not counted.

## What to do next

1. Use the app for a week with the log on, correct what is wrong, and run
   `from-journal.js`. That gives the first real accuracy number.
2. Fix the guest-artist wrong match. It is the one wrong video a rule can prevent.
3. Fix the two cheap misses: split a joined contributor name when comparing artists, and
   read `ARTIST 'Title'` video titles.
4. Decide on length tolerance and one-sided version tags with real cases in hand, and let
   the robustness suite show what each choice lets through.

## Reproduce

```bash
npm ci
npm run eval           # both suites against the baseline, about 4 s
npm run eval:mutants   # the planted-bug check, about 50 s
npm test               # 825 tests, including the eval gate
```
