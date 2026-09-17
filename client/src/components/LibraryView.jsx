import React, { useState, useEffect } from 'react';
import { PlaylistCard, TrackRow } from './SharedUI';
import { useMusic } from '../context/hook';
import { SERVICES, SERVICE_LIST } from '../utils/services';

// Sources that are always listed, connected or not, so their tab can show a
// connect prompt instead of disappearing.
const DEFAULT_SOURCES = ['custom', ...SERVICE_LIST.map(s => s.name)];

const sourceLabel = (source) => (source === 'custom' ? 'Custom Playlists' : (SERVICES[source]?.label || source));

export default function LibraryView() {
    const { playTrack, addToQueue } = useMusic();

    const [connectedSources, setConnectedSources] = useState(DEFAULT_SOURCES);
    const [activeSource, setActiveSource] = useState('custom');
    const [isLibraryMenuOpen, setIsLibraryMenuOpen] = useState(false);

    const [customPlaylists, setCustomPlaylists] = useState([]);
    const [servicePlaylists, setServicePlaylists] = useState([]); // playlists of the active streaming service
    const [serviceError, setServiceError] = useState(null);
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
                        const available = [...new Set([...DEFAULT_SOURCES, ...data.map(conn => conn.source_name)])];
                        setConnectedSources(available.filter(s => s === 'custom' || SERVICES[s]));
                    }
                })
                .catch(err => console.log("Falling back to default sources.", err.message));
        }
    }, []);

    useEffect(() => {
        const authToken = localStorage.getItem('authToken');
        if (!authToken) return;
        const headers = { 'Authorization': `Bearer ${authToken}` };

        if (activeSource === 'custom') {
            fetch('http://localhost:3000/api/custom-playlists', { headers })
                .then(async res => {
                    const data = await res.json();
                    if (!res.ok) throw new Error("Failed to fetch custom playlists");
                    return data;
                })
                .then(data => setCustomPlaylists(Array.isArray(data) ? data : []))
                .catch(err => console.error("Failed to fetch Custom playlists:", err));
            return;
        }

        const service = SERVICES[activeSource];
        if (!service) return;

        // Our own session token; the server looks up (and for SoundCloud
        // refreshes) the service token it stored when the account was connected.
        // (Stale playlists/errors are cleared in selectSource, not here.)
        fetch(service.playlistsEndpoint, { headers })
            .then(async res => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    const err = new Error(data.error || "Failed to fetch");
                    err.code = data.code;
                    err.status = res.status;
                    throw err;
                }
                return data;
            })
            .then(data => setServicePlaylists(Array.isArray(data) ? data : []))
            .catch(err => {
                console.error(`Failed to fetch ${service.label} playlists:`, err);
                setServicePlaylists([]);
                if (err.status === 503) {
                    setServiceError({
                        message: service.name === 'soundcloud'
                            ? 'SoundCloud playlists and likes need API credentials on the server (SOUNDCLOUD_CLIENT_ID / SECRET). Search and playback still work from the Search tab.'
                            : `${service.label} is not configured on this server.`,
                        canConnect: false
                    });
                } else if (err.status === 429) {
                    setServiceError({ message: `${service.label} rate limit reached. Try again later.`, canConnect: false });
                } else if (err.code === service.notConnectedCode) {
                    setServiceError({ message: `Link your ${service.label} account to view these playlists.`, canConnect: true });
                } else {
                    setServiceError({ message: `Your ${service.label} session has expired. Please reconnect your account.`, canConnect: true });
                }
            });
    }, [activeSource]);

    // Switching source clears whatever the previous service showed, so the
    // effect above only has to load; it never resets state synchronously.
    const selectSource = (source) => {
        setIsLibraryMenuOpen(false);
        if (source === activeSource) return;
        setServiceError(null);
        setServicePlaylists([]);
        setActiveSource(source);
    };

    const handleViewPlaylist = async (playlist, type) => {
        const token = localStorage.getItem('authToken');
        if (!token) return;

        setSelectedPlaylist(playlist);
        setPlaylistTracks([]);

        try {
            const endpoint = type === 'custom'
                ? `http://localhost:3000/api/custom-playlists/${playlist.id}/tracks`
                : SERVICES[type].playlistTracksEndpoint(playlist.id);

            const res = await fetch(endpoint, { headers: { 'Authorization': `Bearer ${token}` } });
            const data = await res.json();
            if (res.ok && Array.isArray(data)) {
                setPlaylistTracks(data);
            }
        } catch (err) {
            console.error("Failed to load playlist tracks:", err);
        }
    };

    const handlePlayAll = () => {
        const playable = (playlistTracks || []).filter(t => t.playable !== false);
        if (playable.length === 0) return;
        playTrack(playable[0]);
        playable.slice(1).forEach(track => addToQueue(track));
    };

    const activeService = SERVICES[activeSource];

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
                                {sourceLabel(activeSource)}
                                <span style={{ fontSize: '12px' }}>▼</span>
                            </div>

                            {isLibraryMenuOpen && (
                                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: '8px', background: '#282828', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 12px rgba(0,0,0,0.5)', width: '100%', minWidth: '180px' }}>
                                    {connectedSources.map(source => (
                                        <div 
                                            key={source}
                                            onClick={() => selectSource(source)} 
                                            style={{ padding: '12px 15px', cursor: 'pointer', color: 'white', borderBottom: '1px solid #333' }}
                                            onMouseEnter={(e) => e.target.style.background = '#333'}
                                            onMouseLeave={(e) => e.target.style.background = 'transparent'}
                                        >
                                            {sourceLabel(source)}
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

                        {activeService && serviceError && (
                            <div style={{ gridColumn: '1 / -1', padding: '20px', background: '#ff4d4d20', color: '#ff4d4d', borderRadius: '8px', textAlign: 'center', border: '1px solid #ff4d4d' }}>
                                <h3>Connection Error</h3>
                                <p>{serviceError.message}</p>
                                {serviceError.canConnect && (
                                    <button
                                        onClick={activeService.connect}
                                        style={{ marginTop: '10px', padding: '10px 20px', background: activeService.color, color: 'white', border: 'none', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold' }}
                                    >
                                        {activeService.connectLabel}
                                    </button>
                                )}
                            </div>
                        )}

                        {activeService && !serviceError && servicePlaylists?.map(playlist => (
                            <PlaylistCard key={`${activeSource}-${playlist.id}`} playlist={playlist} type={activeSource} onClick={handleViewPlaylist} />
                        ))}
                    </div>

                    {activeSource === 'soundcloud' && !serviceError && servicePlaylists.length > 0 && (
                        <p style={{ color: '#666', fontSize: '12px', textAlign: 'center', marginTop: '20px' }}>
                            Playlists and audio provided by <a href="https://soundcloud.com" target="_blank" rel="noreferrer" style={{ color: '#ff5500' }}>SoundCloud</a>.
                        </p>
                    )}
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
                            {selectedPlaylist?.permalinkUrl && (
                                <a href={selectedPlaylist.permalinkUrl} target="_blank" rel="noreferrer" style={{ color: '#ff5500', fontSize: '12px', fontWeight: 'bold', textDecoration: 'none' }}>
                                    Open on SoundCloud ↗
                                </a>
                            )}
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
                                <TrackRow key={`pl-track-${track.source || 'youtube'}-${track.id || track.videoId}-${index}`} track={track} onPlay={playTrack} onQueue={addToQueue} />
                            ))
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
