import { useEffect, useState } from 'react';
import { waitForServer } from '../utils/api';

// The window can open before the local server is listening: in the installed
// app both start together, and the server needs a second or two on a cold
// disk. Requests made in that gap failed and were not all asked again, which
// left the first screen half empty. Nothing is drawn (and so nothing is asked)
// until the server answers. When it is already up, this adds one request of a
// few milliseconds.

const screen = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', height: '100vh', width: '100vw', background: '#121212', color: '#b3b3b3' };
const button = { background: '#1db954', color: 'black', padding: '10px 24px', border: 'none', borderRadius: '24px', fontWeight: 'bold', cursor: 'pointer' };

export default function ServerGate({ children }) {
    // checking: asked, no answer yet (too soon to say anything)
    // starting: still no answer after a moment
    // ready / down
    const [state, setState] = useState('checking');
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        const slow = setTimeout(() => setState((s) => (s === 'checking' ? 'starting' : s)), 400);
        waitForServer(controller.signal).then((up) => {
            if (!controller.signal.aborted) setState(up ? 'ready' : 'down');
        });
        return () => { controller.abort(); clearTimeout(slow); };
    }, [attempt]);

    if (state === 'ready') return children;
    if (state === 'checking') return <div style={screen} />;
    if (state === 'starting') {
        return (
            <div style={screen} role="status">
                <h1 style={{ color: 'white', margin: 0 }}>Music Manager</h1>
                <p style={{ margin: 0 }}>Starting…</p>
            </div>
        );
    }
    return (
        <div style={screen} role="alert">
            <h1 style={{ color: 'white', margin: 0 }}>Music Manager</h1>
            <p style={{ margin: 0, maxWidth: '420px', textAlign: 'center' }}>
                The app's local server is not answering. If you run it from source, start it with <code>npm start</code>.
            </p>
            <button type="button" style={button} onClick={() => { setState('checking'); setAttempt((n) => n + 1); }}>Try again</button>
        </div>
    );
}
