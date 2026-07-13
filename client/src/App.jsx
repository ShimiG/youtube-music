import { useState, useEffect } from 'react';
import LibraryView from './components/LibraryView';
import SearchView from './components/SearchView';
import HistoryView from './components/HistoryView';
import Sidebar from './components/Sidebar';
import PlayerFooter from './components/PlayerFooter';
import Queue from './components/Queue';
import AuthScreen from './components/AuthScreen'; 
import './App.css';

function App() {
    const [view, setView] = useState('search'); 
    
    // Simple Local Auth State
    const [localUser, setLocalUser] = useState(() => {
        const storedId = localStorage.getItem('localUserId');
        const storedName = localStorage.getItem('localUserName');
        return storedId ? { id: storedId, username: storedName } : null;
    });

    // After the Google connect flow, the backend redirects here with
    // #google=connected&expires_at=... in the URL fragment. The Google tokens
    // themselves stay on the server (user_connections table); the client only
    // records when they expire, then scrubs the fragment from the address bar.
    useEffect(() => {
        const hash = window.location.hash;
        if (!hash.includes('google=')) return;

        const params = new URLSearchParams(hash.slice(1));
        if (params.get('google') === 'connected' && params.get('expires_at')) {
            localStorage.setItem('googleExpiresAt', params.get('expires_at'));
        } else if (params.get('google') === 'error') {
            console.error('Google account connection failed.');
        }
        window.history.replaceState(null, '', window.location.pathname);
    }, []);

    const handleLoginSuccess = (token, userId, username) => {
        localStorage.setItem('authToken', token);
        localStorage.setItem('localUserId', userId);
        localStorage.setItem('localUserName', username);
        setLocalUser({ id: userId, username });
    };

    const handleLogout = () => {
        localStorage.removeItem('authToken');
        localStorage.removeItem('localUserId');
        localStorage.removeItem('localUserName');
        localStorage.removeItem('googleExpiresAt');
        localStorage.removeItem('userToken'); // legacy key from the old client-held-token flow
        setLocalUser(null);
    };

    // Auto-logout when the Google token expires, so the next login forces a
    // fresh connect and fresh tokens. When more streaming services are added,
    // this should use the EARLIEST expiry among all connected services.
    useEffect(() => {
        if (!localUser) return;
        const expiresAt = Number(localStorage.getItem('googleExpiresAt'));
        if (!expiresAt) return;

        const msLeft = expiresAt - Date.now();
        if (msLeft <= 0) {
            handleLogout();
            return;
        }
        const timer = setTimeout(handleLogout, msLeft);
        return () => clearTimeout(timer);
    }, [localUser]);

    return (
        <div className="app-container">
            {/* Show AuthScreen if no local user exists */}
            {!localUser ? (
                <AuthScreen onLoginSuccess={handleLoginSuccess} />
            ) : (
                <>
                    <Sidebar view={view} setView={setView} handleLogout={handleLogout} />

                    <main className="content" style={{ padding: '20px' }}>
                        {(view === 'search' || view === 'history') && (
                            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px', width: '100%', boxSizing: 'border-box' }}> 
                                <div>
                                    {view === 'search' && <SearchView />}
                                    {view === 'history' && <HistoryView />}
                                </div>
                                <Queue />
                            </div>
                        )}
                        {view === 'library' && <LibraryView />}
                    </main>

                    <PlayerFooter />
                </>
            )}
        </div>
    );
}

export default App;