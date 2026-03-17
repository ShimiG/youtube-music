const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const cacheDir = path.join(__dirname, '../cache');
const isWindows = process.platform === 'win32';
const ffmpegPath = require('ffmpeg-static');
const ytDlpPath = path.join(__dirname, '../bin', isWindows ? 'yt-dlp.exe' : 'yt-dlp_macos');

const resolvedCacheDir = path.resolve(cacheDir);
const MAX_SEEK_SECONDS = 24 * 60 * 60; // 24 hours, adjust as needed

if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}

function isValidVideoId(videoId) {
    // Allow only URL-safe characters typically used in YouTube IDs, with a sane length limit
    return typeof videoId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(videoId);
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
        if (!videoId || videoId === 'undefined') {
            console.error("❌ [YouTube] Stream rejected: Missing videoId in request!");
            return res.status(400).send("Missing videoId");
        }

        if (!isValidVideoId(videoId)) {
            console.error("❌ [YouTube] Stream rejected: Invalid videoId format!");
            return res.status(400).send("Invalid videoId");
        }

        const rawSeek = req.query.seek;
        let seekTime = 0;
        if (rawSeek !== undefined) {
            const parsedSeek = Number(rawSeek);
            if (!Number.isFinite(parsedSeek)) {
                console.error("❌ [YouTube] Stream rejected: Non-numeric seek parameter!");
                return res.status(400).send("Invalid seek parameter");
            }
            seekTime = Math.floor(parsedSeek);
            if (seekTime < 0 || seekTime > MAX_SEEK_SECONDS) {
                console.error(`❌ [YouTube] Stream rejected: Out-of-range seek parameter (${seekTime})!`);
                return res.status(400).send("Invalid seek parameter");
            }
        }

        console.log(`\n[YouTube] STREAM REQUEST: Video ${videoId} | Seek: ${seekTime}s`);

        const finalFilePath = path.resolve(resolvedCacheDir, `${videoId}.mp3`);
        const partFilePath = path.resolve(resolvedCacheDir, `${videoId}_${Date.now()}.part`);

        if (!finalFilePath.startsWith(resolvedCacheDir) || !partFilePath.startsWith(resolvedCacheDir)) {
            console.error("❌ [YouTube] Stream rejected: Computed file path escaped cache directory!");
            return res.status(400).send("Invalid videoId");
        }

        if (fs.existsSync(finalFilePath)) {
            console.log(`[YouTube] Serving MP3 from local cache: ${videoId}`);
            const now = new Date();
            fs.utimesSync(finalFilePath, now, now);
            return res.sendFile(finalFilePath); 
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
                '-c:a', 'libmp3lame',        
                '-b:a', '128k',          
                '-f', 'mp3',        
                '-'                  
            ];

            const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);
            
            ffmpegProcess.on('error', (err) => {
                console.error(`[YouTube] Failed to start FFmpeg.`, err.message);
                if (!res.headersSent) res.status(500).send("Audio processor missing.");
            });

            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Transfer-Encoding', 'chunked');

            ffmpegProcess.stdout.pipe(res);
            const uniquePartId = `${videoId}_${Date.now()}.part`;
            const partFilePath = path.join(cacheDir, uniquePartId);
            let fileStream = null;
            if (seekTime === 0) {
                fileStream = fs.createWriteStream(partFilePath);
                ffmpegProcess.stdout.pipe(fileStream);
            }

            ffmpegProcess.stderr.on('data', (data) => {
                const msg = data.toString();
                if (msg.includes('Error') || msg.includes('Invalid')) {
                    console.error(`[YouTube] FFmpeg Error: ${msg}`);
                }
            });
            req.isAborted = false;
            req.on('close', () => {
                console.log(`[YouTube] Client paused connection. Letting FFmpeg finish caching in background...`);
                ffmpegProcess.stdout.unpipe(res);
            });
            ffmpegProcess.on('close', (code) => {
                if (fileStream) {
                    fileStream.end();
                    
                    setTimeout(() => {
                        if (fs.existsSync(partFilePath)) {
                            const stats = fs.statSync(partFilePath);
                            if (code === 0 && stats.size > 100000) {
                                console.log(`[YouTube] Download complete. Caching: ${videoId}`);
                                if (!fs.existsSync(finalFilePath)) {
                                    fs.renameSync(partFilePath, finalFilePath);
                                    manageAudioCache(50); 
                                } else {
                                    fs.unlinkSync(partFilePath);
                                }
                            } else {
                                console.log(`[YouTube] Trashing broken stream (Code: ${code}, Size: ${stats.size} bytes).`);
                                fs.unlinkSync(partFilePath);
                            }
                        }
                    }, 250);
                }
            });
        });
    }

    const getDuration = (req, res) => {
        const videoId = req.query.videoId;
        if (!videoId){
            console.error("❌ [YouTube] Duration rejected: Missing videoId in request!");
            return res.status(400).send("Missing videoId");
        }

        if (!isValidVideoId(videoId)) {
            console.error("❌ [YouTube] Duration rejected: Invalid videoId format!");
            return res.status(400).send("Invalid videoId");
        }

        const args = ['--print', 'duration', `https://www.youtube.com/watch?v=${videoId}`];
        
        execFile(ytDlpPath, args, (error, stdout) => {
            if (error) {
                console.error("[YouTube] Failed to fetch duration:", error);
                return res.status(500).json({ duration: 0 });
            }

            const durationInSeconds = parseInt(stdout.trim(), 10);
            res.json({ duration: durationInSeconds });
        });
    };


module.exports = { streamTrack, getDuration };