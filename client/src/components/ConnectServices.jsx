import React, { useEffect, useState } from 'react';
import { SERVICE_LIST, isConnectionActive } from '../utils/services';

// One-click connect banner shown at the top of the home screen. Only lists
// services the logged-in user has NOT connected yet (or whose tokens have
// expired without a server-side refresh); disappears once everything is linked.
export default function ConnectServices() {
    const [connectedNames, setConnectedNames] = useState(null); // null = still loading
    const [unavailable, setUnavailable] = useState(new Set()); // services this server cannot connect

    useEffect(() => {
        const authToken = localStorage.getItem('authToken');
        if (!authToken) return;
        const headers = { 'Authorization': `Bearer ${authToken}` };

        fetch('http://localhost:3000/api/user/connections', { headers })
            .then(res => (res.ok ? res.json() : []))
            .then(data => {
                const now = Date.now();
                const active = (Array.isArray(data) ? data : [])
                    .filter(conn => isConnectionActive(conn, now))
                    .map(conn => conn.source_name);
                setConnectedNames(new Set(active));
            })
            .catch(() => setConnectedNames(new Set()));

        // SoundCloud search and playback work without credentials (yt-dlp), but
        // connecting an account needs the official API. Hide the button when
        // the server cannot offer it instead of showing one that only errors.
        fetch('http://localhost:3000/api/soundcloud/status', { headers })
            .then(res => (res.ok ? res.json() : null))
            .then(status => {
                if (status && status.connectAvailable === false) setUnavailable(new Set(['soundcloud']));
            })
            .catch(() => {});
    }, []);

    // While loading, render nothing rather than flashing buttons that may hide.
    if (!connectedNames) return null;

    const missingServices = SERVICE_LIST.filter(s => !connectedNames.has(s.name) && !unavailable.has(s.name));
    if (missingServices.length === 0) return null;

    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '20px', background: '#181818', border: '1px solid #333', borderRadius: '12px', padding: '15px 20px', marginBottom: '20px', flexWrap: 'wrap' }}>
            <span style={{ color: '#b3b3b3', fontSize: '14px' }}>
                Connect your streaming services to search and play music.
            </span>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                {missingServices.map(service => (
                    <button
                        key={service.name}
                        onClick={service.connect}
                        style={{ background: service.color, color: 'white', padding: '10px 20px', border: 'none', borderRadius: '20px', fontWeight: 'bold', fontSize: '14px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                        {service.connectLabel}
                    </button>
                ))}
            </div>
        </div>
    );
}
