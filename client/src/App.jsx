import { useState, useEffect } from 'react';
import LibraryView from './components/LibraryView';
import SearchView from './components/SearchView';
import HistoryView from './components/HistoryView';
import Sidebar from './components/Sidebar';
import PlayerFooter from './components/PlayerFooter';
import Queue from './components/Queue';
import AuthScreen from './components/AuthScreen';
import ConnectServices from './components/ConnectServices';
import { SERVICE_LIST } from './utils/services';
import './App.css';

// Services whose OAuth callback lands back on the app with a URL fragment, and
// the ones whose token expiry should log the user out (those the server does
// not refresh itself). Both facts live in the registry, not here.
const CALLBACK_SERVICES = SERVICE_LIST.filter(s => s.callbackParam);
const AUTO_LOGOUT_SERVICES = SERVICE_LIST.filter(s => s.autoLogoutOnExpiry && s.expiryStorageKey);

function App() {
    const [view, setView] = useState('search'); 
    
    // Simple Local Auth State
    const [localUser, setLocalUser] = useState(() => {
        const storedId = localStorage.getItem('localUserId');
        const storedName = localStorage.getItem('localUserName');
        return storedId ? { id: storedId, username: storedName } : null;
    });

    // After a connect flow, the backend redirects here with
    // #<callbackParam>=connected&expires_at=... in the URL fragment. The
    // service tokens themselves stay on the server (user_connections table).
    // For a service the server does not refresh, the client records the expiry
    // (under the registry's expiryStorageKey) to schedule its auto-logout. The
    // fragment is scrubbed from the address bar either way.
    useEffect(() => {
        const hash = window.location.hash;
        const params = new URLSearchParams(hash.slice(1));
        const landed = CALLBACK_SERVICES.filter(s => params.has(s.callbackParam));
        if (landed.length === 0) return;

        for (const s of landed) {
            const outcome = params.get(s.callbackParam);
            if (outcome === 'connected' && s.expiryStorageKey && params.get('expires_at')) {
                localStorage.setItem(s.expiryStorageKey, params.get('expires_at'));
            } else if (outcome === 'error') {
                console.error(`${s.label} account connection failed.${params.get('reason') ? ` (${params.get('reason')})` : ''}`);
            }
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
        for (const s of SERVICE_LIST) {
            if (s.expiryStorageKey) localStorage.removeItem(s.expiryStorageKey);
        }
        localStorage.removeItem('userToken'); // legacy key from the old client-held-token flow
        setLocalUser(null);
    };

    // Auto-logout at the EARLIEST expiry among the services whose tokens the
    // server does not refresh, so the next login forces a fresh connect and
    // fresh tokens. Server-refreshed services never trigger this.
    useEffect(() => {
        if (!localUser) return;
        const expiries = AUTO_LOGOUT_SERVICES
            .map(s => Number(localStorage.getItem(s.expiryStorageKey)))
            .filter(n => Number.isFinite(n) && n > 0);
        if (expiries.length === 0) return;

        // Defer logout through a timer (0 ms when already expired) so no state
        // update runs synchronously inside the effect body.
        const msLeft = Math.max(0, Math.min(...expiries) - Date.now());
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