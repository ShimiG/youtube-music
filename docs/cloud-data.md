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
| Service logins (YouTube / SoundCloud tokens) | `user_connections`, `app_tokens` | Yes, held by the Worker, encrypted (see "Secrets") |
| Service credentials (Google client ID and secret) | `app_settings` | Yes, as Worker secrets, never in the database (see "Secrets") |
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
  The Worker exposes a few narrow operations (sign in, `POST /sync/push`,
  `GET /sync/pull?since=`, and the Google sign-in described under
  "Secrets"), checks who is calling, validates what it is sent, and is the
  only thing that touches D1.
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
  the owner's own free Cloudflare account. A computer is linked by signing
  in to the cloud account (see "Secrets" below). Nobody else holds the
  data.
- The cloud side stays behind one small interface (`push`, `pull`), so
  another provider would be a second adapter, not a rewrite.

### Secrets, and "set up once, not once per computer"

Asked by the owner: can the YouTube credentials live in the cloud too, so
they are not pasted in on every computer, and be built into the app?

Yes, and without the secret ever being stored in the database or shipped in
the app. Two things are meant by "credentials", and they are handled
differently:

- **The Google client ID and secret** (what identifies this app to Google)
  become **secrets of the Worker** (`wrangler secret put`). The Worker, not
  the desktop app, does the sign-in with Google: the app opens the Worker's
  "connect YouTube" address, Google sends the result back to the Worker,
  and the Worker exchanges it using the secret. No computer ever holds the
  secret, so there is nothing to paste. This is the standard arrangement
  for an app with a server side, and the Worker is that server side.
- **The YouTube login itself** (the refresh token Google issues) is kept by
  the Worker in D1, encrypted with a key that is also a Worker secret. The
  desktop app asks the Worker for a short-lived access token when it needs
  one. Connect YouTube once, on any computer, and it is connected on all of
  them. This replaces the earlier default of reconnecting on each computer.

What "built into the app" can mean:

- **Built in: the Worker's address.** It is not a secret. The release build
  can carry it (a build setting), with Settings → Accounts able to override
  it. A new computer then needs only the app and the account's user name
  and password.
- **Not built in: the Google secret.** The repository and the installers
  are public; a secret placed in either can be read by anyone, and GitHub's
  secret scanning has flagged exactly that in this repository before. With
  the Worker doing the sign-in, it never needs to be.

What this adds to the design:

- **Accounts move to the Worker.** Signing in on a computer is "user name
  and password, checked by the Worker", which then also decides whose data
  is synced and whose YouTube login is used. The sync token of the first
  design is replaced by that login. The local server keeps working on its
  own, with local accounts, when no cloud is set up.
- **Sign-up is closed by default.** Because the Worker's address would be
  in a public installer, the Worker only accepts the accounts its owner
  creates (the first account, or an invite code). "For now it's just me"
  is the default, not an assumption.
- **Google's side.** The redirect address registered with Google becomes
  the Worker's. And one setting in the Google Cloud console matters: while
  the project's audience is "External" with publishing status "Testing",
  Google expires a login after seven days (the app then shows YouTube as
  disconnected). Set the status to "In production" for a login to last.
  Checked against Google's documentation on 12 Nov 2026 (see Sources).
- SoundCloud's optional credentials follow the same pattern.

It is more to build than sync alone (accounts, sign-in broker, token
storage), so it comes after the data sync works.

### A fix that needs no cloud

Run from source, the app keeps its database inside the project folder, so
every freshly downloaded copy starts empty (this is what happened after
v2.1.0). The installed app already uses the per-user data folder. Using that
folder for source runs too, and moving an existing project-folder database
there once, makes the data survive new copies on the same computer. Small,
and worth doing first whatever is decided about the cloud.

## Built so far

- **Step 1:** data in the per-user data folder for source runs too
  (`services/dataFolder.js`).
- **Step 3, the cloud side:** [`cloud/`](../cloud/README.md) holds the
  Worker (Hono, TypeScript), the D1 schema as a migration, and tests that
  run inside the Workers runtime. Accounts (sign-up closed unless a
  registration code is set), sessions, push and pull are done. What changed
  from the sketch above while building it:
  - **The password is stretched on the device, not in the Worker.** The free
    plan gives a Worker 10 ms of processor time per request, too little to
    hash a password properly. The device derives a key with scrypt and sends
    that; the Worker stores only a hash of it.
  - **Records are stored generically** (collection, id, JSON content, time of
    change), not as a copy of the desktop's tables, so a change to the
    desktop's schema needs no change in the cloud.
  - **A push is one transaction of two statements** whatever its size (the
    records travel as one JSON parameter), which fits the limits of 50
    queries per request and 100 parameters per query.
- **Steps 2 and 4, the desktop side:** `services/cloud/` and Settings →
  Accounts → Cloud sync. A user links a computer to their cloud account;
  their custom playlists (with the order of their tracks) and their play
  history are then the same on every linked computer. How it works:
  - Nothing in the app reports changes. A sync run reads the user's records
    as they are, compares them with what this computer and the cloud last
    agreed on (`sync_records`, a hash per record), pushes what differs and
    pulls what the cloud accepted since. A place that edits data cannot be
    forgotten, because no place has to do anything.
  - Runs happen a few seconds after a change, every five minutes, and on
    "Sync now". A failure is shown, retried, and loses nothing.
  - Each computer keeps its own local account; the cloud account is linked
    to it. The cloud session is stored encrypted and renews itself, so the
    password is asked for once per computer.
  - Tracks from Local Files stay on their computer. A record a computer
    cannot use (from a newer version, say) is left alone in the cloud.
  - Checked with two copies of the app syncing through the Worker running
    locally (`wrangler dev`), both directions.
- **Step 5, YouTube through the cloud account:** `cloud/src/google.ts` and
  `services/cloud/google.js`.
  - The Worker does the sign-in with Google (its client ID and secret are
    Worker secrets) and keeps the refresh token in D1, encrypted with a key
    derived from the Worker's `JWT_SECRET`. The desktop app asks it for an
    access token (valid about an hour) and stores only that, encrypted.
  - A linked user's "Connect YouTube" goes through the cloud when the
    Worker has Google credentials; otherwise through this installation's
    own credentials, as before. A login made with local credentials is
    still renewed locally.
  - After Google, the Worker sends the browser back only to the desktop
    app's own link or to an address on the same computer
    (`http://localhost:<port>`), chosen when the flow starts and signed.
  - Each sync run also asks whether YouTube is connected, so a computer
    learns within minutes that it was connected or disconnected elsewhere.
    Disconnecting disconnects the account: the Worker revokes the login at
    Google and every computer loses it.
  - If the cloud cannot be reached when a token is needed, the app says
    YouTube is unavailable for the moment; the login is not dropped.
- **Step 6, signing in to the app with the cloud account:** the login
  screen offers "Sign in with your cloud account" when the computer knows a
  cloud address, or when nobody has used the computer yet (the address is
  then asked for, checked, and kept only if the sign-in works).
  - A first sign-in creates the account on that computer under the cloud
    user name, links it, and syncs before the first screen is drawn. Later
    sign-ins find the same account.
  - A one-way hash of the password is kept with that local account (as for
    any local account), so the same name and password still open it when
    the cloud cannot be reached.
  - A local account that merely has the same name is never handed over:
    log in to it and link it under Settings instead.
  - **The address can be built in.** `CLOUD_URL` at build time is compiled
    into the server (`scripts/build-sea.mjs`); the release workflow reads
    it from a repository variable. Order of precedence: `CLOUD_URL` in the
    environment, the built-in address, the one saved in the app. The first
    two cannot be changed from the app.
  - Checked end to end with the Worker running locally (`wrangler dev`):
    one computer creating the cloud account and starting the Google
    sign-in, a second, empty one signing in with only the cloud account,
    and a packaged server with a built-in address. Google itself could not
    be reached from the build machine, so the exchange with Google is
    covered by the Worker's tests against a stand-in, not by a real login.
- Not built: SoundCloud's login through the cloud, changing the cloud
  password, deleting the cloud account from the app.

## Proposed steps

1. Per-user data folder for source runs, with a one-time move (above).
2. Sync groundwork in the local database: "changed at" / "deleted at" on the
   synced tables, a stable id per row that is the same on every computer,
   and a per-installation id.
3. `cloud/`: the D1 schema as migrations, the Worker with accounts (sign-in,
   closed sign-up) and sync (push, pull), input validation, tests that run
   in the Workers runtime, and the deploy instructions.
4. The sync module in the desktop server, with sign-in to the cloud account
   and status under Settings → Accounts ("Cloud sync: on, last synced 2
   minutes ago"), and the first-run flows: upload, download, merge.
5. Google sign-in through the Worker: client secret as a Worker secret,
   YouTube login stored encrypted in D1, short-lived access tokens handed
   to the desktop app. Then the Worker's address as a build setting.
6. A two-computer run against a real Cloudflare account. This cannot be done
   from the build environment and needs the owner's account.

## Decided by the owner (12 Nov 2026)

1. Local database with cloud sync, not cloud-only.
2. Provider: Cloudflare D1.
3. One person, several computers, the same data on each. Sharing one cloud
   database between several people is not a goal for now; the design does
   not rule it out (rows belong to an account), but nothing is built for it.

4. Service credentials and logins live in the cloud too (Worker secrets and
   encrypted rows), so nothing is pasted in per computer (see "Secrets").

## Sources

- Google: logins of an "External" app in "Testing" expire after 7 days:
  https://developers.google.com/identity/protocols/oauth2 ,
  https://support.google.com/cloud/answer/15549945

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
