import React, { useState } from 'react';
import { TrackRow } from './SharedUI';
import { useMusic } from '../context/hook';

export default function SearchView() {
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const { playTrack, addToQueue } = useMusic();

    const handleSearch = async (e) => {
        e.preventDefault();
        if (!searchQuery) return;

        try {
            const res = await fetch(`http://localhost:3000/search?q=${encodeURIComponent(searchQuery)}`, {
                credentials: 'include'  // Include JWT cookie
            });
            if (!res.ok) throw new Error("Search failed");
            const data = await res.json();
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