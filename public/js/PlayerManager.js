class PlayerManager {
    constructor() {
        this.queue = [];
        this.currentAdapter = null;
        this.adapters = {}; // Will hold { youtube: new YouTubeAdapter(), spotify: ... }
        
        // UI References
        this.ui = {
            container: document.getElementById('playerContainer'),
            title: document.getElementById('playerTitle'),
            thumb: document.getElementById('playerThumbnail'),
            loading: document.getElementById('playerLoading'),
            minBtn: document.getElementById('btnMin'),
            audio: document.getElementById('audioPlayer')
        };
    }

    // Initialize adapters
    registerAdapter(name, adapterInstance) {
        this.adapters[name] = adapterInstance;
    }

    // --- PLAYBACK LOGIC ---

    async play(track) {
        // 1. Determine which adapter to use
        const source = track.source.toLowerCase();
        const adapter = this.adapters[source];

        if (!adapter) {
            console.error(`No adapter found for source: ${source}`);
            return;
        }

        // 2. Switch Adapter if needed (Future proofing for Spotify)
        if (this.currentAdapter && this.currentAdapter !== adapter) {
            this.currentAdapter.stop();
        }
        this.currentAdapter = adapter;

        // 3. Update UI
        this.updateUI(track);

        // 4. Play via Adapter
        try {
            this.ui.loading.style.display = 'block';
            await adapter.play(track);
            this.ui.loading.style.display = 'none';
            
            // 5. Update System Media Session (Notification Bar)
            this.updateMediaSession(track);
            
        } catch (err) {
            this.ui.loading.innerText = "Error playing track";
        }
    }

    playNext() {
        if (this.queue.length > 0) {
            const nextTrack = this.queue.shift();
            this.play(nextTrack);
        } else {
            console.log("Queue is empty.");
        }
    }

    addToQueue(track) {
        this.queue.push(track);
        // Visual feedback would go here
        console.log("Added to queue:", track.title);
    }

    // --- UI & SYSTEM ---

    updateUI(track) {
        this.ui.container.classList.remove('hidden');
        this.ui.container.style.display = 'flex';
        
        // Ensure not minimized on new song
        if(this.ui.container.classList.contains('minimized')) {
             // Optional: Force expand, or keep it minimized. Let's keep user preference for now.
             // But update the text just in case
        }
        
        this.ui.title.innerText = track.title;
        this.ui.thumb.src = track.image;
    }

    updateMediaSession(track) {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.title,
                artist: track.artist,
                artwork: [{ src: track.image, sizes: '512x512', type: 'image/jpeg' }]
            });

            navigator.mediaSession.setActionHandler('play', () => this.currentAdapter.resume());
            navigator.mediaSession.setActionHandler('pause', () => this.currentAdapter.pause());
            navigator.mediaSession.setActionHandler('nexttrack', () => this.playNext());
        }
    }
}