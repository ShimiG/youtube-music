class YouTubeAdapter {
    constructor(audioElement) {
        this.audio = audioElement;
        this.sourceName = 'YouTube';
    }

async play(track) {
        console.log(`🎵 YouTube Adapter: Loading ${track.title}`);
        
        const streamUrl = `/play?videoId=${track.id}&t=${Date.now()}`;
        this.audio.src = streamUrl;
        
        try {
            await this.audio.play();
            console.log("✅ Playback started successfully");
        } catch (error) {
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