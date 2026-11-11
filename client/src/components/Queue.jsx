import React from 'react';
import { useMusic } from '../context/hook';

// "Up Next". `theme="dark"` is used inside the Now Playing view; the default
// light card is the one beside Search and Recently Played. `heading={false}`
// leaves the title out where a tab already names the list.
const THEMES = {
    light: { panel: '#f9f9f9', heading: 'black', rule: '#ddd', row: 'white', rowActive: '#1db95420', text: 'black', empty: '#888', shadow: '0 1px 3px rgba(0,0,0,0.1)' },
    dark: { panel: 'transparent', heading: 'white', rule: '#333', row: '#ffffff0d', rowActive: '#1db95430', text: '#eee', empty: '#999', shadow: 'none' }
};

export default function Queue({ theme = 'light', heading = true }) {
    const { queue, queueIndex, playQueueIndex, removeFromQueue } = useMusic();
    const c = THEMES[theme] || THEMES.light;

    return (
        <div style={{ background: c.panel, padding: theme === 'dark' ? 0 : '15px', borderRadius: '8px', height: 'fit-content' }}>
            {heading && <h2 style={{ borderBottom: `1px solid ${c.rule}`, paddingBottom: '10px', marginTop: 0, color: c.heading }}>Up Next</h2>}
            
            {!queue || queue.length === 0 ? (
                <p style={{ color: c.empty, fontStyle: 'italic' }}>Your queue is empty.</p>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
                    {queue.map((track, index) => {
                        const isPlayingNode = index === queueIndex;
                        return (
                            <div key={index} style={{ 
                                display: 'flex', alignItems: 'center', gap: '10px', padding: '8px', 
                                background: isPlayingNode ? c.rowActive : c.row, 
                                borderLeft: isPlayingNode ? '4px solid #1db954' : '4px solid transparent',
                                borderRadius: '4px', boxShadow: c.shadow
                            }}>
                                <div style={{ flex: 1, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => playQueueIndex(index)}>
                                    <div style={{ fontSize: '14px', fontWeight: isPlayingNode ? 'bold' : 'normal', color: c.text, overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.title}</div>
                                </div>
                                <button onClick={() => removeFromQueue(index)} aria-label={`Remove ${track.title} from the queue`} style={{ border: 'none', background: 'none', color: '#ff4d4d', cursor: 'pointer', fontSize: '16px' }}>✕</button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
