import React, { useEffect, useState } from 'react';
import { API_BASE } from '../utils/api';

// The first screen: sign in with your cloud account. It is the only account
// there is. Signing in on a computer sets that computer up: your playlists,
// history and YouTube connection come with you, and a copy is kept here so
// the app stays fast and works without a connection (docs/cloud-data.md).
//
// Creating the account happens here too, once, with the registration code
// that was set when the cloud service was deployed.

const field = { padding: '12px', borderRadius: '6px', border: '1px solid #333', background: '#282828', color: 'white', outline: 'none' };
const linkStyle = { textAlign: 'center', fontSize: '14px', color: '#b3b3b3', cursor: 'pointer', background: 'none', border: 'none', padding: 0, font: 'inherit' };
const note = { margin: 0, fontSize: '13px', color: '#b3b3b3', textAlign: 'center' };

// Whether this computer knows where the cloud service is.
async function cloudInfo(signal) {
    try {
        const res = await fetch(`${API_BASE}/api/cloud/info`, { signal });
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

export default function AuthScreen({ onLoginSuccess }) {
    const [creating, setCreating] = useState(false);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [address, setAddress] = useState('');
    const [cloud, setCloud] = useState(null); // { configured, canSetAddress }; null while asking
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        cloudInfo(controller.signal).then((info) => { if (!controller.signal.aborted) setCloud(info || { configured: false, canSetAddress: false }); });
        return () => controller.abort();
    }, []);

    const askAddress = Boolean(cloud && !cloud.configured && cloud.canSetAddress);
    // No address, and none can be given here: it is fixed for this copy and wrong.
    const stuck = Boolean(cloud && !cloud.configured && !cloud.canSetAddress);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);
        try {
            const body = {
                username,
                password,
                ...(askAddress ? { url: address } : {}),
                ...(creating ? { registrationCode: code } : {})
            };
            const res = await fetch(`${API_BASE}/api/cloud/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Signing in failed.');
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

            <form onSubmit={handleSubmit} aria-label={creating ? 'Create your account' : 'Sign in'} style={{ background: '#181818', padding: '40px', borderRadius: '12px', width: '300px', display: 'flex', flexDirection: 'column', gap: '20px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                <h2 style={{ margin: 0, textAlign: 'center' }}>{creating ? 'Create Account' : 'Sign In'}</h2>

                <p style={note}>
                    {creating
                        ? 'Create your account in your cloud service. You need the registration code that was set when it was deployed.'
                        : 'Your playlists, history and YouTube connection come with your account to every computer you sign in on.'}
                </p>

                {error && <div role="alert" style={{ color: '#ff4d4d', fontSize: '14px', textAlign: 'center', background: '#ff4d4d20', padding: '10px', borderRadius: '6px' }}>{error}</div>}
                {stuck && (
                    <div role="alert" style={{ color: '#ffb84d', fontSize: '13px', textAlign: 'center', background: '#ffb84d20', padding: '10px', borderRadius: '6px' }}>
                        The address of the cloud service set for this copy of the app (CLOUD_URL) is not usable. Correct it and start the app again.
                    </div>
                )}

                {askAddress && (
                    <>
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
                        <p style={{ ...note, textAlign: 'left', fontSize: '12px' }}>
                            The address of your own cloud service, asked for once on this computer. It was printed when the service was deployed and looks like https://music-manager-cloud.your-name.workers.dev
                        </p>
                    </>
                )}

                <input
                    type="text"
                    placeholder="User name"
                    aria-label="User name"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    spellCheck={false}
                    required
                    style={field}
                />

                <input
                    type="password"
                    placeholder="Password"
                    aria-label="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={creating ? 'new-password' : 'current-password'}
                    required
                    style={field}
                />

                {creating && (
                    <>
                        <input
                            type="password"
                            placeholder="Registration code"
                            aria-label="Registration code"
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            autoComplete="off"
                            required
                            style={field}
                        />
                        <p style={{ ...note, textAlign: 'left', fontSize: '12px' }}>
                            The password cannot be recovered, so choose one you will remember.
                        </p>
                    </>
                )}

                <button
                    type="submit"
                    disabled={isLoading || !cloud || stuck}
                    style={{ background: '#1db954', color: 'black', padding: '12px', border: 'none', borderRadius: '24px', fontWeight: 'bold', fontSize: '16px', cursor: isLoading ? 'not-allowed' : 'pointer', marginTop: '10px', opacity: !cloud || stuck ? 0.5 : 1 }}
                >
                    {isLoading ? (creating ? 'Creating…' : 'Signing in…') : (creating ? 'Create Account' : 'Sign In')}
                </button>

                <button type="button" style={linkStyle} onClick={() => { setCreating(c => !c); setError(''); }}>
                    {creating ? 'I already have an account' : 'Create an account'}
                </button>
            </form>
        </div>
    );
}
