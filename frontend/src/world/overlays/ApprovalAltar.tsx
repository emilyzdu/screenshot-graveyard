import { useState } from 'react';
import type { GhostView } from '../model/ghostView';
import { demoApproval } from '../data/worldFixtures';
import { PrototypeTag } from './OverlayHost';

/**
 * Read-only. Approving happens in the draft panels of the Action Card. The
 * stamp below is an animation preview only: it records nothing.
 */
export function ApprovalAltar({ ghosts, synthetic, reducedMotion, onPick }: {
  ghosts: readonly GhostView[]; synthetic: boolean; reducedMotion: boolean; onPick: (id: number, opener: HTMLElement) => void;
}) {
  const [stamped, setStamped] = useState(false);
  const rows = synthetic ? ghosts.map((g) => ({ g, state: demoApproval(g.id) })).filter((r) => r.state !== null) : [];
  return (
    <div>
      {synthetic ? (
        <>
          <p><PrototypeTag>Demo data</PrototypeTag> Approval states below are invented for the preview.</p>
          {rows.length === 0 ? <p role="status">No approved or ready-for-review ghosts in this sample.</p> : (
            <ul className="pw-list" aria-label="Approval states">
              {rows.map(({ g, state }) => (
                <li key={g.id}><span className="pw-list__item pw-list__item--static">
                  <span className="pw-list__name">{g.filename}</span>
                  <span className="pw-muted">{state === 'approved' ? 'Approved (demo)' : 'Ready for review (demo)'}</span>
                </span></li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <p role="status">The altar cannot list approvals yet: the backend reports an approval only per draft.</p>
          <p className="pw-muted">To review or approve a draft, open a screenshot. Approval is always your own click on one exact saved version.</p>
          {ghosts.length > 0 && (
            <ul className="pw-list" aria-label="Screenshots">
              {ghosts.filter((g) => g.category).map((g) => (
                <li key={g.id}><button type="button" className="pw-list__item" onClick={(e) => onPick(g.id, e.currentTarget)}>
                  <span className="pw-list__name">{g.filename}</span><span className="pw-muted">Open to review drafts</span>
                </button></li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="pw-proto-box">
        <PrototypeTag>Prototype stamp</PrototypeTag>
        <p>This preview shows the stamp animation planned for approvals. It does not approve, save or send anything.</p>
        <div className={`pw-stamp-pad${stamped ? ' is-stamped' : ''}${reducedMotion ? ' is-static' : ''}`} data-testid="stamp-pad" aria-hidden="true">
          <span className="pw-stamp">SAMPLE</span>
        </div>
        <button type="button" className="pw-btn" onClick={() => setStamped(!stamped)}>{stamped ? 'Reset preview' : 'Preview stamp'}</button>
      </div>
    </div>
  );
}
