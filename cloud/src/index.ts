// Music Manager cloud: a small API in front of D1 (docs/cloud-data.md).
//
//   GET    /health                 is the service up, and is sign-up open
//   POST   /auth/register          { username, authKey, registrationCode } -> session
//   POST   /auth/login             { username, authKey }                   -> session
//   POST   /auth/refresh           a new session for a valid one (signed in)
//   DELETE /auth/account           { authKey }                (signed in)
//   POST   /sync/push              { deviceId, changes: [...] } (signed in)
//   GET    /sync/pull?since=&limit=                             (signed in)
//   /google/...                    YouTube sign-in through the cloud (src/google.ts)
//   /soundcloud/...                SoundCloud through the cloud (src/soundcloud.ts)
//   GET    /services               what the installation's services are set up with (signed in)
//
// The callers are Music Manager's own desktop servers, never a web page, so no
// cross-origin access is granted. The Worker is the only thing that touches D1.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { deleteAccount, login, refresh, register, requireSession } from './auth';
import * as google from './google';
import * as soundcloud from './soundcloud';
import { pull, push } from './sync';
import { ApiError, type AppEnv } from './types';

// Nothing but the handler may be exported from this file: the Workers runtime
// treats every export of the entry module as an entrypoint.
const VERSION = '0.4.0';
const MAX_BODY_BYTES = 1024 * 1024;

const app = new Hono<AppEnv>();

app.use('*', secureHeaders());
app.use('*', async (c, next) => {
    await next();
    // Answers are about one account at one moment: never cache them.
    c.header('Cache-Control', 'no-store');
});
app.use('*', bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => { throw new ApiError(413, 'BODY_TOO_LARGE', 'The request is too large.'); }
}));

// The body as JSON, or a clear error (not a crash) for anything else.
async function jsonBody(request: Request): Promise<unknown> {
    try {
        return await request.json();
    } catch {
        throw new ApiError(400, 'BAD_JSON', 'The request body must be JSON.');
    }
}

app.get('/health', (c) => c.json({
    ok: true,
    service: 'music-manager-cloud',
    version: VERSION,
    registrationOpen: Boolean(c.env.REGISTRATION_CODE)
}));

app.post('/auth/register', async (c) => c.json(await register(c.env, await jsonBody(c.req.raw)), 201));
app.post('/auth/login', async (c) => c.json(await login(c.env, await jsonBody(c.req.raw))));

app.use('/auth/refresh', requireSession);
app.post('/auth/refresh', async (c) => c.json(await refresh(c.env, c.get('userId'))));

app.use('/auth/account', requireSession);
app.delete('/auth/account', async (c) => {
    await deleteAccount(c.env, c.get('userId'), await jsonBody(c.req.raw));
    return c.body(null, 204);
});

app.use('/sync/*', requireSession);
app.post('/sync/push', async (c) => c.json(await push(c.env, c.get('userId'), await jsonBody(c.req.raw))));
app.get('/sync/pull', async (c) => c.json(await pull(c.env, c.get('userId'), { since: c.req.query('since'), limit: c.req.query('limit') })));

// YouTube sign-in through the cloud (src/google.ts). The callback is where
// Google sends the browser: no session there, the signed `state` says who.
app.get('/google/callback', async (c) => google.callback(c.env, new URL(c.req.url).origin, {
    code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error')
}));
app.use('/google', requireSession);
app.use('/google/status', requireSession);
app.use('/google/start', requireSession);
app.use('/google/token', requireSession);
app.get('/google/status', async (c) => c.json(await google.status(c.env, c.get('userId'))));
app.post('/google/start', async (c) => c.json(await google.start(c.env, c.get('userId'), new URL(c.req.url).origin, await jsonBody(c.req.raw))));
app.post('/google/token', async (c) => c.json(await google.accessToken(c.env, c.get('userId'))));
app.delete('/google', async (c) => {
    await google.disconnect(c.env, c.get('userId'));
    return c.body(null, 204);
});

// SoundCloud through the cloud (src/soundcloud.ts), the same way.
app.get('/soundcloud/callback', async (c) => soundcloud.callback(c.env, new URL(c.req.url).origin, {
    code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error')
}));
app.use('/soundcloud', requireSession);
app.use('/soundcloud/status', requireSession);
app.use('/soundcloud/start', requireSession);
app.use('/soundcloud/token', requireSession);
app.use('/soundcloud/app-token', requireSession);
app.get('/soundcloud/status', async (c) => c.json(await soundcloud.status(c.env, c.get('userId'))));
app.post('/soundcloud/start', async (c) => c.json(await soundcloud.start(c.env, c.get('userId'), new URL(c.req.url).origin, await jsonBody(c.req.raw))));
app.post('/soundcloud/token', async (c) => c.json(await soundcloud.accessToken(c.env, c.get('userId'))));
app.post('/soundcloud/app-token', async (c) => c.json(await soundcloud.appToken(c.env)));
app.delete('/soundcloud', async (c) => {
    await soundcloud.disconnect(c.env, c.get('userId'));
    return c.body(null, 204);
});

// What this installation's services are set up with, for a signed-in
// computer: which sign-ins the Worker can do, and the settings that are not
// secrets. The secrets themselves are never sent anywhere.
app.use('/services', requireSession);
app.get('/services', async (c) => c.json({
    google: { configured: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET) },
    soundcloud: { configured: Boolean(c.env.SOUNDCLOUD_CLIENT_ID && c.env.SOUNDCLOUD_CLIENT_SECRET) },
    audius: { apiKey: c.env.AUDIUS_API_KEY || null }
}));

app.notFound((c) => c.json({ error: 'There is nothing at this address.', code: 'NOT_FOUND' }, 404));

app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.status);
    // Details go to the Worker's log, never to the caller.
    console.error('Unhandled error:', err);
    return c.json({ error: 'Something went wrong on the cloud service.', code: 'INTERNAL' }, 500);
});

export default app;
