import { createContext, useState, useContext, useRef, useEffect, useCallback } from 'react';

// 1. Create Context
const MusicContext = createContext();

// 2. Create Custom Hook
export const useMusic = () => useContext(MusicContext);

// 3. Create Provider Component
export const MusicProvider = ({ children }) => {
    const [currentTrack, setCurrentTrack] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [queue, setQueue] = useState([]);
    const [queueIndex, setQueueIndex] = useState(0);
    
    const audioRef = useRef(new Audio());

    const playTrack = useCallback((track) => {
        if (currentTrack?.id !== track.id) {
            setCurrentTrack(track);
            setQueue([track]); 
            setQueueIndex(0);
            
            // Connect to Backend Stream
            // Ensure this URL matches your backend port (3000)
            const streamUrl = `http://localhost:3000/stream?videoId=${track.id}`;
            audioRef.current.src = streamUrl;
            audioRef.current.load();
        }
        
        audioRef.current.play()
            .then(() => setIsPlaying(true))
            .catch(e => console.error("Playback failed:", e));
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
            const nextTrack = queue[nextIndex];
            setQueueIndex(nextIndex);
            // We manually update currentTrack here to keep sync
            setCurrentTrack(nextTrack);
            
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
            
            audioRef.current.src = `http://localhost:3000/stream?videoId=${prevTrack.id}`;
            audioRef.current.load();
            audioRef.current.play();
            setIsPlaying(true);
        }
    }, [queue, queueIndex]);

    useEffect(() => {
        const audio = audioRef.current;
        const handleEnded = () => playNext();

        audio.addEventListener('ended', handleEnded);
        return () => audio.removeEventListener('ended', handleEnded);
    }, [playNext]);

    const value = {
        currentTrack,
        isPlaying,
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