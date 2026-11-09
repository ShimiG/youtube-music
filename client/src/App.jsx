import { useState, useEffect } from 'react';
import LibraryView from './components/LibraryView';
import SearchView from './components/SearchView';
import HistoryView from './components/HistoryView';
import Sidebar from './components/Sidebar';
import PlayerFooter from './components/PlayerFooter';
import Queue from './components/Queue';
import AuthScreen from './components/AuthScreen';
import ConnectServices from './components/ConnectServices';
import Toaster from './components/Toaster';
import { toast } from './utils/toast';
import { isDesktopApp, onOAuthResult, openExternal } from './utils/desktop';

// Reports the outcome of a connect flow (#google=connected, #soundcloud=error,
// ...). The service tokens stay on the server, encrypted; this only tells the
// user, and lets the connect banner reload.
function reportConnectResult(fragment) {
    const params = new URLSearchParams(fragment);
    if (params.get('google') === 'connected') toast('YouTube connected.');
    else if (params.get('google') === 'error') toast('Connecting YouTube failed. Try again.', { kind: 'error' });
    if (params.get('soundcloud') === 'connected') toast('SoundCloud connected.');
    else if (params.get('soundcloud') === 'error') toast('Connecting SoundCloud failed. Try again.', { kind: 'error' });
    window.dispatchEvent(new Event('connections-changed'));
}
import './App.css';

function App() {
    const [view, setView] = useState('search'); 
    
    // Simple Local Auth State
    const [localUser, setLocalUser] = useState(() => {
        const storedId = localStorage.getItem('localUserId');
        const storedName = localStorage.getItem('localUserName');
        return storedId ? { id: storedId, username: storedName } : null;
    });

    // Web: after a connect flow the backend redirects here with
    // #<service>=connected|error in the URL fragment, scrubbed once read.
    useEffect(() => {
        const hash = window.location.hash;
        if (!hash.includes('google=') && !hash.includes('soundcloud=')) return;
        reportConnectResult(hash.slice(1));
        window.history.replaceState(null, '', window.location.pathname);
    }, []);

    // Desktop: the consent page ran in the system browser; the result comes
    // back as a musicmanager://oauth#<service>=... deep link.
    useEffect(() => {
        let unsubscribe = () => {};
        let cancelled = false;
        onOAuthResult(reportConnectResult)
            .then(stop => { if (cancelled) stop(); else unsubscribe = stop; })
            .catch(err => console.error('Deep link listener failed:', err));
        return () => { cancelled = true; unsubscribe(); };
    }, []);

    // Desktop: links that would open a new browser tab (SoundCloud pages,
    // attribution links) go to the system browser instead of a dead webview tab.
    useEffect(() => {
        if (!isDesktopApp()) return;
        const onClick = (event) => {
            const link = event.target.closest && event.target.closest('a[target="_blank"]');
            if (!link || !link.href.startsWith('https://')) return;
            event.preventDefault();
            openExternal(link.href).catch(err => console.error('Could not open link:', err));
        };
        document.addEventListener('click', onClick);
        return () => document.removeEventListener('click', onClick);
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
        localStorage.removeItem('googleExpiresAt'); // legacy key from the pre-refresh auto-logout
        localStorage.removeItem('userToken'); // legacy key from the old client-held-token flow
        setLocalUser(null);
    };

    // The server renews any connection it holds a refresh token for, so an
    // expiry passing is normally invisible. Auto-logout only applies to a
    // connection the server cannot renew (no refresh token): at the earliest
    // such expiry the user is logged out so the next login reconnects it.
    useEffect(() => {
        if (!localUser) return;
        const authToken = localStorage.getItem('authToken');
        if (!authToken) return;

        let timer;
        let cancelled = false;
        fetch('http://localhost:3000/api/user/connections', { headers: { Authorization: `Bearer ${authToken}` } })
            .then(res => (res.ok ? res.json() : []))
            .then(rows => {
                if (cancelled || !Array.isArray(rows)) return;
                const expiries = rows
                    .filter(conn => !conn.refreshable && conn.expires_at)
                    .map(conn => Number(conn.expires_at));
                if (!expiries.length) return;
                const msLeft = Math.max(0, Math.min(...expiries) - Date.now());
                // setTimeout caps at ~24.8 days; anything longer needs no timer this session.
                if (msLeft > 2 ** 31 - 1) return;
                timer = setTimeout(() => {
                    toast('A connected service session ended. Log in again to reconnect.', { kind: 'warning' });
                    handleLogout();
                }, msLeft);
            })
            .catch(() => { /* offline: nothing to schedule */ });
        return () => { cancelled = true; clearTimeout(timer); };
    }, [localUser]);

    return (
        <div className="app-container">
            <Toaster />
            {/* Show AuthScreen if no local user exists */}
            {!localUser ? (
                <AuthScreen onLoginSuccess={handleLoginSuccess} />
            ) : (
                <>
                    <Sidebar view={view} setView={setView} handleLogout={handleLogout} />

                    <main className="content" style={{ padding: '20px' }}>
                        <ConnectServices />
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