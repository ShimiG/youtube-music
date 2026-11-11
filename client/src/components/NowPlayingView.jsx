import { useEffect, useRef, useState } from 'react';
import { useMusic } from '../context/hook';
import { serviceOf, DEFAULT_SOURCE } from '../utils/services';
import { artOf } from '../utils/artwork';
import Artwork from './Artwork';
import Queue from './Queue';
import Lyrics from './Lyrics';

const TABS = [{ id: 'queue', label: 'Up Next' }, { id: 'lyrics', label: 'Lyrics' }];

// The expanded "Now Playing" view (issue #29): a drawer that slides up from
// behind the player bar and fills the rest of the window with the cover art
// and, in tabs beside it, the queue and the lyrics (issue #30). The player bar
// itself never moves, so play / pause, seek and volume stay where they are
// (its height is published as --player-height by PlayerFooter). Closed, the
// drawer is hidden from keyboard and screen readers as well as from sight.
export default function NowPlayingView({ open, onClose }) {
    const { currentTrack, queue, queueIndex } = useMusic();
    const closeRef = useRef(null);
    const [tab, setTab] = useState('queue');

    // Escape closes; focus moves into the drawer when it opens and back to
    // the opener when it closes.
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        // Remember what had focus (the button that opened the drawer) and
        // give it back on close, so keyboard users are not left stranded.
        const opener = document.activeElement;
        if (closeRef.current) closeRef.current.focus();
        return () => {
            document.removeEventListener('keydown', onKey);
            if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
        };
    }, [open, onClose]);

    // Left / Right move between the tabs, as in any tab list.
    const onTabKey = (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const at = TABS.findIndex(t => t.id === tab);
        const next = TABS[(at + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
        e.preventDefault();
        setTab(next.id);
        const button = document.getElementById(`now-playing-tab-${next.id}`);
        if (button) button.focus();
    };

    const track = currentTrack;
    const service = track ? serviceOf(track.source || DEFAULT_SOURCE) : null;
    const artist = track ? (track.artist || track.channelTitle || 'Unknown Artist') : '';
    const position = queue && queue.length > 0 ? `${queueIndex + 1} of ${queue.length}` : null;

    return (
        <section
            className={`now-playing ${open ? 'is-open' : ''}`}
            role="dialog"
            aria-label="Now playing"
            aria-hidden={!open}
            inert={!open}
        >
            <button ref={closeRef} type="button" className="now-playing-close" onClick={onClose} aria-label="Close Now Playing" title="Close (Esc)">
                <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M7.4 8.6 12 13.200l4.600-4.600L18 10l-6 6-6-6z" /></svg>
            </button>

            {track && (
                <div className="now-playing-body">
                    <div className="now-playing-track">
                        <Artwork src={artOf(track)} alt="" className="now-playing-art" />
                        <h2 className="now-playing-title">{track.title}</h2>
                        <p className="now-playing-artist">{artist}{track.album ? ` · ${track.album}` : ''}</p>
                        <p className="now-playing-meta">
                            <span className="now-playing-source" style={{ color: service.color, borderColor: service.color }}>
                                <span aria-hidden="true">{service.icon}</span> {service.label}
                            </span>
                            {service.attribution && (
                                <a href={track.permalinkUrl || service.attribution.url} target="_blank" rel="noreferrer">
                                    Open on {service.attribution.text} ↗
                                </a>
                            )}
                            {position && <span>Track {position}</span>}
                        </p>
                    </div>
                    <div className="now-playing-side">
                        <div className="now-playing-tabs" role="tablist" aria-label="Queue and lyrics" onKeyDown={onTabKey}>
                            {TABS.map(t => (
                                <button
                                    key={t.id}
                                    type="button"
                                    role="tab"
                                    id={`now-playing-tab-${t.id}`}
                                    aria-selected={tab === t.id}
                                    aria-controls={`now-playing-panel-${t.id}`}
                                    tabIndex={tab === t.id ? 0 : -1}
                                    className={`now-playing-tab ${tab === t.id ? 'is-selected' : ''}`}
                                    onClick={() => setTab(t.id)}
                                >
                                    {t.label}
                                </button>
                            ))}
                        </div>
                        <div role="tabpanel" id="now-playing-panel-queue" aria-labelledby="now-playing-tab-queue" hidden={tab !== 'queue'}>
                            <Queue theme="dark" heading={false} />
                        </div>
                        <div role="tabpanel" id="now-playing-panel-lyrics" aria-labelledby="now-playing-tab-lyrics" hidden={tab !== 'lyrics'}>
                            <Lyrics active={open && tab === 'lyrics'} />
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}
