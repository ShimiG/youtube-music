const YouTubeController = require('./YouTubeController');
// const SpotifyController = require('./SpotifyController'); // We will create this later!

class StreamingController {
    static handleStream(req, res) {
        const source = req.query.source || 'youtube';

        switch(source.toLowerCase()) {
            case 'youtube': 
                return YouTubeController.streamTrack(req, res);
                
            case 'spotify': 
                // return SpotifyController.streamTrack(req, res);
                return res.status(501).send("Spotify streaming not implemented yet");
                
            default: 
                return res.status(400).send(`Unsupported streaming source: ${source}`);
        }
    }
}

module.exports = StreamingController;