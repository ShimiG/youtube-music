import React from 'react';
import { openSettings } from '../utils/navigation';

// The one source switch, shared by Library and Search. Takes the sources from
// useSources(): a usable source is selectable; one that needs a connection the
// user does not have is shown greyed and clicking it opens its connect action
// instead (or, when this installation is not set up for it yet, Settings ->
// Accounts, where that is done). No service is named here.
//
// `requiresConnection(source)` says whether this screen needs the user's own
// connection for that source. The Library always does; Search passes its own
// rule, because some sources search public content without one.
export default function SourcePicker({ sources, value, onChange, filter, requiresConnection, ariaLabel = 'Source' }) {
    const visible = (sources || []).filter(s => (filter ? filter(s) : true));
    if (visible.length === 0) return null;

    const required = requiresConnection || ((s) => Boolean(s.connect && s.connect.required));
    const needsConnect = (s) => Boolean(required(s) && !s.connected);
    const unavailable = (s) => needsConnect(s) && !(s.connect && s.connect.available);

    const handleClick = (s) => {
        if (!needsConnect(s)) return onChange(s.name);
        if (unavailable(s)) return openSettings('accounts');
        if (s.connectAction) return s.connectAction();
        return undefined;
    };

    return (
        <div role="tablist" aria-label={ariaLabel} style={{ display: 'inline-flex', background: '#282828', borderRadius: '20px', padding: '4px', gap: '2px', flexWrap: 'wrap' }}>
            {visible.map(s => {
                const selected = s.name === value;
                const greyed = needsConnect(s);
                const blocked = unavailable(s);
                const title = blocked
                    ? `${s.label} is not set up on this computer yet. Open Settings, Accounts.`
                    : greyed ? `Connect ${s.label}` : s.label;
                return (
                    <button
                        key={s.name}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        title={title}
                        onClick={() => handleClick(s)}
                        style={{
                            padding: '6px 14px', borderRadius: '16px', border: 'none', fontWeight: 'bold', fontSize: '13px',
                            cursor: 'pointer',
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
