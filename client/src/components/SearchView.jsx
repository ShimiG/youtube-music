import React, { useState } from 'react';
import { TrackRow } from './SharedUI';
import { useMusic } from '../context/hook';
import { connectGoogle } from '../utils/googleAuth';

export default function SearchView() {
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [googleError, setGoogleError] = useState(null);
    const { playTrack, addToQueue } = useMusic();

    const handleSearch = async (e) => {
        e.preventDefault();
        if (!searchQuery) return;
        // Search uses our own session; the server holds the Google token.
        const token = localStorage.getItem('authToken');
        if (!token) return;

        try {
            const res = await fetch(`http://localhost:3000/search?q=${encodeURIComponent(searchQuery)}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();

            if (res.status === 401) {
                setGoogleError(
                    data.code === 'GOOGLE_NOT_CONNECTED'
                        ? 'Connect your YouTube account to search for music.'
                        : 'Your YouTube session has expired. Reconnect to keep searching.'
                );
                setSearchResults([]);
                return;
            }
            if (!res.ok) throw new Error(data.error || "Search failed");

            setGoogleError(null);
            setSearchResults(data.items || data || []);
        } catch (err) {
            console.error(err);
            setSearchResults([]);
        }
    };

    return (
        <div>
            <form onSubmit={handleSearch} style={{ marginBottom: '20px' }}>
                <input
                    type="text" placeholder="Search songs..." value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{ padding: '10px 20px', width: '300px', borderRadius: '20px', border: 'none', outline: 'none' }}
                />
            </form>

            {googleError && (
                <div style={{ padding: '20px', background: '#ff4d4d20', color: '#ff4d4d', borderRadius: '8px', textAlign: 'center', border: '1px solid #ff4d4d', marginBottom: '20px' }}>
                    <p style={{ marginTop: 0 }}>{googleError}</p>
                    <button
                        onClick={connectGoogle}
                        style={{ padding: '10px 20px', background: '#1db954', color: 'black', border: 'none', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold' }}
                    >
                        Connect YouTube
                    </button>
                </div>
            )}

            {searchResults.length > 0 && (
                <h2 style={{ borderBottom: '1px solid #333', paddingBottom: '10px', marginTop: 0 }}>Search Results</h2>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: '10px' }}>
                {searchResults.map(video => (
                    <TrackRow key={`search-${video.id}`} track={video} onPlay={playTrack} onQueue={addToQueue} imageSize={60} />
                ))}
            </div>
        </div>
    );
}
