const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const cacheDir = path.join(__dirname, '../cache');
const isWindows = process.platform === 'win32';
const ffmpegPath = require('ffmpeg-static');
const ytDlpPath = path.join(__dirname, '../bin', isWindows ? 'yt-dlp.exe' : 'yt-dlp_macos');
const logger = require('../services/logger');

const resolvedCacheDir = path.resolve(cacheDir);
const MAX_SEEK_SECONDS = 24 * 60 * 60; // 24 hours
const MAX_PROCESS_TIME = parseInt(process.env.PROCESS_TIMEOUT || 60000);  // 60 seconds default
const MAX_CONCURRENT_STREAMS = parseInt(process.env.MAX_CONCURRENT_STREAMS || 10);

let activeStreams = 0;

/**
 * Derive a safe filename component from a videoId
 */
function toSafeFilenameComponent(videoId) {
    if (typeof videoId !== 'string') {
        return 'unknown';
    }
    const sanitized = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return sanitized.substring(0, 64) || 'unknown';
}

if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}

function isValidVideoId(videoId) {
    return typeof videoId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(videoId);
}

function manageAudioCache(maxFiles = 50) {
    fs.readdir(cacheDir, (err, files) => {
        if (err) {
            logger.error('Cache directory read error', { error: err.message });
            return;
        }

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
                    if (err) {
                        logger.error('Cache deletion failed', { file: fileObj.path, error: err.message });
                    } else {
                        logger.info('Cache file deleted', { file: path.basename(fileObj.path) });
                    }
                });
            });
        }
    });
}

const streamTrack = async (req, res) => {
    const videoId = req.query.videoId;
    
    if (!videoId || videoId === 'undefined') {
        logger.warn('Stream rejected: Missing videoId', { ip: req.ip });
        return res.status(400).json({ error: "Missing videoId" });
    }

    if (!isValidVideoId(videoId)) {
        logger.warn('Stream rejected: Invalid videoId format', { videoId, ip: req.ip });
        return res.status(400).json({ error: "Invalid videoId" });
    }

    // Check concurrent stream limit
    if (activeStreams >= MAX_CONCURRENT_STREAMS) {
        logger.warn('Stream rejected: Max concurrent streams exceeded', { 
            activeStreams, 
            limit: MAX_CONCURRENT_STREAMS,
            ip: req.ip 
        });
        return res.status(429).json({ error: "Too many concurrent streams. Please try again later." });
    }

    const rawSeek = req.query.seek;
    let seekTime = 0;
    if (rawSeek !== undefined) {
        const parsedSeek = Number(rawSeek);
        if (!Number.isFinite(parsedSeek)) {
            return res.status(400).json({ error: "Invalid seek parameter" });
        }
        seekTime = Math.floor(parsedSeek);
        if (seekTime < 0 || seekTime > MAX_SEEK_SECONDS) {
            return res.status(400).json({ error: "Seek value out of range" });
        }
    }

    logger.info('Stream requested', { videoId, seekTime, userId: req.userId });

    activeStreams++;
    const streamStartTime = Date.now();

    const finalFilePath = path.resolve(resolvedCacheDir, `${videoId}.mp3`);
    const partFilePath = path.resolve(resolvedCacheDir, `${videoId}_${Date.now()}.part`);

    if (!finalFilePath.startsWith(resolvedCacheDir) || !partFilePath.startsWith(resolvedCacheDir)) {
        activeStreams--;
        return res.status(400).json({ error: "Invalid videoId" });
    }

    // Check cache first
    if (fs.existsSync(finalFilePath)) {
        logger.info('Serving from cache', { videoId, userId: req.userId });
        const now = new Date();
        fs.utimesSync(finalFilePath, now, now);
        res.setHeader('Content-Type', 'audio/mpeg');
        
        const stream = fs.createReadStream(finalFilePath);
        stream.on('end', () => {
            activeStreams--;
        });
        stream.on('error', (err) => {
            activeStreams--;
            logger.error('Cache file read error', { videoId, error: err.message });
        });
        
        return stream.pipe(res);
    }

    logger.info('Downloading audio', { videoId, userId: req.userId });
    
    // Fetch audio URL with timeout
    const args = ['-g', `https://www.youtube.com/watch?v=${videoId}`];

    const timeoutHandle = setTimeout(() => {
        logger.warn('yt-dlp process timeout', { videoId });
        // Process will be killed automatically
    }, MAX_PROCESS_TIME);

    execFile(ytDlpPath, args, { timeout: MAX_PROCESS_TIME, maxBuffer: 1024 * 1024 }, 
        (error, stdout, stderr) => {
            clearTimeout(timeoutHandle);
            
            if (error) {
                activeStreams--;
                logger.error('yt-dlp error', { videoId, error: error.message });
                if (!res.headersSent) {
                    return res.status(500).json({ error: "Could not fetch audio URL" });
                }
                return;
            }

            const audioUrl = stdout.trim();
            
            // SECURITY: Validate URL before passing to ffmpeg (SSRF protection)
            try {
                const urlObj = new URL(audioUrl);
                if (!urlObj.hostname.includes('youtube') && !urlObj.hostname.includes('googlevideo')) {
                    activeStreams--;
                    logger.error('SSRF attempt blocked - invalid audio source', { videoId, hostname: urlObj.hostname });
                    if (!res.headersSent) {
                        return res.status(403).json({ error: "Invalid audio source" });
                    }
                    return;
                }
            } catch (e) {
                activeStreams--;
                logger.error('Invalid URL from yt-dlp', { videoId, error: e.message });
                if (!res.headersSent) {
                    return res.status(500).json({ error: "Invalid audio URL" });
                }
                return;
            }

            logger.info('Audio URL obtained', { videoId });

            // Start ffmpeg with timeout
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

            const ffmpegTimeoutHandle = setTimeout(() => {
                logger.warn('FFmpeg process timeout', { videoId });
                ffmpegProcess.kill('SIGTERM');
                if (!res.headersSent) {
                    activeStreams--;
                    return res.status(504).json({ error: "Stream processing timeout" });
                }
            }, MAX_PROCESS_TIME);

            const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            ffmpegProcess.on('error', (err) => {
                clearTimeout(ffmpegTimeoutHandle);
                activeStreams--;
                logger.error('FFmpeg error', { videoId, error: err.message });
                if (!res.headersSent) {
                    return res.status(500).json({ error: "Audio processing failed" });
                }
            });

            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Transfer-Encoding', 'chunked');

            ffmpegProcess.stdout.pipe(res);
            
            const safeVideoId = toSafeFilenameComponent(videoId);
            const uniquePartId = `${safeVideoId}_${Date.now()}.part`;
            const candidatePartPath = path.resolve(cacheDir, uniquePartId);
            const safePartFilePath = candidatePartPath.startsWith(resolvedCacheDir + path.sep)
                ? candidatePartPath
                : null;
            
            let fileStream = null;
            if (seekTime === 0 && safePartFilePath) {
                fileStream = fs.createWriteStream(safePartFilePath);
                ffmpegProcess.stdout.pipe(fileStream);
            }

            ffmpegProcess.stderr.on('data', (data) => {
                const msg = data.toString();
                if (msg.includes('Error') || msg.includes('Invalid')) {
                    logger.debug('FFmpeg stderr', { videoId, message: msg });
                }
            });

            req.on('close', () => {
                logger.info('Client closed connection', { videoId, userId: req.userId });
                ffmpegProcess.stdout.unpipe(res);
            });

            ffmpegProcess.on('close', (code) => {
                clearTimeout(ffmpegTimeoutHandle);
                activeStreams--;
                
                if (fileStream) {
                    fileStream.end();
                    
                    setTimeout(() => {
                        if (safePartFilePath && fs.existsSync(safePartFilePath)) {
                            const stats = fs.statSync(safePartFilePath);
                            if (code === 0 && stats.size > 100000) {
                                logger.info('Stream cached', { videoId, size: stats.size });
                                if (!fs.existsSync(finalFilePath)) {
                                    fs.renameSync(safePartFilePath, finalFilePath);
                                    manageAudioCache(50); 
                                } else {
                                    fs.unlinkSync(safePartFilePath);
                                }
                            } else {
                                logger.warn('Corrupted stream discarded', { videoId, code, size: stats.size });
                                fs.unlinkSync(safePartFilePath);
                            }
                        }
                    }, 250);
                }
                
                const duration = Date.now() - streamStartTime;
                logger.info('Stream completed', { videoId, duration: `${duration}ms`, code });
            });
        }
    );
};

const getDuration = (req, res) => {
    const videoId = req.query.videoId;
    if (!videoId) {
        logger.warn('Duration request rejected: Missing videoId');
        return res.status(400).json({ error: "Missing videoId" });
    }

    if (!isValidVideoId(videoId)) {
        logger.warn('Duration request rejected: Invalid videoId', { videoId });
        return res.status(400).json({ error: "Invalid videoId" });
    }

    const args = ['--print', 'duration', `https://www.youtube.com/watch?v=${videoId}`];
    
    const timeoutHandle = setTimeout(() => {
        logger.warn('getDuration timeout', { videoId });
    }, MAX_PROCESS_TIME);

    execFile(ytDlpPath, args, { timeout: MAX_PROCESS_TIME, maxBuffer: 1024 * 1024 }, 
        (error, stdout) => {
            clearTimeout(timeoutHandle);
            
            if (error) {
                logger.error('getDuration error', { videoId, error: error.message });
                return res.status(500).json({ duration: 0 });
            }

            const durationInSeconds = parseInt(stdout.trim(), 10);
            res.json({ duration: durationInSeconds });
        }
    );
};

// Cleanup on process exit
process.on('exit', () => {
    if (activeStreams > 0) {
        logger.info('Closing active streams on process exit', { count: activeStreams });
    }
});

module.exports = { streamTrack, getDuration };

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
            const safeVideoId = toSafeFilenameComponent(videoId);
            const uniquePartId = `${safeVideoId}_${Date.now()}.part`;
            const candidatePartPath = path.resolve(cacheDir, uniquePartId);
            const safePartFilePath = candidatePartPath.startsWith(resolvedCacheDir + path.sep)
                ? candidatePartPath
                : null;
            let fileStream = null;
            if (seekTime === 0 && safePartFilePath) {
                fileStream = fs.createWriteStream(safePartFilePath);
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
                        if (safePartFilePath && fs.existsSync(safePartFilePath)) {
                            const stats = fs.statSync(safePartFilePath);
                            if (code === 0 && stats.size > 100000) {
                                console.log(`[YouTube] Download complete. Caching: ${videoId}`);
                                if (!fs.existsSync(finalFilePath)) {
                                    fs.renameSync(safePartFilePath, finalFilePath);
                                    manageAudioCache(50); 
                                } else {
                                    fs.unlinkSync(safePartFilePath);
                                }
                            } else {
                                console.log(`[YouTube] Trashing broken stream (Code: ${code}, Size: ${stats.size} bytes).`);
                                fs.unlinkSync(safePartFilePath);
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