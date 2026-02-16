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
    const [seekOffset, setOffset] = useState(0);

    const audioRef = useRef(new Audio());

    const playTrack = useCallback((track) => {
        if (currentTrack?.id !== track.id) {
            setCurrentTrack(track);
            setQueue([track]); 
            setQueueIndex(0);
            setIsLoading(true); 
            setOffset(0)
            const streamUrl = `http://localhost:3000/stream?videoId=${track.id}`;
            audioRef.current.src = streamUrl;
            audioRef.current.load();
        }

        const playPromise = audioRef.current.play();
        if (playPromise !== undefined) {
            playPromise
                .then(() => {
                    setIsPlaying(true);
                    setOffset(0);
                })
                .catch(e => {
                    console.error("Playback failed:", e);
                    setIsLoading(false);
                });
        }
    }, [currentTrack]);

    const togglePlay = useCallback(() => {
        if (isPlaying) {
            audioRef.current.pause();
        } else {
            audioRef.current.play();
        }
        setIsPlaying(!isPlaying);
    }, [isPlaying]);

    const playNext = useCallback(() => {
        if (queueIndex < queue.length - 1) {
            const nextIndex = queueIndex + 1;
            setQueueIndex(nextIndex);
            const nextTrack = queue[nextIndex];
            setCurrentTrack(nextTrack);
            setIsLoading(true); 
            
            audioRef.current.src = `http://localhost:3000/stream?videoId=${nextTrack.id}`;
            audioRef.current.load();
            audioRef.current.play();
            setIsPlaying(true);
            setOffset(0);
        } else {
            setIsPlaying(false);
        }
    }, [queue, queueIndex]);

    const playPrev = useCallback(() => {
        if (queueIndex > 0) {
            const prevIndex = queueIndex - 1;
            const prevTrack = queue[prevIndex];
            setQueueIndex(prevIndex);
            setCurrentTrack(prevTrack);
            setIsLoading(true); 
            
            audioRef.current.src = `http://localhost:3000/stream?videoId=${prevTrack.id}`;
            audioRef.current.load();
            audioRef.current.play();
            setIsPlaying(true);
            setOffset(0);
        }
    }, [queue, queueIndex]);

const seek = useCallback((time) => {
        if (!currentTrack) return;

        console.log(`⏩ Seeking to ${time}s`);
        
        
        setCurrentTime(time);
        setOffset(time); 
        setIsLoading(true);

        const streamUrl = `http://localhost:3000/stream?videoId=${currentTrack.id}&seek=${time}`;
        audioRef.current.src = streamUrl;
        
      
        audioRef.current.load(); 
        audioRef.current.play()
            .then(() => setIsPlaying(true))
            .catch(e => console.error("Seek failed", e));
            
    }, [currentTrack]);


    // --- EVENT LISTENERS ---
    useEffect(() => {
        const audio = audioRef.current;

        const handleEnded = () => playNext();
        const handleWaiting = () => setIsLoading(true);   
        const handlePlaying = () => setIsLoading(false);  
        const handleCanPlay = () => setIsLoading(false);  
        const handleSeek = () => setOffset(seek);
        const handleTimeUpdate = () => {
            if (!isNaN(audio.currentTime)) {
                setCurrentTime(seekOffset + audio.currentTime);
            }
        };
        const handleLoadedMetadata = () => {
            const d = audio.duration;
            if (!isNaN(d) && d !== Infinity && d > 0) {
                setDuration(d);
            }
            }
        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('waiting', handleWaiting);
        audio.addEventListener('playing', handlePlaying);
        audio.addEventListener('canplay', handleCanPlay);
        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('loadedmetadata', handleLoadedMetadata);
        audio.addEventListener('seekoffset', handleSeek);
        audio.addEventListener('durationchange', handleLoadedMetadata)
        return () => {
            audio.removeEventListener('ended', handleEnded);
            audio.removeEventListener('waiting', handleWaiting);
            audio.removeEventListener('playing', handlePlaying);
            audio.removeEventListener('canplay', handleCanPlay);
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
            audio.removeEventListener('seekoffset', handleSeek);
            audio.removeEventListener('durationchage', handleLoadedMetadata)
        };
    }, [playNext, seekOffset, seek]);

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
        seekOffset
    };

    return (
        <MusicContext.Provider value={value}>
            {children}
        </MusicContext.Provider>
    );
};