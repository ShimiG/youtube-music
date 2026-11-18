#!/usr/bin/env node
// Fetches yt-dlp into the data folder at build time, for a host where none is
// installed (render.yaml). The server would fetch it itself within a minute
// of starting (services/ytdlpFolder.js), but tracks played before that would
// fail; fetched here, it is there from the first request.
//
// The same code path as the server's own: yt-dlp's folder build, checked
// against the release's published checksums, unpacked by the app's code, and
// tried before it is kept. MUSIC_DATA_DIR must be the folder the server will
// use, and inside what the host keeps from the build.
//
// Never fails the build: without it the server fetches yt-dlp itself.
const folder = require('../services/ytdlpFolder');

(async () => {
    if (!process.env.MUSIC_DATA_DIR) {
        console.log('fetch-ytdlp: MUSIC_DATA_DIR is not set; the server will fetch yt-dlp itself.');
        return;
    }
    const why = folder.notManaged();
    if (why) {
        console.log(`fetch-ytdlp: skipped (${why}).`);
        return;
    }
    const result = await folder.ensure({ currentPath: null });
    console.log(`fetch-ytdlp: ${result.status}: ${result.message}`);
})().catch((err) => console.log(`fetch-ytdlp: ${err.message}; the server will fetch yt-dlp itself.`));
