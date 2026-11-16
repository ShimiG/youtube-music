// What the cloud service says this installation's services are set up with
// (the Worker's GET /services): which sign-ins it can do, and the settings
// that are not secrets. The secrets stay in the Worker; a computer only ever
// gets tokens (services/cloud/google.js, services/cloud/soundcloud.js).
//
// Today that is one value: the Audius API key, which only names the app to
// Audius. It is remembered across restarts, since Audius is used without
// anyone having to be signed in at that moment.
const client = require('./client');
const sync = require('./sync');

const AUDIUS_KEY = 'cloud_audius_api_key';
const MAX_KEY_CHARS = 200;

let audiusKey = null;

/** Loads what was last known, at start-up. */
async function load(db) {
    audiusKey = (await sync.getMeta(db, AUDIUS_KEY)) || null;
}

/** The Audius API key: this computer's own setting first, else the cloud's. */
const audiusApiKey = () => process.env.AUDIUS_API_KEY || audiusKey || undefined;

/** Asks the cloud and remembers the answer. Null when the user is not signed in to it. */
async function refresh(db, userId) {
    const session = await sync.sessionFor(db, userId);
    if (!session) return null;
    const answer = await client.request(session.url, '/services', { token: session.token });
    const key = answer && answer.audius && typeof answer.audius.apiKey === 'string' ? answer.audius.apiKey : null;
    // Plain printable text only: it goes into a request address.
    const clean = key && key.length <= MAX_KEY_CHARS && /^[\x21-\x7e]+$/.test(key) ? key : null;
    if (clean !== audiusKey) {
        audiusKey = clean;
        await sync.setMeta(db, AUDIUS_KEY, clean || '');
    }
    return {
        google: Boolean(answer && answer.google && answer.google.configured),
        soundcloud: Boolean(answer && answer.soundcloud && answer.soundcloud.configured),
        audius: Boolean(clean)
    };
}

// Tests only.
function _reset() { audiusKey = null; }

module.exports = { load, refresh, audiusApiKey, _reset };
