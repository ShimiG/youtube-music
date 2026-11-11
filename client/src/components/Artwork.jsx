import { useState } from 'react';
import { PLACEHOLDER_ART } from '../utils/artwork';

// A cover image that falls back to the local placeholder when the track has
// no artwork or its image fails to load. `src` changes with the track, so the
// failure is remembered per URL.
export default function Artwork({ src, alt = '', className, style }) {
    const [failed, setFailed] = useState(null);
    const shown = src && failed !== src ? src : PLACEHOLDER_ART;
    return (
        <img
            src={shown}
            alt={alt}
            className={className}
            style={style}
            onError={() => { if (src) setFailed(src); }}
            draggable={false}
        />
    );
}
