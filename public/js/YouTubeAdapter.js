class YouTubeAdapter {
    constructor(audioElement) {
        this.audio = audioElement;
        this.sourceName = 'YouTube';
    }

    // The Manager calls this generic function
    async play(track) {
        // Track object looks like: { id, title, artist, image, source: 'youtube' }
        
        // 1. Construct the Proxy URL (The logic you already have)
        // We add the timestamp to prevent caching issues
        const streamUrl = `/play?videoId=${track.id}&t=${Date.now()}`;
        
        // 2. Set the Source and Play
        this.audio.src = streamUrl;
        
        try {
            await this.audio.play();
        } catch (error) {
            console.error("YouTube Adapter Error:", error);
            throw error;
        }
    }

    pause() {
        this.audio.pause();
    }

    resume() {
        this.audio.play();
    }

    stop() {
        this.audio.pause();
        this.audio.src = ""; // Unload the buffer
    }
}