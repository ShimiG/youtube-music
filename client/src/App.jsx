import { useState, useEffect } from 'react';
import { useMusic } from './context/MusicContext'; // Import the hook

function App() {
  const [token, setToken] = useState(localStorage.getItem('userToken'));
  
  // Grab music data directly from the "Air" (Context)
  const { currentTrack, isPlaying, togglePlay } = useMusic();

  useEffect(() => {
    // ... (Keep your existing Auth Logic here) ...
    const params = new URLSearchParams(window.location.search);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (accessToken) {
      localStorage.setItem('userToken', accessToken);
      if (refreshToken) localStorage.setItem('refreshToken', refreshToken);
      setToken(accessToken);
      window.history.replaceState({}, document.title, "/");
    }
  }, []);

  const handleLogin = () => { window.location.href = 'http://localhost:3000/auth/google'; };
  const handleLogout = () => {
    localStorage.removeItem('userToken');
    setToken(null);
  };

  return (
    <div className="app-container">
      {!token ? (
        /* --- AUTH SCREEN --- */
        <div className="auth-screen">
            <h1>Music Manager</h1>
            <button onClick={handleLogin} className="login-btn">Login with Google</button>
        </div>
      ) : (
        /* --- MAIN APP --- */
        <div className="main-layout">
          <nav className="sidebar">
            <h2>🎵 Music</h2>
            {}
            <button onClick={handleLogout}>Exit</button>
          </nav>

          <main className="content">
            <h1>Welcome, User!</h1>
            {}
          </main>

          {}
          {currentTrack && (
            <div className="player-footer">
              <div className="mini-player-controls">
                <img src={currentTrack.image} style={{width: 50, height: 50}} />
                <div>
                    <b>{currentTrack.title}</b><br/>
                    <small>{currentTrack.artist}</small>
                </div>
                <button onClick={togglePlay}>
                  {isPlaying ? "⏸" : "▶"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;