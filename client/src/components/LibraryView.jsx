import React, { useEffect, useState } from 'react';
import { PlaylistCard, TrackRow } from './SharedUI';
import SourcePicker from './SourcePicker';
import VirtualList from './VirtualList';
import { useMusic } from '../context/hook';
import { useSources } from '../hooks/useSources';
import { useLibrary, usePlaylistTracks } from '../hooks/useLibrary';
import { describeSourceError } from '../utils/services';
import { likeTrack, unlikeTrack, createCustomPlaylist } from '../utils/library';
import { toast } from '../utils/toast';

const panelStyle = { gridColumn: '1 / -1', padding: '20px', background: '#ff4d4d20', color: '#ff4d4d', borderRadius: '8px', textAlign: 'center', border: '1px solid #ff4d4d' };
const pillButton = (bg) => ({ marginTop: '10px', padding: '10px 20px', background: bg, color: 'white', border: 'none', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold' });

// One error panel for every source: "Connect <label>" / "Reconnect <label>"
// for whichever source is active, a retry for anything else.
function renderError(err, service, retry) {
    if (!err) return null;
    const info = describeSourceError(err, service);
    const connect = service && service.connectAction;
    return (
        <div style={panelStyle}>
            <h3 style={{ marginTop: 0 }}>{info.canConnect ? 'Connection needed' : 'Something went wrong'}</h3>
            <p>{info.message}</p>
            {info.canConnect && connect && (
                <button onClick={() => connect(info.scope ? { scope: info.scope } : undefined)} style={pillButton(service.color)}>
                    {info.connectLabel || service.connectLabel}
                </button>
            )}
            {!info.canConnect && retry && (
                <button onClick={retry} style={pillButton('#333')}>Try again</button>
            )}
        </div>
    );
}

function renderLoadMore(list) {
    if (!list.hasMore) return null;
    return (
        <button
            onClick={list.loadMore}
            disabled={list.loading}
            style={{ margin: '20px auto', display: 'block', padding: '10px 24px', background: '#333', color: 'white', border: 'none', borderRadius: '20px', cursor: list.loading ? 'wait' : 'pointer', fontWeight: 'bold' }}
        >
            {list.loading ? 'Loading…' : 'Load more'}
        </button>
    );
}

function renderAttribution(service, what) {
    if (!service || !service.attribution) return null;
    return (
        <p style={{ color: '#666', fontSize: '12px', textAlign: 'center', marginTop: '20px' }}>
            {what} provided by <a href={service.attribution.url} target="_blank" rel="noreferrer" style={{ color: service.color }}>{service.attribution.text}</a>.
        </p>
    );
}

// One fetch path for every source. Which sources exist, what they can do and
// whether they are connected come from useSources(); playlists and tracks come
// from the generic library API. No service is named in this file.
export default function LibraryView() {
    const { playTrack, addToQueue } = useMusic();
    const { sources, loading: sourcesLoading, reload: reloadSources } = useSources();

    const [chosenSource, setChosenSource] = useState(null);
    const [selectedPlaylist, setSelectedPlaylist] = useState(null);

    // The first listed source (the local one, per the registry order) until the
    // user picks another.
    const activeSource = chosenSource && sources.some(s => s.name === chosenSource) ? chosenSource : (sources[0] ? sources[0].name : null);
    const service = sources.find(s => s.name === activeSource) || null;

    const playlists = useLibrary(activeSource);
    const tracks = usePlaylistTracks(selectedPlaylist && selectedPlaylist.source, selectedPlaylist && selectedPlaylist.id);

    // "Create Playlist" card: turns into a small form in place.
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [saving, setSaving] = useState(false);

    const submitNewPlaylist = async (e) => {
        e.preventDefault();
        const name = newName.trim();
        if (!name || saving) return;
        setSaving(true);
        try {
            await createCustomPlaylist(name);
            toast(`Playlist "${name}" created.`);
            setNewName('');
            setCreating(false);
            playlists.reload();
        } catch (err) {
            toast(err.message || 'Could not create the playlist.', { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    // A track added from a row's "+ Playlist" menu changes the song counts
    // (and may have created a playlist): refresh the local source's list.
    const reloadPlaylists = playlists.reload;
    const isLocal = Boolean(service && service.local);
    useEffect(() => {
        if (!isLocal) return;
        const onChange = () => reloadPlaylists();
        window.addEventListener('custom-playlists-changed', onChange);
        return () => window.removeEventListener('custom-playlists-changed', onChange);
    }, [isLocal, reloadPlaylists]);

    const selectSource = (name) => {
        if (name === activeSource) return;
        setSelectedPlaylist(null);
        setChosenSource(name);
    };

    const handlePlayAll = () => {
        const playable = tracks.items.filter(t => t.playable !== false);
        if (playable.length === 0) return;
        playTrack(playable[0]);
        playable.slice(1).forEach(track => addToQueue(track));
    };

    const canLike = Boolean(service && service.capabilities && service.capabilities.like);
    const inLiked = Boolean(selectedPlaylist && selectedPlaylist.kind === 'liked');
    const onLike = canLike && !inLiked ? (track) => likeTrack(track.source, track.id) : undefined;
    const onUnlike = canLike && inLiked
        ? async (track) => {
            await unlikeTrack(track.source, track.id);
            tracks.removeItem(t => t.id === track.id);
        }
        : undefined;

    if (!selectedPlaylist) {
        return (
            <div className="library-view" style={{ padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', gap: '16px', flexWrap: 'wrap' }}>
                    <h1 style={{ marginTop: 0, marginBottom: 0 }}>Your Library</h1>
                    {sourcesLoading
                        ? <span style={{ color: '#888' }}>Loading sources…</span>
                        : <SourcePicker sources={sources} value={activeSource} onChange={selectSource} ariaLabel="Library source" />}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '20px' }}>
                    {service && service.local && !creating && (
                        <button
                            type="button"
                            onClick={() => setCreating(true)}
                            style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', background: '#1db95420', borderRadius: '8px', cursor: 'pointer', border: '2px dashed #1db954', minHeight: '200px', font: 'inherit' }}
                        >
                            <span style={{ fontSize: '40px', color: '#1db954' }}>+</span>
                            <span style={{ color: '#1db954', fontWeight: 'bold' }}>Create Playlist</span>
                        </button>
                    )}
                    {service && service.local && creating && (
                        <form
                            onSubmit={submitNewPlaylist}
                            style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '10px', background: '#1db95420', borderRadius: '8px', border: '2px dashed #1db954', minHeight: '200px', padding: '16px', boxSizing: 'border-box' }}
                        >
                            <label htmlFor="new-playlist-name" style={{ color: '#1db954', fontWeight: 'bold' }}>New playlist</label>
                            <input
                                id="new-playlist-name"
                                autoFocus
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Escape') { setCreating(false); setNewName(''); } }}
                                placeholder="Playlist name"
                                maxLength={120}
                                style={{ padding: '8px 10px', borderRadius: '4px', border: '1px solid #555', background: '#181818', color: '#eee', font: 'inherit', minWidth: 0 }}
                            />
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <button type="submit" disabled={saving || !newName.trim()} style={{ flex: 1, padding: '8px', borderRadius: '4px', border: 'none', background: '#1db954', color: '#000', fontWeight: 'bold', cursor: 'pointer', opacity: saving || !newName.trim() ? 0.5 : 1 }}>
                                    {saving ? 'Creating…' : 'Create'}
                                </button>
                                <button type="button" onClick={() => { setCreating(false); setNewName(''); }} style={{ padding: '8px 12px', borderRadius: '4px', border: '1px solid #555', background: 'transparent', color: '#ddd', cursor: 'pointer' }}>
                                    Cancel
                                </button>
                            </div>
                        </form>
                    )}

                    {renderError(playlists.error, service, () => { reloadSources(); playlists.reload(); })}

                    {!playlists.error && playlists.items.map(playlist => (
                        <PlaylistCard key={`${playlist.source}-${playlist.id}`} playlist={playlist} onClick={setSelectedPlaylist} />
                    ))}

                    {!playlists.error && playlists.loaded && !playlists.loading && playlists.items.length === 0 && (
                        <div style={{ gridColumn: '1 / -1', color: '#888', textAlign: 'center', padding: '20px' }}>No playlists here yet.</div>
                    )}
                </div>

                {playlists.loading && playlists.items.length === 0 && <p style={{ color: '#888', textAlign: 'center' }}>Loading…</p>}
                {renderLoadMore(playlists)}
                {renderAttribution(service, 'Playlists and audio')}
            </div>
        );
    }

    return (
        <div className="library-view" style={{ padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid #333', paddingBottom: '15px', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap' }}>
                    <button onClick={() => setSelectedPlaylist(null)} style={{ background: '#333', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold' }}>
                        ← Back
                    </button>
                    <h2 style={{ margin: 0 }}>
                        {inLiked && service && <span style={{ color: service.color, marginRight: '8px' }}>♥</span>}
                        {selectedPlaylist.name}
                    </h2>
                    {selectedPlaylist.permalinkUrl && service && service.attribution && (
                        <a href={selectedPlaylist.permalinkUrl} target="_blank" rel="noreferrer" style={{ color: service.color, fontSize: '12px', fontWeight: 'bold', textDecoration: 'none' }}>
                            Open on {service.attribution.text} ↗
                        </a>
                    )}
                </div>
                <button
                    onClick={handlePlayAll} disabled={tracks.items.length === 0}
                    style={{ background: '#1db954', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '20px', cursor: tracks.items.length === 0 ? 'not-allowed' : 'pointer', fontWeight: 'bold', opacity: tracks.items.length === 0 ? 0.5 : 1 }}
                >
                    ▶ Play All
                </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
                {renderError(tracks.error, service, tracks.reload)}
                {!tracks.error && (
                    <VirtualList
                        items={tracks.items}
                        rowHeight={71}
                        renderRow={(track, index) => (
                            <TrackRow key={`pl-track-${track.source}-${track.id}-${index}`} track={track} onPlay={playTrack} onQueue={addToQueue} onLike={onLike} onUnlike={onUnlike} canAddToPlaylist={selectedPlaylist.source !== 'custom'} />
                        )}
                    />
                )}
                {!tracks.error && tracks.loading && tracks.items.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '20px', color: '#888' }}>Loading tracks...</div>
                )}
                {!tracks.error && tracks.loaded && !tracks.loading && tracks.items.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '20px', color: '#888' }}>This playlist is empty.</div>
                )}
            </div>
            {renderLoadMore(tracks)}
            {renderAttribution(service, 'Playlists and audio')}
        </div>
    );
}
