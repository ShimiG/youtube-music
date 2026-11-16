import {  useState, useRef, useEffect, useCallback } from 'react';
import { MusicContext } from './hook';
import { toast } from '../utils/toast';
import { apiFetch } from '../utils/api';
import { DEFAULT_SOURCE } from '../utils/services';
import { mediaUrl, mediaUrlSync, warmMediaToken } from '../utils/media';
import { artOf } from '../utils/artwork';
import { setPlaybackTime } from '../utils/playbackClock';


const PREPARE_AFTER_SEC = 15;
const PREPARE_BEFORE_END_SEC = 25;

export const MusicProvider = ({ children }) => {
    const [currentTrack, setCurrentTrack] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isLoading, setIsLoading] = useState(false); 
    const [queue, setQueue] = useState([]);
    const [queueIndex, setQueueIndex] = useState(0);
    const [isShuffle, setIsShuffle] = useState(false);
    const originalQueueRef = useRef([]);
    // The position itself lives in utils/playbackClock.js, not here: it
    // changes four times a second and would re-render everything that reads
    // this context. All this context keeps is whether the track is far enough
    // in for the next one to be prepared.
    const [reachedPrepare, setReachedPrepare] = useState(false);
    const [duration, setDuration] = useState(0);
    const setOffset = useRef(0);
    const [volume, setVolume] = useState(1);
    const prevVolumeRef = useRef(1);
    const audioRef = useRef(new Audio());
    // Which next track the server has already been asked to get ready.
    const preparedNext = useRef(null);
    const playStartTime = useRef(0);
    
    
    // Media URLs carry a short-lived token (utils/media.js). Keep one ready so
    // playback can start synchronously from a click, and renew it in time.
    useEffect(() => {
        warmMediaToken();
        const timer = setInterval(warmMediaToken, 5 * 60 * 1000);
        return () => clearInterval(timer);
    }, []);

    // Sets the audio source and starts playing. With a token in memory this
    // runs synchronously (inside the user's click); otherwise it waits for
    // one. `isCurrent` drops a load that a newer one has replaced meanwhile.
    const startStream = useCallback((params, isCurrent, failureLabel) => {
        const audio = audioRef.current;
        const begin = (url) => {
            if (!isCurrent()) return;
            audio.src = url;
            audio.play()
                .then(() => setIsPlaying(true))
                .catch(e => {
                    console.error(failureLabel, e);
                    setIsLoading(false);
                });
        };
        const ready = mediaUrlSync('/stream', params);
        if (ready) return begin(ready);
        mediaUrl('/stream', params).then(begin).catch(e => {
            if (!isCurrent()) return;
            console.error(failureLabel, e);
            setIsLoading(false);
            toast('Could not start playback. Try again, or log in again.', { kind: 'error' });
        });
    }, []);
    const loadSeq = useRef(0);

    const loadAudio = useCallback((track) => {
        const seq = ++loadSeq.current;
        playStartTime.current = Date.now();
        setCurrentTrack(track);
        setIsLoading(true); 
        setOffset.current = 0; 
        setPlaybackTime(0);
        setReachedPrepare(false);
        setDuration(0);
        const safeId = track.id || track.videoId;
        // Tracks carry their source; rows from before that default to DEFAULT_SOURCE.
        const source = track.source || DEFAULT_SOURCE;
        // Normalised tracks carry durationSec; older rows still carry duration.
        const catalogDuration = track.durationSec ?? track.duration;
        // Sources that decide what plays at play time (Deezer: the full track
        // via a YouTube match, or a 30 s preview) set verifyDuration: show the
        // catalog length meanwhile, but ask the server what will really play.
        const knownDuration = track.verifyDuration ? null : catalogDuration;
        if (knownDuration) {
            setDuration(knownDuration);
        } else {
            if (catalogDuration) setDuration(catalogDuration);
            mediaUrl('/duration', { videoId: safeId, source })
                .then(url => fetch(url))
                .then(res => res.json())
                .then(data => {
                    if (seq !== loadSeq.current) return; // another track started meanwhile
                    if (data.duration) {
                        setDuration(data.duration);
                        if (!track.verifyDuration) track.duration = data.duration;
                    }
                    if (data.preview) {
                        toast(`Only a 30-second preview of "${track.title}" is available.`, { kind: 'warning' });
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
                    thumbnail: track.thumbnail || track.image,
                    source
                })
            })
                // Recently Played shows it without being asked to look again.
                .then(res => { if (res.ok) window.dispatchEvent(new Event('history-changed')); })
                .catch(err => console.error("Failed to log history:", err));
        }
        
        startStream({ videoId: safeId, source }, () => seq === loadSeq.current, "Playback failed:");
    }, [startStream]);

    const playTrack = useCallback((track) => {
        if (currentTrack?.id !== track.id || (currentTrack?.source || DEFAULT_SOURCE) !== (track.source || DEFAULT_SOURCE)) {
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

        // A file with a known length (a cached track, a local file) can be
        // positioned by the player itself: the browser fetches the part it
        // needs. Only a live conversion, which has no length, needs the
        // server to start again from the new position.
        const isFile = targetInternalTime >= 0 && Number.isFinite(audio.duration) && audio.duration > 0;

        if (isBuffered || isFile) {
            audio.currentTime = targetInternalTime; 
            setPlaybackTime(cleanTime);
        } else {
            setPlaybackTime(cleanTime);
            setOffset.current = cleanTime; 
            setIsLoading(true);

            const safeId = currentTrack.id || currentTrack.videoId;
            const source = currentTrack.source || DEFAULT_SOURCE;
            audio.pause();
            const seq = ++loadSeq.current;
            startStream({ videoId: safeId, source, seek: cleanTime }, () => seq === loadSeq.current, "Audio Playback Failed after seek:");
        }
    }, [currentTrack, startStream]);


    // When the next track is asked for (see the effect further down).
    const prepareFrom = duration > 0 ? Math.min(PREPARE_AFTER_SEC, Math.max(0, duration - PREPARE_BEFORE_END_SEC)) : PREPARE_AFTER_SEC;

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
                const position = offset + time;
                setPlaybackTime(position);
                // The same value most of the time, which React ignores.
                setReachedPrepare(position >= prepareFrom);
            }
        };
        const handleLoadedMetadata = () => {
            if (audio) {
                const rawDuration = audio.duration;
                if (Number.isFinite(rawDuration) && rawDuration > 0) {
                    setDuration((prevDuration) => prevDuration > 0 ? prevDuration : rawDuration);
                } else {
                    // A streamed (transcoded) response has no length of its own
                    // (Infinity). Keep what is already known (the track's
                    // length, or /duration's answer) and never reset it to 0:
                    // normalised tracks carry durationSec, not duration, and a
                    // 0 here used to blank the total and disable the seek bar.
                    const fromTrack = currentTrack?.durationSec ?? currentTrack?.duration ?? 0;
                    setDuration((prevDuration) => prevDuration > 0 ? prevDuration : fromTrack);
                }
            }
        };
        // The stream endpoint answers a failed resolve with TRACK_UNAVAILABLE;
        // the <audio> element only sees an error. Tell the user and move on
        // instead of silently stopping the queue.
        const handleError = (e) => {
            if (!audio.src) return; // clearing src fires an error too
            console.error("Native Audio Element Error:", e);
            setIsLoading(false);
            setIsPlaying(false);
            const title = currentTrack?.title ? `"${currentTrack.title}"` : 'This track';
            const canSkip = queueIndex < queue.length - 1;
            const failedLoad = loadSeq.current;
            // A missing helper program stops every streamed track, so say that
            // (once) instead of skipping through the whole queue.
            apiFetch('/api/health')
                .then(health => ['ytDlp', 'ffmpeg'].filter(name => health.binaries && health.binaries[name] && !health.binaries[name].available))
                .catch(() => [])
                .then(missing => {
                    if (loadSeq.current !== failedLoad) return; // another track was started meanwhile
                    if (missing.length) {
                        const names = missing.map(name => (name === 'ytDlp' ? 'yt-dlp' : name)).join(' and ');
                        toast(`Nothing can play: ${names} was not found on this computer. See Settings, System.`, { kind: 'error', timeoutMs: 12000 });
                    } else if (canSkip) {
                        toast(`${title} is unavailable. Skipping to the next track.`, { kind: 'warning' });
                        playNext();
                    } else {
                        toast(`${title} could not be played. Settings, System has the details.`, { kind: 'warning' });
                    }
                });
        };
        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('waiting', handleWaiting);
        audio.addEventListener('playing', handlePlaying);
        audio.addEventListener('canplay', handleCanPlay);
        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('loadedmetadata', handleLoadedMetadata);
        audio.addEventListener('durationchange', handleLoadedMetadata);
        audio.addEventListener('error', handleError);
        return () => {
            audio.removeEventListener('ended', handleEnded);
            audio.removeEventListener('waiting', handleWaiting);
            audio.removeEventListener('playing', handlePlaying);
            audio.removeEventListener('canplay', handleCanPlay);
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
            audio.removeEventListener('durationchange', handleLoadedMetadata);
            audio.removeEventListener('error', handleError);
        };
    }, [playNext, setOffset, seek, queue, queueIndex, duration, currentTrack, prepareFrom]);

    // Get the next track ready while this one plays, so a track change does
    // not wait for the server to find and convert the audio. The server is
    // asked once the current track has clearly been settled on (15 seconds
    // in), or 25 seconds before its end if it is shorter than that: early
    // enough for the conversion to land in the disk cache, late enough not to
    // do it for tracks that are skipped straight away.
    const nextTrack = queueIndex < queue.length - 1 ? queue[queueIndex + 1] : null;
    const nextKey = nextTrack && nextTrack.playable !== false
        ? `${nextTrack.source || DEFAULT_SOURCE}:${nextTrack.id || nextTrack.videoId}` : null;
    const timeToPrepare = Boolean(currentTrack) && isPlaying && reachedPrepare;
    useEffect(() => {
        if (!timeToPrepare || !nextKey || preparedNext.current === nextKey) return;
        preparedNext.current = nextKey;
        const [source, ...idParts] = nextKey.split(':');
        mediaUrl('/stream', { videoId: idParts.join(':'), source, prepare: 1 })
            .then(url => fetch(url))
            .catch(() => { preparedNext.current = null; }); // asked again on the next tick
    }, [timeToPrepare, nextKey]);

    useEffect(() => {
        if ('mediaSession' in navigator && currentTrack) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentTrack.title,
                artist: currentTrack.channelTitle || currentTrack.artist || 'Unknown Artist',
                album: 'Music Manager', 
                // Only when the track has cover art; no third-party placeholder.
                artwork: artOf(currentTrack) ? [{ src: artOf(currentTrack), sizes: '512x512' }] : []
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