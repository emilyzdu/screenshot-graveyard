import type { GhostView } from '../model/ghostView';

/** An accessible list of every ghost, with no need to walk anywhere. */
export function QuickQueue({ ghosts, onPick, title = 'Pick a screenshot', hint, showListLink = false }: {
  ghosts: readonly GhostView[]; onPick: (id: number, opener: HTMLElement) => void; title?: string; hint?: string; showListLink?: boolean;
}) {
  return (
    <div>
      {showListLink && <a className="pw-btn" href="?">Open List View</a>}
      {ghosts.length === 0 ? <p className="pw-empty" role="status">{hint ?? 'No screenshots yet. Use Upload to add some.'}</p> :
        <p className="pw-muted">{hint ?? title}</p>}
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
