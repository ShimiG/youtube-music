import { useState, useEffect } from 'react';
import { useMusic } from './context/MusicContext';

function App() {
  const [token, setToken] = useState(() => 
    new URLSearchParams(window.location.search).get('token') || 
    localStorage.getItem('userToken')
  );
  const [view, setView] = useState('search'); 
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]); 
  
  const { currentTrack, isPlaying, togglePlay, playTrack, playNext, playPrev } = useMusic();
  // --- AUTH LOGIC ---
useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const accessToken = params.get('access_token');

    if (accessToken) {
      localStorage.setItem('userToken', accessToken);
      setToken(accessToken);
      

      window.history.replaceState({}, document.title, "/");
    }
  }, []);

  const handleLogin = () => window.location.href = 'http://localhost:3000/auth/google';
  const handleLogout = () => { localStorage.removeItem('userToken'); setToken(null); };

  // --- SEARCH LOGIC ---
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
                            style={{
                                padding: '10px', 
                                width: '300px', 
                                borderRadius: '20px', 
                                border: 'none',
                                outline: 'none'
                            }}
                        />
                    </form>

                      <div className="results-grid">
                      {searchResults.length === 0 ? (
                          <p>Search for a song to begin...</p>
                      ) : (
                          searchResults.map((song) => {
                              const title = song.snippet?.title || song.title || "Unknown Title";
                              const artist = song.snippet?.channelTitle || song.channelTitle || "Unknown Artist";
                              const albumArt = song.snippet?.thumbnails?.default?.url 
                                            || song.thumbnail 
                                            || song.image 
                                            || "https://via.placeholder.com/40"; 

                              const videoId = song.id?.videoId || song.id;

                              return (
                                  <div 
                                      key={videoId} 
                                      className="song-item"
                                  
                                      onClick={() => playTrack({ title, artist, image: albumArt, id: videoId })}
                                      style={{ 
                                          display: 'flex', 
                                          alignItems: 'center', 
                                          padding: '10px', 
                                          cursor: 'pointer',
                                          borderBottom: '1px solid #333'
                                      }}
                                  >
                                      <img 
                                          src={albumArt} 
                                          alt="art" 
                                          style={{ width: 40, height: 40, marginRight: 10, borderRadius: 4 }} 
                                      />
                                      <div>
                                          <div style={{ fontWeight: 'bold' }}>{title}</div>
                                          <div style={{ fontSize: '0.8em', color: '#aaa' }}>{artist}</div>
                                      </div>
                                  </div>
                              );
                          })
                      )}
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

          
    {currentTrack && (
      <div className="player-footer">
        <div style={{ display: 'flex', alignItems: 'center', width: '30%' }}>
          <img src={currentTrack.image} style={{width: 50, height: 50, borderRadius: 4, marginRight: 15}} />
          <div>
            <div style={{ fontWeight: 'bold' }}>{currentTrack.title}</div>
            <div style={{ fontSize: '0.8em', color: '#aaa' }}>{currentTrack.artist}</div>
          </div>
        </div>
        
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '20px' }}>
          <button onClick={playPrev} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '24px' }}>
            ⏮
          </button>

        <button onClick={togglePlay} style={{ 
            background: 'white', color: 'black', borderRadius: '50%', width: 40, height: 40, 
            border: 'none', fontSize: '20px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          {isPlaying ? "⏸" : "▶"}
        </button>

          <button onClick={playNext} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '24px' }}>
            ⏭
          </button>
        </div>
        
        <div style={{ width: '30%' }}></div>
      </div>
    )}
        </>
      )}
    </div>
  );
}

export default App;