import React, { useState } from 'react';
import { TrackRow } from './SharedUI';
import SourcePicker from './SourcePicker';
import { useMusic } from '../context/hook';
import { useSources } from '../hooks/useSources';
import { useSearch } from '../hooks/useLibrary';
import { describeSourceError } from '../utils/services';
import { likeTrack } from '../utils/library';

// Search through the generic /api/search/:source route. The source switch is
// the shared SourcePicker, limited to sources that can search. No service is
// named in this file.
export default function SearchView() {
    const { playTrack, addToQueue } = useMusic();
    const { sources, loading: sourcesLoading } = useSources();

    const [chosenSource, setChosenSource] = useState(null);
    const [input, setInput] = useState('');

    // Searching needs the user's own connection only for sources that say so
    // (the server's searchRequiresConnection); others search public content.
    const searchNeedsConnection = (s) => s.searchRequiresConnection !== false && Boolean(s.connect && s.connect.required);
    const canSearchNow = (s) => s.connected || !searchNeedsConnection(s);

    // Default to the first searchable source that can be searched right now,
    // else the first searchable one at all, until the user picks another.
    const searchable = sources.filter(s => s.capabilities && s.capabilities.search);
    const activeSource = chosenSource && searchable.some(s => s.name === chosenSource)
        ? chosenSource
        : ((searchable.find(canSearchNow) || searchable[0] || {}).name || null);
    const service = searchable.find(s => s.name === activeSource) || null;

    const search = useSearch(activeSource);

    const switchSource = (name) => {
        if (name === activeSource) return;
        setChosenSource(name);
        search.clear();
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        if (input.trim()) search.run(input);
    };

    const canLike = Boolean(service && service.capabilities && service.capabilities.like && service.connected);
    const onLike = canLike ? (track) => likeTrack(track.source, track.id) : undefined;

    const error = search.error ? describeSourceError(search.error, service) : null;
    const connect = service && service.connectAction;

    return (
        <div>
            <form onSubmit={handleSubmit} style={{ marginBottom: '20px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                    type="text" placeholder={`Search ${service ? service.label : ''}...`} value={input}
                    onChange={(e) => setInput(e.target.value)}
                    style={{ padding: '10px 20px', width: '300px', borderRadius: '20px', border: 'none', outline: 'none' }}
                />
                {!sourcesLoading && (
                    <SourcePicker
                        sources={searchable}
                        value={activeSource}
                        onChange={switchSource}
                        requiresConnection={searchNeedsConnection}
                        ariaLabel="Search source"
                    />
                )}
            </form>

            {error && (
                <div style={{ padding: '20px', background: '#ff4d4d20', color: '#ff4d4d', borderRadius: '8px', textAlign: 'center', border: '1px solid #ff4d4d', marginBottom: '20px' }}>
                    <p style={{ marginTop: 0 }}>{error.message}</p>
                    {error.canConnect && connect && (
                        <button
                            onClick={() => connect(error.scope ? { scope: error.scope } : undefined)}
                            style={{ padding: '10px 20px', background: service.color, color: 'white', border: 'none', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold' }}
                        >
                            {error.connectLabel || service.connectLabel}
                        </button>
                    )}
                </div>
            )}

            {search.items.length > 0 && (
                <h2 style={{ borderBottom: '1px solid #333', paddingBottom: '10px', marginTop: 0 }}>Search Results</h2>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: '10px' }}>
                {search.items.map(track => (
                    <TrackRow key={`search-${track.source}-${track.id}`} track={track} onPlay={playTrack} onQueue={addToQueue} onLike={onLike} canAddToPlaylist imageSize={60} />
                ))}
            </div>

            {search.loading && <p style={{ color: '#888', textAlign: 'center' }}>Searching…</p>}
            {!search.loading && search.loaded && !search.error && search.items.length === 0 && search.query && (
                <p style={{ color: '#888', textAlign: 'center' }}>No results for “{search.query}”.</p>
            )}

            {search.hasMore && !search.loading && (
                <button
                    onClick={search.loadMore}
                    style={{ margin: '20px auto', display: 'block', padding: '10px 24px', background: '#333', color: 'white', border: 'none', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                    Load more
                </button>
            )}

            {service && service.attribution && search.items.length > 0 && (
                <p style={{ color: '#666', fontSize: '12px', textAlign: 'center', marginTop: '20px' }}>
                    Results and audio provided by <a href={service.attribution.url} target="_blank" rel="noreferrer" style={{ color: service.color }}>{service.attribution.text}</a>.
                </p>
            )}
        </div>
    );
}
