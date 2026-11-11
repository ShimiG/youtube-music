import React from 'react';
import { useSources } from '../hooks/useSources';
import { openSettings } from '../utils/navigation';

// One-click connect banner shown at the top of the home screen. Lists every
// source the server says needs a connection, can be connected here, and this
// user has not connected yet. A source that cannot be connected because this
// installation has no credentials for it yet is named too, with the way to
// Settings -> Accounts, instead of silently having no button. Disappears once
// everything is linked. No service is named in this file; useSources() and
// the registry supply the details.
export default function ConnectServices() {
    const { sources, loading } = useSources();

    // While loading, render nothing rather than flashing buttons that may hide.
    if (loading) return null;

    const missing = sources.filter(s =>
        s.connect && s.connect.required && s.connect.available && !s.connected && typeof s.connectAction === 'function'
    );
    // Needs a connection even to search, has none, and the server cannot start
    // one yet. A source that works without an account is not nagged about.
    const notSetUp = sources.filter(s => s.connect && s.connect.required && s.searchRequiresConnection && !s.connect.available && !s.connected);
    if (missing.length === 0 && notSetUp.length === 0) return null;
    const names = notSetUp.map(s => s.label).join(' and ');

    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '20px', background: '#181818', border: '1px solid #333', borderRadius: '12px', padding: '15px 20px', marginBottom: '20px', flexWrap: 'wrap' }}>
            <span style={{ color: '#b3b3b3', fontSize: '14px' }}>
                {missing.length > 0
                    ? 'Connect your streaming services to search and play music.'
                    : `${names} ${notSetUp.length > 1 ? 'are' : 'is'} not set up on this computer yet.`}
            </span>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                {missing.map(s => (
                    <button
                        key={s.name}
                        onClick={() => s.connectAction()}
                        style={{ background: s.color, color: 'white', padding: '10px 20px', border: 'none', borderRadius: '20px', fontWeight: 'bold', fontSize: '14px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                        {s.connectLabel}
                    </button>
                ))}
                {notSetUp.length > 0 && (
                    <button
                        onClick={() => openSettings('accounts')}
                        title={`${names}: not set up on this computer yet`}
                        style={{ background: 'transparent', color: 'white', padding: '10px 20px', border: '1px solid #555', borderRadius: '20px', fontWeight: 'bold', fontSize: '14px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                        {missing.length > 0 ? `Set up ${names}` : 'Open Accounts'}
                    </button>
                )}
            </div>
        </div>
    );
}
