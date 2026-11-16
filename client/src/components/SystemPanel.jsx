import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { toast } from '../utils/toast';

// Settings -> System. What playback depends on (yt-dlp and ffmpeg) and
// whether this computer has it, from GET /api/health; what happened to the
// last plays (how long each took, or why it failed); and the end of the
// server's log for a problem report (owner only). When nothing plays, this
// is the first place to look.

const MB = 1024 * 1024;
const HELPERS = [
    { key: 'ytDlp', name: 'yt-dlp', role: 'finds the audio for YouTube, SoundCloud and Deezer tracks', mac: 'brew install yt-dlp' },
    { key: 'ffmpeg', name: 'ffmpeg', role: 'converts audio for playback', mac: 'brew install ffmpeg' }
];

const seconds = (ms) => (ms < 995 ? `${Math.max(0.01, ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`);
const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const LOOKUPS = { 'yt-dlp': 'yt-dlp was run', shared: 'a yt-dlp run already under way', memory: 'remembered, no yt-dlp run', api: "the service's own API" };

// What one play was made of, in a line.
function describePlay(play) {
    // The server did its part and the player in the app still gave up.
    if (play.player && play.status !== 'failed') {
        const sent = play.status === 'playing' ? `The server sent the audio after ${seconds(play.ms || 0)}` : 'The server was still fetching the audio';
        return { text: `${sent}; the player reported: ${play.player}.`, kind: 'error', label: 'Not played' };
    }
    if (play.status === 'failed' && play.player) return { text: `${(play.reason || 'It could not be played').replace(/[.\s]+$/, '')}. The player reported: ${play.player}.`, kind: 'error', label: `Failed after ${seconds(play.ms || 0)}` };
    if (play.status === 'failed') return { text: play.reason || 'It could not be played.', kind: 'error', label: `Failed after ${seconds(play.ms || 0)}` };
    if (play.status === 'left') return { text: 'Skipped before any sound.', kind: 'off', label: `Left after ${seconds(play.ms || 0)}` };
    if (play.status === 'waiting') return { text: 'Still being fetched.', kind: 'off', label: 'Waiting' };
    const label = `Sound after ${seconds(play.ms || 0)}`;
    if (play.how === 'cache') return { text: 'From the audio cache.', kind: 'ok', label };
    if (play.how === 'file') return { text: 'A file played as it is.', kind: 'ok', label };
    const lookup = play.addressFrom
        ? `Finding the audio took ${seconds(play.addressMs || 0)} (${LOOKUPS[play.addressFrom] || play.addressFrom}); the rest is starting the conversion.`
        : (play.how === 'joined' ? 'Joined a conversion already under way (the track was being prepared).' : 'Converted from the source.');
    return { text: `${lookup}${play.seek ? ` Started at ${play.seek} s.` : ''}`, kind: 'ok', label };
}

// The last plays: how long each took to make sound and what the wait was made
// of, or why it failed. One screenshot of this says what a log excerpt would.
function RecentPlays({ plays, onRefresh }) {
    return (
        <div className="system-plays">
            <div className="accounts-actions" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <strong>Recent plays</strong>
                <button type="button" className="settings-link" onClick={onRefresh}>Refresh</button>
            </div>
            {plays.length === 0
                ? <p className="accounts-detail">Nothing has been played since the app was started.</p>
                : (
                    <ul className="system-list">
                        {plays.map((play) => {
                            const what = describePlay(play);
                            return (
                                <li key={play.n}>
                                    <span>
                                        {clock(play.at)} · {play.source} {play.id}
                                        <small style={what.kind === 'error' ? { color: '#ff8a8a' } : undefined}>{what.text}</small>
                                    </span>
                                    <span className={`accounts-status is-${what.kind === 'error' ? 'warn' : what.kind}`}>{what.label}</span>
                                </li>
                            );
                        })}
                    </ul>
                )}
        </div>
    );
}

export default function SystemPanel() {
    const [plays, setPlays] = useState([]);
    const fetchPlays = useCallback(() => apiFetch('/api/system/plays?limit=12')
        .then(data => setPlays(Array.isArray(data.plays) ? data.plays : []))
        .catch(() => {}), []);
    useEffect(() => { fetchPlays(); }, [fetchPlays]);
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
        fetchPlays();
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
            <RecentPlays plays={plays} onRefresh={fetchPlays} />
            {log && log.denied && <p className="accounts-detail">Only the first person who signed in on this computer can read the log.</p>}
            {log && log.lines && (
                <textarea className="system-log" readOnly aria-label="Recent server log" value={log.lines.length ? log.lines.join('\n') : 'The log is empty.'} />
            )}
        </>
    );
}
