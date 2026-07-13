import React, { useState, useEffect } from 'react';
import { PlaylistCard, TrackRow } from './SharedUI';
import { useMusic } from '../context/hook';
import { connectGoogle } from '../utils/googleAuth';

export default function LibraryView() {
    const { playTrack, addToQueue } = useMusic();

    // Local State
    const [connectedSources, setConnectedSources] = useState(['custom', 'youtube']); 
    const [activeSource, setActiveSource] = useState('custom');
    const [isLibraryMenuOpen, setIsLibraryMenuOpen] = useState(false);
    
    const [customPlaylists, setCustomPlaylists] = useState([]);
    const [youtubePlaylists, setYoutubePlaylists] = useState([]);
    const [youtubeError, setYoutubeError] = useState(null);
    const [selectedPlaylist, setSelectedPlaylist] = useState(null);
    const [playlistTracks, setPlaylistTracks] = useState([]);

    useEffect(() => {
        const authToken = localStorage.getItem('authToken');
        if (authToken) {
            fetch('http://localhost:3000/api/user/connections', {
                headers: { 'Authorization': `Bearer ${authToken}` }
            })
                .then(res => {
                    if (res.ok) return res.json();
                    throw new Error("Connections endpoint missing or failing");
                })
                .then(data => {
                    if (Array.isArray(data)) {
                        // youtube stays listed even when not connected, so its tab
                        // can show the connect prompt instead of disappearing.
                        const available = [...new Set(['custom', 'youtube', ...data.map(conn => conn.source_name)])];
                        setConnectedSources(available);
                    }
                })
                .catch(err => console.log("Falling back to default sources.", err.message));
        }
    }, []);

    useEffect(() => {
        const loadLibraryData = async () => {
        if (activeSource === 'youtube') {
            // Our own session token; the server looks up the Google token it
            // stored for this user when the account was connected.
            const token = localStorage.getItem('authToken');
            if (!token) return;

            setYoutubeError(null);

            fetch('http://localhost:3000/playlists', {
                headers: { 'Authorization': `Bearer ${token}` }
            })
            .then(async res => {
                const data = await res.json();
                if (res.status === 401) {
                    const err = new Error(data.error || "Unauthorized");
                    err.code = data.code;
                    throw err;
                }
                if (!res.ok) throw new Error(data.error || "Failed to fetch");
                return data;
            })
            .then(data => {
                if (Array.isArray(data)) {
                    setYoutubePlaylists(data);
                } else {
                    setYoutubePlaylists([]);
                }
            })
            .catch(err => {
                console.error("Failed to fetch YT playlists:", err);
                setYoutubePlaylists([]);
                setYoutubeError(err.code === 'GOOGLE_NOT_CONNECTED'
                    ? "Link your YouTube account to view these playlists."
                    : "Your YouTube session has expired. Please reconnect your account.");
            });

        } else if (activeSource === 'custom') {
            const authToken = localStorage.getItem('authToken');
            if (!authToken) return;

            fetch('http://localhost:3000/api/custom-playlists', {
                headers: { 'Authorization': `Bearer ${authToken}` }
            })
            .then(async res => {
                const data = await res.json();
                if (!res.ok) throw new Error("Failed to fetch custom playlists");
                return data;
            })
            .then(data => setCustomPlaylists(Array.isArray(data) ? data : [])) 
            .catch(err => console.error("Failed to fetch Custom playlists:", err));
        }
    }
    loadLibraryData();
    }, [activeSource]);

    const handleViewPlaylist = async (playlist, type) => {
        // Both playlist types authenticate with our own JWT now; for YouTube
        // playlists the server supplies the stored Google token itself.
        const token = localStorage.getItem('authToken');
        if (!token) return;

        setSelectedPlaylist(playlist);
        setPlaylistTracks([]);

        try {
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

                        {activeSource === 'youtube' && youtubeError && (
                            <div style={{ gridColumn: '1 / -1', padding: '20px', background: '#ff4d4d20', color: '#ff4d4d', borderRadius: '8px', textAlign: 'center', border: '1px solid #ff4d4d' }}>
                                <h3>Connection Error</h3>
                                <p>{youtubeError}</p>
                                <button
                                    onClick={connectGoogle}
                                    style={{ marginTop: '10px', padding: '10px 20px', background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold' }}
                                >
                                    Reconnect YouTube
                                </button>
                            </div>
                        )}

                        {activeSource === 'youtube' && !youtubeError && youtubePlaylists?.map(playlist => (
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