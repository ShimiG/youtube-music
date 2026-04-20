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
    const [localUser, setLocalUser] = useState(null);
    const [isCheckingAuth, setIsCheckingAuth] = useState(true);

    // Check if user is authenticated on mount
    useEffect(() => {
        const checkAuth = async () => {
            try {
                const res = await fetch('http://localhost:3000/auth/success', {
                    credentials: 'include'  // Include cookies
                });
                if (res.ok) {
                    const data = await res.json();
                    setLocalUser({ 
                        id: data.userId, 
                        email: data.email 
                    });
                }
            } catch (err) {
                console.error('Auth check failed:', err);
            } finally {
                setIsCheckingAuth(false);
            }
        };
        checkAuth();
    }, []);

    const handleLoginSuccess = (userId, email) => {
        setLocalUser({ id: userId, email });
    };

    const handleLogout = () => { 
        // Call logout endpoint
        fetch('http://localhost:3000/auth/logout', {
            method: 'POST',
            credentials: 'include'
        }).finally(() => {
            setLocalUser(null);
        });
    };

    if (isCheckingAuth) {
        return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#121212', color: 'white' }}>Loading...</div>;
    }

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