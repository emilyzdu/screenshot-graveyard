import type { GhostBadge } from '../model/ghostView';

// 12x12 pixel glyphs: each has its own silhouette so it reads without color.
const SHAPES: Record<Exclude<GhostBadge, 'none'>, { fill: string; rects: [number, number, number, number, string?][] }> = {
  book: { fill: '#a77be0', rects: [[1, 2, 10, 8, '#1b1433'], [2, 3, 4, 6, '#f3ecff'], [6, 3, 4, 6, '#ffe4a3'], [5, 3, 2, 6, '#6c4ab0']] },
  image: { fill: '#8fd3ff', rects: [[1, 2, 10, 8, '#1b1433'], [2, 3, 8, 6, '#8fd3ff'], [3, 7, 3, 2, '#4d7a5c'], [6, 6, 4, 3, '#2f4a3e'], [8, 4, 1, 1, '#f3ecff']] },
  question: { fill: '#ffe4a3', rects: [[3, 1, 6, 10, '#1b1433'], [4, 2, 4, 1, '#ffe4a3'], [7, 3, 1, 2, '#ffe4a3'], [5, 5, 2, 1, '#ffe4a3'], [5, 6, 1, 2, '#ffe4a3'], [5, 9, 2, 1, '#ffe4a3']] },
  lock: { fill: '#f6a6c8', rects: [[3, 1, 6, 4, '#1b1433'], [4, 2, 4, 3, '#9a93b8'], [2, 5, 8, 6, '#1b1433'], [3, 6, 6, 4, '#f6a6c8'], [5, 7, 2, 2, '#1b1433']] },
};

export function Badge({ kind }: { kind: GhostBadge }) {
  if (kind === 'none') return null;
  return (
    <svg className="pw-badge" width="12" height="12" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true" data-badge={kind}>
      {SHAPES[kind].rects.map(([x, y, w, h, f], i) => <rect key={i} x={x} y={y} width={w} height={h} fill={f ?? SHAPES[kind].fill} />)}
    </svg>
  );
}
