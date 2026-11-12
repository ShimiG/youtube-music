import React, { useEffect, useState } from 'react';
import { API_BASE } from '../utils/api';

// The first screen: log in to (or create) an account on this computer, or
// sign in with the cloud account. The last one is for a computer that has not
// seen you before: it creates the account here, links it, and brings your
// playlists, history and YouTube login with it (docs/cloud-data.md).

const field = { padding: '12px', borderRadius: '6px', border: '1px solid #333', background: '#282828', color: 'white', outline: 'none' };
const linkStyle = { textAlign: 'center', fontSize: '14px', color: '#b3b3b3', cursor: 'pointer', background: 'none', border: 'none', padding: 0, font: 'inherit' };

const TITLES = { login: 'Welcome Back', register: 'Create Account', cloud: 'Cloud Account' };
const BUTTONS = { login: 'Log In', register: 'Sign Up', cloud: 'Sign In' };
const ENDPOINTS = { login: '/api/login', register: '/api/register', cloud: '/api/cloud/login' };

// Whether this computer can sign in with a cloud account.
async function cloudInfo(signal) {
    try {
        const res = await fetch(`${API_BASE}/api/cloud/info`, { signal });
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

export default function AuthScreen({ onLoginSuccess }) {
    const [mode, setMode] = useState('login'); // login | register | cloud
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [address, setAddress] = useState('');
    const [cloud, setCloud] = useState(null); // { configured, canSetAddress }
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        cloudInfo(controller.signal).then((info) => { if (info) setCloud(info); });
        return () => controller.abort();
    }, []);

    const cloudOffered = Boolean(cloud && (cloud.configured || cloud.canSetAddress));
    const askAddress = mode === 'cloud' && cloud && !cloud.configured && cloud.canSetAddress;
    const switchTo = (next) => { setMode(next); setError(''); };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);

        try {
            const body = { username, password, ...(askAddress ? { url: address } : {}) };
            const res = await fetch(`${API_BASE}${ENDPOINTS[mode]}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                throw new Error(data.error || "Authentication failed");
            }

            onLoginSuccess(data.token, data.userId, data.username);

        } catch (err) {
            setError(err.message);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', width: '100vw', background: '#121212', color: 'white' }}>
            <h1 style={{ marginBottom: '30px', fontSize: '36px' }}>Music Manager</h1>
            
            <form onSubmit={handleSubmit} style={{ background: '#181818', padding: '40px', borderRadius: '12px', width: '300px', display: 'flex', flexDirection: 'column', gap: '20px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                <h2 style={{ margin: 0, textAlign: 'center' }}>{TITLES[mode]}</h2>

                {mode === 'cloud' && (
                    <p style={{ margin: 0, fontSize: '13px', color: '#b3b3b3', textAlign: 'center' }}>
                        Sign in with your cloud account to set this computer up with your playlists, history and YouTube login.
                    </p>
                )}
                
                {error && <div role="alert" style={{ color: '#ff4d4d', fontSize: '14px', textAlign: 'center', background: '#ff4d4d20', padding: '10px', borderRadius: '6px' }}>{error}</div>}

                {askAddress && (
                    <input
                        type="url"
                        placeholder="Cloud address (https://…)"
                        aria-label="Cloud address"
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        required
                        style={field}
                    />
                )}

                <input 
                    type="text" 
                    placeholder={mode === 'cloud' ? 'Cloud user name' : 'Username'}
                    aria-label={mode === 'cloud' ? 'Cloud user name' : 'Username'}
                    value={username} 
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    required
                    style={field}
                />
                
                <input 
                    type="password" 
                    placeholder="Password" 
                    aria-label="Password"
                    value={password} 
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                    required
                    style={field}
                />

                <button 
                    type="submit" 
                    disabled={isLoading}
                    style={{ background: '#1db954', color: 'black', padding: '12px', border: 'none', borderRadius: '24px', fontWeight: 'bold', fontSize: '16px', cursor: isLoading ? 'not-allowed' : 'pointer', marginTop: '10px' }}
                >
                    {isLoading ? (mode === 'cloud' ? 'Signing in…' : '...') : BUTTONS[mode]}
                </button>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
                    {mode !== 'cloud' && (
                        <button type="button" style={linkStyle} onClick={() => switchTo(mode === 'login' ? 'register' : 'login')}>
                            {mode === 'login' ? "Don't have an account? Sign up" : "Already have an account? Log in"}
                        </button>
                    )}
                    {mode !== 'cloud' && cloudOffered && (
                        <button type="button" style={linkStyle} onClick={() => switchTo('cloud')}>
                            Sign in with your cloud account
                        </button>
                    )}
                    {mode === 'cloud' && (
                        <button type="button" style={linkStyle} onClick={() => switchTo('login')}>
                            Use an account on this computer instead
                        </button>
                    )}
                </div>
            </form>
        </div>
    );
}
