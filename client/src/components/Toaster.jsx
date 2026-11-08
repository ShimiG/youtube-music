import { useEffect, useState } from 'react';
import { subscribeToasts } from '../utils/toast';

// Renders toasts raised through utils/toast.js, newest at the bottom, each
// dismissing itself after its timeout (or on click).
export default function Toaster() {
    const [items, setItems] = useState([]);

    useEffect(() => subscribeToasts((item) => {
        setItems((prev) => [...prev.slice(-3), item]);
        setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== item.id)), item.timeoutMs);
    }), []);

    const dismiss = (id) => setItems((prev) => prev.filter((t) => t.id !== id));

    return (
        <div className="toaster" role="status" aria-live="polite">
            {items.map((t) => (
                <button key={t.id} type="button" className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
                    {t.message}
                </button>
            ))}
        </div>
    );
}
