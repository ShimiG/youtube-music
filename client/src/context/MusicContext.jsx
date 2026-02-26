import {  useState, useRef, useEffect, useCallback } from 'react';
import { MusicContext } from './hook';


export const MusicProvider = ({ children }) => {
    const [currentTrack, setCurrentTrack] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isLoading, setIsLoading] = useState(false); 
    const [queue, setQueue] = useState([]);
    const [queueIndex, setQueueIndex] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const setOffset = useRef(0);
    const [volume, setVolume] = useState(1);
    const prevVolumeRef = useRef(1);
    const audioRef = useRef(new Audio());

    
    const loadAudio = useCallback((track) => {
        setCurrentTrack(track);
        setIsLoading(true);
        
        setOffset.current = 0; 
        setCurrentTime(0);

        if (track.duration) {
            setDuration(track.duration);
        } else {
            setDuration(0);
        }
        
        const streamUrl = `http://localhost:3000/stream?videoId=${track.id}`;
        audioRef.current.src = streamUrl;
        audioRef.current.load();
        
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
            setQueueIndex(0);
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
        for (let i = 0; i < audio.buffered.length; i++) {
            if (targetInternalTime >= audio.buffered.start(i) && targetInternalTime <= audio.buffered.end(i)) {
                isBuffered = true;
                break;
            }
        }

        if (isBuffered) {
            audio.currentTime = targetInternalTime; 
            setCurrentTime(cleanTime);
        } else {
            setCurrentTime(cleanTime);
            setOffset.current = cleanTime; 
            setIsLoading(true);

            const streamUrl = `http://localhost:3000/stream?videoId=${currentTrack.id}&seek=${cleanTime}`;
            
            audio.pause();
            audio.src = streamUrl;
            audio.load();
            
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

        const handleEnded = () => playNext();
        const handleWaiting = () => setIsLoading(true);   
        const handlePlaying = () => setIsLoading(false);  
        const handleCanPlay = () => setIsLoading(false);  
        const handleSeek = () => setOffset.current=seek;
        const handleTimeUpdate = () => {
            const time = audio.currentTime;
            if (!isNaN(time)) {
                const offset = setOffset.current || 0
                setCurrentTime(offset + time);
            }
        };
        const handleLoadedMetadata = () => {
            const d = audio.duration;
            if (!isNaN(d) && d !== Infinity && d > 0) {
                setDuration(d);
            }
        };
        
        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('waiting', handleWaiting);
        audio.addEventListener('playing', handlePlaying);
        audio.addEventListener('canplay', handleCanPlay);
        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('loadedmetadata', handleLoadedMetadata);
        audio.addEventListener('seekoffset', handleSeek);
        audio.addEventListener('durationchange', handleLoadedMetadata);
        return () => {
            audio.removeEventListener('ended', handleEnded);
            audio.removeEventListener('waiting', handleWaiting);
            audio.removeEventListener('playing', handlePlaying);
            audio.removeEventListener('canplay', handleCanPlay);
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
            audio.removeEventListener('seekoffset', handleSeek);
            audio.removeEventListener('durationchange', handleLoadedMetadata)
        };
    }, [playNext, setOffset, seek]);

    // --- OS MEDIA CONTROLS  ---
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