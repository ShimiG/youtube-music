import React from 'react';

//  LIST ROW 
export const TrackRow = ({ track, onPlay, onQueue, imageSize = 50 }) => (
    <div style={{ display: 'flex', gap: '15px', padding: '10px', borderBottom: '1px solid #333', alignItems: 'center' }}>
        <img 
            src={track.thumbnail || track.image} 
            style={{ width: imageSize, height: imageSize, objectFit: 'cover', borderRadius: '4px', cursor: 'pointer' }} 
            onClick={() => onPlay(track)} 
            alt="thumbnail" 
            onError={(e) => { e.target.src = 'https://via.placeholder.com/50?text=🎵'; }}
        />
        <div style={{ flex: 1, cursor: 'pointer', overflow: 'hidden' }} onClick={() => onPlay(track)}>
            <div style={{ fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {track.title}
            </div>
            <div style={{ fontSize: '12px', color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {track.channelTitle || track.artist}
            </div>
        </div>
        {onQueue && (
            <button 
                onClick={() => onQueue(track)}
                style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid #1db954', background: 'transparent', color: '#1db954', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
            >
                + Queue
            </button>
        )}
    </div>
);

// GRID CARD 
export const TrackCard = ({ track, onClick }) => (
    <div 
        onClick={() => onClick(track)}
        style={{ background: '#181818', padding: '15px', borderRadius: '8px', cursor: 'pointer', transition: 'background 0.3s' }}
        onMouseEnter={(e) => e.currentTarget.style.background = '#282828'}
        onMouseLeave={(e) => e.currentTarget.style.background = '#181818'}
    >
        <img 
            src={track.thumbnail || track.image} 
            alt={track.title} 
            style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '4px', marginBottom: '10px' }} 
            onError={(e) => { e.target.src = 'https://via.placeholder.com/150?text=🎵'; }}
        />
        <div style={{ fontWeight: 'bold', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {track.title}
        </div>
        <div style={{ color: '#b3b3b3', fontSize: '12px', marginTop: '5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {track.channelTitle || track.artist}
        </div>
    </div>
);

//  PLAYLIST CARD 
export const PlaylistCard = ({ playlist, type, onClick }) => {
    const imageUrl = playlist.thumbnail || playlist.snippet?.thumbnails?.high?.url || 'https://via.placeholder.com/150?text=📁';
    const title = playlist.title || playlist.name || playlist.snippet?.title;
    const subtitle = type === 'custom' ? `${playlist.itemCount || 0} songs` : 'YouTube Music';

    return (
        <div 
            onClick={() => onClick(playlist, type)} 
            style={{ background: '#282828', padding: '15px', borderRadius: '8px', cursor: 'pointer', transition: 'background 0.3s' }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#3e3e3e'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#282828'}
        >
            <img src={imageUrl} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '4px', marginBottom: '10px' }} alt="playlist cover" />
            <div style={{ fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
            <div style={{ fontSize: '12px', color: '#aaa' }}>{subtitle}</div>
        </div>
    );
};