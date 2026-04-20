import React, { useState } from 'react';

export default function AuthScreen({ onLoginSuccess }) {
    const [isLogin, setIsLogin] = useState(true);
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);

        const endpoint = isLogin ? '/api/login' : '/api/register';
        const body = isLogin 
            ? { username, password }
            : { username, email, password };

        try {
            const res = await fetch(`http://localhost:3000${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',  // Include cookies
                body: JSON.stringify(body)
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || "Authentication failed");
            }

            onLoginSuccess(data.userId, data.email);

        } catch (err) {
            setError(err.message);
        } finally {
            setIsLoading(false);
        }
    };

    const handleGoogleLogin = () => {
        // Redirect to Google OAuth
        window.location.href = 'http://localhost:3000/auth/google';
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', width: '100vw', background: '#121212', color: 'white' }}>
            <h1 style={{ marginBottom: '30px', fontSize: '36px' }}>Music Manager</h1>
            
            <form onSubmit={handleSubmit} style={{ background: '#181818', padding: '40px', borderRadius: '12px', width: '300px', display: 'flex', flexDirection: 'column', gap: '20px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                <h2 style={{ margin: 0, textAlign: 'center' }}>{isLogin ? 'Welcome Back' : 'Create Account'}</h2>
                
                {error && <div style={{ color: '#ff4d4d', fontSize: '14px', textAlign: 'center', background: '#ff4d4d20', padding: '10px', borderRadius: '6px' }}>{error}</div>}

                <input 
                    type="text" 
                    placeholder="Username" 
                    value={username} 
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    style={{ padding: '12px', borderRadius: '6px', border: '1px solid #333', background: '#282828', color: 'white', outline: 'none' }}
                />
                
                {!isLogin && (
                    <input 
                        type="email" 
                        placeholder="Email" 
                        value={email} 
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        style={{ padding: '12px', borderRadius: '6px', border: '1px solid #333', background: '#282828', color: 'white', outline: 'none' }}
                    />
                )}
                
                <input 
                    type="password" 
                    placeholder="Password" 
                    value={password} 
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    style={{ padding: '12px', borderRadius: '6px', border: '1px solid #333', background: '#282828', color: 'white', outline: 'none' }}
                />

                {!isLogin && (
                    <div style={{ fontSize: '12px', color: '#b3b3b3', background: '#282828', padding: '10px', borderRadius: '6px' }}>
                        ✓ Password must be 12+ characters<br/>
                        ✓ Must include uppercase and lowercase<br/>
                        ✓ Must include a number and special character (@$!%*?&)
                    </div>
                )}

                <button 
                    type="submit" 
                    disabled={isLoading}
                    style={{ background: '#1db954', color: 'black', padding: '12px', border: 'none', borderRadius: '24px', fontWeight: 'bold', fontSize: '16px', cursor: isLoading ? 'not-allowed' : 'pointer', marginTop: '10px' }}
                >
                    {isLoading ? '...' : (isLogin ? 'Log In' : 'Sign Up')}
                </button>

                <div style={{ textAlign: 'center', fontSize: '12px', color: '#666', margin: '10px 0' }}>or</div>

                <button 
                    type="button"
                    onClick={handleGoogleLogin}
                    disabled={isLoading}
                    style={{ background: '#fff', color: '#121212', padding: '12px', border: 'none', borderRadius: '24px', fontWeight: 'bold', fontSize: '16px', cursor: 'pointer' }}
                >
                    Continue with Google
                </button>

                <div style={{ textAlign: 'center', fontSize: '14px', color: '#b3b3b3', marginTop: '10px', cursor: 'pointer' }} onClick={() => { setIsLogin(!isLogin); setError(''); }}>
                    {isLogin ? "Don't have an account? Sign up" : "Already have an account? Log in"}
                </div>
            </form>
        </div>
    );
}
