import { useState, useEffect } from 'react';

function App() {
  const [token, setToken] = useState(localStorage.getItem('userToken'));

  useEffect(() => {
    // Handle OAuth Callback (URL parsing)
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

  const handleLogin = () => {
    window.location.href = 'http://localhost:3000/auth/google'; // Point to Backend
  };

  const handleLogout = () => {
    localStorage.removeItem('userToken');
    localStorage.removeItem('refreshToken');
    setToken(null);
  };

  return (
    <div className="app-container">
      {!token ? (
        /* --- AUTH SCREEN --- */
        <div className="auth-screen">
          <h1 style={{ fontSize: '40px', marginBottom: '10px' }}>Music Manager</h1>
          <p style={{ color: '#b3b3b3', marginBottom: '40px' }}>Your Unified Music Player</p>
          <button onClick={handleLogin} style={{ padding: '15px 40px', fontSize: '18px', borderRadius: '50px', border: 'none', background: '#1db954', color: 'white', cursor: 'pointer', fontWeight: 'bold' }}>
            Login with Google
          </button>
        </div>
      ) : (
        /* --- MAIN APP LAYOUT --- */
        <div className="main-layout">
          {/* SIDEBAR */}
          <nav className="sidebar">
            <h2>🎵 Music</h2>
            <button className="nav-btn active"><span className="nav-icon">🔍</span> Search</button>
            <button className="nav-btn"><span className="nav-icon">📚</span> My Library</button>
            <button className="nav-btn"><span className="nav-icon">⚙️</span> Settings</button>
            <button className="nav-btn"><span className="nav-icon">⏳</span> Queue</button>
            
            <div className="user-profile">
              <div className="user-avatar"></div>
              <span style={{ fontSize: '14px', fontWeight: 'bold' }}>User</span>
              <button onClick={handleLogout} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#b3b3b3', cursor: 'pointer' }}>Exit</button>
            </div>
          </nav>

          {/* MAIN CONTENT */}
          <main className="content">
            <h1>Search View (Placeholder)</h1>
          </main>

          {/* PLAYER FOOTER */}
          <div className="player-footer">
            <div className="mini-player-controls">
              <span>Player Controls Here</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;