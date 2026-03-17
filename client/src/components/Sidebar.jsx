import React from 'react';
import { useMusic } from '../context/hook';

export default function Sidebar({ view, setView, handleLogout }) {
    const { currentTrack } = useMusic();

    const getBtnStyle = (targetView) => ({
        color: view === targetView ? 'white' : '#b3b3b3',
        background: 'transparent', border: 'none', cursor: 'pointer', 
        display: 'block', marginBottom: '15px', fontSize: '16px', 
        fontWeight: 'bold', textAlign: 'left'
    });

    return (
        <nav className="sidebar" style={{ paddingBottom: currentTrack ? '100px' : '20px', overflowY: 'auto' }}>
            <h2>🎵 Music</h2>
            <button onClick={() => setView('search')} style={getBtnStyle('search')}>🔍 Search</button>
            <button onClick={() => setView('library')} style={getBtnStyle('library')}>📚 My Library</button>
            <button onClick={() => setView('history')} style={getBtnStyle('history')}>🕒 Recently Played</button>

            <div style={{ flex: 1 }}></div> 
            <button onClick={handleLogout} style={{ background: 'transparent', border: 'none', color: '#ff4d4d', cursor: 'pointer', fontSize: '16px', fontWeight: 'bold', textAlign: 'left' }}>
                Exit
            </button>
        </nav>
    );
}