# Match engine eval

The match engine (`services/matcher/`) decides which YouTube video plays for a track from
Deezer (and, later, Spotify). A wrong decision plays the wrong song. This folder measures
how often it decides correctly, what each decision costs, and fails the build when either
changes without anyone saying so.

Nothing here reaches the network. Each case holds what the searches would return, and the
real engine runs on it: the HTTP parsing, the query sequence, the scoring, the cache table
and the decision log are all the code that ships.

```bash
npm run eval                  # report; fails if the results differ from baseline.json
npm run eval -- --update      # accept the current results as the new baseline
npm run eval -- --case <id>   # one case with the engine's whole decision
npm run eval -- --json        # everything, for scripts
npm run eval:mutants          # plant bugs in the engine and check the eval notices
```

`npm test` runs the same comparison (`tests/matcherEval.test.js`), so CI gates on it.

## Two suites

**Labelled cases** (`cases/*.json`). A track, the search results for it, and which result
is the right recording, or `[]` when nothing should play. Each case says why it exists.

| File | What it covers |
|---|---|
| `recorded.json` | Real YouTube Music and yt-dlp responses from `tests/fixtures/` |
| `titles.json` | Punctuation, scripts other than Latin, brackets that belong to the name |
| `artists.json` | Guest credits, acts with joiners in their name, covers, karaoke, tribute acts |
| `versions.json` | Remasters, live, acoustic, edits, remixes, re-recordings, albums |
| `sources.json` | Length, official versus fan uploads, the query sequence, the yt-dlp fallback, ISRC reuse |

`"origin": "recorded"` means the results are a captured response. `"origin": "constructed"`
means a person wrote them: the titles are mostly real songs, but the result lists, lengths
and play counts are modelled on what the services return, not captured from them. The pass
rate over constructed cases says which situations the rules handle. It is not the share of
a real library that matches correctly.

**Robustness** (`robustness.js`). Generated, not written. It takes every (track, right
video) pair it can find, the official entries in the recorded responses and the right
answers of the labelled cases, and rewrites the track mechanically. Rewrites that keep the
recording (a remaster tag, upper case, a missing accent, 3 s of drift) must still match
the video; rewrites that change it ("(Live)", a remix, another artist, 6 s of drift) must
stop matching. The expected answer follows from the rewrite, so nobody's judgement of a
case is involved.

## Outcomes

| Outcome | Meaning |
|---|---|
| `correct_match` | Played one of the accepted videos |
| `correct_reject` | Played nothing, and nothing should have played |
| `wrong_match` | Played a video that is not accepted. The error that matters most |
| `miss` | Played nothing although an accepted video was in the results |

Precision is `correct_match / (correct_match + wrong_match)`: of what it played, how much
was right. Recall is `correct_match / cases with an accepted video`.

Cost is counted from the engine's decision log: YouTube Music searches actually sent and
yt-dlp runs, per case and by how the case ended.

## A case

```json
{
  "id": "variant-studio-over-live",
  "tags": ["variant"],
  "origin": "constructed",
  "why": "Studio track; a concert recording of nearly the same length is listed first.",
  "track": {"title": "Creep", "artist": "Radiohead", "durationSec": 238, "artists": ["Radiohead"], "album": "Pablo Honey"},
  "songs": [
    {"label": "live", "title": "Creep (Live)", "artists": ["Radiohead"], "dur": 240, "album": "Live Recordings"},
    {"label": "studio", "title": "Creep", "artists": ["Radiohead"], "dur": 239, "album": "Pablo Honey"}
  ],
  "accept": ["studio"]
}
```

- `track` is what the provider hands the engine (`providers/deezer.js` `matchInput`).
- `songs` / `videos` are what the YouTube Music songs and videos searches return. A
  candidate has a `label` (a name, not a video id; ids are derived), `title`, `artists`,
  `dur` in seconds, and optionally `album`, `plays` and `type` (`atv` catalog audio, `omv`
  official video, `ugc` fan upload; songs default to `atv`, videos to `omv`).
  - An array answers every query the same way.
  - `{"calls": [[...], [...]]}` gives the first search the first list, and so on.
  - `{"queries": {"<query>": [...]}}` answers by exact query.
  - `{"fixture": "innertube-search.json"}` replays a recorded response.
- `ytsearch` is yt-dlp's output: `label`, `title`, `channel`, `dur`, and optionally
  `verified`, `views`, `live`.
- `innertube`: `"down"`, `"rate_limited"` or `"http500"` to make YouTube Music fail.
- `seed`: rows already in the match table (`isrc`, `label`, `durationSec`), for ISRC reuse.
- `env`: engine settings for this case only.
- `accept`: labels of the right answers; `[]` when nothing should play. `prefer` names the
  best of several. `expectStatus: "error"` when the right outcome is "retry later".

Add a case, run `npm run eval`, read what the engine did with it, then
`npm run eval -- --update` and commit the case with the new baseline.

## Cases from real use

The engine logs every fresh decision with what it was made from
(`services/matcher/journal.js`, `logs/matches.jsonl` in the data folder). A person who
corrects a match in the app ("Wrong match?", or "not available") leaves the right answer
in the database. `from-journal.js` joins the two:

```bash
node evals/matcher/from-journal.js --db <data folder>/database.sqlite > evals/matcher/cases/reported.json
```

Each corrected decision becomes a case labelled with the correction, replaying exactly the
results the engine saw. That is the only route to a number for real use, and the only
cases here whose label does not come from whoever wrote the case. The output holds titles
and artist names from your own library: read it before committing it.

## Does the eval notice a broken engine?

`npm run eval:mutants` plants twelve small bugs in the engine, one at a time and only in
memory (a looser length tolerance, the artist check removed, "live" treated as "studio",
and so on), and runs both suites against each. A bug is caught when the results differ
from the baseline. All twelve are caught today; a mutant that survives is a kind of bug
this eval would let through, and a reason to add a case.
