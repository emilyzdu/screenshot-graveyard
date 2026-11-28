import type { GhostView } from '../model/ghostView';

/** An accessible list of every ghost, with no need to walk anywhere. */
export function QuickQueue({ ghosts, onPick, title = 'Pick a screenshot', hint }: {
  ghosts: readonly GhostView[]; onPick: (id: number, opener: HTMLElement) => void; title?: string; hint?: string;
}) {
  if (ghosts.length === 0) return <p role="status">{hint ?? 'No screenshots yet. Use the Upload Well to add some.'}</p>;
  return (
    <div>
      <p className="pw-muted">{hint ?? `${title}. Opening one only reads what is saved.`}</p>
      <ul className="pw-list" aria-label="Screenshots">
        {ghosts.map((g) => (
          <li key={g.id}>
            <button type="button" className="pw-list__item" onClick={(e) => onPick(g.id, e.currentTarget)}>
              <span className="pw-list__name">{g.filename}</span>
              <span className="pw-muted">{g.label}{g.category ? ` · ${g.category}` : ''}{g.isDuplicate ? ' · duplicate' : ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
