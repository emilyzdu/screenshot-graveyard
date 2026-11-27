import { useState } from 'react';
import '../../ui/theme.css';
import '../../ui/components.css';
import '../../shell/shell.css';
import { imageUrl, type Screenshot } from '../../api/client';
import { useProviderStatus } from '../../ai/PrivacyNotice';
import { RevivePanel } from '../../shell/RevivePanel';
import { MakeNotesDraft } from '../../shell/MakeNotesDraft';
import { CalendarDraft } from '../../shell/CalendarDraft';
import type { GhostView } from '../model/ghostView';
import { PrototypeTag } from './OverlayHost';

export type CardChoice = 'make_notes' | 'add_calendar' | null;

function Header({ ghost, synthetic }: { ghost: GhostView; synthetic: boolean }) {
  return (
    <div className="pw-card__head">
      <p><strong>#{ghost.id} · {ghost.filename}</strong>{synthetic && <> <PrototypeTag>Demo data</PrototypeTag></>}</p>
      <p className="pw-muted">{ghost.label}{ghost.category ? ` · ${ghost.category}` : ''}{ghost.isDuplicate ? ' · duplicate upload' : ''}</p>
      {ghost.epitaph && <q>{ghost.epitaph}</q>}
    </div>
  );
}

/** Synthetic ghosts never reach the API: the card only explains what the real one does. */
function DemoCard({ ghost }: { ghost: GhostView }) {
  return (
    <div className="pw-card" data-testid="action-card">
      <Header ghost={ghost} synthetic />
      <div className="pw-proto-box" role="note">
        <PrototypeTag>Prototype</PrototypeTag>
        <p>This is a synthetic screenshot. In your real workspace this card shows the image, the AI consent step, Revive, and Make Notes or Add to Calendar drafts.</p>
        <p>Nothing is analyzed, saved or sent from demo data. Open the world without <code>demo=1</code> and with the backend running to use the real panels.</p>
      </div>
    </div>
  );
}

/**
 * Hosts the existing RevivePanel, MakeNotesDraft and CalendarDraft with the
 * same props the list view passes. Opening the card only reads; every paid call
 * still needs the user's own clicks inside those components.
 */
function LiveCard({ ghost, shot, initialChoice, onChanged }: { ghost: GhostView; shot: Screenshot; initialChoice: CardChoice; onChanged: () => void }) {
  const provider = useProviderStatus();
  const [choice, setChoice] = useState<CardChoice>(initialChoice);
  return (
    <div className="pw-card" data-testid="action-card">
      <Header ghost={ghost} synthetic={false} />
      <img className="pw-card__img" src={imageUrl(shot.screenshotId)} alt={`Preview of ${ghost.filename}`} loading="lazy" />
      <RevivePanel
        screenshot={shot}
        providerMode={provider.mode}
        providerLoading={provider.loading}
        refreshProvider={provider.refresh}
        onAnalysisChanged={onChanged}
      />
      {shot.analysis ? (
        <section className="pw-card__next" aria-label="Next step">
          <h3>Next step</h3>
          <p className="pw-muted">Choosing a step sends nothing. Preparing a draft is a separate button below.</p>
          <div className="pw-row">
            <button type="button" className="pw-btn" aria-pressed={choice === 'make_notes'} onClick={() => setChoice(choice === 'make_notes' ? null : 'make_notes')}>Make Notes</button>
            <button type="button" className="pw-btn" aria-pressed={choice === 'add_calendar'} onClick={() => setChoice(choice === 'add_calendar' ? null : 'add_calendar')}>Add to Calendar</button>
          </div>
        </section>
      ) : (
        <p className="pw-muted">A next step can be chosen once the screenshot has a saved analysis.</p>
      )}
      <MakeNotesDraft key={`notes-${shot.screenshotId}`} screenshot={shot} providerMode={provider.mode} canStart={choice === 'make_notes'} />
      <CalendarDraft key={`calendar-${shot.screenshotId}`} screenshot={shot} providerMode={provider.mode} canStart={choice === 'add_calendar'} />
    </div>
  );
}

export function ActionCard({ ghost, shot, synthetic, initialChoice, onChanged }: {
  ghost: GhostView; shot: Screenshot | null; synthetic: boolean; initialChoice: CardChoice; onChanged: () => void;
}) {
  if (synthetic || !shot) return <DemoCard ghost={ghost} />;
  return <LiveCard ghost={ghost} shot={shot} initialChoice={initialChoice} onChanged={onChanged} />;
}
