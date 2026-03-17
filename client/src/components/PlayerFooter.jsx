import React, { useState } from 'react';
import { useMusic } from '../context/hook';

export default function PlayerFooter() {
    const { 
        currentTrack, isPlaying, isLoading, togglePlay, playNext, playPrev, 
        currentTime, duration, volume, updateVolume, toggleMute, seek, isShuffle, toggleShuffle 
    } = useMusic();
    
    const [sliderValue, setSliderValue] = useState(0);
    const [isDragging, setIsDragging] = useState(false);


    const formatTime = (seconds) => {
        if (!seconds) return "0:00";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    };

    if (!currentTrack) return null;

    return (
        <div className="player-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px 20px', background: '#181818', color: 'white', position: 'fixed', bottom: 0, left: 0, right: 0 }}>
            {/* Track Info */}
            <div style={{ display: 'flex', alignItems: 'center', width: '30%' }}>
                <img src={currentTrack.thumbnail || currentTrack.image} style={{width: 50, height: 50, borderRadius: 4, marginRight: 15}} alt="Album Art" />
                <div>
                    <div style={{ fontWeight: 'bold' }}>{currentTrack.title}</div>
                    <div style={{ fontSize: '0.8em', color: '#aaa' }}>{currentTrack.channelTitle || currentTrack.artist}</div>
                </div>
            </div>
            
            {/* Controls & Seek Bar */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', width: '40%' }}>
                <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '20px' }}>
                    <button className={`shuffle-btn ${isShuffle ? 'active' : ''}`} onClick={toggleShuffle} title="Shuffle">
                        <svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
                    </button>
                    <button onClick={playPrev} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '24px' }}>⏮</button>
                    <button onClick={togglePlay} style={{ background: 'white', color: 'black', borderRadius: '50%', width: 40, height: 40, border: 'none', fontSize: '20px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {isLoading ? <div className="loader" style={{ border: '3px solid #f3f3f3', borderTop: '3px solid #555', borderRadius: '50%', width: '20px', height: '20px', animation: 'spin 1s linear infinite' }}></div> : (isPlaying ? "⏸" : "▶")}
                    </button>
                    <button onClick={playNext} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '24px' }}>⏭</button>
                    <button className="shuffle-btn" title="Repeat" style={{ opacity: 0.5 }}>
                        <svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
                    </button>
                </div>

                {/* Seek Bar */}
                <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '12px', minWidth: '35px', textAlign: 'right', color: '#b3b3b3' }}>
                        {formatTime(isDragging ? sliderValue : currentTime)}
                    </span>
                    <input type="range" min="0" max={duration || 0} step="any" value={isDragging ? sliderValue : (currentTime || 0)} disabled={!duration} onMouseDown={() => setIsDragging(true)} onTouchStart={() => setIsDragging(true)} onChange={(e) => setSliderValue(Number(e.target.value))} onMouseUp={() => { setIsDragging(false); seek(sliderValue); }} onTouchEnd={() => { setIsDragging(false); seek(sliderValue); }} style={{ flex: 1, cursor: 'pointer', accentColor: '#1db954' }} />
                    <span style={{ fontSize: '12px', minWidth: '35px', color: '#b3b3b3' }}>{formatTime(duration)}</span>
                </div>
            </div>

            {/* Volume Controls */}
            <div className="volume-container" style={{ display: 'flex', alignItems: 'center', width: '30%', justifyContent: 'flex-end', gap: '10px' }}>
                <button className={`sound-btn ${volume === 0 ? 'sound-mute' : ''}`} onClick={toggleMute} title={volume === 0 ? "Unmute" : "Mute"}>
                    <div className="sound-icon"><svg viewBox="0 0 24 24" width="20" fill="white"><path d="M7 9v6h4l5 5V4l-5 5H7z" /></svg></div>
                </button>
                <input type="range" className="volume-slider" min="0" max="1" step="0.01" value={volume} onChange={(e) => updateVolume(parseFloat(e.target.value))} style={{ background: `linear-gradient(to right, ${volume > 0 ? '#1db954' : '#4d4d4d'} ${volume * 100}%, #4d4d4d ${volume * 100}%)`, width: '100px' }} />
            </div>
        </div>
    );
}