import { useState, useEffect } from 'react';
import { useMusic } from './context/hook.jsx';
import './App.css';

function App() {
  const [token, setToken] = useState(() => 
    new URLSearchParams(window.location.search).get('access_token') || 
    localStorage.getItem('userToken')
  );
  
  const [view, setView] = useState('search'); 
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]); 
  const [sliderValue, setSliderValue] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [playlists, setPlaylists] = useState([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [playlistTracks, setPlaylistTracks] = useState([]);
  const [recentTracks, setRecentTracks] = useState([]);
  const [activeSource, setActiveSource] = useState('custom');
  const [customPlaylists, setCustomPlaylists] = useState([]);
  const { 
    currentTrack, isPlaying, isLoading, togglePlay, playTrack, playNext, playPrev, 
    currentTime, duration, volume, updateVolume, toggleMute, seek, 
    queue, queueIndex, playQueueIndex, removeFromQueue, addToQueue, isShuffle, toggleShuffle 
  } = useMusic();

useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('access_token');
    const localToken = localStorage.getItem('userToken');

    // Prevent literal strings "undefined" or "null" from breaking the app
    let activeToken = urlToken || localToken;
    if (activeToken === 'undefined' || activeToken === 'null') {
        activeToken = null;
    }

    console.log(" URL Token:", urlToken);
    console.log("Local Token:", localToken);
    console.log("Active Token being used:", activeToken);

    // Save new token if it came from the URL and is valid
    if (urlToken && urlToken !== 'undefined') {
      localStorage.setItem('userToken', urlToken);
      setToken(urlToken); 
      window.history.replaceState({}, document.title, "/");
    }

    // Fetch the Google Profile if we have a token
    if (activeToken && !localStorage.getItem('googleId')) {
      console.log("🌐 Pinging Google for Profile...");
      
      fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${activeToken}` }
      })
      .then(res => {
          console.log("📡 Google Response Status:", res.status);
          if (!res.ok) throw new Error("Google rejected the token! Status: " + res.status);
          return res.json();
      })
      .then(data => {
          console.log("Google Data Received:", data);
          if (data.id) {
              localStorage.setItem('googleId', data.id);
              localStorage.setItem('userName', data.name);
              localStorage.setItem('userEmail', data.email);
          }
      })
      .catch(err => {
          console.error("Auth check failed:", err.message);
          // (Auto-logout removed temporarily so you can read these logs!)
      });
    }
  }, []);

  const handleLogin = () => window.location.href = 'http://localhost:3000/auth/google';
  const handleLogout = () => { localStorage.removeItem('userToken'); setToken(null); };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery) return;

    const token = localStorage.getItem('userToken'); 

    if (!token) {
        console.error("No token found! Please log in.");
        return;
    }
    
    try {
        const res = await fetch(`http://localhost:3000/search?q=${searchQuery}`, {
            headers: {
                'Authorization': `Bearer ${token}` 
            }
        });

        if (res.status === 401) {
            console.error("Token expired or invalid.");
            handleLogout(); 
            return;
        }

        if (!res.ok) {
            throw new Error(`HTTP error! status: ${res.status}`);
        }

        const data = await res.json();

        if (data.items) {
            setSearchResults(data.items);
        } else if (Array.isArray(data)) {
            setSearchResults(data);
        } else {
            console.error("Unexpected data format:", data);
            setSearchResults([]);
        }
        
    } catch (err) {
        console.error("Search failed:", err);
        setSearchResults([]);
    }
  };

  const formatTime = (seconds) => {
    if (!seconds) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };


  useEffect(() => {
    if (view === 'library') {
      const token = localStorage.getItem('userToken');
      const googleId = localStorage.getItem('googleId');
      if (!token || !googleId) return;

      if (activeSource === 'youtube') {
          fetch('http://localhost:3000/playlists', {
            headers: { 'Authorization': `Bearer ${token}` }
          })
          .then(res => res.json())
          .then(data => setPlaylists(data))
          .catch(err => console.error("Failed to fetch YT playlists:", err));
      } else if (activeSource === 'custom') {
          fetch('http://localhost:3000/api/custom-playlists', { 
            headers: { 'x-google-id': googleId }
          })
          .then(res => res.json())
          .then(data => setCustomPlaylists(data))
          .catch(err => console.error("Failed to fetch Custom playlists:", err));
      }
    }
  }, [view, activeSource]);

const handleViewPlaylist = async (playlist) => {
    const token = localStorage.getItem('userToken');
    if (!token) return;

    setSelectedPlaylist(playlist);
    setPlaylistTracks([]); 

    try {
        const res = await fetch(`http://localhost:3000/playlists/${playlist.id}/tracks`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (res.ok && Array.isArray(data)) {
            setPlaylistTracks(data);
        } else {
            console.error("Failed to load tracks:", data.error || "Unknown error");
            setPlaylistTracks([]); // Keep it an empty array so .map() doesn't crash
        }
    } catch (err) {
        console.error("Failed to load playlist tracks:", err);
        setPlaylistTracks([]);
    }
  };

    const handlePlayAll = () => {
        if (!playlistTracks || playlistTracks.length === 0) return;
        playTrack(playlistTracks[0]);
        playlistTracks.slice(1).forEach(track => {
            addToQueue(track);
        });
    };

    useEffect(() => {
    if (view === 'history') {
        const googleId = localStorage.getItem('googleId'); 
        if (!googleId) return;

        fetch('http://localhost:3000/history', {
            headers: { 
                'x-google-id': googleId 
            }
        })
        .then(res => res.json())
        .then(data => setRecentTracks(data))
        .catch(err => console.error("Failed to fetch history:", err));
    }
  }, [view]);

  useEffect(() => {
    if (!isDragging) {
      setSliderValue(currentTime);
    }
  }, [currentTime, isDragging]);

return (
    <div className="app-container">
      {!token ? (
        <div className="auth-screen">
            <h1>Music Manager</h1>
            <button onClick={handleLogin}>Login with Google</button>
        </div>
      ) : (
        <>
          {/* FIXED SIDEBAR: Removed duplicates and moved Exit to the bottom */}
          <nav className="sidebar">
            <h2>🎵 Music</h2>
            
            <button 
                onClick={() => setView('search')} 
                style={{ color: view === 'search' ? 'white' : '#b3b3b3', background: 'transparent', border: 'none', cursor: 'pointer', display: 'block', marginBottom: '15px', fontSize: '16px', fontWeight: 'bold', textAlign: 'left' }}
            >
                🔍 Search
            </button>
            <button 
                onClick={() => { setView('library'); setSelectedPlaylist(null); }} 
                style={{ color: view === 'library' ? 'white' : '#b3b3b3', background: 'transparent', border: 'none', cursor: 'pointer', display: 'block', marginBottom: '15px', fontSize: '16px', fontWeight: 'bold', textAlign: 'left' }}
            >
                📚 My Library
            </button>
            <button 
                onClick={() => setView('history')} 
                style={{ color: view === 'history' ? 'white' : '#b3b3b3', background: 'transparent', border: 'none', cursor: 'pointer', display: 'block', marginBottom: '15px', fontSize: '16px', fontWeight: 'bold', textAlign: 'left' }}
            >
                🕒 Recently Played
            </button>

            {/* Pushes the Exit button to the very bottom */}
            <div style={{ flex: 1 }}></div> 
            <button 
                onClick={handleLogout}
                style={{ background: 'transparent', border: 'none', color: '#ff4d4d', cursor: 'pointer', fontSize: '16px', fontWeight: 'bold', textAlign: 'left' }}
            >
                Exit
            </button>
          </nav>

          <main className="content" style={{ padding: '20px' }}>
            
            {/* ONLY SHOW SEARCH BAR IN SEARCH VIEW */}
            {view === 'search' && (
                <form onSubmit={handleSearch} style={{ marginBottom: '20px' }}>
                    <input 
                        type="text" 
                        placeholder="Search songs..." 
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        style={{ padding: '10px 20px', width: '300px', borderRadius: '20px', border: 'none', outline: 'none' }}
                    />
                </form>
            )}
            
            {/* SHARED SPLIT LAYOUT: For Search Results AND History */}
            {(view === 'search' || view === 'history') && (
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px', width: '100%', boxSizing: 'border-box' }}> 
                    
                    {/* LEFT COLUMN: Switches between Search Results and History */}
                    <div>
                        {/* 1. SEARCH VIEW */}
                        {view === 'search' && (
                            <>
                                {searchResults.length > 0 && (
                                    <h2 style={{ borderBottom: '1px solid #333', paddingBottom: '10px', marginTop: 0 }}>Search Results</h2>
                                )}
                                <div style={{ display: 'grid', gap: '10px', marginTop: '10px' }}>
                                    {searchResults.map(video => (
                                        <div key={video.id} style={{ display: 'flex', gap: '10px', padding: '10px', borderBottom: '1px solid #eee', alignItems: 'center' }}>
                                            <img src={video.thumbnail || video.image} style={{ width: 80, borderRadius: '4px', cursor: 'pointer' }} onClick={() => playTrack(video)} alt="thumbnail" />
                                            <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => playTrack(video)}>
                                                <div style={{ fontWeight: 'bold' }}>{video.title}</div>
                                                <div style={{ fontSize: '12px', color: '#666' }}>{video.channelTitle || video.artist}</div>
                                            </div>
                                            <button 
                                                onClick={() => addToQueue(video)}
                                                style={{ padding: '8px 12px', borderRadius: '4px', border: '1px solid #1db954', background: 'transparent', color: '#1db954', cursor: 'pointer', fontWeight: 'bold' }}
                                            >
                                                + Queue
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}

                        {/* 2. HISTORY VIEW */}
                        {view === 'history' && (
                            <>
                                <h1 style={{ marginTop: 0, borderBottom: '1px solid #333', paddingBottom: '10px' }}>Recently Played</h1>
                                {recentTracks.length === 0 ? (
                                    <p style={{ color: '#888', fontStyle: 'italic' }}>Search for a song to start your history!</p>
                                ) : (
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '15px', marginTop: '15px' }}>
                                        {recentTracks.map((track, idx) => (
                                            <div 
                                                key={`history-${track.id}-${idx}`}
                                                onClick={() => playTrack(track)}
                                                style={{ background: '#181818', padding: '15px', borderRadius: '8px', cursor: 'pointer', transition: 'background 0.3s' }}
                                                className="history-card"
                                            >
                                                <img src={track.image} alt={track.title} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '4px', marginBottom: '10px' }} />
                                                <div style={{ fontWeight: 'bold', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                    {track.title}
                                                </div>
                                                <div style={{ color: '#b3b3b3', fontSize: '12px', marginTop: '5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                    {track.channelTitle}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                      
                    {/* RIGHT COLUMN: Up Next Queue (Persists across Search and History) */}
                    <div style={{ background: '#f9f9f9', padding: '15px', borderRadius: '8px', height: 'fit-content' }}>
                        <h2 style={{ borderBottom: '1px solid #ddd', paddingBottom: '10px', marginTop: 0, color: 'black' }}>Up Next</h2>
                        
                        {queue && queue.length === 0 ? (
                          <p style={{ color: '#888', fontStyle: 'italic' }}>Your queue is empty.</p>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
                            {queue && queue.map((track, index) => {
                              const isPlayingNode = index === queueIndex;
                              return (
                                <div key={index} style={{ 
                                    display: 'flex', alignItems: 'center', gap: '10px', padding: '8px', 
                                    background: isPlayingNode ? '#1db95420' : 'white', 
                                    borderLeft: isPlayingNode ? '4px solid #1db954' : '4px solid transparent',
                                    borderRadius: '4px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
                                }}>
                                  <div style={{ flex: 1, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => playQueueIndex(index)}>
                                    <div style={{ fontSize: '14px', fontWeight: isPlayingNode ? 'bold' : 'normal', color: 'black' }}>{track.title}</div>
                                  </div>
                                  <button onClick={() => removeFromQueue(index)} style={{ border: 'none', background: 'none', color: '#ff4d4d', cursor: 'pointer', fontSize: '16px' }}>
                                    ✕
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                        )}
                    </div>

                </div>
            )}

            {/* LIBRARY VIEW */}
{/* LIBRARY VIEW */}
            {view === 'library' && (
                <div className="library-view" style={{ padding: '20px' }}>
                    
                    {!selectedPlaylist ? (
                        <>
                            {/* --- HEADER & DROPDOWN --- */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                                <h1 style={{ marginTop: 0, marginBottom: 0 }}>Your Library</h1>
                                <select 
                                    value={activeSource} 
                                    onChange={(e) => setActiveSource(e.target.value)}
                                    style={{ padding: '10px', borderRadius: '8px', background: '#333', color: 'white', border: 'none', outline: 'none', cursor: 'pointer', fontWeight: 'bold' }}
                                >
                                    <option value="custom">Custom Playlists</option>
                                    <option value="youtube">YouTube Music</option>
                                </select>
                            </div>

                            {/* --- CUSTOM PLAYLISTS GRID --- */}
                            {activeSource === 'custom' && (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '20px' }}>
                                    <div 
                                        onClick={() => {/* Trigger Create Playlist Modal/Prompt */}}
                                        style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', background: '#1db95420', borderRadius: '8px', cursor: 'pointer', border: '2px dashed #1db954', minHeight: '200px' }}
                                    >
                                        <span style={{ fontSize: '40px', color: '#1db954' }}>+</span>
                                        <span style={{ color: '#1db954', fontWeight: 'bold' }}>Create Playlist</span>
                                    </div>
                                    
                                    {customPlaylists?.map(playlist => (
                                        <div key={`custom-${playlist.id}`} onClick={() => handleViewPlaylist(playlist, 'custom')} style={{ background: '#282828', padding: '15px', borderRadius: '8px', cursor: 'pointer' }}>
                                            <img src={playlist.thumbnail || 'https://via.placeholder.com/150'} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '4px', marginBottom: '10px' }} alt="thumbnail" />
                                            <div style={{ fontWeight: 'bold' }}>{playlist.name}</div>
                                            <div style={{ fontSize: '12px', color: '#aaa' }}>{playlist.itemCount || 0} songs</div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* --- YOUTUBE PLAYLISTS GRID --- */}
                            {activeSource === 'youtube' && (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '20px' }}>
                                    {(!playlists || playlists.length === 0) ? <p style={{ color: '#888' }}>No YouTube playlists found.</p> : null}
                                    {playlists?.map(playlist => (
                                        <div key={`yt-${playlist.id}`} onClick={() => handleViewPlaylist(playlist, 'youtube')} style={{ background: '#282828', padding: '15px', borderRadius: '8px', cursor: 'pointer' }}>
                                            <img src={playlist.thumbnail || playlist.snippet?.thumbnails?.high?.url} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '4px', marginBottom: '10px' }}  alt="thumbnail" />
                                            <div style={{ fontWeight: 'bold' }}>{playlist.title || playlist.snippet?.title}</div>
                                            <div style={{ fontSize: '12px', color: '#aaa' }}>YouTube Music</div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    ) : selectedPlaylist ? ( // Added double-check here
                        <>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid #333', paddingBottom: '15px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                                    <button 
                                        onClick={() => setSelectedPlaylist(null)} 
                                        style={{ background: '#333', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold' }}
                                    >
                                        ← Back
                                    </button>
                                    {/* Added ? optional chaining below! */}
                                    <h2 style={{ margin: 0 }}>{selectedPlaylist?.title || selectedPlaylist?.name || "Playlist"}</h2>
                                </div>
                                <button 
                                    onClick={handlePlayAll}
                                    disabled={!playlistTracks || playlistTracks.length === 0}
                                    style={{ 
                                        background: '#1db954', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '20px', 
                                        cursor: (!playlistTracks || playlistTracks.length === 0) ? 'not-allowed' : 'pointer', fontWeight: 'bold',
                                        opacity: (!playlistTracks || playlistTracks.length === 0) ? 0.5 : 1
                                    }}
                                >
                                    ▶ Play All
                                </button>
                            </div>
                            
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {!playlistTracks || playlistTracks.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '20px', color: '#888' }}>Loading tracks...</div>
                                ) : (
                                    playlistTracks.map((track, index) => (
                                        <div key={`${track.id}-${index}`} style={{ display: 'flex', gap: '15px', padding: '10px', borderBottom: '1px solid #333', alignItems: 'center' }}>
                                            <img src={track.thumbnail || track.image} style={{ width: 50, borderRadius: '4px', cursor: 'pointer' }} onClick={() => playTrack(track)} alt="thumbnail" onError={(e) => { e.target.src = 'https://via.placeholder.com/50?text=🎵'; }}/>
                                            <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => playTrack(track)}>
                                                <div style={{ fontWeight: 'bold' }}>{track.title}</div>
                                                <div style={{ fontSize: '12px', color: '#aaa' }}>{track.channelTitle || track.artist}</div>
                                            </div>
                                            <button 
                                                onClick={() => addToQueue(track)}
                                                style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid #1db954', background: 'transparent', color: '#1db954', cursor: 'pointer', fontSize: '12px' }}
                                            >
                                                + Queue
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        </>
                    ) : null}
                </div>
            )}
          </main>

          {/* PLAYER FOOTER LAYOUT */}
          {currentTrack && (
            <div className="player-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px 20px', background: '#181818', color: 'white', position: 'fixed', bottom: 0, left: 0, right: 0 }}>
              
              {/* Track Info */}
              <div style={{ display: 'flex', alignItems: 'center', width: '30%' }}>
                <img src={currentTrack.thumbnail || currentTrack.image} style={{width: 50, height: 50, borderRadius: 4, marginRight: 15}} alt="Album Art" />
                <div>
                  <div style={{ fontWeight: 'bold' }}>{currentTrack.title}</div>
                  <div style={{ fontSize: '0.8em', color: '#aaa' }}>{currentTrack.channelTitle || currentTrack.artist}</div>
                </div>
              </div>
              
              {/* Controls & Seek Bar */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', width: '40%' }}>
                
                {/* Playback Buttons */}
                <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>

                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '20px' }}>
                    <button className={`shuffle-btn ${isShuffle ? 'active' : ''}`} onClick={toggleShuffle} title="Shuffle">
                      <svg viewBox="0 0 24 24">
                          <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
                      </svg>
                  </button>

                  <button onClick={playPrev} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '24px' }}>⏮</button>
                  <button onClick={togglePlay} style={{ background: 'white', color: 'black', borderRadius: '50%', width: 40, height: 40, border: 'none', fontSize: '20px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {isLoading ? <div className="loader" style={{ border: '3px solid #f3f3f3', borderTop: '3px solid #555', borderRadius: '50%', width: '20px', height: '20px', animation: 'spin 1s linear infinite' }}></div> : (isPlaying ? "⏸" : "▶")}
                  </button>
                  <button onClick={playNext} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '24px' }}>⏭</button>

                  <button className="shuffle-btn" title="Repeat" style={{ opacity: 0.5 }}>
                      <svg viewBox="0 0 24 24">
                          <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
                      </svg>
                  </button>
                </div>

                {/* Seek Bar */}
                <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '12px', minWidth: '35px', textAlign: 'right', color: '#b3b3b3' }}>{formatTime(sliderValue)}</span>
                  <input 
                    type="range"
                    min="0"
                    max={duration || 0}
                    value={sliderValue}
                    disabled={!duration}
                    onPointerDown={() => setIsDragging(true)}
                    onChange={(e) => setSliderValue(Number(e.target.value))}
                    onPointerUp={() => {
                        setIsDragging(false); 
                        seek(sliderValue); 
                    }}
                    style={{ flex: 1, cursor: 'pointer', accentColor: '#1db954' }}
                  />
                  <span style={{ fontSize: '12px', minWidth: '35px', color: '#b3b3b3' }}>{formatTime(duration)}</span>
                </div>
              </div>

            {/* Volume Controls */}
             <div className="volume-container">
                 <button 
                     className={`sound-btn ${volume === 0 ? 'sound-mute' : ''}`} 
                     onClick={toggleMute}
                     title={volume === 0 ? "Unmute" : "Mute"}
                 >
                     <div className="sound-icon">
                         <svg viewBox="0 0 24 24">
                             <path d="M7 9v6h4l5 5V4l-5 5H7z" />
                         </svg>
                     </div>
                     <div className="sound-wave sound-wave_one"></div>
                     <div className="sound-wave sound-wave_two"></div>
                 </button>
                 <input 
                     type="range" 
                     className="volume-slider"
                     min="0" 
                     max="1" 
                     step="0.01" 
                     value={volume} 
                     onChange={(e) => updateVolume(parseFloat(e.target.value))} 
                     style={{
                         background: `linear-gradient(to right, ${volume > 0 ? '#1db954' : '#4d4d4d'} ${volume * 100}%, #4d4d4d ${volume * 100}%)`
                     }}
                 />
             </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}


export default App;