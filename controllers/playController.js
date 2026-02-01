// controllers/playController.js
const { spawn } = require('child_process');
const NodeCache = require('node-cache');
const axios = require('axios');

// Cache links for 1 hour so we don't ask yt-dlp every time
const playCache = new NodeCache({ stdTTL: 3600 });

/**
 * Helper function to get the direct URL using yt-dlp
 */
const getAudioUrl = (videoId) => {
    return new Promise((resolve, reject) => {
        // -g: Get URL only (don't download)
        // -f: Best audio m4a
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
                // Trim whitespace/newlines
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
    // Get the "Range" header (e.g., "bytes=10000-") sent by the browser when seeking
    const range = req.headers.range;

    if (!videoId) return res.status(400).send("Missing videoId");

    try {
        // 1. Get the Direct Audio URL (Check cache first)
        let audioUrl = playCache.get(videoId);

        if (!audioUrl) {
            console.log(`🎵 Getting Fresh URL for: ${videoId}`);
            audioUrl = await getAudioUrl(videoId);
            playCache.set(videoId, audioUrl);
        } else {
            console.log(`⚡ Using Cached URL for: ${videoId}`);
        }

        // 2. Prepare headers for the Proxy Request
        // We forward the Range header so Google knows which part of the file we want
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        };
        if (range) {
            headers['Range'] = range;
        }

        // 3. Request the stream from Google
        const response = await axios({
            method: 'get',
            url: audioUrl,
            responseType: 'stream',
            headers: headers,
            validateStatus: (status) => status >= 200 && status < 400 // Accept 206 (Partial Content)
        });

        // 4. Pass the appropriate headers back to the Browser
        // This tells the browser "Yes, I support seeking (Partial Content)"
        res.status(response.status); // Usually 206
        
        // Critical headers for seeking:
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

        // 5. Pipe the data
        response.data.pipe(res);

    } catch (error) {
        console.error("🔥 PROXY ERROR:", error.message);
        
        // If 403 Forbidden (Link expired), clear cache so next try works
        if (error.response && (error.response.status === 403 || error.response.status === 410)) {
            console.log("⚠️ Link expired or blocked. Clearing cache.");
            playCache.del(videoId);
        }

        if (!res.headersSent) res.status(500).send("Stream failed");
    }
};

module.exports = { streamAudio };