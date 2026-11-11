import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { toast } from '../utils/toast';

const box = { background: '#181818', border: '1px solid #333', borderRadius: '10px', padding: '14px 16px', marginBottom: '20px' };
const smallButton = { padding: '6px 12px', borderRadius: '4px', border: '1px solid #555', background: 'transparent', color: '#ddd', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' };

const when = (ms) => (ms ? new Date(ms).toLocaleString() : 'never');

// The folders the Local Files source plays from (issue #24): add one by its
// path, rescan, remove. Scans run on the server in the background; while one
// runs this polls for progress and refreshes the folder list when it ends.
export default function LocalFoldersPanel({ onChange }) {
    const [folders, setFolders] = useState(null); // null = loading
    const [path, setPath] = useState('');
    const [busy, setBusy] = useState(false);
    // The latest onChange, without making the polling effect depend on it.
    const onChangeRef = useRef(onChange);
    useEffect(() => { onChangeRef.current = onChange; });
    const notifyChange = useCallback(() => { if (onChangeRef.current) onChangeRef.current(); }, []);

    const load = useCallback(() => apiFetch('/api/local/folders')
        .then(data => setFolders(data.folders || []))
        .catch(() => setFolders([])), []);

    useEffect(() => { load(); }, [load]);

    // Poll while a scan runs; when it finishes, refresh the playlists too.
    const scanning = Boolean(folders && folders.some(f => f.scanning));
    useEffect(() => {
        if (!scanning) return undefined;
        const timer = setInterval(load, 1500);
        return () => { clearInterval(timer); notifyChange(); };
    }, [scanning, load, notifyChange]);

    const add = async (e) => {
        e.preventDefault();
        if (!path.trim() || busy) return;
        setBusy(true);
        try {
            const folder = await apiFetch('/api/local/folders', { method: 'POST', body: { path: path.trim() } });
            toast(`Scanning ${folder.path} …`);
            setPath('');
            await load();
            notifyChange();
        } catch (err) {
            toast(err.message || 'Could not add the folder.', { kind: 'error' });
        } finally {
            setBusy(false);
        }
    };

    const rescan = async (folder) => {
        try {
            await apiFetch(`/api/local/folders/${encodeURIComponent(folder.id)}/rescan`, { method: 'POST' });
            await load();
        } catch (err) {
            toast(err.message || 'Could not rescan.', { kind: 'error' });
        }
    };

    const remove = async (folder) => {
        if (!window.confirm(`Remove "${folder.path}" from your library? The files themselves are not touched.`)) return;
        try {
            await apiFetch(`/api/local/folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' });
            await load();
            notifyChange();
        } catch (err) {
            toast(err.message || 'Could not remove the folder.', { kind: 'error' });
        }
    };

    return (
        <section style={box} aria-label="Local music folders">
            <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Music folders</div>
            {folders === null && <div style={{ color: '#888', fontSize: '13px' }}>Loading…</div>}
            {folders && folders.length === 0 && (
                <div style={{ color: '#aaa', fontSize: '13px', marginBottom: '10px' }}>
                    Add a folder on this computer that holds your music (MP3, M4A, FLAC, WAV, OGG, Opus…). Its subfolders are included.
                </div>
            )}
            {folders && folders.map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderTop: '1px solid #2a2a2a', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: '200px' }}>
                        <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '13px', wordBreak: 'break-all' }}>{f.path}</div>
                        <div style={{ color: f.error ? '#ff6b6b' : '#888', fontSize: '12px', marginTop: '2px' }}>
                            {f.scanning
                                ? `Scanning… ${f.progress && f.progress.total ? `${f.progress.done} / ${f.progress.total} files` : ''}`
                                : f.error
                                    ? f.error
                                    : `${f.fileCount} track${f.fileCount === 1 ? '' : 's'} · last scanned ${when(f.lastScanAt)}${f.truncated ? ' · stopped at the file limit' : ''}`}
                        </div>
                    </div>
                    <button type="button" style={smallButton} onClick={() => rescan(f)} disabled={f.scanning}>Rescan</button>
                    <button type="button" style={{ ...smallButton, color: '#ff8a8a', borderColor: '#663333' }} onClick={() => remove(f)}>Remove</button>
                </div>
            ))}
            <form onSubmit={add} style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                <input
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="Folder path, e.g. ~/Music"
                    aria-label="Folder path"
                    maxLength={1024}
                    style={{ flex: 1, minWidth: '220px', padding: '8px 10px', borderRadius: '4px', border: '1px solid #555', background: '#121212', color: '#eee', font: 'inherit', fontSize: '13px' }}
                />
                <button type="submit" disabled={busy || !path.trim()} style={{ padding: '8px 16px', borderRadius: '4px', border: 'none', background: '#3b82f6', color: '#fff', fontWeight: 'bold', cursor: 'pointer', opacity: busy || !path.trim() ? 0.5 : 1 }}>
                    {busy ? 'Adding…' : 'Add folder'}
                </button>
            </form>
        </section>
    );
}
