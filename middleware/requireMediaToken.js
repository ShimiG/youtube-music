// Guards the media routes (/stream, /duration): the request must carry a
// valid media token in the `t` query parameter (see services/mediaToken.js).
// Sets req.userId. Runs before any input validation or yt-dlp / ffmpeg work,
// so a request without a token costs nothing.
const { verifyMediaToken } = require('../services/mediaToken');

module.exports = (req, res, next) => {
    const payload = verifyMediaToken(req.query.t);
    if (!payload) {
        return res.status(401).json({
            error: 'A valid media token is required. Log in again if this persists.',
            code: 'MEDIA_TOKEN_REQUIRED'
        });
    }
    req.userId = payload.userId;
    next();
};
