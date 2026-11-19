// What to tell the person when the cloud service would not start a YouTube or
// SoundCloud sign-in (controllers/authController.js, soundcloudController.js).
//
// Every refusal used to come out as "could not be reached ... try again",
// which sent people waiting for something that would never change: most
// refusals are a setting, and the cloud's own answer says which.
const { CloudError } = require('./client');

/**
 * { status, body } for the answer to the browser. `label`: "YouTube" or
 * "SoundCloud"; `returnTo`: where the sign-in was to come back to.
 */
function describeConnectFailure(err, { label, source, returnTo }) {
    const answer = (status, code, error) => ({ status, body: { error, code, source, reason: err && err.code ? String(err.code) : undefined } });
    if (!(err instanceof CloudError)) {
        return answer(502, 'SOURCE_UPSTREAM', `Your cloud account could not be reached to connect ${label}. Try again in a moment.`);
    }
    switch (err.code) {
        case 'BAD_RETURN':
            // The Worker only sends the browser back to places it knows.
            return answer(502, 'CLOUD_RETURN_NOT_ALLOWED',
                `Your cloud service does not accept ${returnTo === 'app' ? 'the desktop app' : returnTo} as the place to come back to after connecting ${label}. `
                + `Set the Worker's WEB_ORIGINS (a Secret) to ${returnTo === 'app' ? 'this site\'s address' : returnTo} and deploy it. `
                + 'The Worker\'s /health page says how many sites it took from WEB_ORIGINS ("webOrigins"): 0 means the value was not understood.');
        case 'NOT_SIGNED_IN':
            return answer(401, 'CLOUD_SIGNIN_REQUIRED', 'Your cloud session has ended. Sign out and sign in again, then connect again.');
        case 'NOT_CONFIGURED':
            return answer(502, 'CLOUD_NOT_CONFIGURED', 'Your cloud service is not set up yet: its JWT_SECRET is missing or too short.');
        case 'NOT_FOUND':
            return answer(502, 'CLOUD_TOO_OLD', `Your cloud service does not offer ${label} sign-in: it runs an older version. Deploy the Worker again (its /health page should say version 0.5.0 or later).`);
        case 'UNREACHABLE':
            return answer(502, 'SOURCE_UPSTREAM', `Your cloud account could not be reached to connect ${label}. Try again in a moment.`);
        default:
            return answer(502, 'SOURCE_UPSTREAM', `Your cloud service would not start connecting ${label}: ${String(err.message || err.code).slice(0, 200)}`);
    }
}

module.exports = { describeConnectFailure };
