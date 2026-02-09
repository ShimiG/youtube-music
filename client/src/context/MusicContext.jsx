import { createContext, useState, useContext, useRef } from 'react';


const MusicContext = createContext();

export const MusicProvider = ({ children }) => {
    // --- STATE ---
    const [currentTrack, setCurrentTrack] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [queue, setQueue] = useState([]);

    const audioRef = useRef(new Audio());
    
    // --- ACTIONS  ---
    const playTrack = (track) => {
        setCurrentTrack(track);
        setIsPlaying(true);

        const streamUrl = `http://localhost:3000/stream?videoId=${track.id}`;
        audioRef.current.src = streamUrl;
        audioRef.current.play().catch(e => console.error("Playback failed:", e));
    };

    const togglePlay = () => {
        if (audioRef.current.paused) {
            audioRef.current.play();
            setIsPlaying(true);
        } else {
            audioRef.current.pause();
            setIsPlaying(false);
        }
    };

    const addToQueue = (track) => {
        setQueue((prev) => [...prev, track]);
    };

    const playNext = () => {
        if (queue.length > 0) {
            const nextTrack = queue[0];
            setQueue((prev) => prev.slice(1));
            playTrack(nextTrack);
        }
    };

    // --- EXPOSE ---
    const value = {
        currentTrack,
        isPlaying,
        queue,
        playTrack,
        togglePlay,
        addToQueue,
        playNext
    };

    return (
        <MusicContext.Provider value={value}>
            {children}
        </MusicContext.Provider>
    );
};


export const useMusic = () => {
    return useContext(MusicContext);
};