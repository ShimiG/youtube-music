import { useState, useEffect } from 'react';
import LibraryView from './components/LibraryView';
import SearchView from './components/SearchView';
import HistoryView from './components/HistoryView';
import Sidebar from './components/Sidebar';
import PlayerFooter from './components/PlayerFooter';
import Queue from './components/Queue';
import './App.css';

function App() {
    const [view, setView] = useState('search'); 
    
    // Auth Initialization State
    const [token, setToken] = useState(() => {
        const urlToken = new URLSearchParams(window.location.search).get('access_token');
        let localToken = localStorage.getItem('userToken');
        if (localToken === 'null' || localToken === 'undefined') {
            localStorage.removeItem('userToken');
            localToken = null;
        }
        if (urlToken && urlToken !== 'null' && urlToken !== 'undefined') return urlToken;
        return localToken || null;
    });

useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const urlToken = params.get('access_token');
        let localToken = localStorage.getItem('userToken');

        if (localToken === 'null' || localToken === 'undefined') {
            localStorage.removeItem('userToken');
            localToken = null;
        }

        let activeToken = urlToken || localToken;

        if (urlToken && urlToken !== 'undefined' && urlToken !== 'null') {
            localStorage.setItem('userToken', urlToken);
            window.history.replaceState({}, document.title, "/");
            activeToken = urlToken; 
        } else if (localToken) {
            activeToken = localToken;
        }
        if (activeToken && !localStorage.getItem('googleId')) {
            fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${activeToken}` }
            })
            .then(res => {
                if (!res.ok) throw new Error("Google rejected the token!");
                return res.json();
            })
            .then(data => {
                if (data.id) {
                    localStorage.setItem('googleId', data.id);
                    localStorage.setItem('userName', data.name);
                    localStorage.setItem('userEmail', data.email);
                }
            })
            .catch(() => {
                localStorage.removeItem('userToken');
                setToken(null);
            });
        }
    }, []);

    const handleLogin = () => {
        try { window.location.href = 'http://localhost:3000/auth/google'; } 
        catch (e) { console.error("Login failed:", e); }
    };

    const handleLogout = () => { 
        localStorage.removeItem('userToken');
        localStorage.removeItem('googleId');
        setToken(null); 
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
                    <Sidebar view={view} setView={setView} handleLogout={handleLogout} />

                    <main className="content" style={{ padding: '20px' }}>
                        
                        {/* SHARED SPLIT LAYOUT */}
                        {(view === 'search' || view === 'history') && (
                            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px', width: '100%', boxSizing: 'border-box' }}> 
                                <div>
                                    {view === 'search' && <SearchView />}
                                    {view === 'history' && <HistoryView />}
                                </div>
                                <Queue />
                            </div>
                        )}

                        {/* FULL WIDTH LAYOUT */}
                        {view === 'library' && <LibraryView />}
                    </main>

                    <PlayerFooter />
                </>
            )}
        </div>
    );
}

export default App;