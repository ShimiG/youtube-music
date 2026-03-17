import React from 'react';
import { useMusic } from '../context/hook';

export default function Queue() {
    const { queue, queueIndex, playQueueIndex, removeFromQueue } = useMusic();

    return (
        <div style={{ background: '#f9f9f9', padding: '15px', borderRadius: '8px', height: 'fit-content' }}>
            <h2 style={{ borderBottom: '1px solid #ddd', paddingBottom: '10px', marginTop: 0, color: 'black' }}>Up Next</h2>
            
            {!queue || queue.length === 0 ? (
                <p style={{ color: '#888', fontStyle: 'italic' }}>Your queue is empty.</p>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
                    {queue.map((track, index) => {
                        const isPlayingNode = index === queueIndex;
                        return (
                            <div key={index} style={{ 
                                display: 'flex', alignItems: 'center', gap: '10px', padding: '8px', 
                                background: isPlayingNode ? '#1db95420' : 'white', 
                                borderLeft: isPlayingNode ? '4px solid #1db954' : '4px solid transparent',
                                borderRadius: '4px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
                            }}>
                                <div style={{ flex: 1, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => playQueueIndex(index)}>
                                    <div style={{ fontSize: '14px', fontWeight: isPlayingNode ? 'bold' : 'normal', color: 'black' }}>{track.title}</div>
                                </div>
                                <button onClick={() => removeFromQueue(index)} style={{ border: 'none', background: 'none', color: '#ff4d4d', cursor: 'pointer', fontSize: '16px' }}>✕</button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}