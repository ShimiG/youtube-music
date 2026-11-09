import React from 'react';

// The one source switch, shared by Library and Search. Takes the sources from
// useSources(): a connected source is selectable; an unconnected one is shown
// greyed and clicking it opens its connect action instead (or, when the server
// cannot connect it, explains why). No service is named here.
export default function SourcePicker({ sources, value, onChange, filter, ariaLabel = 'Source' }) {
    const visible = (sources || []).filter(s => (filter ? filter(s) : true));
    if (visible.length === 0) return null;

    const needsConnect = (s) => Boolean(s.connect && s.connect.required && !s.connected);
    const unavailable = (s) => needsConnect(s) && !s.connect.available;

    const handleClick = (s) => {
        if (!needsConnect(s)) return onChange(s.name);
        if (!unavailable(s) && s.connectAction) s.connectAction();
    };

    return (
        <div role="tablist" aria-label={ariaLabel} style={{ display: 'inline-flex', background: '#282828', borderRadius: '20px', padding: '4px', gap: '2px', flexWrap: 'wrap' }}>
            {visible.map(s => {
                const selected = s.name === value;
                const greyed = needsConnect(s);
                const blocked = unavailable(s);
                const title = blocked
                    ? `${s.label} cannot be connected on this server`
                    : greyed ? `Connect ${s.label}` : s.label;
                return (
                    <button
                        key={s.name}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-disabled={blocked}
                        title={title}
                        onClick={() => handleClick(s)}
                        style={{
                            padding: '6px 14px', borderRadius: '16px', border: 'none', fontWeight: 'bold', fontSize: '13px',
                            cursor: blocked ? 'not-allowed' : 'pointer',
                            background: selected ? s.color : 'transparent',
                            color: selected ? 'white' : (greyed ? '#666' : '#b3b3b3'),
                            opacity: blocked ? 0.5 : 1
                        }}
                    >
                        <span aria-hidden="true" style={{ marginRight: '6px' }}>{s.icon}</span>{s.label}
                    </button>
                );
            })}
        </div>
    );
}
