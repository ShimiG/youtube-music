import { useEffect, useState } from 'react';
import AccountsPanel from './AccountsPanel';
import CloudPanel from './CloudPanel';
import SystemPanel from './SystemPanel';
import { QUALITY_OPTIONS, getAudioQuality, setAudioQuality, setOnlineLyrics, setDynamicTheme } from '../utils/settings';
import { useDynamicTheme } from '../hooks/useArtworkTheme';
import useOnlineLyrics from '../hooks/useOnlineLyrics';
import { toast } from '../utils/toast';

const card = { background: '#181818', border: '1px solid #333', borderRadius: '10px', padding: '18px 20px', maxWidth: '640px' };

const SECTIONS = [
    { id: 'accounts', label: 'Accounts' },
    { id: 'quality', label: 'Audio quality' },
    { id: 'lyrics', label: 'Lyrics' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'system', label: 'System' }
];
const jumpTo = (id) => {
    const el = document.getElementById(`settings-${id}`);
    if (el) el.scrollIntoView({ block: 'start' });
};

// Accounts: the services' logins and, for the owner, their credentials.
// System: what playback depends on, and the server's log.
// Settings for this device. Audio quality (issue #39) applies to the next
// track that starts: streams are converted to MP3 at the chosen bitrate.
// Online lyrics (issue #30) is the same choice the Lyrics tab asks about.
// Cover colours (issue #26) take effect at once.
export default function SettingsView({ section = null }) {
    const [quality, setQuality] = useState(getAudioQuality);
    const onlineLyrics = useOnlineLyrics();
    const dynamicTheme = useDynamicTheme();

    // Opened at a section (the connect banner and greyed-out service tabs
    // send people to Accounts).
    useEffect(() => {
        if (section && section.id) jumpTo(section.id);
    }, [section]);

    const choose = (value) => {
        setQuality(value);
        setAudioQuality(value);
        const option = QUALITY_OPTIONS.find(o => o.value === value);
        toast(`Audio quality: ${option.label}. Applies from the next track.`);
    };

    return (
        <div style={{ padding: '20px' }}>
            <h1 style={{ marginTop: 0 }}>Settings</h1>
            <nav className="settings-nav" aria-label="Settings sections">
                {SECTIONS.map(s => (
                    <button key={s.id} type="button" onClick={() => jumpTo(s.id)}>{s.label}</button>
                ))}
            </nav>

            <section id="settings-accounts" style={card} aria-labelledby="accounts-heading">
                <h2 id="accounts-heading" style={{ margin: '0 0 4px', fontSize: '18px' }}>Accounts</h2>
                <p style={{ color: '#aaa', fontSize: '13px', margin: '0 0 14px' }}>
                    Connect your streaming accounts. The logins stay on this computer, unless you turn on cloud sync below: your YouTube login is then kept with your cloud account.
                </p>
                <AccountsPanel />
                <CloudPanel />
            </section>

            <section id="settings-quality" style={{ ...card, marginTop: '20px' }} aria-labelledby="quality-heading">
                <h2 id="quality-heading" style={{ margin: '0 0 4px', fontSize: '18px' }}>Audio quality</h2>
                <p style={{ color: '#aaa', fontSize: '13px', margin: '0 0 14px' }}>
                    For music streamed from YouTube, SoundCloud, Audius and Deezer.
                </p>
                <div role="radiogroup" aria-labelledby="quality-heading" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {QUALITY_OPTIONS.map(option => {
                        const selected = option.value === quality;
                        return (
                            <label
                                key={option.value}
                                style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', border: `1px solid ${selected ? '#1db954' : '#333'}`, background: selected ? '#1db95415' : 'transparent' }}
                            >
                                <input
                                    type="radio"
                                    name="audio-quality"
                                    value={option.value}
                                    checked={selected}
                                    onChange={() => choose(option.value)}
                                    style={{ marginTop: '3px', accentColor: '#1db954' }}
                                />
                                <span>
                                    <span style={{ fontWeight: 'bold' }}>{option.label}</span>
                                    <span style={{ display: 'block', color: '#aaa', fontSize: '13px', marginTop: '2px' }}>{option.detail}</span>
                                </span>
                            </label>
                        );
                    })}
                </div>
                <p style={{ color: '#888', fontSize: '12px', margin: '14px 0 0', lineHeight: 1.5 }}>
                    Streaming services send compressed audio, so High cannot add detail the source does not have.
                    Your own MP3, M4A, FLAC and WAV files (Local Files) always play in their original quality, whatever is chosen here.
                </p>
            </section>

            <section id="settings-lyrics" style={{ ...card, marginTop: '20px' }} aria-labelledby="lyrics-heading">
                <h2 id="lyrics-heading" style={{ margin: '0 0 4px', fontSize: '18px' }}>Lyrics</h2>
                <p style={{ color: '#aaa', fontSize: '13px', margin: '0 0 14px' }}>
                    Shown in the Now Playing view, next to the queue.
                </p>
                <label style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', border: `1px solid ${onlineLyrics === 'on' ? '#1db954' : '#333'}`, background: onlineLyrics === 'on' ? '#1db95415' : 'transparent' }}>
                    <input
                        type="checkbox"
                        checked={onlineLyrics === 'on'}
                        onChange={(e) => setOnlineLyrics(e.target.checked ? 'on' : 'off')}
                        style={{ marginTop: '3px', accentColor: '#1db954' }}
                    />
                    <span>
                        <span style={{ fontWeight: 'bold' }}>Look up lyrics online</span>
                        <span style={{ display: 'block', color: '#aaa', fontSize: '13px', marginTop: '2px' }}>
                            Sends the title, artist and length of the playing track to LRCLIB (lrclib.net), a free community lyrics database.
                        </span>
                    </span>
                </label>
                <p style={{ color: '#888', fontSize: '12px', margin: '14px 0 0', lineHeight: 1.5 }}>
                    Lyrics stored with your own music (inside the file, or in a .lrc file with the same name next to it)
                    are always shown, and nothing is sent anywhere for them.
                </p>
            </section>

            <section id="settings-appearance" style={{ ...card, marginTop: '20px' }} aria-labelledby="appearance-heading">
                <h2 id="appearance-heading" style={{ margin: '0 0 14px', fontSize: '18px' }}>Appearance</h2>
                <label style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', border: `1px solid ${dynamicTheme ? '#1db954' : '#333'}`, background: dynamicTheme ? '#1db95415' : 'transparent' }}>
                    <input
                        type="checkbox"
                        checked={dynamicTheme}
                        onChange={(e) => setDynamicTheme(e.target.checked)}
                        style={{ marginTop: '3px', accentColor: '#1db954' }}
                    />
                    <span>
                        <span style={{ fontWeight: 'bold' }}>Match colours to the cover art</span>
                        <span style={{ display: 'block', color: '#aaa', fontSize: '13px', marginTop: '2px' }}>
                            The player bar and the Now Playing view take their colours from the cover of the playing track.
                        </span>
                    </span>
                </label>
                <p style={{ color: '#888', fontSize: '12px', margin: '14px 0 0', lineHeight: 1.5 }}>
                    Colours are always adjusted so text stays readable. Tracks without a cover (your own files, for now) use the standard colours.
                </p>
            </section>

            <section id="settings-system" style={{ ...card, marginTop: '20px' }} aria-labelledby="system-heading">
                <h2 id="system-heading" style={{ margin: '0 0 4px', fontSize: '18px' }}>System</h2>
                <p style={{ color: '#aaa', fontSize: '13px', margin: '0 0 14px' }}>
                    What playback depends on. If nothing plays, look here first.
                </p>
                <SystemPanel />
            </section>
        </div>
    );
}
