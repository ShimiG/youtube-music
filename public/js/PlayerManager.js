class PlayerManager {
    constructor() {
        this.queue = [];
        this.currentAdapter = null;
        this.adapters = {}; // Will hold { youtube: new YouTubeAdapter(), spotify: ... }
        
        // UI References
        this.ui = {};
    }

    init(){
                this.ui = {
            container: document.getElementById('playerContainer'),
            title: document.getElementById('playerTitle'),
            thumb: document.getElementById('playerThumbnail'),
            loading: document.getElementById('playerLoading'),
            minBtn: document.getElementById('btnMin'),
            audio: document.getElementById('audioPlayer')
        };
        if (!this.ui.title) console.error("🚨 CRITICAL: Player Title Element Not Found!");
    }

    // Initialize adapters
    registerAdapter(name, adapterInstance) {
        this.adapters[name] = adapterInstance;
    }

    // --- PLAYBACK LOGIC ---

    async play(track) {
        // 1. Validate Track
        if (!track || !track.id) {
            console.error("Invalid track data:", track);
            return;
        }

        // 2. Select Adapter
        const adapter = this.adapters[track.source];
        if (!adapter) {
            console.error(`No adapter for source: ${track.source}`);
            return;
        }

        // 3. Update Manager State
        if (this.currentAdapter && this.currentAdapter !== adapter) {
            this.currentAdapter.stop();
        }
        this.currentAdapter = adapter;
        this.currentTrack = track;

        // 4. Update UI IMMEDIATELY (Visual Feedback)
        this.updateUI(track);

        // 5. Play Logic (Wrapped in Try/Catch)
        try {
            console.log(`▶ Playing: ${track.title}`);
            await adapter.play(track);
            this.isPlaying = true;
        } catch (err) {
            console.error("Playback failed:", err);
            // Auto-skip if it fails
            setTimeout(() => this.playNext(), 2000); 
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
    addToQueue(track) {
        this.queue.push(track);
        console.log(`Added to queue: ${track.title}`);
        this.renderQueue(); // Update UI
    }

    playNext() {
        if (this.queue.length > 0) {
            const nextTrack = this.queue.shift(); // Get first item
            this.play(nextTrack);
            this.renderQueue(); // Update UI
        } else {
            console.log("Queue is empty.");
        }
    }

    renderQueue() {
        const container = document.getElementById('queue-list');
        if (!container) return; // Guard clause

        if (this.queue.length === 0) {
            container.innerHTML = '<p>Queue is empty.</p>';
            return;
        }

        container.innerHTML = ''; // Clear
        this.queue.forEach((track, index) => {
            const div = document.createElement('div');
            div.className = 'result-item';
            div.innerHTML = `
                <img src="${track.image}" style="width:40px; height:40px; border-radius:4px;">
                <div class="result-info">
                    <strong>${track.title}</strong>
                </div>
                <button onclick="playerManager.removeFromQueue(${index})" style="background:none; border:none; color:#b3b3b3; cursor:pointer;">❌</button>
            `;
            container.appendChild(div);
        });
    }

    removeFromQueue(index) {
        this.queue.splice(index, 1);
        this.renderQueue();
    }
}