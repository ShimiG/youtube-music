import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { toast } from '../utils/toast';

// Settings -> Accounts -> Your account. The account the person is signed in
// with is their cloud account (a Cloudflare Worker they run themselves, see
// cloud/README.md); this shows how the copy on this computer is doing: when
// it last synced, anything still waiting, and a way to sync now.

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
                Change it only if the service has moved: your account has to exist at the new address, and you will be asked for your password again.
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

// Shown only when the cloud session stored on this computer ran out or was
// refused: the same account, password only. Signing in as someone else is
// done by logging out.
function SignInAgainForm({ status, onDone }) {
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const next = await apiFetch('/api/cloud/link', { method: 'POST', body: { password } });
            const ok = next.result && next.result.ok;
            onDone(next, ok ? 'Signed in again. This computer is up to date.' : 'Signed in. The sync did not finish; it will be tried again.');
        } catch (err) {
            setError(err.message || 'Could not sign in.');
        } finally {
            setBusy(false);
            setPassword('');
        }
    };

    return (
        <form className="accounts-form" onSubmit={submit} aria-label="Sign in to the cloud again">
            <p>Your sign-in to the cloud has run out on this computer. Enter the password of <strong>{status.username}</strong> to carry on syncing. Nothing is lost meanwhile.</p>
            <label className="accounts-field">
                <span>Password</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </label>
            {error && <p className="accounts-error" role="alert">{error}</p>}
            <div className="accounts-actions">
                <button type="submit" className="settings-button is-primary" disabled={busy}>{busy ? 'Working…' : 'Sign in again'}</button>
            </div>
        </form>
    );
}

export default function CloudPanel() {
    const [status, setStatus] = useState(null);
    const [failed, setFailed] = useState(false);
    const [editingAddress, setEditingAddress] = useState(false);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => apiFetch('/api/cloud/status')
        .then(data => { setStatus(data); setFailed(false); })
        .catch(() => setFailed(true)), []);
    useEffect(() => { load(); }, [load]);

    const update = (next, message) => {
        setStatus(next);
        setEditingAddress(false);
        if (message) toast(message);
    };

    const syncNow = async () => {
        setBusy(true);
        try {
            const next = await apiFetch('/api/cloud/sync', { method: 'POST' });
            const failedRun = next.result && !next.result.ok;
            update(next, failedRun ? null : 'Synced.');
            if (failedRun) toast(next.result.error || next.lastError || 'Sync did not finish. It will be tried again.', { kind: 'warning' });
        } catch (err) {
            toast(err.message || 'That did not work.', { kind: 'error' });
        } finally {
            setBusy(false);
        }
    };

    if (failed) return <p className="accounts-error" role="alert">Could not load your account's status.</p>;
    if (!status) return <p className="accounts-detail">Loading…</p>;

    const needsSignIn = status.linked && status.state === 'signin_required';
    let badge;
    if (!status.linked) badge = { text: 'Not signed in', kind: 'off' };
    else if (needsSignIn) badge = { text: 'Sign in again', kind: 'warn' };
    else if (status.lastError) badge = { text: 'Waiting to retry', kind: 'warn' };
    else badge = { text: 'In sync', kind: 'ok' };

    return (
        <div className="accounts-row cloud-panel">
            <div className="accounts-head">
                <span className="accounts-icon" style={{ background: '#f38020' }} aria-hidden="true">☁</span>
                <div className="accounts-name">
                    <strong>{status.linked ? status.username : 'Your account'}</strong>
                    <span>Your account lives in your cloud service. This computer keeps a copy, so the app is fast and works without a connection.</span>
                </div>
                <span className={`accounts-status is-${badge.kind}`}>{badge.text}</span>
                <div className="accounts-buttons">
                    {status.linked && !needsSignIn && (
                        <button type="button" className="settings-button" onClick={syncNow} disabled={busy}>
                            {busy ? 'Syncing…' : 'Sync now'}
                        </button>
                    )}
                </div>
            </div>

            {!status.linked && (
                <p className="accounts-detail">You are not signed in with a cloud account. Log out and sign in to carry on.</p>
            )}

            {status.linked && !needsSignIn && (
                <>
                    <p className="accounts-detail">
                        Last synced {ago(status.lastSyncAt)}
                        {status.pending > 0 ? `; ${status.pending} change${status.pending === 1 ? '' : 's'} waiting to be sent` : ''}.
                    </p>
                    {status.lastError && (
                        <p className="accounts-error" role="alert">
                            The last sync did not finish: {status.lastError} It is tried again every few minutes; nothing is lost meanwhile.
                        </p>
                    )}
                </>
            )}

            {needsSignIn && !editingAddress && <SignInAgainForm status={status} onDone={update} />}

            {editingAddress
                ? <AddressForm current={status.url} onSaved={update} onCancel={() => setEditingAddress(false)} />
                : status.configured && (
                    <p className="accounts-detail">
                        Cloud service: <code>{status.url}</code>
                        {status.urlFromEnv && ' (built in)'}
                        {status.canConfigure && (
                            <> · <button type="button" className="settings-link" onClick={() => setEditingAddress(true)}>Change</button></>
                        )}
                    </p>
                )}

            {status.linked && !needsSignIn && status.youtube && status.youtube.available && (
                <p className="accounts-detail">
                    {status.youtube.connected
                        ? 'Your YouTube connection is kept with your account: it works on every computer you sign in on.'
                        : 'YouTube is connected once for your account (above), and then works on every computer you sign in on.'}
                </p>
            )}
            <p className="accounts-note">
                Kept in your account: custom playlists and recently played
                {status.youtube && status.youtube.available ? ', and your YouTube connection' : ''}.
                Stays on this computer: music from Local Files{status.youtube && status.youtube.available ? ' and your SoundCloud connection' : ', and your YouTube and SoundCloud connections'}.
            </p>
        </div>
    );
}
