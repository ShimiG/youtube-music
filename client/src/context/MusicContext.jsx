import {  useState, useRef, useEffect, useCallback } from 'react';
import { MusicContext } from './hook';


export const MusicProvider = ({ children }) => {
    const [currentTrack, setCurrentTrack] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isLoading, setIsLoading] = useState(false); 
    const [queue, setQueue] = useState([]);
    const [queueIndex, setQueueIndex] = useState(0);
    
    const audioRef = useRef(new Audio());

    const playTrack = useCallback((track) => {
        if (currentTrack?.id !== track.id) {
            setCurrentTrack(track);
            setQueue([track]); 
            setQueueIndex(0);
            setIsLoading(true); 
            
            const streamUrl = `http://localhost:3000/stream?videoId=${track.id}`;
            audioRef.current.src = streamUrl;
            audioRef.current.load();
        }

        const playPromise = audioRef.current.play();
        if (playPromise !== undefined) {
            playPromise
                .then(() => {
                    setIsPlaying(true);
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
        }
    }, [queue, queueIndex]);

    // --- EVENT LISTENERS ---
    useEffect(() => {
        const audio = audioRef.current;

        const handleEnded = () => playNext();
        const handleWaiting = () => setIsLoading(true);   
        const handlePlaying = () => setIsLoading(false);  
        const handleCanPlay = () => setIsLoading(false);  

        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('waiting', handleWaiting);
        audio.addEventListener('playing', handlePlaying);
        audio.addEventListener('canplay', handleCanPlay);

        return () => {
            audio.removeEventListener('ended', handleEnded);
            audio.removeEventListener('waiting', handleWaiting);
            audio.removeEventListener('playing', handlePlaying);
            audio.removeEventListener('canplay', handleCanPlay);
        };
    }, [playNext]);

    const value = {
        currentTrack,
        isPlaying,
        isLoading, 
        queue,
        playTrack,
        togglePlay,
        playNext,
        playPrev
    };

    return (
        <MusicContext.Provider value={value}>
            {children}
        </MusicContext.Provider>
    );
};