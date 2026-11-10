import { useEffect, useRef, useState } from 'react';
import { addTrackToCustomPlaylist, createCustomPlaylist, listCustomPlaylists } from '../utils/library';
import { toast } from '../utils/toast';

const menuStyle = { position: 'absolute', right: 0, top: 'calc(100% + 6px)', minWidth: '220px', maxHeight: '260px', overflowY: 'auto', background: '#282828', border: '1px solid #444', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 50, padding: '6px' };
const itemStyle = { display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent', border: 'none', borderRadius: '4px', color: '#eee', cursor: 'pointer', font: 'inherit', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

// "+ Playlist" on a track row: a small menu of the user's custom playlists,
// plus a field to create a new one and add the track to it in one step.
export default function AddToPlaylist({ track }) {
    const [open, setOpen] = useState(false);
    const [playlists, setPlaylists] = useState(null); // null = loading
    const [newName, setNewName] = useState('');
    const [busy, setBusy] = useState(false);
    const rootRef = useRef(null);

    // Close on a click outside or Escape.
    useEffect(() => {
        if (!open) return;
        const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const toggle = (e) => {
        e.stopPropagation();
        if (open) return setOpen(false);
        setOpen(true);
        setPlaylists(null);
        listCustomPlaylists()
            .then(setPlaylists)
            .catch(() => { setPlaylists([]); toast('Could not load your playlists.', { kind: 'error' }); });
    };

    const addTo = async (playlist) => {
        if (busy) return;
        setBusy(true);
        try {
            const result = await addTrackToCustomPlaylist(playlist.id, track);
            toast(result && result.alreadyInPlaylist ? `Already in "${playlist.name}".` : `Added to "${playlist.name}".`);
            window.dispatchEvent(new Event('custom-playlists-changed'));
            setOpen(false);
        } catch (err) {
            toast(err.message || 'Could not add the track.', { kind: 'error' });
        } finally {
            setBusy(false);
        }
    };

    const createAndAdd = async (e) => {
        e.preventDefault();
        const name = newName.trim();
        if (!name || busy) return;
        setBusy(true);
        try {
            const created = await createCustomPlaylist(name);
            setNewName('');
            setBusy(false);
            await addTo({ id: created.id, name: created.name });
        } catch (err) {
            setBusy(false);
            toast(err.message || 'Could not create the playlist.', { kind: 'error' });
        }
    };

    return (
        <span ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
            <button
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                title="Add to a playlist"
                style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid #555', background: 'transparent', color: '#ddd', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', whiteSpace: 'nowrap' }}
            >
                + Playlist
            </button>
            {open && (
                <div role="menu" style={menuStyle} onClick={(e) => e.stopPropagation()}>
                    {playlists === null && <div style={{ ...itemStyle, color: '#888', cursor: 'default' }}>Loading…</div>}
                    {playlists && playlists.length === 0 && (
                        <div style={{ ...itemStyle, color: '#888', cursor: 'default' }}>No playlists yet</div>
                    )}
                    {playlists && playlists.map(p => (
                        <button
                            key={p.id}
                            role="menuitem"
                            style={itemStyle}
                            disabled={busy}
                            onClick={() => addTo(p)}
                            onMouseEnter={(e) => { e.currentTarget.style.background = '#3a3a3a'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                            {p.name}
                        </button>
                    ))}
                    <form onSubmit={createAndAdd} style={{ display: 'flex', gap: '6px', padding: '6px 4px 2px', borderTop: '1px solid #444', marginTop: '4px' }}>
                        <input
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            placeholder="New playlist…"
                            maxLength={120}
                            aria-label="New playlist name"
                            style={{ flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: '4px', border: '1px solid #555', background: '#181818', color: '#eee', font: 'inherit', fontSize: '13px' }}
                        />
                        <button type="submit" disabled={busy || !newName.trim()} style={{ padding: '6px 10px', borderRadius: '4px', border: 'none', background: '#1db954', color: '#000', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px', opacity: busy || !newName.trim() ? 0.5 : 1 }}>
                            Add
                        </button>
                    </form>
                </div>
            )}
        </span>
    );
}
