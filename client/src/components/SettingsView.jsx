import { useState } from 'react';
import { QUALITY_OPTIONS, getAudioQuality, setAudioQuality } from '../utils/settings';
import { toast } from '../utils/toast';

const card = { background: '#181818', border: '1px solid #333', borderRadius: '10px', padding: '18px 20px', maxWidth: '640px' };

// Settings for this device. Audio quality (issue #39) applies to the next
// track that starts: streams are converted to MP3 at the chosen bitrate.
export default function SettingsView() {
    const [quality, setQuality] = useState(getAudioQuality);

    const choose = (value) => {
        setQuality(value);
        setAudioQuality(value);
        const option = QUALITY_OPTIONS.find(o => o.value === value);
        toast(`Audio quality: ${option.label}. Applies from the next track.`);
    };

    return (
        <div style={{ padding: '20px' }}>
            <h1 style={{ marginTop: 0 }}>Settings</h1>
            <section style={card} aria-labelledby="quality-heading">
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
        </div>
    );
}
