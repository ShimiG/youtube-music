// Media tokens: what lets the player (and only the player) use /stream and
// /duration.
//
// The browser's <audio> element cannot send an Authorization header, so those
// two routes used to be open to anything that could reach the server,
// including any web page in the user's browser (<audio src="http://localhost:
// 3000/stream?...">), which could start transcodes at will (security review
// 2026-11-08 / -09, issue #53). Now the logged-in client asks for a media
// token (GET /api/media/token, Bearer-authenticated) and puts it in the media
// URL as `t`. Another page cannot read it, so it cannot build a valid URL.
//
// The token is a JWT signed with JWT_SECRET with purpose 'media'. requireAuth
// rejects every purpose except 'session', so a media token (which travels in
// URLs) can never act as a login; and a session token is not accepted here.
const jwt = require('jsonwebtoken');

const MEDIA_TOKEN_TTL_SEC = 6 * 60 * 60;
const MAX_TOKEN_LENGTH = 1024;

/** Issues a media token for a logged-in user. */
function issueMediaToken(userId) {
    const token = jwt.sign({ userId, purpose: 'media' }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: MEDIA_TOKEN_TTL_SEC
    });
    return { token, expiresAt: Date.now() + MEDIA_TOKEN_TTL_SEC * 1000 };
}

/** Returns the token's payload, or null when it is missing, invalid or expired. */
function verifyMediaToken(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        if (payload.purpose !== 'media') return null;
        if (typeof payload.exp !== 'number') return null;
        if (!Number.isInteger(payload.userId) || payload.userId <= 0) return null;
        return payload;
    } catch {
        return null;
    }
}

module.exports = { issueMediaToken, verifyMediaToken, MEDIA_TOKEN_TTL_SEC };
