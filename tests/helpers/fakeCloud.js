// A stand-in for the cloud service (the Worker in cloud/), for tests of the
// app's side of it. It follows the Worker's rules: newest change wins, equal
// times go to the larger device id, every accepted change gets the account's
// next number (cloud/src/sync.ts); and the YouTube sign-in the Worker offers
// (cloud/src/google.ts), with Google itself left out.
//
//   const cloud = fakeCloud();
//   client.http.fetch = cloud.fetch;      // services/cloud/client.js
const WORKER = 'https://music-manager-cloud.example.workers.dev';

function fakeCloud() {
    const accounts = new Map(); // lower-case name -> { authKey, records: Map, seq }
    const sessions = new Map(); // token -> account
    const state = {
        calls: [], pushes: [], registrationCode: 'let-me-in', down: false, rejectSessions: false, nextToken: 1,
        // YouTube sign-in (cloud/src/google.ts)
        googleConfigured: true, googleDown: false, googleStarts: [], googleTokens: 0
    };
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const session = (account) => {
        const token = `session-${state.nextToken++}`;
        sessions.set(token, account);
        return { token, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 };
    };
    state.fetch = async (url, init = {}) => {
        const u = new URL(url);
        const body = init.body ? JSON.parse(init.body) : null;
        state.calls.push(`${init.method || 'GET'} ${u.pathname}`);
        if (state.down) throw new Error('getaddrinfo ENOTFOUND');
        if (u.origin !== WORKER) return json(404, { code: 'NOT_FOUND', error: 'nothing here' });
        if (u.pathname === '/health') return json(200, { ok: true, service: 'music-manager-cloud', registrationOpen: Boolean(state.registrationCode) });
        if (u.pathname === '/auth/register') {
            if (body.registrationCode !== state.registrationCode) return json(403, { code: 'BAD_REGISTRATION_CODE', error: 'That registration code is not right.' });
            const key = body.username.toLowerCase();
            if (accounts.has(key)) return json(409, { code: 'USERNAME_TAKEN', error: 'That user name is already in use.' });
            accounts.set(key, { authKey: body.authKey, records: new Map(), seq: 0, google: false });
            return json(201, session(accounts.get(key)));
        }
        if (u.pathname === '/auth/login') {
            const account = accounts.get(String(body.username).toLowerCase());
            if (!account || account.authKey !== body.authKey) return json(401, { code: 'BAD_CREDENTIALS', error: 'Wrong user name or password.' });
            return json(200, session(account));
        }
        const token = String((init.headers || {}).Authorization || '').replace('Bearer ', '');
        const account = sessions.get(token);
        if (!account || state.rejectSessions) return json(401, { code: 'NOT_SIGNED_IN', error: 'Sign in to the cloud account first.' });
        if (u.pathname === '/auth/refresh') return json(200, session(account));
        if (u.pathname === '/sync/push') {
            state.pushes.push(body.changes);
            body.changes.forEach((change, index) => {
                const key = `${change.collection}\n${change.id}`;
                const old = account.records.get(key);
                const wins = !old || change.updatedAt > old.updatedAt || (change.updatedAt === old.updatedAt && body.deviceId > old.deviceId);
                if (wins) {
                    account.records.set(key, {
                        collection: change.collection, id: change.id, updatedAt: change.updatedAt,
                        deleted: change.deleted === true, data: change.deleted ? null : change.data,
                        seq: account.seq + index + 1, deviceId: body.deviceId
                    });
                }
            });
            account.seq += body.changes.length;
            return json(200, { received: body.changes.length, cursor: account.seq });
        }
        if (u.pathname === '/sync/pull') {
            const since = Number(u.searchParams.get('since') || 0);
            const limit = Number(u.searchParams.get('limit') || 200);
            const after = [...account.records.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
            const page = after.slice(0, limit);
            return json(200, { changes: page, cursor: page.length ? page[page.length - 1].seq : since, more: after.length > limit });
        }
        if (u.pathname === '/google/status') return json(200, { configured: state.googleConfigured, connected: Boolean(account.google), scope: null });
        const notConfigured = () => json(503, { code: 'GOOGLE_NOT_CONFIGURED', error: 'YouTube sign-in is not set up on the cloud service: its Google credentials are missing.' });
        if (u.pathname === '/google/start') {
            if (!state.googleConfigured) return notConfigured();
            if (body.returnTo !== 'app' && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(body.returnTo))) {
                return json(400, { code: 'BAD_RETURN', error: 'returnTo must be "app" or an address on this computer.' });
            }
            state.googleStarts.push(body);
            return json(200, { url: `https://accounts.google.com/o/oauth2/v2/auth?client_id=cloud-client&state=signed-by-the-cloud-${state.googleStarts.length}` });
        }
        if (u.pathname === '/google/token') {
            if (!state.googleConfigured) return notConfigured();
            if (!account.google) return json(409, { code: 'GOOGLE_NOT_CONNECTED', error: 'YouTube is not connected for this account. Connect it again.' });
            if (state.googleDown) return json(503, { code: 'GOOGLE_UNREACHABLE', error: 'Google could not be reached. Try again in a moment.' });
            state.googleTokens += 1;
            return json(200, { accessToken: `ya29.from-the-cloud-${state.googleTokens}`, expiresAt: Date.now() + 3600 * 1000 });
        }
        if (u.pathname === '/google' && init.method === 'DELETE') {
            account.google = false;
            return json(200, { connected: false });
        }
        return json(404, { code: 'NOT_FOUND', error: 'nothing here' });
    };
    // What Google's consent page and the cloud's callback do between them.
    state.connectYouTube = (name = 'shimi') => { accounts.get(name).google = true; };
    state.records = (name = 'shimi') => [...accounts.get(name).records.values()];
    return state;
}

module.exports = { fakeCloud, WORKER };
