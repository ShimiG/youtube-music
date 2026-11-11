import { useState, useEffect, useCallback } from 'react';
import LibraryView from './components/LibraryView';
import SearchView from './components/SearchView';
import HistoryView from './components/HistoryView';
import Sidebar from './components/Sidebar';
import PlayerFooter from './components/PlayerFooter';
import Queue from './components/Queue';
import AuthScreen from './components/AuthScreen';
import ConnectServices from './components/ConnectServices';
import SettingsView from './components/SettingsView';
import NowPlayingView from './components/NowPlayingView';
import useArtworkTheme from './hooks/useArtworkTheme';
import { onOpenSettings } from './utils/navigation';
import { useMusic } from './context/hook';
import Toaster from './components/Toaster';
import { toast } from './utils/toast';
import { isDesktopApp, onOAuthResult, openExternal } from './utils/desktop';
import { SERVICE_LIST } from './utils/services';
import { warmMediaToken } from './utils/media';
import './App.css';

// Services whose OAuth callback reports back as #<callbackParam>=connected|error.
const CALLBACK_SERVICES = SERVICE_LIST.filter(s => s.callbackParam);

// Reports the outcome of a connect flow (#google=connected, #soundcloud=error,
// ...). The service tokens stay on the server, encrypted; this only tells the
// user, and lets the connect banner and the Library reload.
function reportConnectResult(fragment) {
    const params = new URLSearchParams(fragment);
    for (const s of CALLBACK_SERVICES) {
        const outcome = params.get(s.callbackParam);
        if (outcome === 'connected') toast(`${s.label} connected.`);
        else if (outcome === 'error') {
            const reason = params.get('reason');
            console.error(`${s.label} account connection failed.${reason ? ` (${reason})` : ''}`);
            toast(`Connecting ${s.label} failed. Try again.`, { kind: 'error' });
        }
    }
    window.dispatchEvent(new Event('connections-changed'));
}

function App() {
    const [view, setView] = useState('search'); 
    // Any screen can send the user to Settings, optionally at a section
    // (utils/navigation.js): the connect banner, a greyed-out service tab.
    const [settingsSection, setSettingsSection] = useState(null);
    useEffect(() => onOpenSettings((section) => {
        // A new object each time, so asking for the same section twice scrolls again.
        setSettingsSection(section ? { id: section } : null);
        setView('settings');
    }), []);

    // The expanded Now Playing drawer; only meaningful while a track is loaded.
    const { currentTrack } = useMusic();
    const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
    const nowPlayingShown = nowPlayingOpen && Boolean(currentTrack);
    const closeNowPlaying = useCallback(() => setNowPlayingOpen(false), []);
    // The player bar and the Now Playing view take the cover's colours (issue #26).
    useArtworkTheme(currentTrack);
    
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
        const params = new URLSearchParams(hash.slice(1));
        if (!CALLBACK_SERVICES.some(s => params.has(s.callbackParam))) return;
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
        warmMediaToken(); // so the first play can start straight from the click
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
                        {view !== 'settings' && <ConnectServices />}
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
                        {view === 'settings' && <SettingsView section={settingsSection} />}
                    </main>

                    <NowPlayingView open={nowPlayingShown} onClose={closeNowPlaying} />
                    <PlayerFooter expanded={nowPlayingShown} onToggleExpanded={() => setNowPlayingOpen(open => !open)} />
                </>
            )}
        </div>
    );
}

export default App;