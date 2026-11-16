// Guards the media routes (/stream, /duration): the request must carry a
// valid media token in the `t` query parameter (see services/mediaToken.js).
// Sets req.userId. Runs before any input validation or yt-dlp / ffmpeg work,
// so a request without a token costs nothing.
const { verifyMediaToken } = require('../services/mediaToken');
const playReport = require('../services/playReport');

module.exports = (req, res, next) => {
    const payload = verifyMediaToken(req.query.t);
    if (!payload) {
        // No handler sees this request, so nothing else would say why a track
        // did not play (services/playReport.js).
        if (req.path === '/stream' && req.query.prepare !== '1') {
            playReport.rejected(req, 'the media token in the address was missing, expired or not valid for this server');
        }
        return res.status(401).json({
            error: 'A valid media token is required. Log in again if this persists.',
            code: 'MEDIA_TOKEN_REQUIRED'
        });
    }
    req.userId = payload.userId;
    next();
};
