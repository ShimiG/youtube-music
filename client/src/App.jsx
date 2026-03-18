import { useState } from 'react';
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

    const handleLoginSuccess = (userId, username) => {
        localStorage.setItem('localUserId', userId);
        localStorage.setItem('localUserName', username);
        setLocalUser({ id: userId, username });
    };

    const handleLogout = () => { 
        localStorage.removeItem('localUserId');
        localStorage.removeItem('localUserName');
        setLocalUser(null); 
    };

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