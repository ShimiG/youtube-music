class PlayerManager {
    constructor() {
        // --- DATA STRUCTURES ---
        this.prevStack = [];    // History (Previous songs)
        this.currentTrack = null; 
        this.nextStack = [];    // Queue (Up Next)
        
        this.isShuffle = false;
        this.originalStack = []; // Backup of queue before shuffling
        this.repeatMode = 0;     // 0 = Off, 1 = All, 2 = One

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
            btnNext: document.getElementById('btnNext'),
            progressBar: document.getElementById('progressBar'),
            currTime: document.getElementById('currentTime'),
            totTime: document.getElementById('totalTime'),
            btnPlayPause: document.getElementById('btnPlayPause'),
            volumeSlider: document.getElementById('volumeSlider'),
            btnMute: document.getElementById('btnMute'),
            btnShuffle: document.getElementById('btnShuffle'),
            btnRepeat: document.getElementById('btnRepeat'),
            repeatBadge: document.getElementById('repeatOneBadge')
        };
        
        this.lastVolume = 1;
        this.isDragging = false;
        this.setupProgressEvents();
        this.setupVolumeEvents();
        this.setupMediaSession();
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
        this.updateMediaSession(track);
        
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
        // 1. REPEAT ONE CHECK
        if (this.repeatMode === 2 && this.currentTrack) {
            // Just restart the audio
            const audio = this.ui.audio;
            if (audio) {
                audio.currentTime = 0;
                audio.play();
            }
            return;
        }

        // 2. CHECK QUEUE
        if (this.nextStack.length > 0) {
            // Standard Logic: Move Current -> Prev, Pop Next
            if (this.currentTrack) this.prevStack.push(this.currentTrack);
            const nextTrack = this.nextStack.shift(); 
            this.play(nextTrack, true);
            this.renderQueue(); 

        } else {
            // 3. REPEAT ALL CHECK (Queue is empty)
            if (this.repeatMode === 1 && this.prevStack.length > 0) {
                console.log("Repeating All: Reloading History into Queue...");
                
                // Move current to history first
                if (this.currentTrack) this.prevStack.push(this.currentTrack);
                
                // Move History -> Queue
                this.nextStack = [...this.prevStack];
                this.prevStack = []; // Clear history
                
                // If Shuffle is ON, re-shuffle the new queue
                if (this.isShuffle) this._shuffleArray(this.nextStack);

                // Play the first one
                const nextTrack = this.nextStack.shift();
                this.play(nextTrack, true);
                this.renderQueue();
            } else {
                console.log("End of Queue.");
            }
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
        // Shuffle Visuals
        if (this.ui.btnShuffle) {
            this.ui.btnShuffle.style.color = this.isShuffle ? '#1db954' : '#b3b3b3';
            this.ui.btnShuffle.innerText = this.isShuffle ? "🔀" : "🔀"; // You can change icon if desired
        }

        // Repeat Visuals
        if (this.ui.btnRepeat) {
            // Color is Green if Mode 1 or 2
            this.ui.btnRepeat.style.color = this.repeatMode > 0 ? '#1db954' : '#b3b3b3';
            
            // Show "1" badge if Mode 2
            if (this.ui.repeatBadge) {
                this.ui.repeatBadge.style.display = (this.repeatMode === 2) ? 'block' : 'none';
            }
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
    setupProgressEvents() {
        const { audio, progressBar, currTime, totTime, btnPlayPause } = this.ui;

        // 1. UPDATE BAR AS SONG PLAYS
        audio.addEventListener('timeupdate', () => {
            if (!this.isDragging) {
                const current = audio.currentTime;
                const duration = audio.duration || 0;
                
                // Update Slider Value
                if (duration > 0) {
                    progressBar.value = (current / duration) * 100;
                    progressBar.style.backgroundSize = `${progressBar.value}% 100%`; // Update Green Fill
                }
                
                // Update Text
                currTime.innerText = this.formatTime(current);
                totTime.innerText = this.formatTime(duration);
            }
        });

        // 2. USER DRAGS SLIDER (Seeking)
        progressBar.addEventListener('input', () => {
            this.isDragging = true;
            // Visual update while dragging
            const val = progressBar.value;
            progressBar.style.backgroundSize = `${val}% 100%`;
        });

        progressBar.addEventListener('change', () => {
            this.isDragging = false;
            const duration = audio.duration || 0;
            audio.currentTime = (progressBar.value / 100) * duration;
        });

        // 3. PLAY/PAUSE SYNC
        audio.addEventListener('play', () => {
            if(btnPlayPause) btnPlayPause.innerText = "⏸";
        });
        audio.addEventListener('pause', () => {
             if(btnPlayPause) btnPlayPause.innerText = "▶";
        });
        
        // 4. LOAD METADATA (Set Duration immediately when song loads)
        audio.addEventListener('loadedmetadata', () => {
             totTime.innerText = this.formatTime(audio.duration);
        });
    }

    togglePlay() {
        const audio = this.ui.audio;
        if (audio.paused) audio.play();
        else audio.pause();
    }

    formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return "0:00";
        const min = Math.floor(seconds / 60);
        const sec = Math.floor(seconds % 60);
        return `${min}:${sec < 10 ? '0' : ''}${sec}`;
    }

    setupVolumeEvents() {
        const { audio, volumeSlider, btnMute } = this.ui;

        // 1. SLIDER CHANGE
        volumeSlider.addEventListener('input', () => {
            audio.volume = volumeSlider.value;
            this.updateVolumeUI();
        });

        // 2. SYNC ON LOAD (If you save volume to localStorage later)
        // Default to max for now
        audio.volume = 1; 
        this.updateVolumeUI();
    }

    toggleMute() {
        const audio = this.ui.audio;
        
        if (audio.volume > 0) {
            // MUTE
            this.lastVolume = audio.volume; // Save current level
            audio.volume = 0;
            this.ui.volumeSlider.value = 0;
        } else {
            // UNMUTE
            // Restore to last level, or 100% if undefined
            audio.volume = this.lastVolume || 1;
            this.ui.volumeSlider.value = audio.volume;
        }
        this.updateVolumeUI();
    }

    updateVolumeUI() {
        const { volumeSlider, btnMute } = this.ui;
        const vol = parseFloat(volumeSlider.value);

        // Update Slider Fill (Grey)
        volumeSlider.style.backgroundSize = `${vol * 100}% 100%`;

        // Update Icon based on level
        if (vol === 0) {
            btnMute.innerText = "🔇";
        } else if (vol < 0.5) {
            btnMute.innerText = "Vk"; // Small speaker
        } else {
            btnMute.innerText = "🔊"; // Loud speaker
        }
    }

    // --- SHUFFLE LOGIC ---
    toggleShuffle() {
        this.isShuffle = !this.isShuffle;

        if (this.isShuffle) {
            // Turning ON: Backup current order, then shuffle
            this.originalStack = [...this.nextStack];
            this._shuffleArray(this.nextStack);
        } else {
            // Turning OFF: Restore original order
            // (Note: In a real app, we might want to keep added songs, 
            // but simply restoring is fine for Phase 1)
            this.nextStack = [...this.originalStack];
            this.originalStack = [];
        }

        this.updateButtonStates();
        this.renderQueue();
    }

    _shuffleArray(array) {
        // Fisher-Yates Algorithm
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    // --- REPEAT LOGIC ---
    toggleRepeat() {
        // Cycle: 0 (Off) -> 1 (All) -> 2 (One) -> 0 (Off)
        this.repeatMode = (this.repeatMode + 1) % 3;
        this.updateButtonStates();
    }

    setupMediaSession() {
        if ('mediaSession' in navigator) {
            // 1. Define Actions
            navigator.mediaSession.setActionHandler('play', () => this.togglePlay());
            navigator.mediaSession.setActionHandler('pause', () => this.togglePlay());
            navigator.mediaSession.setActionHandler('previoustrack', () => this.playPrevious());
            navigator.mediaSession.setActionHandler('nexttrack', () => this.playNext());
            
            // Optional: Seek actions (using 10s skips)
            navigator.mediaSession.setActionHandler('seekbackward', (details) => {
                const skipTime = details.seekOffset || 10;
                this.ui.audio.currentTime = Math.max(this.ui.audio.currentTime - skipTime, 0);
            });
            navigator.mediaSession.setActionHandler('seekforward', (details) => {
                const skipTime = details.seekOffset || 10;
                this.ui.audio.currentTime = Math.min(this.ui.audio.currentTime + skipTime, this.ui.audio.duration);
            });
        }
    }

    updateMediaSession(track) {
        if ('mediaSession' in navigator) {
            // 2. Update Metadata (Title, Artist, Art)
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.title,
                artist: track.artist,
                album: "Music Manager", // or track.album if you have it
                artwork: [
                    { src: track.image, sizes: '96x96', type: 'image/png' },
                    { src: track.image, sizes: '128x128', type: 'image/png' },
                    { src: track.image, sizes: '192x192', type: 'image/png' },
                    { src: track.image, sizes: '256x256', type: 'image/png' },
                    { src: track.image, sizes: '384x384', type: 'image/png' },
                    { src: track.image, sizes: '512x512', type: 'image/png' },
                ]
            });
        }
    }
}