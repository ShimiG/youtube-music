# Music Manager cloud

A small Cloudflare Worker in front of a D1 database. It keeps Music Manager's
data (playlists, history, and so on) in sync between the computers of one
account, and can hold the account's YouTube login, so a new computer needs
only a sign-in. Design and reasons: [../docs/cloud-data.md](../docs/cloud-data.md).

It runs in **your own** Cloudflare account, on the free plan. Nobody else
holds the data.

## What is here

| | |
|---|---|
| `src/index.ts` | The routes |
| `src/auth.ts` | Accounts and sessions |
| `src/sync.ts` | Push and pull of records |
| `src/google.ts` | YouTube sign-in with Google, and the stored login |
| `migrations/` | The D1 schema |
| `test/` | Tests, run inside the Workers runtime against a local D1 |
| `wrangler.jsonc` | The Worker's configuration (no secrets in it) |

## API

| Method and path | Needs a session | What it does |
|---|---|---|
| `GET /health` | no | Is the service up; is sign-up open |
| `POST /auth/register` | no | `{ username, authKey, registrationCode }` → session |
| `POST /auth/login` | no | `{ username, authKey }` → session |
| `POST /auth/refresh` | yes | A new session for a valid one (the app renews before expiry) |
| `DELETE /auth/account` | yes | `{ authKey }` → deletes the account and its records |
| `POST /sync/push` | yes | `{ deviceId, changes: [{ collection, id, updatedAt, data }] }` |
| `GET /sync/pull?since=&limit=` | yes | The changes accepted after `since` |
| `GET /google/status` | yes | Can this service do the Google sign-in; is YouTube connected |
| `POST /google/start` | yes | `{ returnTo, scope? }` → the address of Google's consent page |
| `GET /google/callback` | no | Where Google sends the browser back (a signed `state` says for whom) |
| `POST /google/token` | yes | A YouTube access token, valid about an hour |
| `DELETE /google` | yes | Disconnects YouTube and revokes the login at Google |

A session is `{ token, expiresAt }` (valid 30 days); send the token as
`Authorization: Bearer <token>`.

`authKey` is not the password. The device turns the password into a key and
sends only that, as 64 hexadecimal characters:

```
authKey = scrypt(password,
                 salt = "music-manager-cloud:v1:" + lower-case user name,
                 N = 32768, r = 8, p = 1, 32 bytes)
```

For one record, the newest change wins (`updatedAt`, set by the device; at
the very same time, the device with the larger id, so all devices agree). A
deletion is a change with `"deleted": true`. Every accepted change gets the
account's next number (`seq`); a device remembers the last number it saw and
pulls from there.

Ten wrong sign-ins in a row lock an account for 15 minutes.

`returnTo` is where the browser ends up after Google: `"app"` (the desktop
app's `musicmanager://oauth` link) or an address on the same computer
(`http://localhost:<port>`). Nothing else is accepted. The refresh token
Google issues never leaves the Worker; it is stored encrypted with a key
derived from `JWT_SECRET`.

## Set it up (once)

You need Node.js and a free Cloudflare account. Run everything in this
folder (`cloud/`).

Install the tools:

```bash
npm ci
```

Sign the command-line tool in to your Cloudflare account (opens the browser):

```bash
npx wrangler login
```

Create the database. Use the region closest to you (`weur`, `eeur`, `wnam`,
`enam`, `apac`, `oc`). If you already created `music-manager`, skip this:

```bash
npx wrangler d1 create music-manager --location weur
```

It prints a `database_id`. Put it in `wrangler.jsonc`, replacing the row of
zeros. It is an identifier, not a secret. If Wrangler offers to add the
binding to the configuration for you, answer no: it is already there.

Create the tables:

```bash
npm run migrate:remote
```

Set the secrets. Each command asks for the value and stores it encrypted at
Cloudflare; nothing is written to a file. Use long random values; this prints
one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`JWT_SECRET` signs the sessions (required):

```bash
npx wrangler secret put JWT_SECRET
```

`REGISTRATION_CODE` is what you type once in the app to create your account.
Without it nobody can create an account:

```bash
npx wrangler secret put REGISTRATION_CODE
```

`AUTH_PEPPER` is optional: an extra secret mixed into the stored login
hashes. Set it before creating accounts and never change it afterwards:

```bash
npx wrangler secret put AUTH_PEPPER
```

Deploy:

```bash
npm run deploy
```

Wrangler prints the Worker's address
(`https://music-manager-cloud.<your-subdomain>.workers.dev`). Check it:

```bash
curl https://music-manager-cloud.<your-subdomain>.workers.dev/health
```

It should answer `{"ok":true,...,"registrationOpen":true}`. That address is
what Music Manager is pointed at. Once your account exists, sign-up can be
closed again:

```bash
npx wrangler secret delete REGISTRATION_CODE
```

Then, in Music Manager: Settings → Accounts → Cloud sync. Enter the address,
choose "Create an account instead", and give a user name, a password and the
registration code.

On every other computer there is nothing to set up: on the login screen
choose "Sign in with your cloud account" and give the address (asked once,
on a computer nobody has used yet), the user name and the password. That
creates your account on that computer and brings your data.

## YouTube through the cloud (optional, once)

With this, no computer needs Google credentials, and YouTube is connected
once for all your computers. You need the Google Cloud project that has the
YouTube Data API enabled and an OAuth client of type "Web application" (the
one whose ID and secret were entered in the app until now is fine).

1. In the Google Cloud console, open that OAuth client and add this
   **Authorised redirect URI** (your Worker's address, then
   `/google/callback`):

   ```
   https://music-manager-cloud.<your-subdomain>.workers.dev/google/callback
   ```

2. Still in the console, under the app's **Audience**: if the user type is
   "External" and the publishing status is "Testing", Google ends every
   login after 7 days. Set the status to "In production" so the login
   lasts. (With YouTube scopes Google may show an "unverified app" notice
   on the consent page, or ask for verification.)

3. Give the client ID and the client secret to the Worker. Each command
   asks for the value; it is stored encrypted at Cloudflare and is never in
   a file, the repository or the app:

   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   ```

   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

4. In Music Manager, on a computer signed in to the cloud account:
   Settings → Accounts → YouTube → Connect. From then on YouTube is
   connected on every computer signed in to that account.

Do not change `JWT_SECRET` afterwards: the stored YouTube login is encrypted
with a key made from it, and would have to be connected again (sessions
would end too).

A YouTube connection made earlier with credentials typed into the app keeps
working on that computer. To move it to the cloud: disconnect YouTube there,
then connect again while signed in to the cloud account.

## Build the address into the app (optional)

So that the login screen does not ask for the address at all. It is an
address, not a secret.

- Releases built by GitHub Actions: in the repository, Settings → Secrets
  and variables → Actions → Variables, add a variable named `CLOUD_URL`
  with the Worker's address. The next release carries it.
- A build on your own computer: set `CLOUD_URL` when building the server.

  ```bash
  CLOUD_URL=https://music-manager-cloud.<your-subdomain>.workers.dev npm run build:server
  ```

- Run from source: put `CLOUD_URL=...` in the `.env` file of the data
  folder, or enter the address in the app.

Note that the installers on a public releases page then contain the
address. Sign-up stays closed without the registration code, so the address
alone gives nobody an account.

## Update it

After pulling a newer version of this folder, apply any new migrations and
deploy again. Accounts and data are kept:

```bash
npm ci
```

```bash
npm run migrate:remote
```

```bash
npm run deploy
```

## Work on it

Run the tests (no Cloudflare account needed; they use a local database):

```bash
npm test
```

Check the types:

```bash
npm run typecheck
```

Run it locally on http://127.0.0.1:8787, with a local database. Local
secrets go in a file named `.dev.vars` (never committed), for example
`JWT_SECRET=...` and `REGISTRATION_CODE=...` on separate lines (and
`GOOGLE_CLIENT_ID=...`, `GOOGLE_CLIENT_SECRET=...` to try the YouTube
sign-in; register `http://localhost:8787/google/callback` with Google for
that):

```bash
npm run migrate:local
```

```bash
npm run dev
```

## Limits it is built around (Cloudflare's free plan)

- 10 ms of processor time per request: passwords are stretched on the
  device, not here.
- 50 database queries per request: a push is one transaction of two
  statements, however many records it carries.
- 100 parameters per query: the records of a push travel as one JSON
  parameter.
- 5 million rows read and 100,000 rows written per day: a pull reads only
  the rows it returns (there is a test for that); when a day's allowance is
  used up, sync waits until the next day and nothing is lost, because every
  computer keeps its own complete copy.
