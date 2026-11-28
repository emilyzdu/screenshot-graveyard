import { useRef, useState } from 'react';
import '../../ui/theme.css';
import '../../ui/components.css';
import '../../shell/shell.css';
import { archiveScreenshot, imageUrl, type Screenshot } from '../../api/client';
import { useProviderStatus } from '../../ai/PrivacyNotice';
import { RevivePanel } from '../../shell/RevivePanel';
import { MakeNotesDraft } from '../../shell/MakeNotesDraft';
import { CalendarDraft } from '../../shell/CalendarDraft';
import { ActionPlanPanel, type PlanActivity } from '../../shell/ActionPlanPanel';
import type { GhostView } from '../model/ghostView';
import type { RecordStatus } from '../model/lifecycle';

export type CardChoice = 'make_notes' | 'add_calendar' | 'review_plan' | 'deliver' | null;

interface LiveProps {
  shot: Screenshot;
  ghost: GhostView;
  initialChoice: CardChoice;
  onChanged: () => void;
  onArchived: () => void;
  onStatus: (status: RecordStatus) => void;
  onActivity: (activity: PlanActivity) => void;
  onRevive: (state: RecordStatus['revive'], operationId: number | null) => void;
}

function LiveCard({ ghost, shot, initialChoice, onChanged, onArchived, onStatus, onActivity, onRevive }: LiveProps) {
  const provider = useProviderStatus();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveMessage, setArchiveMessage] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [showInterpretation, setShowInterpretation] = useState(!shot.analysis);
  const [showDrafts, setShowDrafts] = useState(initialChoice === 'make_notes' || initialChoice === 'add_calendar');
  const archiveBusy = useRef(false);
  const plannedFirst = initialChoice === 'review_plan' || initialChoice === 'deliver';
  const localFirst = initialChoice === 'make_notes' || initialChoice === 'add_calendar';

  const archive = async () => {
    if (archiveBusy.current) return;
    archiveBusy.current = true;
    setArchiving(true);
    const result = await archiveScreenshot(shot.screenshotId);
    archiveBusy.current = false;
    setArchiving(false);
    if (result.ok && result.status === 'successful') onArchived();
    else {
      setArchiveMessage(!result.ok && result.outcome === 'rejected' ? result.error : 'Archiving could not be confirmed. Check the graveyard and Crypt before trying again.');
      setArchiveOpen(false);
      onChanged();
    }
  };

  const revive = <RevivePanel screenshot={shot} providerMode={provider.mode} providerLoading={provider.loading}
    refreshProvider={provider.refresh} onAnalysisChanged={onChanged}
    onConsentChanged={(consent) => onStatus({ consent })}
    onReviveChanged={(state, operationId) => onRevive(state ?? undefined, operationId)} />;
  const plan = <ActionPlanPanel screenshotId={shot.screenshotId} providerMode={provider.mode}
    onActivity={onActivity} showHistory canPlan={!!shot.analysis} emphasizeReview={initialChoice === 'review_plan'} />;
  const local = <details className="pw-local-drafts" open={showDrafts} onToggle={(event) => setShowDrafts(event.currentTarget.open)}>
    <summary>Workspace notes and calendar drafts</summary>
    {showDrafts && <>
      <MakeNotesDraft screenshot={shot} providerMode={provider.mode} canStart={!!shot.analysis} />
      <CalendarDraft screenshot={shot} providerMode={provider.mode} canStart={!!shot.analysis} />
    </>}
  </details>;

  return (
    <div className="pw-card" data-testid="action-card">
      <aside className="pw-card__source">
        <img className="pw-card__img" src={imageUrl(shot.screenshotId)} alt={`Preview of ${ghost.filename}`} />
        <p><strong>#{ghost.id} · {ghost.filename}</strong></p>
        <p className="pw-muted">{ghost.label}{ghost.category ? ` · ${ghost.category}` : ''}{ghost.isDuplicate ? ' · duplicate upload' : ''}</p>
        {ghost.epitaph && <blockquote>{ghost.epitaph}</blockquote>}
        <section className="pw-card__archive" aria-label="Archive screenshot">
          {archiveOpen ? <>
            <p>Move this screenshot and its history to the Crypt?</p>
            <div className="pw-row">
              <button className="pw-btn" type="button" disabled={archiving} onClick={() => void archive()}>{archiving ? 'Archiving…' : 'Archive screenshot'}</button>
              <button className="pw-btn" type="button" disabled={archiving} onClick={() => setArchiveOpen(false)}>Cancel</button>
            </div>
          </> : <button className="pw-btn" type="button" onClick={() => setArchiveOpen(true)}>Safe Burial</button>}
          {archiveMessage && <p role="alert">{archiveMessage}</p>}
        </section>
      </aside>
      <div className="pw-card__workflow">
        {plannedFirst && plan}
        {localFirst && local}
        {showInterpretation ? revive : <button className="pw-btn pw-interpretation" type="button" onClick={() => setShowInterpretation(true)}>Open AI interpretation and consent</button>}
        {!plannedFirst && plan}
        {!localFirst && local}
      </div>
    </div>
  );
}

export function ActionCard({ ghost, shot, synthetic, ...props }: Omit<LiveProps, 'shot'> & { shot: Screenshot | null; synthetic: boolean }) {
  if (synthetic || !shot) return <div data-testid="action-card"><p><strong>#{ghost.id} · {ghost.filename}</strong></p>
    <p>This is a synthetic screenshot in gallery preview. Open the connected workspace to review a screenshot.</p></div>;
  return <LiveCard ghost={ghost} shot={shot} {...props} />;
}
