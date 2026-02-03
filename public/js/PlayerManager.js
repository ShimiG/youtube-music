class PlayerManager {
    constructor() {
        // --- DATA STRUCTURES ---
        this.prevStack = [];    // History (Previous songs)
        this.currentTrack = null; 
        this.nextStack = [];    // Queue (Up Next)
        
        this.adapters = {};
        this.currentAdapter = null;
        
        // UI References (Populated in init)
        this.ui = {}; 
    }

    init() {
        // Connect to the DOM elements
        this.ui = {
            container: document.getElementById('playerContainer'),
            title: document.getElementById('playerTitle'),
            thumb: document.getElementById('playerThumbnail'),
            bigArt: document.getElementById('bigPlayerArt'),
            audio: document.getElementById('audioPlayer'),
            btnPrev: document.getElementById('btnPrev'),
            btnNext: document.getElementById('btnNext')
        };
        
        // Initial button state check
        this.updateButtonStates();
    }

    registerAdapter(source, adapter) {
        this.adapters[source] = adapter;
    }

    // --- PLAYBACK ENGINE ---

    async play(track, isNavigation = false) {
        if (!track || !track.id) return;

        // 1. History Logic
        // If this is a new track (not from Next/Prev buttons), save current to history
        if (!isNavigation && this.currentTrack && this.currentTrack.id !== track.id) {
            this.prevStack.push(this.currentTrack);
        }

        // 2. Select Adapter
        const adapter = this.adapters[track.source];
        if (!adapter) {
            console.error(`No adapter for source: ${track.source}`);
            return;
        }

        // 3. Switch Adapter if needed
        if (this.currentAdapter && this.currentAdapter !== adapter) {
            this.currentAdapter.stop();
        }
        this.currentAdapter = adapter;
        this.currentTrack = track;

        // 4. Update Visuals
        this.updateUI(track);
        this.updateButtonStates();

        // 5. Attempt Playback
        try {
            console.log(`▶ Playing: ${track.title}`);
            await adapter.play(track);
        } catch (err) {
            console.error("Playback failed:", err);
            // If play fails, try the next one after a delay
            setTimeout(() => this.playNext(), 2000); 
        }
    }

    // --- NAVIGATION ---

    playNext() {
        if (this.nextStack.length > 0) {
            // Move Current -> Prev
            if (this.currentTrack) {
                this.prevStack.push(this.currentTrack);
            }

            // Pop Next -> Current
            const nextTrack = this.nextStack.shift(); 
            
            // Play (isNavigation = true)
            this.play(nextTrack, true);
            this.renderQueue(); 
        } else {
            console.log("End of Queue.");
        }
    }

    playPrevious() {
        if (this.prevStack.length > 0) {
            // Move Current -> Next (Front of queue)
            if (this.currentTrack) {
                this.nextStack.unshift(this.currentTrack);
            }

            // Pop Prev -> Current
            const prevTrack = this.prevStack.pop();

            // Play (isNavigation = true)
            this.play(prevTrack, true);
            this.renderQueue(); 
        } else {
            // No history? Just restart the song
            if (this.ui.audio) {
                this.ui.audio.currentTime = 0;
                this.ui.audio.play();
            }
        }
    }

    // --- QUEUE MANAGEMENT ---

    addToQueue(track) {
        this.nextStack.push(track);
        console.log(`Added to queue: ${track.title}`);
        this.renderQueue();
        this.updateButtonStates();
    }

    removeFromQueue(index) {
        this.nextStack.splice(index, 1);
        this.renderQueue();
        this.updateButtonStates();
    }

    // --- UI UPDATES ---

    updateUI(track) {
        if (this.ui.title) this.ui.title.innerText = track.title;
        if (this.ui.thumb) this.ui.thumb.src = track.image;
        if (this.ui.bigArt) this.ui.bigArt.src = track.image;
        
        if (this.ui.container) {
            this.ui.container.classList.remove('hidden');
        }
    }

    updateButtonStates() {
        if (this.ui.btnPrev) {
            const hasHistory = this.prevStack.length > 0;
            this.ui.btnPrev.style.opacity = hasHistory ? '1' : '0.3';
            this.ui.btnPrev.style.cursor = hasHistory ? 'pointer' : 'default';
        }
        if (this.ui.btnNext) {
            const hasNext = this.nextStack.length > 0;
            this.ui.btnNext.style.opacity = hasNext ? '1' : '0.5';
        }
    }

    renderQueue() {
        this._renderToContainer('queue-list');
        this._renderToContainer('queue-list-expanded');
    }

    _renderToContainer(elementId) {
        const container = document.getElementById(elementId);
        if (!container) return;

        if (this.nextStack.length === 0) {
            container.innerHTML = '<p style="color:#b3b3b3; padding:10px;">Queue is empty.</p>';
            return;
        }

        container.innerHTML = '';
        this.nextStack.forEach((track, index) => {
            const div = document.createElement('div');
            div.className = 'result-item';
            div.style.background = 'transparent';
            div.innerHTML = `
                <img src="${track.image}" style="width:40px; height:40px; border-radius:4px;">
                <div class="result-info">
                    <strong style="font-size:14px;">${track.title}</strong>
                    <br><small style="color:#b3b3b3;">${track.artist}</small>
                </div>
                <button onclick="playerManager.removeFromQueue(${index})" style="background:none; border:none; color:#b3b3b3; cursor:pointer;">❌</button>
            `;
            container.appendChild(div);
        });
    }
}