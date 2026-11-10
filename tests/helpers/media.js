// The media routes (/stream, /duration) need a media token in the URL; this
// appends a valid one for the given user (default: user 1).
const { issueMediaToken } = require('../../services/mediaToken');

function withMedia(url, userId = 1) {
    const { token } = issueMediaToken(userId);
    return `${url}${url.includes('?') ? '&' : '?'}t=${token}`;
}

module.exports = { withMedia };
