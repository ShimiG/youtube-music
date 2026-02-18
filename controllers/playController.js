
const { spawn } = require('child_process');
const NodeCache = require('node-cache');
const axios = require('axios');

const playCache = new NodeCache({ stdTTL: 3600 });



const getAudioUrl = (videoId) => {
    return new Promise((resolve, reject) => {
        const ytDlp = spawn('yt-dlp', [
            '-g', 
            '-f', 'bestaudio[ext=m4a]/bestaudio',
            `https://www.youtube.com/watch?v=${videoId}`
        ]);

        let output = '';

        ytDlp.stdout.on('data', (data) => {
            output += data.toString();
        });

        ytDlp.on('close', (code) => {
            if (code === 0 && output) {
                resolve(output.trim());
            } else {
                reject(new Error('yt-dlp failed to find URL'));
            }
        });
        
        ytDlp.stderr.on('data', (data) => console.error(`yt-dlp stderr: ${data}`));
    });
};

const streamAudio = async (req, res) => {
    const videoId = req.query.videoId;
    const range = req.headers.range;

    if (!videoId) return res.status(400).send("Missing videoId");

    try {
        let audioUrl = playCache.get(videoId);

        if (!audioUrl) {
            console.log(`Getting Fresh URL for: ${videoId}`);
            audioUrl = await getAudioUrl(videoId);
            playCache.set(videoId, audioUrl);
        } else {
            console.log(`Using Cached URL for: ${videoId}`);
        }

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        };
        if (range) {
            headers['Range'] = range;
        }

        const response = await axios({
            method: 'get',
            url: audioUrl,
            responseType: 'stream',
            headers: headers,
            validateStatus: (status) => status >= 200 && status < 400 
        });

        res.status(response.status); 
        
        const headersToPass = [
            'content-range', 
            'accept-ranges', 
            'content-length', 
            'content-type'
        ];

        headersToPass.forEach(header => {
            if (response.headers[header]) {
                res.setHeader(header, response.headers[header]);
            }
        });

        response.data.pipe(res);

    } catch (error) {
        console.error("PROXY ERROR:", error.message);

        if (error.response && (error.response.status === 403 || error.response.status === 410)) {
            console.log("**Link expired or blocked. Clearing cache.");
            playCache.del(videoId);
        }

        if (!res.headersSent) res.status(500).send("Stream failed");
    }
};

module.exports = { streamAudio };