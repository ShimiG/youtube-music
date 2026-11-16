import { useEffect, useRef } from 'react';
import { useMusic } from '../context/hook';
import useLyrics from '../hooks/useLyrics';
import useOnlineLyrics from '../hooks/useOnlineLyrics';
import { usePlaybackTime } from '../utils/playbackClock';
import { setOnlineLyrics } from '../utils/settings';

// The Lyrics tab of the Now Playing view (issue #30). Timed lyrics follow the
// music: the current line is highlighted and kept in the middle, and choosing
// a line jumps to it. Lyrics without times are shown as text. Lyrics kept
// with the user's own files are always shown; everything else is looked up
// online, which is asked about once (see utils/settings.js).

// A line lights up slightly before its time, as the eye needs a moment.
const LEAD_SEC = 0.25;
// After the reader scrolls by hand, the view stays put this long.
const HANDS_OFF_MS = 4000;
// Timed lyrics that run well past the end of what is playing belong to
// another cut (a 30-second preview, say): their times cannot be trusted.
const END_SLACK_SEC = 5;

/** Index of the last line that has started by `time`, or -1 before the first. */
function lineAt(lines, time) {
    let low = 0;
    let high = lines.length - 1;
    let found = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lines[mid].t <= time) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return found;
}

function TimedLyrics({ lines, onSeek }) {
    const boxRef = useRef(null);
    const touchedAt = useRef(0);
    // Renders when the line changes, not on every tick of the clock.
    const current = usePlaybackTime((time) => lineAt(lines, time + LEAD_SEC));

    useEffect(() => {
        const box = boxRef.current;
        if (!box || current < 0) return;
        if (Date.now() - touchedAt.current < HANDS_OFF_MS) return;
        const line = box.querySelector(`[data-line="${current}"]`);
        if (!line) return;
        const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        box.scrollTo({
            top: line.offsetTop - (box.clientHeight - line.offsetHeight) / 2,
            behavior: calm ? 'auto' : 'smooth'
        });
    }, [current]);

    const touched = () => { touchedAt.current = Date.now(); };

    // One tab stop for the whole list; the arrow keys move between lines.
    const onKeyDown = (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const from = e.target.closest('[data-line]');
        if (!from) return;
        const to = e.key === 'ArrowDown' ? from.nextElementSibling : from.previousElementSibling;
        if (to) {
            e.preventDefault();
            touched();
            to.focus();
        }
    };

    const tabStop = current < 0 ? 0 : current;
    return (
        <div ref={boxRef} className="lyrics-scroll" onWheel={touched} onTouchMove={touched} onKeyDown={onKeyDown}>
            {lines.map((line, index) => (
                <button
                    key={index}
                    type="button"
                    data-line={index}
                    className={`lyrics-line ${index === current ? 'is-current' : ''} ${index < current ? 'is-past' : ''}`}
                    aria-current={index === current ? 'true' : undefined}
                    tabIndex={index === tabStop ? 0 : -1}
                    onClick={() => onSeek(line.t)}
                >
                    {line.text || <span aria-label="Instrumental break">♪</span>}
                </button>
            ))}
        </div>
    );
}

function Message({ title, children }) {
    return (
        <div className="lyrics-message">
            <p className="lyrics-message-title">{title}</p>
            {children}
        </div>
    );
}

function Credit({ result }) {
    if (result.origin === 'lrclib' && result.credit) {
        return (
            <p className="lyrics-credit">
                Lyrics from <a href={result.credit.url} target="_blank" rel="noreferrer">{result.credit.name} ↗</a>
            </p>
        );
    }
    if (result.origin === 'file') return <p className="lyrics-credit">From the .lrc file next to this track.</p>;
    if (result.origin === 'tags') return <p className="lyrics-credit">From this file's tags.</p>;
    return null;
}

export default function Lyrics({ active }) {
    const { currentTrack, duration, seek } = useMusic();
    const choice = useOnlineLyrics();
    const { loading, result, retry } = useLyrics(currentTrack, { enabled: active, online: choice === 'on' });

    if (!active || !currentTrack) return null;

    let body;
    if (loading) {
        body = <Message title="Looking for lyrics…" />;
    } else if (result.status === 'found') {
        const lines = result.synced;
        const timed = Array.isArray(lines) && lines.length > 0
            && (!duration || lines[lines.length - 1].t <= duration + END_SLACK_SEC);
        body = (
            <>
                {timed
                    ? <TimedLyrics key={`${currentTrack.source}:${currentTrack.id}`} lines={lines} onSeek={seek} />
                    : (
                        <div className="lyrics-scroll">
                            <p className="lyrics-plain">{result.plain || lines.map(line => line.text).join('\n')}</p>
                        </div>
                    )}
                {!timed && <p className="lyrics-credit">These lyrics are not timed to the music.</p>}
                <Credit result={result} />
            </>
        );
    } else if (result.status === 'instrumental') {
        body = (
            <>
                <Message title="♪ Instrumental"><p>This track has no lyrics.</p></Message>
                <Credit result={result} />
            </>
        );
    } else if (result.status === 'online_disabled' && result.reason === 'server') {
        body = <Message title="No lyrics found"><p>Online lyrics lookups are switched off on this installation.</p></Message>;
    } else if (result.status === 'online_disabled' && choice === 'ask') {
        body = (
            <Message title="Look up lyrics online?">
                <p>
                    Lyrics come from LRCLIB, a free community lyrics database. To find them, Music Manager sends
                    the title, artist and length of the track you are playing to lrclib.net.
                </p>
                <p>Lyrics stored with your own music files are shown without this.</p>
                <div className="lyrics-actions">
                    <button type="button" className="lyrics-button is-primary" onClick={() => setOnlineLyrics('on')}>Look up lyrics</button>
                    <button type="button" className="lyrics-button" onClick={() => setOnlineLyrics('off')}>Not now</button>
                </div>
            </Message>
        );
    } else if (result.status === 'online_disabled') {
        body = (
            <Message title="Online lyrics are off">
                <p>Only lyrics stored with your own music files are shown. You can change this here or in Settings.</p>
                <div className="lyrics-actions">
                    <button type="button" className="lyrics-button is-primary" onClick={() => setOnlineLyrics('on')}>Turn on</button>
                </div>
            </Message>
        );
    } else if (result.status === 'unavailable') {
        body = (
            <Message title="Lyrics could not be loaded">
                <p>The lyrics service did not answer. Check your connection and try again.</p>
                <div className="lyrics-actions">
                    <button type="button" className="lyrics-button is-primary" onClick={retry}>Try again</button>
                </div>
            </Message>
        );
    } else {
        body = <Message title="No lyrics found"><p>Nothing for “{currentTrack.title}” yet.</p></Message>;
    }

    return <div className="lyrics" aria-live={result && result.status === 'found' ? 'off' : 'polite'}>{body}</div>;
}
