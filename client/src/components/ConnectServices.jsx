import React, { useEffect, useState } from 'react';
import { connectGoogle } from '../utils/googleAuth';

// Every streaming service the app can link. When a new service is added
// (e.g. Spotify), register it here and its connect button appears on the
// home screen automatically until the user links it.
const SUPPORTED_SERVICES = [
    { name: 'youtube', label: 'Connect YouTube', connect: connectGoogle }
];

// One-click connect banner shown at the top of the home screen. Only lists
// services the logged-in user has NOT connected yet (or whose tokens have
// expired); disappears completely once everything is linked.
export default function ConnectServices() {
    const [connectedNames, setConnectedNames] = useState(null); // null = still loading

    useEffect(() => {
        const authToken = localStorage.getItem('authToken');
        if (!authToken) return;

        fetch('http://localhost:3000/api/user/connections', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        })
            .then(res => (res.ok ? res.json() : []))
            .then(data => {
                const now = Date.now();
                const active = (Array.isArray(data) ? data : [])
                    .filter(conn => !conn.expires_at || conn.expires_at > now)
                    .map(conn => conn.source_name);
                setConnectedNames(new Set(active));
            })
            .catch(() => setConnectedNames(new Set()));
    }, []);

    // While loading, render nothing rather than flashing buttons that may hide.
    if (!connectedNames) return null;

    const missingServices = SUPPORTED_SERVICES.filter(s => !connectedNames.has(s.name));
    if (missingServices.length === 0) return null;

    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '20px', background: '#181818', border: '1px solid #333', borderRadius: '12px', padding: '15px 20px', marginBottom: '20px' }}>
            <span style={{ color: '#b3b3b3', fontSize: '14px' }}>
                Connect your streaming services to search and play music.
            </span>
            <div style={{ display: 'flex', gap: '10px' }}>
                {missingServices.map(service => (
                    <button
                        key={service.name}
                        onClick={service.connect}
                        style={{ background: '#1db954', color: 'black', padding: '10px 20px', border: 'none', borderRadius: '20px', fontWeight: 'bold', fontSize: '14px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                        {service.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
