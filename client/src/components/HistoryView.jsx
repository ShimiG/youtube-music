import React, { useState, useEffect, useRef } from 'react';
import { TrackCard } from './SharedUI';
import { useMusic } from '../context/hook';
import { apiFetch } from '../utils/api';

// Recently played. The view stays alive while others show (App.jsx), so it
// asks the server only when it is on screen and something has been played
// since it last asked: not on every visit.
export default function HistoryView({ active = true }) {
    const [recentTracks, setRecentTracks] = useState([]);
    const { playTrack } = useMusic();
    // Counts the plays recorded since the app started (the player announces each).
    const [plays, setPlays] = useState(0);
    const shownPlays = useRef(-1);

    useEffect(() => {
        const onPlay = () => setPlays((n) => n + 1);
        window.addEventListener('history-changed', onPlay);
        return () => window.removeEventListener('history-changed', onPlay);
    }, []);

    useEffect(() => {
        if (!active || shownPlays.current === plays) return;
        if (!localStorage.getItem('authToken')) return;
        shownPlays.current = plays;
        apiFetch('/history')
            .then((data) => setRecentTracks(Array.isArray(data) ? data : []))
            .catch((err) => {
                shownPlays.current = -1; // asked again next time
                console.error('Failed to fetch history:', err);
            });
    }, [active, plays]);

    return (
        <div>
            <h1 style={{ marginTop: 0, borderBottom: '1px solid #333', paddingBottom: '10px' }}>Recently Played</h1>
            {recentTracks.length === 0 ? (
                <p style={{ color: '#888', fontStyle: 'italic' }}>Search for a song to start your history!</p>
            ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '15px', marginTop: '15px' }}>
                    {recentTracks.map((track, idx) => (
                        <TrackCard key={`history-${track.id || track.videoId}-${idx}`} track={track} onClick={playTrack} />
                    ))}
                </div>
            )}
        </div>
    );
}
