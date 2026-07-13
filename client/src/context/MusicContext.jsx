import {  useState, useRef, useEffect, useCallback } from 'react';
import { MusicContext } from './hook';


export const MusicProvider = ({ children }) => {
    const [currentTrack, setCurrentTrack] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isLoading, setIsLoading] = useState(false); 
    const [queue, setQueue] = useState([]);
    const [queueIndex, setQueueIndex] = useState(0);
    const [isShuffle, setIsShuffle] = useState(false);
    const originalQueueRef = useRef([]);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const setOffset = useRef(0);
    const [volume, setVolume] = useState(1);
    const prevVolumeRef = useRef(1);
    const audioRef = useRef(new Audio());
    const preloadAudioRef = useRef(new Audio());
    const hasPreloadedNext = useRef(false);
    const playStartTime = useRef(0);
    
    
    const loadAudio = useCallback((track) => {
        playStartTime.current = Date.now();
        setCurrentTrack(track);
        setIsLoading(true); 
        setOffset.current = 0; 
        setCurrentTime(0);
        hasPreloadedNext.current = false;
        setDuration(0);
        const safeId = track.id || track.videoId;
        if (track.duration) {
            setDuration(track.duration);
        } else {
            fetch(`http://localhost:3000/duration?videoId=${safeId}`)
                .then(res => res.json())
                .then(data => {
                    if (data.duration) {
                        setDuration(data.duration);
                        track.duration = data.duration; 
                    }
                })
                .catch(err => console.error("Failed to fetch true duration:", err));
        }
        const authToken = localStorage.getItem('authToken');
        if (authToken) {
            fetch('http://localhost:3000/history', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify({
                    trackId: track.id,
                    title: track.title,
                    artist: track.channelTitle || track.artist || 'Unknown Artist',
                    thumbnail: track.thumbnail || track.image
                })
            }).catch(err => console.error("Failed to log history:", err));
        }
        
        const streamUrl = `http://localhost:3000/stream?videoId=${safeId}`;
        audioRef.current.src = streamUrl;

        
        audioRef.current.play()
            .then(() => setIsPlaying(true))
            .catch(e => {
                console.error("Playback failed:", e);
                setIsLoading(false);
            });
    }, []);

    const playTrack = useCallback((track) => {
        if (currentTrack?.id !== track.id) {
            setQueue([track]); 
            setDuration(0);
            setQueueIndex(0);
            setIsShuffle(false);
            loadAudio(track);
        }
    }, [currentTrack, loadAudio]);


    const playNext = useCallback(() => {
        if (queueIndex < queue.length - 1) {
            const nextIndex = queueIndex + 1;
            setQueueIndex(nextIndex);
            loadAudio(queue[nextIndex]); 
        } else {
            setIsPlaying(false);
        }
    }, [queue, queueIndex, loadAudio]);


    const playPrev = useCallback(() => {
        if (queueIndex > 0) {
            const prevIndex = queueIndex - 1;
            setQueueIndex(prevIndex);
            loadAudio(queue[prevIndex]);
        }
    }, [queue, queueIndex, loadAudio]);

    // --- 3. QUEUE CONTROLS ---
    const addToQueue = useCallback((track) => {
        setQueue(prev => {
            const newQueue = [...prev, track];
            if (newQueue.length === 1 && !currentTrack) {
                setQueueIndex(0);
                loadAudio(track);
            }
            return newQueue;
        });
    }, [currentTrack, loadAudio]);

    const removeFromQueue = useCallback((indexToRemove) => {
        setQueue(prev => prev.filter((_, i) => i !== indexToRemove));
        
        
        if (indexToRemove < queueIndex) {
            setQueueIndex(prev => prev - 1);
        } else if (indexToRemove === queueIndex) {
            playNext(); 
        }
    }, [queueIndex, playNext]);

    const playQueueIndex = useCallback((index) => {
        if (queue[index]) {
            setQueueIndex(index);
            loadAudio(queue[index]);
        }
    }, [queue, loadAudio]);

    const shuffleArray = (array) => {
        const newArr = [...array];
        for (let i = newArr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
        }
        return newArr;
    };

    const toggleShuffle = useCallback(() => {
        setIsShuffle((prevShuffle) => {
            const turningOn = !prevShuffle;

            if (turningOn) {
                originalQueueRef.current = [...queue];
                const current = queue[queueIndex];
                const others = queue.filter((_, i) => i !== queueIndex);
                const shuffledOthers = shuffleArray(others);
                setQueue([current, ...shuffledOthers]);
                setQueueIndex(0); 
            } else {
                const original = originalQueueRef.current;
                setQueue(original);
                const currentId = queue[queueIndex]?.id;
                const restoredIndex = original.findIndex(t => t.id === currentId);
                setQueueIndex(restoredIndex !== -1 ? restoredIndex : 0);
            }

            return turningOn;
        });
    }, [queue, queueIndex]);

    const togglePlay = useCallback(() => {
        if (isPlaying) {
            audioRef.current.pause();
        } else {
            audioRef.current.play();
        }
        setIsPlaying(!isPlaying);
    }, [isPlaying]);

    const updateVolume = useCallback((newVolume) => {
        setVolume(newVolume);
        audioRef.current.volume = newVolume;
        if (newVolume > 0) {
            prevVolumeRef.current = newVolume;
        }
    }, []);

    const toggleMute = useCallback(() => {
        if (volume > 0) {
            updateVolume(0); 
        } else {
            updateVolume(prevVolumeRef.current || 1); 
        }
    }, [volume, updateVolume]);


const seek = useCallback((time) => {
        if (!currentTrack || !audioRef.current) return;

        const cleanTime = Math.floor(Number(time));
        const audio = audioRef.current;
        const targetInternalTime = cleanTime - setOffset.current;

        let isBuffered = false;
        if (targetInternalTime >= 0) {
            for (let i = 0; i < audio.buffered.length; i++) {
                if (targetInternalTime >= audio.buffered.start(i) && targetInternalTime <= audio.buffered.end(i)) {
                    isBuffered = true;
                    break;
                }
            }
        }

        if (isBuffered) {
            audio.currentTime = targetInternalTime; 
            setCurrentTime(cleanTime);
        } else {
            setCurrentTime(cleanTime);
            setOffset.current = cleanTime; 
            setIsLoading(true);

            const safeId = currentTrack.id || currentTrack.videoId;
            const streamUrl = `http://localhost:3000/stream?videoId=${safeId}&seek=${cleanTime}`;
            
            audio.pause();
            audio.src = streamUrl;
            
            audio.play()
                .then(() => setIsPlaying(true))
                .catch(e => {
                    console.error("Audio Playback Failed after seek:", e);
                    setIsLoading(false);
                });
        }
    }, [currentTrack]);


    useEffect(() => {
        const audio = audioRef.current;

        const handleEnded = () => {
            const expectedDuration = duration || 0;
            const actualTime = audio.currentTime || 0;
            
            if (expectedDuration > 0 && actualTime < (expectedDuration - 3)) {
                console.error(`Stream dropped prematurely at ${actualTime}s / ${expectedDuration}s. Halting queue to prevent infinite loop.`);
                setIsPlaying(false);
                setIsLoading(false);
                return; 
            }
            playNext();
        };
        const handleWaiting = () => setIsLoading(true);   
        const handlePlaying = () => setIsLoading(false);  
        const handleCanPlay = () => setIsLoading(false);  
        const handleTimeUpdate = () => {
            const time = audio.currentTime;
            if (!isNaN(time)) {
                const offset = setOffset.current || 0
                setCurrentTime(offset + time);
            }
        };
        const handleLoadedMetadata = () => {
            if (audio) {
                const rawDuration = audio.duration;
                if (Number.isFinite(rawDuration) && rawDuration > 0) {
                    setDuration((prevDuration) => prevDuration > 0 ? prevDuration : rawDuration);
                } else if (currentTrack?.duration) {
                    setDuration(currentTrack.duration);
                } else {
                    setDuration(0);
                }
            }
        };
        const handleProgress = () => {
            if (!audio.duration || audio.buffered.length === 0) return;
            const bufferedEnd = audio.buffered.end(audio.buffered.length - 1);
            if (bufferedEnd >= audio.duration - 2) {
                if (!hasPreloadedNext.current && queueIndex < queue.length - 1) {
                    const nextTrack = queue[queueIndex + 1];
                    const preloadUrl = `http://localhost:3000/stream?videoId=${nextTrack.id}&seek=0`;
                    preloadAudioRef.current.src = preloadUrl;
                    preloadAudioRef.current.load(); 
                    
                    hasPreloadedNext.current = true;
                }
            }
        };
        const handleError = (e) => {
            console.error("Native Audio Element Error:", e);
            setIsLoading(false);
            setIsPlaying(false);
        };
        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('waiting', handleWaiting);
        audio.addEventListener('playing', handlePlaying);
        audio.addEventListener('canplay', handleCanPlay);
        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('loadedmetadata', handleLoadedMetadata);
        audio.addEventListener('durationchange', handleLoadedMetadata);
        audio.addEventListener('progress', handleProgress);
        audio.addEventListener('error', handleError);
        return () => {
            audio.removeEventListener('ended', handleEnded);
            audio.removeEventListener('waiting', handleWaiting);
            audio.removeEventListener('playing', handlePlaying);
            audio.removeEventListener('canplay', handleCanPlay);
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
            audio.removeEventListener('durationchange', handleLoadedMetadata);
            audio.removeEventListener('progress', handleProgress);
            audio.removeEventListener('error', handleError);
        };
    }, [playNext, setOffset, seek, queue, queueIndex, duration, currentTrack]);

    useEffect(() => {
        if ('mediaSession' in navigator && currentTrack) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentTrack.title,
                artist: currentTrack.channelTitle || currentTrack.artist || 'Unknown Artist',
                album: 'Music Manager', 
                artwork: [
                    { 
                        src: currentTrack.thumbnail || currentTrack.image || 'https://via.placeholder.com/512', 
                        sizes: '512x512', 
                        type: 'image/jpeg' 
                    }
                ]
            });

            navigator.mediaSession.setActionHandler('play', () => {
                audioRef.current.play();
                setIsPlaying(true);
            });
            
            navigator.mediaSession.setActionHandler('pause', () => {
                audioRef.current.pause();
                setIsPlaying(false);
            });
            
            navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
            navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
            navigator.mediaSession.setActionHandler('seekto', (details) => {
                if (details.seekTime !== undefined) {
                    seek(details.seekTime);
                }
            });
        }
        return () => {
            if ('mediaSession' in navigator) {
                navigator.mediaSession.setActionHandler('play', null);
                navigator.mediaSession.setActionHandler('pause', null);
                navigator.mediaSession.setActionHandler('previoustrack', null);
                navigator.mediaSession.setActionHandler('nexttrack', null);
                navigator.mediaSession.setActionHandler('seekto', null);
            }
        };
    }, [currentTrack, playNext, playPrev, seek]);

    const value = {
        currentTrack,
        isPlaying,
        isLoading, 
        queue,
        playTrack,
        togglePlay,
        playNext,
        playPrev,
        currentTime,
        duration,
        seek,
        volume,
        updateVolume, 
        toggleMute,
        setOffset,
        queueIndex,
        isShuffle,
        toggleShuffle,
        playQueueIndex,
        removeFromQueue,
        addToQueue

    };

    return (
        <MusicContext.Provider value={value}>
            {children}
        </MusicContext.Provider>
    );
};