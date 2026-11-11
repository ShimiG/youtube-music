import { useCallback, useEffect, useState } from 'react';
import { useSources } from '../hooks/useSources';
import { apiFetch } from '../utils/api';
import { serviceOf } from '../utils/services';
import { toast } from '../utils/toast';

// Settings -> Accounts. One row per service that has an account to connect:
// connect, disconnect, and (for the installation's owner) the service's own
// credentials, which the server needs before anyone can connect. Services
// that need no account are listed in one line. Which services exist comes
// from GET /api/sources; what is set up from GET /api/settings/services.

const changed = () => window.dispatchEvent(new Event('connections-changed'));

function SetupForm({ service, onSaved, onCancel }) {
    const [values, setValues] = useState({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    const copyRedirect = async () => {
        try {
            await navigator.clipboard.writeText(service.redirectUri);
            toast('Redirect address copied.');
        } catch {
            toast('Could not copy. Select the address and copy it by hand.', { kind: 'warning' });
        }
    };

    const submit = async (e) => {
        e.preventDefault();
        setSaving(true);
        setError(null);
        try {
            const data = await apiFetch(`/api/settings/services/${encodeURIComponent(service.source)}`, { method: 'PUT', body: { values } });
            onSaved(data.services, `${service.label} is set up. You can connect your account now.`);
        } catch (err) {
            setError(err.message || 'Could not save.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <form className="accounts-form" onSubmit={submit} aria-label={`${service.label} credentials`}>
            <p>{service.help} <a href={service.helpUrl} target="_blank" rel="noreferrer">Open the developer page ↗</a></p>
            <div className="accounts-redirect">
                <span>Redirect address</span>
                <code>{service.redirectUri}</code>
                <button type="button" className="settings-button" onClick={copyRedirect}>Copy</button>
            </div>
            {service.fields.map(field => (
                <label key={field.key} className="accounts-field">
                    <span>{field.label}</span>
                    <input
                        type={field.secret ? 'password' : 'text'}
                        value={values[field.key] || ''}
                        onChange={(e) => setValues(v => ({ ...v, [field.key]: e.target.value }))}
                        autoComplete="off"
                        spellCheck={false}
                        required
                    />
                </label>
            ))}
            {error && <p className="accounts-error" role="alert">{error}</p>}
            <div className="accounts-actions">
                <button type="submit" className="settings-button is-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                <button type="button" className="settings-button" onClick={onCancel}>Cancel</button>
            </div>
            <p className="accounts-note">Saved on this computer only, encrypted. The secret is never shown again.</p>
        </form>
    );
}

function AccountRow({ source, service, onServices }) {
    const [editing, setEditing] = useState(false);
    const [confirmingRemove, setConfirmingRemove] = useState(false);
    const [busy, setBusy] = useState(false);
    const visuals = serviceOf(source.name);
    const available = Boolean(source.connect && source.connect.available);

    const disconnect = async () => {
        setBusy(true);
        try {
            await apiFetch(`/api/user/connections/${encodeURIComponent(source.name)}`, { method: 'DELETE' });
            toast(`${source.label} disconnected.`);
            changed();
        } catch (err) {
            toast(err.message || `Could not disconnect ${source.label}.`, { kind: 'error' });
        } finally {
            setBusy(false);
        }
    };

    const removeCredentials = async () => {
        setBusy(true);
        try {
            const data = await apiFetch(`/api/settings/services/${encodeURIComponent(source.name)}`, { method: 'DELETE' });
            onServices(data.services, `${source.label} credentials removed.`);
        } catch (err) {
            toast(err.message || 'Could not remove.', { kind: 'error' });
        } finally {
            setBusy(false);
            setConfirmingRemove(false);
        }
    };

    // A source that searches and plays without an account: connecting is an
    // extra, so "not set up" is no warning there.
    const optional = !source.searchRequiresConnection;
    let status;
    if (source.connected) status = { text: 'Connected', kind: 'ok' };
    else if (available) status = { text: 'Not connected', kind: 'off' };
    else if (optional) status = { text: 'Works without an account', kind: 'off' };
    else status = { text: 'Not set up', kind: 'warn' };

    return (
        <li className="accounts-row">
            <div className="accounts-head">
                <span className="accounts-icon" style={{ background: visuals.color }} aria-hidden="true">{visuals.icon}</span>
                <div className="accounts-name">
                    <strong>{source.label}</strong>
                    {visuals.accountNote && <span>{visuals.accountNote}</span>}
                </div>
                <span className={`accounts-status is-${status.kind}`}>{status.text}</span>
                <div className="accounts-buttons">
                    {source.connected && <button type="button" className="settings-button" onClick={disconnect} disabled={busy}>Disconnect</button>}
                    {!source.connected && available && source.connectAction && (
                        <button type="button" className="settings-button is-primary" onClick={() => source.connectAction()}>{source.connectLabel}</button>
                    )}
                    {!available && service && service.canEdit && !editing && (
                        <button type="button" className={`settings-button ${optional ? '' : 'is-primary'}`} onClick={() => setEditing(true)}>Set up {source.label}</button>
                    )}
                </div>
            </div>

            {!available && !editing && (
                <p className="accounts-detail">
                    {!service && `${source.label} cannot be connected on this installation.`}
                    {service && service.canEdit && !optional && `Before anyone can connect, Music Manager needs this installation's own ${source.label} credentials.`}
                    {service && service.canEdit && optional && `Optional. To connect an account, Music Manager needs this installation's own ${source.label} credentials.`}
                    {service && !service.canEdit && service.managedBy === 'env' && `${source.label} is only partly set in the .env file. Complete it there and restart.`}
                    {service && !service.canEdit && service.managedBy !== 'env' && `${source.label} is not set up here yet. The first account created on this computer can set it up.`}
                </p>
            )}

            {available && service && (
                <p className="accounts-detail">
                    {service.managedBy === 'env' ? 'Credentials come from the .env file.' : 'Credentials were entered in this app.'}
                    {service.canEdit && !editing && (
                        <>
                            {' '}<button type="button" className="settings-link" onClick={() => setEditing(true)}>Change</button>
                            {' · '}
                            {confirmingRemove
                                ? <button type="button" className="settings-link is-danger" onClick={removeCredentials} disabled={busy}>Really remove? Everyone will have to reconnect.</button>
                                : <button type="button" className="settings-link" onClick={() => setConfirmingRemove(true)}>Remove</button>}
                        </>
                    )}
                </p>
            )}

            {editing && service && (
                <SetupForm
                    service={service}
                    onCancel={() => setEditing(false)}
                    onSaved={(services, message) => { setEditing(false); onServices(services, message); }}
                />
            )}
        </li>
    );
}

export default function AccountsPanel() {
    const { sources, loading, error } = useSources();
    const [services, setServices] = useState(null);

    const load = useCallback(() => {
        apiFetch('/api/settings/services')
            .then(data => setServices(data.services || []))
            .catch(() => setServices([]));
    }, []);
    useEffect(() => { load(); }, [load]);

    const onServices = (next, message) => {
        setServices(next || []);
        if (message) toast(message);
        changed(); // availability changed: banner, Library and Search reload
    };

    if (loading || services === null) return <p className="accounts-detail">Loading…</p>;
    if (error) return <p className="accounts-error" role="alert">Could not load your accounts. Is the server running?</p>;

    const withAccount = sources.filter(s => s.connect && s.connect.required);
    const withoutAccount = sources.filter(s => !(s.connect && s.connect.required) && !s.local);

    return (
        <>
            <ul className="accounts-list">
                {withAccount.map(source => (
                    <AccountRow key={source.name} source={source} service={services.find(s => s.source === source.name) || null} onServices={onServices} />
                ))}
            </ul>
            {withoutAccount.length > 0 && (
                <p className="accounts-detail">No account needed: {withoutAccount.map(s => s.label).join(', ')}.</p>
            )}
        </>
    );
}
