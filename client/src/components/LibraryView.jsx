import React, { useState, useEffect } from 'react';
import { PlaylistCard, TrackRow } from './SharedUI';
import { useMusic } from '../context/hook'; // Adjust path if necessary

export default function LibraryView() {
    // Bring in the player context so we can play tracks directly from here
    const { playTrack, addToQueue } = useMusic();

    // Local State
    const [connectedSources, setConnectedSources] = useState(['custom', 'youtube']); 
    const [activeSource, setActiveSource] = useState('custom');
    const [isLibraryMenuOpen, setIsLibraryMenuOpen] = useState(false);
    
    const [customPlaylists, setCustomPlaylists] = useState([]);
    const [youtubePlaylists, setYoutubePlaylists] = useState([]);
    
    const [selectedPlaylist, setSelectedPlaylist] = useState(null);
    const [playlistTracks, setPlaylistTracks] = useState([]);

    // 1. Fetch Connected Sources (from your abandoned file logic)
    useEffect(() => {
        const googleId = localStorage.getItem('googleId');
        if (googleId) {
            fetch('http://localhost:3000/api/user/connections', { headers: { 'x-google-id': googleId } })
                .then(res => {
                    if (res.ok) return res.json();
                    throw new Error("Connections endpoint missing or failing");
                })
                .then(data => {
                    if (Array.isArray(data)) {
                        const available = ['custom', ...data.map(conn => conn.source_name)];
                        setConnectedSources(available);
                    }
                })
                .catch(err => console.log("Falling back to default sources.", err.message));
        }
    }, []);

    // 2. Fetch Playlists based on Active Source
    useEffect(() => {
        const token = localStorage.getItem('userToken');
        const googleId = localStorage.getItem('googleId');
        if (!token || !googleId) return;

        if (activeSource === 'youtube') {
            fetch('http://localhost:3000/playlists', {
                headers: { 'Authorization': `Bearer ${token}` }
            })
            .then(res => res.json())
            .then(data => setYoutubePlaylists(data))
            .catch(err => console.error("Failed to fetch YT playlists:", err));
        } else if (activeSource === 'custom') {
            fetch('http://localhost:3000/api/custom-playlists', { 
                headers: { 'x-google-id': googleId }
            })
            .then(res => res.json())
            .then(data => setCustomPlaylists(data))
            .catch(err => console.error("Failed to fetch Custom playlists:", err));
        }
    }, [activeSource]);

    // 3. Handle Clicking a Playlist
    const handleViewPlaylist = async (playlist, type) => {
        const token = localStorage.getItem('userToken');
        if (!token) return;

        setSelectedPlaylist(playlist);
        setPlaylistTracks([]); // Clear old tracks

        try {
            // Note: You will need a custom endpoint later for custom playlist tracks!
            const endpoint = type === 'custom' 
                ? `http://localhost:3000/api/custom-playlists/${playlist.id}/tracks` 
                : `http://localhost:3000/playlists/${playlist.id}/tracks`;

            const res = await fetch(endpoint, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (res.ok && Array.isArray(data)) {
                setPlaylistTracks(data);
            }
        } catch (err) {
            console.error("Failed to load playlist tracks:", err);
        }
    };

    const handlePlayAll = () => {
        if (!playlistTracks || playlistTracks.length === 0) return;
        playTrack(playlistTracks[0]);
        playlistTracks.slice(1).forEach(track => addToQueue(track));
    };

    return (
        <div className="library-view" style={{ padding: '20px' }}>
            {!selectedPlaylist ? (
                <>
                    {/* --- HEADER & CUSTOM TAURI-SAFE DROPDOWN --- */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                        <h1 style={{ marginTop: 0, marginBottom: 0 }}>Your Library</h1>

                        <div style={{ position: 'relative', WebkitAppRegion: 'no-drag', zIndex: 9999 }}>
                            <div 
                                onClick={() => setIsLibraryMenuOpen(!isLibraryMenuOpen)}
                                style={{ padding: '10px 15px', background: '#333', color: 'white', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', display: 'flex', gap: '10px', alignItems: 'center' }}
                            >
                                {activeSource === 'custom' ? 'Custom Playlists' : activeSource.charAt(0).toUpperCase() + activeSource.slice(1)}
                                <span style={{ fontSize: '12px' }}>▼</span>
                            </div>

                            {isLibraryMenuOpen && (
                                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: '8px', background: '#282828', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 12px rgba(0,0,0,0.5)', width: '100%' }}>
                                    {connectedSources.map(source => (
                                        <div 
                                            key={source}
                                            onClick={() => { setActiveSource(source); setIsLibraryMenuOpen(false); }} 
                                            style={{ padding: '12px 15px', cursor: 'pointer', color: 'white', borderBottom: '1px solid #333' }}
                                            onMouseEnter={(e) => e.target.style.background = '#333'}
                                            onMouseLeave={(e) => e.target.style.background = 'transparent'}
                                        >
                                            {source === 'custom' ? 'Custom Playlists' : source.charAt(0).toUpperCase() + source.slice(1)}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* --- GRID RENDERING --- */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '20px' }}>
                        
                        {/* Always show the "Create" button on custom view */}
                        {activeSource === 'custom' && (
                            <div 
                                onClick={() => console.log("Open Create Modal")}
                                style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', background: '#1db95420', borderRadius: '8px', cursor: 'pointer', border: '2px dashed #1db954', minHeight: '200px' }}
                            >
                                <span style={{ fontSize: '40px', color: '#1db954' }}>+</span>
                                <span style={{ color: '#1db954', fontWeight: 'bold' }}>Create Playlist</span>
                            </div>
                        )}

                        {activeSource === 'custom' && customPlaylists?.map(playlist => (
                            <PlaylistCard key={`custom-${playlist.id}`} playlist={playlist} type="custom" onClick={handleViewPlaylist} />
                        ))}

                        {activeSource === 'youtube' && youtubePlaylists?.map(playlist => (
                            <PlaylistCard key={`yt-${playlist.id}`} playlist={playlist} type="youtube" onClick={handleViewPlaylist} />
                        ))}
                    </div>
                </>
            ) : (
                /* --- SELECTED PLAYLIST TRACKS VIEW --- */
                <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid #333', paddingBottom: '15px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                            <button onClick={() => setSelectedPlaylist(null)} style={{ background: '#333', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold' }}>
                                ← Back
                            </button>
                            <h2 style={{ margin: 0 }}>{selectedPlaylist?.title || selectedPlaylist?.name || "Playlist"}</h2>
                        </div>
                        <button 
                            onClick={handlePlayAll} disabled={!playlistTracks || playlistTracks.length === 0}
                            style={{ background: '#1db954', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '20px', cursor: (!playlistTracks || playlistTracks.length === 0) ? 'not-allowed' : 'pointer', fontWeight: 'bold', opacity: (!playlistTracks || playlistTracks.length === 0) ? 0.5 : 1 }}
                        >
                            ▶ Play All
                        </button>
                    </div>
                    
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {!playlistTracks || playlistTracks.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '20px', color: '#888' }}>Loading tracks...</div>
                        ) : (
                            playlistTracks.map((track, index) => (
                                <TrackRow key={`pl-track-${track.id || track.videoId}-${index}`} track={track} onPlay={playTrack} onQueue={addToQueue} />
                            ))
                        )}
                    </div>
                </>
            )}
        </div>
    );
}