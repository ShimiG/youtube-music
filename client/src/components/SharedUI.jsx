import React, { useState } from 'react';
import { serviceOf } from '../utils/services';
import AddToPlaylist from './AddToPlaylist';
import { PLACEHOLDER_ART, listArtOf } from '../utils/artwork';

// Rows and cards render the normalised Track / Playlist shapes from the
// library API. Where older rows (history, custom playlists written before
// Stage 0) still carry legacy field names, the small helpers below accept both.
const artistOf = (t) => t.artist || t.channelTitle || 'Unknown Artist';

// Drawn locally (utils/artwork.js); no request to a placeholder service.
const PLACEHOLDER_50 = PLACEHOLDER_ART;
const PLACEHOLDER_150 = PLACEHOLDER_ART;

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
export const TrackRow = ({ track, onPlay, onQueue, onLike, onUnlike, canAddToPlaylist = false, imageSize = 50 }) => {
    const blocked = track.playable === false;
    const play = () => { if (!blocked) onPlay(track); };
    return (
        <div style={{ display: 'flex', gap: '15px', padding: '10px', borderBottom: '1px solid #333', alignItems: 'center', opacity: blocked ? 0.5 : 1 }}>
            <img
                src={listArtOf(track) || PLACEHOLDER_50}
                loading="lazy"
                decoding="async"
                width={imageSize}
                height={imageSize}
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
            {canAddToPlaylist && !blocked && <AddToPlaylist track={track} />}
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

// "Add to queue" on a card's picture. The card gives no other sign that it
// worked, so the button shows a tick for a moment.
const QueueAction = ({ track, onQueue }) => {
    const [done, setDone] = useState(false);
    const add = (e) => {
        e.stopPropagation(); // not a click on the card, which plays the track
        onQueue(track);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
    };
    return (
        <button type="button" className="card-action" onClick={add} title="Add to queue" aria-label="Add to queue">
            {done ? (
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 10.5l4 4 8-9" />
                </svg>
            ) : (
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <path d="M3 5h13M3 9h13M3 13h6" />
                    <path d="M12.5 11.5l5 3-5 3z" fill="currentColor" stroke="none" />
                </svg>
            )}
        </button>
    );
};

// GRID CARD
// `canAddToPlaylist` and `onQueue` put two small buttons on the picture's top
// right corner (playlist above queue), shown while the pointer is on the card.
export const TrackCard = ({ track, onClick, onQueue, canAddToPlaylist = false }) => {
    const service = serviceOf(track.source);
    const hasActions = canAddToPlaylist || Boolean(onQueue);
    return (
        <div
            className="track-card"
            onClick={() => onClick(track)}
            style={{ background: '#181818', padding: '15px', borderRadius: '8px', cursor: 'pointer', transition: 'background 0.3s' }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#282828'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#181818'}
        >
            <div className="track-card-art">
                <img
                    src={listArtOf(track) || PLACEHOLDER_150}
                    loading="lazy"
                    decoding="async"
                    alt={track.title}
                    style={{ display: 'block', width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '4px' }}
                    onError={(e) => { e.target.src = PLACEHOLDER_150; }}
                />
                {hasActions && (
                    <div className="track-card-actions">
                        {canAddToPlaylist && <AddToPlaylist track={track} compact />}
                        {onQueue && <QueueAction track={track} onQueue={onQueue} />}
                    </div>
                )}
            </div>
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
                <img src={listArtOf(playlist)} loading="lazy" decoding="async" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '4px', marginBottom: '10px' }} alt="playlist cover" />
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
