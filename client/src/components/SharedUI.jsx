import React, { useState } from 'react';
import { serviceOf } from '../utils/services';

// Rows and cards render the normalised Track / Playlist shapes from the
// library API. Where older rows (history, custom playlists written before
// Stage 0) still carry legacy field names, the small helpers below accept both.
const artistOf = (t) => t.artist || t.channelTitle || 'Unknown Artist';
const artOf = (t) => t.thumbnail || t.image || null;

const PLACEHOLDER_50 = 'https://via.placeholder.com/50?text=🎵';
const PLACEHOLDER_150 = 'https://via.placeholder.com/150?text=🎵';

// Inline markers a row can carry: an attribution link for sources whose terms
// require crediting them (declared in the registry), plus the preview /
// not-streamable states some sources report.
const TrackBadges = ({ track }) => {
    if (!track) return null;
    const service = serviceOf(track.source);
    const badges = [];
    // Sources whose terms require crediting them get a link back.
    if (service.attribution) {
        badges.push(
            <a
                key="attr"
                href={track.permalinkUrl || service.attribution.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={`Open on ${service.attribution.text}`}
                style={{ color: service.color, fontSize: '11px', fontWeight: 'bold', textDecoration: 'none', border: `1px solid ${service.color}`, borderRadius: '4px', padding: '1px 6px' }}
            >
                {service.attribution.text} ↗
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

// Heart button: `onLike` likes, `onUnlike` unlikes (used inside the liked
// playlist). Shows a brief confirmation instead of tracking liked state, which
// the API does not return per track.
const LikeButton = ({ track, onLike, onUnlike }) => {
    const [state, setState] = useState('idle'); // idle | busy | done | error
    const action = onUnlike || onLike;
    if (!action) return null;
    const isUnlike = Boolean(onUnlike);

    const handle = async (e) => {
        e.stopPropagation();
        if (state === 'busy') return;
        setState('busy');
        try {
            await action(track);
            setState('done');
            setTimeout(() => setState('idle'), 1500);
        } catch {
            setState('error');
            setTimeout(() => setState('idle'), 2000);
        }
    };

    const label = isUnlike ? 'Remove from liked' : 'Like';
    return (
        <button
            onClick={handle}
            title={label}
            aria-label={label}
            disabled={state === 'busy'}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '18px', color: state === 'error' ? '#ff4d4d' : (isUnlike || state === 'done' ? '#1db954' : '#b3b3b3') }}
        >
            {state === 'done' ? '✓' : (isUnlike ? '♥' : '♡')}
        </button>
    );
};

//  LIST ROW
export const TrackRow = ({ track, onPlay, onQueue, onLike, onUnlike, imageSize = 50 }) => {
    const blocked = track.playable === false;
    const play = () => { if (!blocked) onPlay(track); };
    return (
        <div style={{ display: 'flex', gap: '15px', padding: '10px', borderBottom: '1px solid #333', alignItems: 'center', opacity: blocked ? 0.5 : 1 }}>
            <img
                src={artOf(track) || PLACEHOLDER_50}
                style={{ width: imageSize, height: imageSize, objectFit: 'cover', borderRadius: '4px', cursor: blocked ? 'not-allowed' : 'pointer' }}
                onClick={play}
                alt="thumbnail"
                onError={(e) => { e.target.src = PLACEHOLDER_50; }}
            />
            <div style={{ flex: 1, cursor: blocked ? 'not-allowed' : 'pointer', overflow: 'hidden' }} onClick={play}>
                <div style={{ fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {track.title}
                    <TrackBadges track={track} />
                </div>
                <div style={{ fontSize: '12px', color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {artistOf(track)}
                </div>
            </div>
            {(onLike || onUnlike) && !blocked && <LikeButton track={track} onLike={onLike} onUnlike={onUnlike} />}
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
export const TrackCard = ({ track, onClick }) => {
    const service = serviceOf(track.source);
    return (
        <div
            onClick={() => onClick(track)}
            style={{ background: '#181818', padding: '15px', borderRadius: '8px', cursor: 'pointer', transition: 'background 0.3s' }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#282828'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#181818'}
        >
            <img
                src={artOf(track) || PLACEHOLDER_150}
                alt={track.title}
                style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '4px', marginBottom: '10px' }}
                onError={(e) => { e.target.src = PLACEHOLDER_150; }}
            />
            <div style={{ fontWeight: 'bold', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {track.title}
            </div>
            <div style={{ color: '#b3b3b3', fontSize: '12px', marginTop: '5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {artistOf(track)}
                {service.attribution && (
                    <span style={{ color: '#666' }}> · {service.label}</span>
                )}
            </div>
        </div>
    );
};

//  PLAYLIST CARD — renders the normalised Playlist shape only.
//  { source, id, kind: 'liked' | 'playlist' | 'custom', name, thumbnail, itemCount, readOnly }
export const PlaylistCard = ({ playlist, onClick }) => {
    const service = serviceOf(playlist.source);
    const isLiked = playlist.kind === 'liked';
    const count = playlist.itemCount != null ? `${playlist.itemCount} ${playlist.itemCount === 1 ? 'song' : 'songs'}` : null;

    let subtitle;
    if (isLiked) subtitle = count ? `${service.label} · ${count}` : service.label;
    else if (playlist.kind === 'custom') subtitle = count || '0 songs';
    else subtitle = count ? `${service.label} · ${count}` : service.label;

    return (
        <div
            onClick={() => onClick(playlist)}
            style={{ background: isLiked ? '#2a1f2f' : '#282828', padding: '15px', borderRadius: '8px', cursor: 'pointer', transition: 'background 0.3s', border: isLiked ? `1px solid ${service.color}55` : '1px solid transparent' }}
            onMouseEnter={(e) => e.currentTarget.style.background = isLiked ? '#3a2a40' : '#3e3e3e'}
            onMouseLeave={(e) => e.currentTarget.style.background = isLiked ? '#2a1f2f' : '#282828'}
        >
            {playlist.thumbnail ? (
                <img src={playlist.thumbnail} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '4px', marginBottom: '10px' }} alt="playlist cover" />
            ) : (
                <div aria-hidden="true" style={{ width: '100%', aspectRatio: '1', borderRadius: '4px', marginBottom: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '56px', background: isLiked ? `linear-gradient(135deg, ${service.color}66, #111)` : '#1a1a1a', color: isLiked ? 'white' : '#555' }}>
                    {isLiked ? '♥' : service.icon}
                </div>
            )}
            <div style={{ fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {isLiked && <span style={{ color: service.color, marginRight: '6px' }}>♥</span>}{playlist.name}
            </div>
            <div style={{ fontSize: '12px', color: '#aaa' }}>{subtitle}</div>
        </div>
    );
};
