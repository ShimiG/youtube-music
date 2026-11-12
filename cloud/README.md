# Music Manager cloud

A small Cloudflare Worker in front of a D1 database. It keeps Music Manager's
data (playlists, history, and so on) in sync between the computers of one
account. Design and reasons: [../docs/cloud-data.md](../docs/cloud-data.md).

It runs in **your own** Cloudflare account, on the free plan. Nobody else
holds the data.

## What is here

| | |
|---|---|
| `src/index.ts` | The routes |
| `src/auth.ts` | Accounts and sessions |
| `src/sync.ts` | Push and pull of records |
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
registration code. On every other computer, enter the same address and sign
in with that user name and password.

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
`JWT_SECRET=...` and `REGISTRATION_CODE=...` on separate lines:

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
