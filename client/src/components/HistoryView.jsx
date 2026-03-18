import React, { useState, useEffect } from 'react';
import { TrackCard } from './SharedUI';
import { useMusic } from '../context/hook';

export default function HistoryView() {
    const [recentTracks, setRecentTracks] = useState([]);
    const { playTrack } = useMusic();

useEffect(() => {
        const userId = localStorage.getItem('localUserId'); 
        if (!userId) return;

        fetch('http://localhost:3000/history', { 
            headers: { 'x-user-id': userId } 
        })
            .then(res => res.json())
            .then(data => setRecentTracks(data))
            .catch(err => console.error("Failed to fetch history:", err));
    }, []);

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