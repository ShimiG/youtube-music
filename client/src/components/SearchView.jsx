import React, { useState } from 'react';
import { TrackRow } from './SharedUI';
import { useMusic } from '../context/hook';
import { SERVICES, SERVICE_LIST } from '../utils/services';

export default function SearchView() {
    const [source, setSource] = useState('youtube');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [nextCursor, setNextCursor] = useState(null);
    const [isSearching, setIsSearching] = useState(false);
    const [serviceError, setServiceError] = useState(null); // { message, canConnect }
    const { playTrack, addToQueue } = useMusic();

    const service = SERVICES[source];

    const runSearch = async (url, append = false) => {
        // Search uses our own session; the server holds the service tokens.
        const token = localStorage.getItem('authToken');
        if (!token) return;

        setIsSearching(true);
        try {
            const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
            const data = await res.json().catch(() => ({}));

            if (res.status === 401) {
                setServiceError({
                    message: data.code === service.notConnectedCode
                        ? `Connect your ${service.label} account to search for music.`
                        : `Your ${service.label} session has expired. Reconnect to keep searching.`,
                    canConnect: true
                });
                setSearchResults([]);
                setNextCursor(null);
                return;
            }
            if (res.status === 429) {
                setServiceError({ message: data.error || `${service.label} rate limit reached. Try again later.`, canConnect: false });
                return;
            }
            if (res.status === 503) {
                setServiceError({ message: data.error || `${service.label} is not configured on this server.`, canConnect: false });
                setSearchResults([]);
                return;
            }
            if (!res.ok) throw new Error(data.error || 'Search failed');

            setServiceError(null);
            const items = Array.isArray(data) ? data : (data.items || []);
            setSearchResults(prev => (append ? [...prev, ...items] : items));
            setNextCursor(Array.isArray(data) ? null : (data.nextCursor || null));
        } catch (err) {
            console.error(err);
            setServiceError({ message: 'Search failed. Please try again.', canConnect: false });
            if (!append) setSearchResults([]);
        } finally {
            setIsSearching(false);
        }
    };

    const handleSearch = (e) => {
        e.preventDefault();
        if (!searchQuery.trim()) return;
        runSearch(service.searchEndpoint(searchQuery.trim()));
    };

    const handleLoadMore = () => {
        if (!nextCursor) return;
        // The cursor is a SoundCloud next_href; the server validates its host.
        runSearch(`${service.searchEndpoint(searchQuery.trim())}&cursor=${encodeURIComponent(nextCursor)}`, true);
    };

    const switchSource = (name) => {
        if (name === source) return;
        setSource(name);
        setSearchResults([]);
        setNextCursor(null);
        setServiceError(null);
    };

    return (
        <div>
            <form onSubmit={handleSearch} style={{ marginBottom: '20px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                    type="text" placeholder={`Search ${service.label}...`} value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{ padding: '10px 20px', width: '300px', borderRadius: '20px', border: 'none', outline: 'none' }}
                />
                <div role="tablist" aria-label="Search source" style={{ display: 'flex', background: '#282828', borderRadius: '20px', padding: '4px' }}>
                    {SERVICE_LIST.map(s => (
                        <button
                            key={s.name}
                            type="button"
                            role="tab"
                            aria-selected={s.name === source}
                            onClick={() => switchSource(s.name)}
                            style={{
                                padding: '6px 14px', borderRadius: '16px', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px',
                                background: s.name === source ? s.color : 'transparent',
                                color: s.name === source ? 'white' : '#b3b3b3'
                            }}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
            </form>

            {serviceError && (
                <div style={{ padding: '20px', background: '#ff4d4d20', color: '#ff4d4d', borderRadius: '8px', textAlign: 'center', border: '1px solid #ff4d4d', marginBottom: '20px' }}>
                    <p style={{ marginTop: 0 }}>{serviceError.message}</p>
                    {serviceError.canConnect && (
                        <button
                            onClick={service.connect}
                            style={{ padding: '10px 20px', background: service.color, color: 'white', border: 'none', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold' }}
                        >
                            {service.connectLabel}
                        </button>
                    )}
                </div>
            )}

            {searchResults.length > 0 && (
                <h2 style={{ borderBottom: '1px solid #333', paddingBottom: '10px', marginTop: 0 }}>Search Results</h2>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: '10px' }}>
                {searchResults.map(track => (
                    <TrackRow key={`search-${track.source || source}-${track.id}`} track={track} onPlay={playTrack} onQueue={addToQueue} imageSize={60} />
                ))}
            </div>

            {isSearching && <p style={{ color: '#888', textAlign: 'center' }}>Searching…</p>}

            {nextCursor && !isSearching && (
                <button
                    onClick={handleLoadMore}
                    style={{ margin: '20px auto', display: 'block', padding: '10px 24px', background: '#333', color: 'white', border: 'none', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                    Load more
                </button>
            )}

            {source === 'soundcloud' && searchResults.length > 0 && (
                <p style={{ color: '#666', fontSize: '12px', textAlign: 'center', marginTop: '20px' }}>
                    Results and audio provided by <a href="https://soundcloud.com" target="_blank" rel="noreferrer" style={{ color: '#ff5500' }}>SoundCloud</a>.
                </p>
            )}
        </div>
    );
}
