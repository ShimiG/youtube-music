import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Renders only the rows near the visible part of a long list (issue #27), so
// a playlist that grew to 10,000 tracks through "Load more" stays fast.
//
// - Short lists (up to `threshold` items) render normally, exactly as before.
// - Rows must all be the same height (TrackRow is: one-line title and artist,
//   fixed image). `rowHeight` is the first guess; the real height is measured
//   from a rendered row and used from then on.
// - The list scrolls with the page: it follows the nearest scrolling ancestor
//   (the app's `.content` column), not a scroll box of its own.
// - Off-screen rows are replaced by two spacers in normal flow, so menus that
//   open inside a row (AddToPlaylist) still overlap the rows below it.
export default function VirtualList({ items, renderRow, rowHeight, threshold = 150, overscan = 12 }) {
    const containerRef = useRef(null);
    // The visible window and the row height it was computed with; both come
    // from the DOM, so they are updated together, from layout and scroll.
    const [range, setRange] = useState({ start: 0, end: Math.min(items.length, 60), height: rowHeight });
    const virtual = items.length > threshold;

    const update = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        // Hidden (its view is not the one showing): nothing to measure. The
        // app announces a view change as a resize, which brings it up to date.
        if (container.offsetParent === null) return;
        // Use the real row height once a row is on screen (children[0] and the
        // last child are the spacers).
        const firstRow = container.children.length > 2 ? container.children[1] : null;
        const measured = firstRow ? firstRow.getBoundingClientRect().height : 0;
        const height = measured > 0 ? measured : rowHeight;
        const scroller = scrollParentOf(container);
        const viewportHeight = scroller === window ? window.innerHeight : scroller.clientHeight;
        // The list's top edge, in the scroller's coordinates.
        const scrollerTop = scroller === window ? 0 : scroller.getBoundingClientRect().top;
        const listTop = container.getBoundingClientRect().top - scrollerTop;
        const first = Math.floor(-listTop / height) - overscan;
        const last = Math.ceil((viewportHeight - listTop) / height) + overscan;
        const start = Math.max(0, Math.min(items.length, first));
        const end = Math.max(start, Math.min(items.length, last));
        setRange(prev => (prev.start === start && prev.end === end && Math.abs(prev.height - height) < 0.5
            ? prev
            : { start, end, height }));
    }, [items.length, rowHeight, overscan]);

    useLayoutEffect(() => {
        if (virtual) update();
    }, [virtual, update]);

    useEffect(() => {
        if (!virtual) return undefined;
        const scroller = scrollParentOf(containerRef.current);
        let frame = 0;
        const onScroll = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => { frame = 0; update(); });
        };
        scroller.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        return () => {
            cancelAnimationFrame(frame);
            scroller.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onScroll);
        };
    }, [virtual, update]);

    if (!virtual) {
        return <>{items.map((item, index) => renderRow(item, index))}</>;
    }

    const { start, end, height } = range;
    return (
        <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column' }} data-virtual-list={items.length}>
            <div aria-hidden="true" style={{ height: start * height, flexShrink: 0 }} />
            {items.slice(start, end).map((item, i) => renderRow(item, start + i))}
            <div aria-hidden="true" style={{ height: (items.length - end) * height, flexShrink: 0 }} />
        </div>
    );
}

function scrollParentOf(element) {
    for (let node = element && element.parentElement; node; node = node.parentElement) {
        const { overflowY } = getComputedStyle(node);
        if (overflowY === 'auto' || overflowY === 'scroll') return node;
    }
    return window;
}
