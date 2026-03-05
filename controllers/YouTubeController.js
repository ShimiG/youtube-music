const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const cacheDir = path.join(__dirname, '../cache');
const isWindows = process.platform === 'win32';
const ffmpegPath = require('ffmpeg-static');
const ytDlpPath = path.join(__dirname, '../bin', isWindows ? 'yt-dlp.exe' : 'yt-dlp_macos');

if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}

function manageAudioCache(maxFiles = 50) {
    fs.readdir(cacheDir, (err, files) => {
        if (err) return console.error('🔍 Error reading cache directory:', err);

        const audioFiles = files.filter(f => f.endsWith('.m4a') || f.endsWith('.mp3'));

        if (audioFiles.length > maxFiles) {
            const filesWithStats = audioFiles.map(file => {
                const fullPath = path.join(cacheDir, file);
                return {
                    path: fullPath,
                    time: fs.statSync(fullPath).mtime.getTime() 
                };
            });

            filesWithStats.sort((a, b) => a.time - b.time);
            const filesToDelete = filesWithStats.slice(0, filesWithStats.length - maxFiles);

            filesToDelete.forEach(fileObj => {
                fs.unlink(fileObj.path, err => {
                    if (err) console.error(`Failed to delete old cache file: ${fileObj.path}`, err);
                    else console.log(`Cache Manager deleted old track: ${path.basename(fileObj.path)}`);
                });
            });
        }
    });
}

    const streamTrack = async (req, res) => {
        const videoId = req.query.videoId;
        const seekTime = Math.floor(Number(req.query.seek || 0)); 

        if (!videoId) return res.status(400).send("Missing videoId");

        console.log(`\n[YouTube] STREAM REQUEST: Video ${videoId} | Seek: ${seekTime}s`);

        const filePath = path.join(cacheDir, `${videoId}.m4a`);

        if (fs.existsSync(filePath)) {
            console.log(`[YouTube] Serving from local cache: ${videoId}`);
            const now = new Date();
            fs.utimesSync(filePath, now, now);
            return res.sendFile(filePath); 
        }

        console.log(`[YouTube] Not in cache. Downloading and streaming: ${videoId}`);
        const args = ['-g', `https://www.youtube.com/watch?v=${videoId}`];

        execFile(ytDlpPath, args, (error, stdout, stderr) => {
            if (error) {
                console.error("[YouTube] yt-dlp Error:", stderr);
                return res.status(500).send("Could not find audio URL");
            }   

            const audioUrl = stdout.trim();
            if (!audioUrl) return res.status(500).send("No URL found");

            const ffmpegArgs = [
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-ss', seekTime.toString(),      
                '-i', audioUrl,      
                '-vn',
                '-c:a', 'aac',        
                '-b:a', '128k',          
                '-f', 'adts',        
                '-'                  
            ];

            const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);
            ffmpegProcess.on('error', (err) => {
                console.error(`[YouTube] Failed to start FFmpeg. Is it installed?`, err.message);
                if (!res.headersSent) {
                    res.status(500).send("Audio processor missing (FFmpeg).");
                }
            });
            res.setHeader('Content-Type', 'audio/aac');
            res.setHeader('Transfer-Encoding', 'chunked');
            ffmpegProcess.stdout.pipe(res);
            const fileStream = fs.createWriteStream(filePath);
            ffmpegProcess.stdout.pipe(fileStream);
            ffmpegProcess.stderr.on('data', (data) => {
                const msg = data.toString();
                if (msg.includes('Error') || msg.includes('Invalid')) {
                    console.error(`[YouTube] FFmpeg Error: ${msg}`);
                }
            });

            req.on('close', (code) => {
                if (code === 0) {
                    console.log(`[YouTube] Successfully cached: ${videoId}`);
                     manageAudioCache(50); 
                } else {
                    console.error(`[YouTube] Process exited with code ${code}`);
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                }
                ffmpegProcess.kill('SIGKILL');
            });
        });
    }


module.exports = { streamTrack };