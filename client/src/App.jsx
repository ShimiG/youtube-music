import { useState, useEffect } from 'react';
import { useMusic } from './context/hook.jsx';

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

  const { 
    currentTrack, isPlaying, isLoading, togglePlay, playTrack, playNext, playPrev, 
    currentTime, duration, volume, updateVolume, toggleMute, seek, 
    queue, queueIndex, playQueueIndex, removeFromQueue, addToQueue 
  } = useMusic();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const accessToken = params.get('access_token');

    if (accessToken) {
      localStorage.setItem('userToken', accessToken);
      window.history.replaceState({}, document.title, "/");
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
          <nav className="sidebar">
            <h2>🎵 Music</h2>
            <button 
                onClick={() => setView('search')}
                style={{ color: view === 'search' ? 'white' : '#b3b3b3' }}
            >
                🔍 Search
            </button>
            <button 
                onClick={() => setView('library')}
                style={{ color: view === 'library' ? 'white' : '#b3b3b3' }}
            >
                📚 My Library
            </button>
            <div style={{ flex: 1 }}></div> 
            <button onClick={handleLogout}>Exit</button>
          </nav>

          <main className="content">
            {view === 'search' && (
                <div className="search-view">
                    <form onSubmit={handleSearch} style={{ marginBottom: '20px' }}>
                        <input 
                            type="text" 
                            placeholder="Search songs..." 
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            style={{ padding: '10px', width: '300px', borderRadius: '20px', border: 'none', outline: 'none' }}
                        />
                    </form>
                    
                    {/* MAIN CONTENT AREA */}
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px', padding: '20px' }}>
                      
                      {/* SEARCH RESULTS */}
                      <div>
                        <h2 style={{ borderBottom: '1px solid #eee', paddingBottom: '10px' }}>Search Results</h2>
                        <div style={{ display: 'grid', gap: '10px', marginTop: '10px' }}>
                          {searchResults.map(video => (
                            <div key={video.id} style={{ display: 'flex', gap: '10px', padding: '10px', borderBottom: '1px solid #eee', alignItems: 'center' }}>
                              {/* Using fallback to support both 'thumbnail' and 'image' formats */}
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
                      </div>

                      {/* QUEUE PANEL */}
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
                </div>
            )}

            {view === 'library' && (
                <div className="library-view">
                    <h1>Your Library</h1>
                    <p>Playlists coming soon...</p>
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
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '20px' }}>
                  <button onClick={playPrev} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '24px' }}>⏮</button>
                  <button onClick={togglePlay} style={{ background: 'white', color: 'black', borderRadius: '50%', width: 40, height: 40, border: 'none', fontSize: '20px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {isLoading ? <div className="loader" style={{ border: '3px solid #f3f3f3', borderTop: '3px solid #555', borderRadius: '50%', width: '20px', height: '20px', animation: 'spin 1s linear infinite' }}></div> : (isPlaying ? "⏸" : "▶")}
                  </button>
                  <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
                  <button onClick={playNext} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '24px' }}>⏭</button>
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
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px', width: '30%' }}>
                <button onClick={toggleMute} style={{ background: 'none', border: 'none', color: '#b3b3b3', fontSize: '18px', cursor: 'pointer' }}>
                  {volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
                </button>
                <input 
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(e) => updateVolume(Number(e.target.value))}
                  style={{ width: '80px', cursor: 'pointer', accentColor: '#1db954' }}
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