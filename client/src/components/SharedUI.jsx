import React from 'react';

const SOURCE_LABELS = { youtube: 'YouTube', soundcloud: 'SoundCloud' };

// Small inline marker for tracks that come from a service other than YouTube,
// plus the "preview only" / "not streamable" states SoundCloud reports. The
// SoundCloud link satisfies the API attribution requirement (credit the
// source and link to the track's SoundCloud page).
const TrackBadges = ({ track }) => {
    if (!track) return null;
    const badges = [];
    if (track.source === 'soundcloud') {
        badges.push(
            <a
                key="sc"
                href={track.permalinkUrl || 'https://soundcloud.com'}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="Open on SoundCloud"
                style={{ color: '#ff5500', fontSize: '11px', fontWeight: 'bold', textDecoration: 'none', border: '1px solid #ff5500', borderRadius: '4px', padding: '1px 6px' }}
            >
                SoundCloud ↗
            </a>
        );
    }
    if (track.preview) {
        badges.push(<span key="preview" title="Only a preview snippet is available for this track" style={{ color: '#f0c040', fontSize: '11px', border: '1px solid #f0c040', borderRadius: '4px', padding: '1px 6px' }}>Preview</span>);
    }
    if (track.playable === false) {
        badges.push(<span key="blocked" title="This track cannot be streamed here" style={{ color: '#888', fontSize: '11px', border: '1px solid #555', borderRadius: '4px', padding: '1px 6px' }}>Not streamable</span>);
    }
    if (badges.length === 0) return null;
    return <span style={{ display: 'inline-flex', gap: '6px', marginLeft: '8px', verticalAlign: 'middle' }}>{badges}</span>;
};

//  LIST ROW 
export const TrackRow = ({ track, onPlay, onQueue, imageSize = 50 }) => {
    const blocked = track.playable === false;
    const play = () => { if (!blocked) onPlay(track); };
    return (
        <div style={{ display: 'flex', gap: '15px', padding: '10px', borderBottom: '1px solid #333', alignItems: 'center', opacity: blocked ? 0.5 : 1 }}>
            <img 
                src={track.thumbnail || track.image || 'https://via.placeholder.com/50?text=🎵'} 
                style={{ width: imageSize, height: imageSize, objectFit: 'cover', borderRadius: '4px', cursor: blocked ? 'not-allowed' : 'pointer' }} 
                onClick={play} 
                alt="thumbnail" 
                onError={(e) => { e.target.src = 'https://via.placeholder.com/50?text=🎵'; }}
            />
            <div style={{ flex: 1, cursor: blocked ? 'not-allowed' : 'pointer', overflow: 'hidden' }} onClick={play}>
                <div style={{ fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {track.title}
                    <TrackBadges track={track} />
                </div>
                <div style={{ fontSize: '12px', color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {track.channelTitle || track.artist}
                </div>
            </div>
            {onQueue && !blocked && (
                <button 
                    onClick={() => onQueue(track)}
                    style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid #1db954', background: 'transparent', color: '#1db954', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                >
                    + Queue
                </button>
            )}
        </div>
    );
};

// GRID CARD 
export const TrackCard = ({ track, onClick }) => (
    <div 
        onClick={() => onClick(track)}
        style={{ background: '#181818', padding: '15px', borderRadius: '8px', cursor: 'pointer', transition: 'background 0.3s' }}
        onMouseEnter={(e) => e.currentTarget.style.background = '#282828'}
        onMouseLeave={(e) => e.currentTarget.style.background = '#181818'}
    >
        <img 
            src={track.thumbnail || track.image || 'https://via.placeholder.com/150?text=🎵'} 
            alt={track.title} 
            style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '4px', marginBottom: '10px' }} 
            onError={(e) => { e.target.src = 'https://via.placeholder.com/150?text=🎵'; }}
        />
        <div style={{ fontWeight: 'bold', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {track.title}
        </div>
        <div style={{ color: '#b3b3b3', fontSize: '12px', marginTop: '5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {track.channelTitle || track.artist}
            {track.source && track.source !== 'youtube' && (
                <span style={{ color: '#666' }}> · {SOURCE_LABELS[track.source] || track.source}</span>
            )}
        </div>
    </div>
);

//  PLAYLIST CARD 
export const PlaylistCard = ({ playlist, type, onClick }) => {
    const isLiked = playlist.kind === 'liked';
    const imageUrl = playlist.thumbnail || playlist.snippet?.thumbnails?.high?.url || (isLiked ? 'https://via.placeholder.com/150/ff5500/ffffff?text=%E2%99%A5' : 'https://via.placeholder.com/150?text=📁');
    const title = playlist.title || playlist.name || playlist.snippet?.title;

    let subtitle;
    if (type === 'custom') subtitle = `${playlist.itemCount || 0} songs`;
    else if (isLiked) subtitle = `${SOURCE_LABELS[type] || type} · Liked`;
    else if (playlist.itemCount != null && type !== 'youtube') subtitle = `${SOURCE_LABELS[type] || type} · ${playlist.itemCount} tracks`;
    else subtitle = type === 'youtube' ? 'YouTube Music' : (SOURCE_LABELS[type] || type);

    return (
        <div 
            onClick={() => onClick(playlist, type)} 
            style={{ background: '#282828', padding: '15px', borderRadius: '8px', cursor: 'pointer', transition: 'background 0.3s' }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#3e3e3e'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#282828'}
        >
            <img src={imageUrl} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '4px', marginBottom: '10px' }} alt="playlist cover" />
            <div style={{ fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{isLiked ? '♥ ' : ''}{title}</div>
            <div style={{ fontSize: '12px', color: '#aaa' }}>{subtitle}</div>
        </div>
    );
};
