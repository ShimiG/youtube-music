import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { toast } from '../utils/toast';

// Settings -> Accounts -> Cloud sync. Links this computer to the user's cloud
// account (a Cloudflare Worker they run themselves, see cloud/README.md), so
// custom playlists and history are the same on every linked computer. The
// password is turned into a key on this computer's server and is not stored;
// see services/cloud/ on the server.

function ago(ms) {
    if (!ms) return 'never';
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    return `${Math.round(hours / 24)} days ago`;
}

function AddressForm({ onSaved, onCancel, current }) {
    const [url, setUrl] = useState(current || '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            onSaved(await apiFetch('/api/cloud/url', { method: 'PUT', body: { url } }), 'Cloud address saved.');
        } catch (err) {
            setError(err.message || 'Could not save.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <form className="accounts-form" onSubmit={submit} aria-label="Where your cloud service is">
            <p>
                The address of your own cloud service, printed when you deploy it
                (see <code>cloud/README.md</code>). It looks like <code>https://music-manager-cloud.your-name.workers.dev</code>.
            </p>
            <label className="accounts-field">
                <span>Cloud address</span>
                <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoComplete="off" spellCheck={false} required />
            </label>
            {error && <p className="accounts-error" role="alert">{error}</p>}
            <div className="accounts-actions">
                <button type="submit" className="settings-button is-primary" disabled={busy}>{busy ? 'Checking…' : 'Save'}</button>
                {onCancel && <button type="button" className="settings-button" onClick={onCancel}>Cancel</button>}
            </div>
        </form>
    );
}

function SignInForm({ status, onDone }) {
    const again = status.linked; // the session ran out: same account, password only
    const [username, setUsername] = useState(status.username || '');
    const [password, setPassword] = useState('');
    const [creating, setCreating] = useState(false);
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const body = { username, password, ...(creating ? { registrationCode: code } : {}) };
            const next = await apiFetch('/api/cloud/link', { method: 'POST', body });
            const ok = next.result && next.result.ok;
            onDone(next, ok ? 'Cloud sync is on. This computer is up to date.' : 'Signed in. The first sync did not finish; it will be tried again.');
        } catch (err) {
            setError(err.message || 'Could not sign in.');
        } finally {
            setBusy(false);
            setPassword('');
        }
    };

    return (
        <form className="accounts-form" onSubmit={submit} aria-label="Cloud account">
            {!again && (
                <p>
                    {creating
                        ? 'Create your cloud account. You need the registration code you set when deploying the cloud service.'
                        : 'Sign in to your cloud account. Your playlists and history will be the same on every computer signed in to it.'}
                </p>
            )}
            <label className="accounts-field">
                <span>Cloud user name</span>
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} required disabled={again} />
            </label>
            <label className="accounts-field">
                <span>Password</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={creating ? 'new-password' : 'current-password'} required />
            </label>
            {creating && (
                <label className="accounts-field">
                    <span>Registration code</span>
                    <input type="password" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" required />
                </label>
            )}
            {error && <p className="accounts-error" role="alert">{error}</p>}
            <div className="accounts-actions">
                <button type="submit" className="settings-button is-primary" disabled={busy}>
                    {busy ? 'Working…' : (creating ? 'Create account and sync' : (again ? 'Sign in again' : 'Sign in and sync'))}
                </button>
                {!again && (
                    <button type="button" className="settings-button" onClick={() => { setCreating(c => !c); setError(null); }}>
                        {creating ? 'I already have an account' : 'Create an account instead'}
                    </button>
                )}
            </div>
            <p className="accounts-note">
                Your password is not stored and is not sent as it is: this computer turns it into a key first.
                {creating && ' There is no way to recover it, so choose one you will remember.'}
            </p>
        </form>
    );
}

export default function CloudPanel() {
    const [status, setStatus] = useState(null);
    const [failed, setFailed] = useState(false);
    const [editingAddress, setEditingAddress] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirmingOff, setConfirmingOff] = useState(false);

    const load = useCallback(() => apiFetch('/api/cloud/status')
        .then(data => { setStatus(data); setFailed(false); })
        .catch(() => setFailed(true)), []);
    useEffect(() => { load(); }, [load]);

    const update = (next, message) => {
        setStatus(next);
        setEditingAddress(false);
        setConfirmingOff(false);
        if (message) toast(message);
    };

    const act = async (path, method, message) => {
        setBusy(true);
        try {
            const next = await apiFetch(path, { method });
            const failedRun = next.result && !next.result.ok;
            update(next, failedRun ? null : message);
            if (failedRun) toast(next.result.error || next.lastError || 'Sync did not finish. It will be tried again.', { kind: 'warning' });
        } catch (err) {
            toast(err.message || 'That did not work.', { kind: 'error' });
        } finally {
            setBusy(false);
        }
    };

    if (failed) return <p className="accounts-error" role="alert">Could not load the cloud sync status.</p>;
    if (!status) return <p className="accounts-detail">Loading…</p>;

    const needsSignIn = status.linked && status.state === 'signin_required';
    let badge;
    if (!status.configured) badge = { text: 'Not set up', kind: 'off' };
    else if (!status.linked) badge = { text: 'Off', kind: 'off' };
    else if (needsSignIn) badge = { text: 'Sign in again', kind: 'warn' };
    else if (status.lastError) badge = { text: 'Waiting to retry', kind: 'warn' };
    else badge = { text: 'On', kind: 'ok' };

    return (
        <div className="accounts-row cloud-panel">
            <div className="accounts-head">
                <span className="accounts-icon" style={{ background: '#f38020' }} aria-hidden="true">☁</span>
                <div className="accounts-name">
                    <strong>Cloud sync</strong>
                    <span>Keeps your custom playlists and history the same on every computer you sign in on.</span>
                </div>
                <span className={`accounts-status is-${badge.kind}`}>{badge.text}</span>
                <div className="accounts-buttons">
                    {status.linked && !needsSignIn && (
                        <button type="button" className="settings-button" onClick={() => act('/api/cloud/sync', 'POST', 'Synced.')} disabled={busy}>
                            {busy ? 'Syncing…' : 'Sync now'}
                        </button>
                    )}
                </div>
            </div>

            {!status.configured && !status.canConfigure && (
                <p className="accounts-detail">Cloud sync is not set up on this computer. The first account created here can set it up.</p>
            )}
            {((!status.configured && status.canConfigure) || editingAddress) && (
                <AddressForm current={status.url} onSaved={update} onCancel={status.configured ? () => setEditingAddress(false) : null} />
            )}

            {status.configured && !editingAddress && (
                <p className="accounts-detail">
                    Cloud service: <code>{status.url}</code>
                    {status.urlFromEnv && ' (built in)'}
                    {status.canConfigure && !status.linked && (
                        <> · <button type="button" className="settings-link" onClick={() => setEditingAddress(true)}>Change</button></>
                    )}
                </p>
            )}

            {status.configured && !editingAddress && (!status.linked || needsSignIn) && (
                <SignInForm key={needsSignIn ? 'again' : 'new'} status={status} onDone={update} />
            )}

            {status.linked && !needsSignIn && (
                <>
                    <p className="accounts-detail">
                        Signed in as <strong>{status.username}</strong>. Last synced {ago(status.lastSyncAt)}
                        {status.pending > 0 ? `; ${status.pending} change${status.pending === 1 ? '' : 's'} waiting to be sent` : ''}.
                    </p>
                    {status.lastError && (
                        <p className="accounts-error" role="alert">
                            The last sync did not finish: {status.lastError} It is tried again every few minutes; nothing is lost meanwhile.
                        </p>
                    )}
                </>
            )}

            {status.linked && (
                <p className="accounts-detail">
                    {confirmingOff
                        ? <button type="button" className="settings-link is-danger" onClick={() => act('/api/cloud/link', 'DELETE', 'Cloud sync is off on this computer.')} disabled={busy}>Really turn it off here? Your data stays on this computer and in the cloud.</button>
                        : <button type="button" className="settings-link" onClick={() => setConfirmingOff(true)}>Turn off on this computer</button>}
                </p>
            )}
            {status.linked && !needsSignIn && status.youtube && status.youtube.available && (
                <p className="accounts-detail">
                    {status.youtube.connected
                        ? 'Your YouTube login is kept with this account: it works on every computer signed in to it.'
                        : 'YouTube can be connected through this account (above). Connect it once and it works on every computer signed in to it.'}
                </p>
            )}
            <p className="accounts-note">
                Synced: custom playlists and recently played
                {status.youtube && status.youtube.available ? ', and your YouTube login' : ''}.
                Not synced: music from Local Files{status.youtube && status.youtube.available ? ' and your SoundCloud login' : ', and your YouTube and SoundCloud logins'}.
            </p>
        </div>
    );
}
