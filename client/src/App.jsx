import { useState, useEffect } from 'react';
import { useMusic } from './context/MusicContext';

function App() {
  const [token, setToken] = useState(localStorage.getItem('userToken'));
  const [view, setView] = useState('search'); // 'search' or 'library'
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]); // Array of songs
  
  const { currentTrack, isPlaying, togglePlay, playTrack } = useMusic();

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

    // 1. Get the token from storage
    const token = localStorage.getItem('userToken'); 

    if (!token) {
        console.error("No token found! Please log in.");
        return;
    }
    
    try {
        // 2. Attach the token to the request headers
        const res = await fetch(`http://localhost:3000/search?q=${searchQuery}`, {
            headers: {
                'Authorization': `Bearer ${token}` 
            }
        });

        // 3. Handle 401 explicitly (Token expired)
        if (res.status === 401) {
            console.error("Token expired or invalid.");
            handleLogout(); // Force logout so user gets a new token
            return;
        }

        const data = await res.json();

        // 4. Handle Data (same fix as before)
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
          {/* --- SIDEBAR --- */}
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
            <div style={{ flex: 1 }}></div> {/* Spacer */}
            <button onClick={handleLogout}>Exit</button>
          </nav>

          {/* --- MAIN CONTENT --- */}
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
                            searchResults.map((song) => (
                                <div 
                                    key={song.id} 
                                    className="song-item"
                                    onClick={() => playTrack(song)}
                                    style={{ 
                                        display: 'flex', 
                                        alignItems: 'center', 
                                        padding: '10px', 
                                        cursor: 'pointer',
                                        borderBottom: '1px solid #333'
                                    }}
                                >
                                    <img src={song.thumbnail || song.image} alt="art" style={{ width: 40, height: 40, marginRight: 10, borderRadius: 4 }} />
                                    <div>
                                        <div style={{ fontWeight: 'bold' }}>{song.title}</div>
                                        <div style={{ fontSize: '0.8em', color: '#aaa' }}>{song.channelTitle || "Artist"}</div>
                                    </div>
                                </div>
                            ))
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

          {/* --- PLAYER FOOTER --- */}
          {currentTrack && (
            <div className="player-footer">
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <img src={currentTrack.thumbnail || currentTrack.image} style={{width: 50, height: 50, borderRadius: 4, marginRight: 15}} />
                <div>
                    <div style={{ fontWeight: 'bold' }}>{currentTrack.title}</div>
                </div>
              </div>
              
              <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
                 <button 
                    onClick={togglePlay}
                    style={{ 
                        background: 'white', 
                        color: 'black', 
                        borderRadius: '50%', 
                        width: 40, height: 40, 
                        border: 'none', 
                        fontSize: '20px',
                        cursor: 'pointer'
                    }}
                 >
                  {isPlaying ? "⏸" : "▶"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;