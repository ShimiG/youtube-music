import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { toast } from '../utils/toast';

// Settings -> System. What playback depends on (yt-dlp and ffmpeg) and
// whether this computer has it, from GET /api/health, plus the end of the
// server's log for a problem report (owner only). When nothing plays, this
// is the first place to look.

const MB = 1024 * 1024;
const HELPERS = [
    { key: 'ytDlp', name: 'yt-dlp', role: 'finds the audio for YouTube, SoundCloud and Deezer tracks', mac: 'brew install yt-dlp' },
    { key: 'ffmpeg', name: 'ffmpeg', role: 'converts audio for playback', mac: 'brew install ffmpeg' }
];

export default function SystemPanel() {
    const [health, setHealth] = useState(null);
    const [failed, setFailed] = useState(false);
    const [checking, setChecking] = useState(false);
    const [log, setLog] = useState(null); // null: not loaded; { lines } | { denied: true }

    const fetchHealth = useCallback((fresh) => apiFetch(`/api/health${fresh ? '?fresh=1' : ''}`)
        .then(data => { setHealth(data); setFailed(false); })
        .catch(() => setFailed(true)), []);
    useEffect(() => { fetchHealth(false); }, [fetchHealth]);

    const checkAgain = () => {
        setChecking(true);
        fetchHealth(true).finally(() => setChecking(false));
    };

    const fetchLog = () => apiFetch('/api/system/log?lines=300')
        .then(data => ({ lines: data.lines || [] }))
        .catch(err => (err.status === 403 ? { denied: true } : { lines: [], error: true }));

    const showLog = async () => {
        if (log) return setLog(null);
        return setLog(await fetchLog());
    };

    const copyLog = async () => {
        const result = await fetchLog();
        if (result.denied) return setLog(result);
        try {
            await navigator.clipboard.writeText(result.lines.join('\n'));
            toast(`Copied the last ${result.lines.length} log lines.`);
        } catch {
            setLog(result);
            toast('Could not copy. The log is shown below: select and copy it by hand.', { kind: 'warning' });
        }
        return undefined;
    };

    if (failed) return <p className="accounts-error" role="alert">Could not reach the server.</p>;
    if (!health) return <p className="accounts-detail">Checking…</p>;

    const isMac = health.platform === 'darwin';
    return (
        <>
            <ul className="system-list">
                <li><span>Music Manager</span><span>{health.version}</span></li>
                {HELPERS.map(helper => {
                    const found = health.binaries[helper.key];
                    return (
                        <li key={helper.key}>
                            <span>{helper.name}<small>{helper.role}</small></span>
                            {found.available
                                ? <span className="accounts-status is-ok">{found.version || 'Found'}{typeof found.startMs === 'number' ? ` · starts in ${(found.startMs / 1000).toFixed(1)} s` : ''}</span>
                                : <span className="accounts-status is-warn">Not found</span>}
                        </li>
                    );
                })}
                <li><span>Audio cache</span><span>{Math.round(health.cache.bytes / MB)} MB of {Math.round(health.cache.maxBytes / MB)} MB</span></li>
            </ul>
            {HELPERS.filter(helper => !health.binaries[helper.key].available).map(helper => (
                <p key={helper.key} className="accounts-error" role="alert">
                    {helper.name} was not found, so streamed music cannot play.
                    {isMac ? <> Install it (in Terminal: <code>{helper.mac}</code>), then restart Music Manager.</> : ' Install it, then restart Music Manager.'}
                </p>
            ))}
            <div className="accounts-actions">
                <button type="button" className="settings-button" onClick={checkAgain} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
                {health.log && health.log.enabled && (
                    <>
                        <button type="button" className="settings-button" onClick={copyLog}>Copy recent log</button>
                        <button type="button" className="settings-button" onClick={showLog}>{log ? 'Hide log' : 'Show log'}</button>
                    </>
                )}
            </div>
            {health.log && health.log.enabled && (
                <p className="accounts-note">
                    The server keeps its log in <code>{health.log.file}</code> in its data folder, so it is still there after the app is closed.
                    Links and tokens are cut from it.
                </p>
            )}
            {log && log.denied && <p className="accounts-detail">Only the first account created on this computer can read the log.</p>}
            {log && log.lines && (
                <textarea className="system-log" readOnly aria-label="Recent server log" value={log.lines.length ? log.lines.join('\n') : 'The log is empty.'} />
            )}
        </>
    );
}
