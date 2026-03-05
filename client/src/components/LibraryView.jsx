import { useState, useEffect } from 'react';

export default function LibraryView() {
    const [connectedSources, setConnectedSources] = useState(['custom']); 
    const [activeSource, setActiveSource] = useState('custom');

    useEffect(() => {
        fetch('/api/user/connections', { headers: { 'x-google-id': localStorage.getItem('googleId') } })
            .then(res => res.json())
            .then(data => {
                const available = ['custom', ...data.map(conn => conn.source_name)];
                setConnectedSources(available);
            });
    }, []);

    return (
        <div className="library-view" style={{ padding: '20px' }}>
            <div className="library-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <h1>Your Library</h1>
                
                {/* Dynamic Service Selector */}
                <select 
                    value={activeSource} 
                    onChange={(e) => setActiveSource(e.target.value)}
                    style={{ padding: '10px', borderRadius: '8px', background: '#333', color: 'white' }}
                >
                    {connectedSources.map(source => (
                        <option key={source} value={source}>
                            {source === 'custom' ? 'Custom Playlists' : source.charAt(0).toUpperCase() + source.slice(1)}
                        </option>
                    ))}
                </select>
            </div>

            {/* Conditional Rendering based on selected source */}
            <div className="library-content">
                {activeSource === 'custom' && <CustomPlaylistGrid />}
                {activeSource === 'youtube' && <YouTubeNativeGrid />}
                {activeSource === 'spotify' && <SpotifyNativeGrid />}
            </div>
        </div>
    );
}