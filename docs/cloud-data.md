# Keeping the app's data in the cloud: options and a proposal

Status: research and proposal (12 Nov 2026). Nothing here is built yet.

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
| **Turso** | SQLite in the cloud (libSQL) | 5 GB, 500 M rows read and 10 M written per month, 100 databases | No | **Best fit.** Same SQL as today, plain HTTPS API with a token, can also keep a local copy in sync itself. Caveat: Supabase agreed to buy Turso on 2 Oct 2026; "nothing changes for existing users", but the free tier's future is not promised. |
| **Cloudflare D1** | SQLite in the cloud | 5 GB, 5 M rows read and 100,000 written per day | No | Good second choice. Same SQL. Reached from a desktop app through Cloudflare's REST API with an account token, or through a small Worker the user deploys: more setup. |
| **Neon** | Postgres | About 0.5 to 1 GB per project, 100 compute-hours per month | Pauses compute after 5 idle minutes and wakes by itself (first query slower); data is kept | Workable. The synced tables' SQL must be ported to Postgres. |
| **Google Drive app-data folder** | File storage | Counts against the user's own Drive space (15 GB free) | No | Zero new accounts: uses the Google login the app already has, plus one extra, non-sensitive permission. Snapshot sync only (way 3). |
| Supabase | Postgres | 500 MB, 2 projects | **Yes: paused after 1 week unused, resumed by hand** | Not recommended: a week away from the app and sync is down until someone logs in to their dashboard. |
| MongoDB Atlas (free cluster) | Document database | 512 MB | **Yes: paused after 30 days unused** | Not recommended: pausing, and the data model would have to be rewritten. |
| Firebase Firestore | Document database | 1 GiB, 50,000 reads and 20,000 writes per day | No | Possible but a rewrite of the data model, plus Firebase sign-in or a key file to manage. |
| CockroachDB Basic | Postgres-compatible | $15 of use per month (about 10 GiB and 50 M request units) | No | Free in practice, but it is a billing account with a credit, not a free plan. |

## Recommendation

**Way 2 with Turso, built so the provider can be swapped.**

- The local SQLite file stays the database the app reads. Nothing gets
  slower and the app still works offline.
- A sync module sends changed rows to the cloud and fetches other computers'
  changes: on start, after changes (a few seconds later, batched), and every
  few minutes. Rows carry "changed at" and "deleted at" times; the newer
  change wins. For one person using two computers this is enough.
- It talks to the cloud over plain HTTPS with a pure-JavaScript client, so
  the single-file build of the server (`scripts/build-sea.mjs`) keeps
  working. Turso's own "keep a local copy in sync" feature needs a native
  add-on, which is what the move to `node:sqlite` got rid of; it stays an
  option for later, not the starting point.
- The cloud side is one small interface (`push(changes)`, `pull(since)`), so
  moving to Cloudflare D1 or Neon later is a second adapter, not a rewrite.
  That is the answer to the Turso acquisition risk.
- Each installation uses the user's own free database: its address and token
  are entered under Settings → Accounts, like the Google credentials, stored
  encrypted, owner only. No shared server, no data held by anyone else.

If creating one more account is unwanted, the alternative is **way 3 with
Google Drive**: less machinery, no new account, coarser merging.

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
3. The sync module and the Turso adapter; settings and status under
   Settings → Accounts ("Cloud sync: on, last synced 2 minutes ago").
4. First-run flows: "this computer has data, the cloud is empty" (upload),
   "the cloud has data, this computer is empty" (download), both (merge).
5. Tests against a local stand-in for the cloud, and a two-computer run.

## Decisions needed

1. Way 2 (local + sync, recommended) or way 1 (cloud only)?
2. Turso (recommended), Cloudflare D1, or the Google Drive snapshot?
3. Secrets: reconnect per computer (recommended) or passphrase sync?
4. Is one person on several computers the case to build for, or several
   people sharing one cloud database?

## Sources

- Turso free plan figures (pricing trackers; confirm on turso.tech/pricing):
  https://costbench.com/software/database-as-service/turso/free-plan
- Turso embedded replicas and offline sync:
  https://docs.turso.tech/features/embedded-replicas/introduction ,
  https://turso.tech/blog/turso-offline-sync-public-beta
- Supabase to acquire Turso (2 Oct 2026):
  https://www.prnewswire.com/news-releases/supabase-announces-150m-in-new-funding-and-turso-acquisition-302896752.html
- Cloudflare D1 pricing and limits: https://developers.cloudflare.com/d1/platform/pricing/
- Neon free plan: https://neon.com/faqs/free-plan-limits-and-quotas
- Supabase pricing (pausing after 1 week): https://supabase.com/pricing
- MongoDB Atlas free cluster limits and pausing:
  https://mongodb.com/docs/atlas/reference/free-shared-limitations/ ,
  https://mongodb.com/docs/atlas/pause-terminate-cluster/
- Firebase pricing: https://firebase.google.com/pricing
- CockroachDB Cloud costs: https://www.cockroachlabs.com/docs/cockroachcloud/costs
- Google Drive app-data folder: https://developers.google.com/workspace/drive/api/guides/appdata
