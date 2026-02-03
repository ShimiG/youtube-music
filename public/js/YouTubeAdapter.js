class YouTubeAdapter {
    constructor(audioElement) {
        this.audio = audioElement;
        this.sourceName = 'YouTube';
    }

    // The Manager calls this generic function
async play(track) {
        console.log(`🎵 YouTube Adapter: Loading ${track.title}`);
        
        // Add timestamp to prevent caching
        const streamUrl = `/play?videoId=${track.id}&t=${Date.now()}`;
        this.audio.src = streamUrl;
        
        try {
            // Attempt to play
            await this.audio.play();
            console.log("✅ Playback started successfully");
        } catch (error) {
            // THIS is where the silent error is hiding
            console.error("🚨 Playback Failed:", error);
            
            if (error.name === 'NotAllowedError') {
                alert("Autoplay blocked. Please interact with the page (click somewhere) and try again.");
            }
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