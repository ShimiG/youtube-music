# Keeping the app's data in the cloud: options and a proposal

Status: researched 12 Nov 2026; **provider decided: Cloudflare D1** (see
"Decision"). Nothing here is built yet.

## What this is for

Today all data lives in one SQLite file on the computer the app runs on
(`database.sqlite`; see `config/db.js`). A second computer, a reinstall, or a
fresh copy of the source starts empty. The goal: the data survives all of
those and is the same on every computer the app is used on, at no cost.

## What the data is

| Data | Tables | Goes to the cloud? |
|---|---|---|
| Accounts (name, password hash) | `users` | Yes |
| Custom playlists and their tracks | `playlists`, `playlist_tracks`, `tracks` | Yes |
| Play history | `history` | Yes |
| Match corrections | `track_matches` (overrides), `match_reports` | Yes |
| Service logins (YouTube / SoundCloud tokens) | `user_connections`, `app_tokens` | Not by default (see "Secrets") |
| Service credentials entered in the app | `app_settings` | Not by default (see "Secrets") |
| Local music folders and their files | `local_folders`, `local_tracks` | No: they describe one computer's disk |
| Caches (lyrics, cover colours, audio) | `lyrics_cache`, `artwork_colors`, `cache/` | No: rebuilt on demand |

The part that goes to the cloud is small: a few megabytes even after years
of use. Every free tier below is hundreds of times larger than needed, so
size is not what decides this.

## Three ways to do it

1. **The app reads and writes the cloud database directly.** Simple to
   explain, but every screen then waits on the internet: a request that takes
   1 to 6 ms against the local file today becomes one or more round trips of
   50 to 300 ms each, and the app stops working offline. This works against
   the performance work in `docs/performance-plan.md`.
2. **Local file stays in charge, a copy is kept in sync with the cloud.**
   Reads stay as fast as today and the app keeps working offline; changes are
   sent to the cloud in the background and fetched on start. The data is
   exactly as persistent as in (1). This is the recommended shape.
3. **Snapshot to cloud file storage.** The portable part is exported as one
   file and uploaded to storage the user already has (the hidden app-data
   folder of their Google Drive). No new account at all, but merging two
   computers' changes is coarser.

## Free options, as checked on 12 Nov 2026

Free tiers change. The figures are from the providers' own pages where one is
linked under "Sources", otherwise from pricing trackers, and need a last look
at the provider's pricing page before building.

| Option | Kind | Free allowance | Goes to sleep when unused? | Fit for this app |
|---|---|---|---|---|
| **Turso** | SQLite in the cloud (libSQL) | 5 GB, 500 M rows read and 10 M written per month, 100 databases | No | Closest technical fit: same SQL as today, plain HTTPS API with a token, can also keep a local copy in sync itself. Caveat: Supabase agreed to buy Turso on 2 Oct 2026; "nothing changes for existing users", but the free tier's future is not promised. |
| **Cloudflare D1** | SQLite in the cloud | 5 GB, 5 M rows read and 100,000 written per day | No | **Chosen.** Same SQL. Reached through a small Worker the user deploys (Cloudflare's recommended way): a little more setup, on the most widely used platform of the list. |
| **Neon** | Postgres | About 0.5 to 1 GB per project, 100 compute-hours per month | Pauses compute after 5 idle minutes and wakes by itself (first query slower); data is kept | Workable. The synced tables' SQL must be ported to Postgres. |
| **Google Drive app-data folder** | File storage | Counts against the user's own Drive space (15 GB free) | No | Zero new accounts: uses the Google login the app already has, plus one extra, non-sensitive permission. Snapshot sync only (way 3). |
| Supabase | Postgres | 500 MB, 2 projects | **Yes: paused after 1 week unused, resumed by hand** | Not recommended: a week away from the app and sync is down until someone logs in to their dashboard. |
| MongoDB Atlas (free cluster) | Document database | 512 MB | **Yes: paused after 30 days unused** | Not recommended: pausing, and the data model would have to be rewritten. |
| Firebase Firestore | Document database | 1 GiB, 50,000 reads and 20,000 writes per day | No | Possible but a rewrite of the data model, plus Firebase sign-in or a key file to manage. |
| CockroachDB Basic | Postgres-compatible | $15 of use per month (about 10 GiB and 50 M request units) | No | Free in practice, but it is a billing account with a credit, not a free plan. |

## Decision

**Cloudflare D1, reached through a small Cloudflare Worker, with the local
database kept in sync (way 2).**

Turso is the closer technical fit (see the table), and that was the first
recommendation. Cloudflare was chosen by the project owner because this is a
portfolio project and Cloudflare's platform (Workers, D1, Wrangler) is what
is widely used and asked for. It is also the provider least likely to
withdraw its free tier, and it has no acquisition in progress.

How it is put together:

- **The local SQLite file stays the database the app reads.** Nothing gets
  slower and the app still works offline.
- **A Worker in front of D1, not D1's REST API.** Cloudflare's own guidance
  is that the REST API is for administration (it shares the account-wide
  limit of 1,200 API calls per five minutes, and its token can do far more
  than read one database) and that applications should go through a Worker.
  The Worker exposes two narrow operations, `POST /sync/push` and
  `GET /sync/pull?since=`, checks a bearer token kept as a Worker secret,
  validates what it is sent, and is the only thing that touches D1.
- **A sync module in the desktop server** sends changed rows and fetches
  other computers' changes: on start, a few seconds after a change
  (batched), and every few minutes. Rows carry "changed at" and "deleted at"
  times; the newer change wins. For one person on several computers that is
  enough.
- **Free-plan limits shape the batches.** A Worker on the free plan may run
  50 D1 queries per request, and since 1 Sep 2026 D1 refuses queries once
  the day's 5 million row reads or 100,000 row writes are used up. Pushes
  are therefore sent as a few multi-row statements per request, pulls are
  paged by an indexed "changed at" column (D1 counts rows scanned, not rows
  returned), and the app treats "limit reached" as "try again tomorrow",
  never as data loss: the local copy is complete.
- **In the repository:** a `cloud/` folder with the Worker, its Wrangler
  configuration and the D1 migrations, deployed with `wrangler deploy` to
  the user's own free Cloudflare account. The Worker's address and the sync
  token are entered under Settings → Accounts, stored encrypted, owner only.
  No shared server; nobody else holds the data.
- The cloud side stays behind one small interface (`push`, `pull`), so
  another provider would be a second adapter, not a rewrite.

### Secrets

Service logins and credentials are encrypted with a key that exists only on
the computer that stored them (`.token-key`), which is why they are useless
if copied elsewhere. Two choices:

- **Default, proposed:** do not sync them. On a new computer you connect
  YouTube once more and enter the credentials once more. Nothing secret
  leaves the computer.
- **Optional, later:** sync them encrypted with a key derived from a
  passphrase the user types on each computer. More work, and the passphrase
  becomes the thing protecting the tokens.

### A fix that needs no cloud

Run from source, the app keeps its database inside the project folder, so
every freshly downloaded copy starts empty (this is what happened after
v2.1.0). The installed app already uses the per-user data folder. Using that
folder for source runs too, and moving an existing project-folder database
there once, makes the data survive new copies on the same computer. Small,
and worth doing first whatever is decided about the cloud.

## Proposed steps

1. Per-user data folder for source runs, with a one-time move (above).
2. Sync groundwork in the local database: "changed at" / "deleted at" on the
   synced tables, a stable id per row that is the same on every computer,
   and a per-installation id.
3. `cloud/`: the D1 schema as migrations, the Worker (push, pull, token
   check, input validation, tests that run in the Workers runtime), and the
   deploy instructions.
4. The sync module in the desktop server, with settings and status under
   Settings → Accounts ("Cloud sync: on, last synced 2 minutes ago").
5. First-run flows: "this computer has data, the cloud is empty" (upload),
   "the cloud has data, this computer is empty" (download), both (merge).
6. A two-computer run against a real Cloudflare account. This cannot be done
   from the build environment and needs the owner's account.

## Decided by the owner (12 Nov 2026)

1. Local database with cloud sync, not cloud-only.
2. Provider: Cloudflare D1.
3. One person, several computers, the same data on each. Sharing one cloud
   database between several people is not a goal for now; the design does
   not rule it out (rows belong to an account), but nothing is built for it.

Still at its default, since it was not raised: service logins and
credentials are not synced; each computer connects once (see "Secrets").

## Sources

- Turso free plan figures (pricing trackers; confirm on turso.tech/pricing):
  https://costbench.com/software/database-as-service/turso/free-plan
- Turso embedded replicas and offline sync:
  https://docs.turso.tech/features/embedded-replicas/introduction ,
  https://turso.tech/blog/turso-offline-sync-public-beta
- Supabase to acquire Turso (2 Oct 2026):
  https://www.prnewswire.com/news-releases/supabase-announces-150m-in-new-funding-and-turso-acquisition-302896752.html
- Cloudflare D1 pricing and limits: https://developers.cloudflare.com/d1/platform/pricing/ ,
  https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare: use a Worker in front of D1, the REST API is for administration:
  https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/
- Cloudflare D1 changelog (daily limits enforced from 1 Sep 2026):
  https://developers.cloudflare.com/changelog/product/d1/
- Neon free plan: https://neon.com/faqs/free-plan-limits-and-quotas
- Supabase pricing (pausing after 1 week): https://supabase.com/pricing
- MongoDB Atlas free cluster limits and pausing:
  https://mongodb.com/docs/atlas/reference/free-shared-limitations/ ,
  https://mongodb.com/docs/atlas/pause-terminate-cluster/
- Firebase pricing: https://firebase.google.com/pricing
- CockroachDB Cloud costs: https://www.cockroachlabs.com/docs/cockroachcloud/costs
- Google Drive app-data folder: https://developers.google.com/workspace/drive/api/guides/appdata
