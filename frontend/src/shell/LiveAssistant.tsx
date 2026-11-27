import type { AutoProcessState, ProviderMode } from '../api/ai';
import type { Screenshot } from '../api/client';
import { describeAuxiliaryResultOrigin, describeResultOrigin } from '../ai/messages';
import { getReviveEntry, getReviveSuccess } from '../ai/reviveCoordinator';
import { Ghost } from '../ui/Ghost';
import { Icon } from '../ui/Icon';
import { Badge, Button, MenuButton } from '../ui/primitives';
import { CalendarDraft } from './CalendarDraft';
import { MakeNotesDraft } from './MakeNotesDraft';
import {
  LIVE_ACTIONS,
  LIVE_ACTION_ORDER,
  epitaphProvenanceLabel,
  type ActionChoice,
  type LiveActionId,
  type RuleSuggestion,
} from './nextAction';

import type { AnalysisValidation } from './useValidatedAnalysis';

interface Props {
  /** Selected screenshots (Workspace view only), in the order the user picked them. */
  selected: Screenshot[];
  providerMode: ProviderMode | 'unknown';
  validation: AnalysisValidation;
  conflicts: boolean;
  rule: RuleSuggestion;
  onRetry: () => void;
  /** The user's choice for each screenshot id (transient, owned by LiveWorkspace). */
  choices: Record<number, ActionChoice>;
  onChoose: (screenshotId: number, choice: ActionChoice | null) => void;
  onOpen: (screenshotId: number, opener: HTMLElement) => void;
  onClearSelection: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Batch 6B: the latest automatic-preparation state per screenshot (when automation is on). */
  autoStates?: Record<number, AutoProcessState>;
  /** Batch 6B: bumps when work settled on the server, so the draft panels re-read. */
  draftEpochs?: Record<number, number>;
}

/**
 * Live Quiet Assistant (Batch 3B). Shows what the server saved for ONE selected
 * screenshot and a conservative, rule-based next action the user can accept or
 * override. Workspace owns the validated read. Choosing an action is
 * local UI state that ends at "Ready to prepare": nothing is generated, saved,
 * classified or sent from here.
 */
export function LiveAssistant({
  selected,
  providerMode,
  validation,
  conflicts,
  rule,
  onRetry,
  choices,
  onChoose,
  onOpen,
  onClearSelection,
  collapsed,
  onToggleCollapsed,
  autoStates = {},
  draftEpochs = {},
}: Props) {
  const one = selected.length === 1 ? selected[0] : null;
  if (collapsed) {
    return (
      <aside className="sg-assistant sg-assistant--collapsed ui-card" aria-label="Quiet Assistant (collapsed)">
        <button type="button" className="sg-assistant__expand" aria-expanded="false" onClick={onToggleCollapsed}>
          <Ghost size={34} />
          <span className="sg-assistant__expand-text">
            <b>Quiet Assistant</b>
            <small>{one ? `About ${one.originalFilename || `Screenshot #${one.screenshotId}`}` : 'Select a screenshot'}</small>
          </span>
          <Icon name="chevronDown" size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sg-assistant ui-card" aria-label="Quiet Assistant" data-testid="live-assistant" tabIndex={-1}>
      <div className="sg-assistant__head">
        <Ghost size={44} />
        <div>
          <h2 className="sg-display sg-assistant__title">Quiet Assistant</h2>
          <p>Shows what was saved for a screenshot and helps you pick a next step.</p>
        </div>
        <button
          type="button"
          className="sg-icon-btn sg-icon-btn--sm"
          aria-expanded="true"
          aria-label="Collapse assistant"
          onClick={onToggleCollapsed}
        >
          <Icon name="chevronDown" size={16} style={{ transform: 'rotate(180deg)' }} />
        </button>
      </div>

      {selected.length === 0 && (
        <p className="sg-suggest--none" role="status">
          Tick a screenshot&apos;s box to see what was saved for it and choose a next step. Nothing is analyzed or
          sent by selecting it.
        </p>
      )}

      {selected.length > 1 && (
        <div className="sg-suggest--none" role="status">
          <p>
            {selected.length} screenshots selected. For now, choosing a next step works on one screenshot at a time.
            Keep one selected.
          </p>
          <Button size="sm" onClick={onClearSelection}>
            Clear selection
          </Button>
        </div>
      )}

      {one && (
        <OneScreenshot
          shot={one}
          read={validation}
          conflicts={conflicts}
          rule={rule}
          providerMode={providerMode}
          choice={choices[one.screenshotId]}
          onChoose={(c) => onChoose(one.screenshotId, c)}
          onOpen={(el) => onOpen(one.screenshotId, el)}
          onRetry={onRetry}
          auto={autoStates[one.screenshotId]}
          epoch={draftEpochs[one.screenshotId] ?? 0}
        />
      )}

      <div className="sg-live-links">
        <p className="sg-muted">
          Notes and calendar drafts for one screenshot open right here. Study notes built from several screenshots are
          in the classic workspace.
        </p>
        <a className="sg-link" href="?view=classic">Open classic workspace</a>
        <a className="sg-link" href="?demo=1">Explore the visual demo</a>
      </div>
    </aside>
  );
}

function OneScreenshot({
  shot,
  read,
  conflicts,
  rule,
  providerMode,
  choice,
  onChoose,
  onOpen,
  onRetry,
  auto,
  epoch = 0,
}: {
  auto?: AutoProcessState;
  epoch?: number;
  shot: Screenshot;
  read: AnalysisValidation;
  providerMode: ProviderMode | 'unknown';
  conflicts: boolean;
  rule: RuleSuggestion;
  choice: ActionChoice | undefined;
  onChoose: (choice: ActionChoice | null) => void;
  onOpen: (opener: HTMLElement) => void;
  onRetry: () => void;
}) {
  const id = shot.screenshotId;
  const title = shot.originalFilename || `Screenshot #${id}`;
  const summary = shot.analysis;

  if (!summary) {
    const entry = getReviveEntry(id);
    const confirmed = getReviveSuccess(id);
    return (
      <section className="sg-suggest" aria-label={`About ${title}`}>
        <p className="sg-suggest__msg">
          <Icon name="info" size={18} />
          <span>
            {confirmed
              ? `Revive finished for ${title}, but its result has not loaded yet. Open it to retry loading the result.`
              : entry
                ? entry.phase === 'unresolved'
                  ? `An earlier Revive for ${title} is not confirmed as finished yet. Open it to check its status.`
                  : `A Revive for ${title} is in progress.`
                : `${title} has not been analyzed yet. Nothing is analyzed until you open it, allow AI processing and press Revive.`}
          </span>
        </p>
        <Button size="sm" icon="expand" onClick={(e) => onOpen(e.currentTarget)}>
          Open screenshot
        </Button>
        <p className="sg-muted">A next step can be chosen once it has a saved analysis.</p>
      </section>
    );
  }

  // Authoritative data: the full read when it succeeded, otherwise the list summary.
  const full = read.phase === 'ready' ? read.analysis : null;
  const category = full ? full.classification.category : summary.category;
  const classUncertain = full ? full.classification.uncertain : summary.uncertain;
  // Batch 6B: the server routed this screenshot and prepared that draft automatically.
  // Only when the server RECORDED that automation started this draft (never inferred from the route).
  const autoChosen =
    auto?.preparation?.trigger === 'auto' && auto.route !== null && auto.preparation.action === auto.route.action;
  const others = LIVE_ACTION_ORDER.filter((a) =>
    choice ? a !== choice.action : autoChosen ? a !== auto?.route?.action : rule.kind !== 'suggest' || a !== rule.action);
  const choose = (action: LiveActionId, basis: ActionChoice['basis']) => onChoose({ action, basis, category: full ? category : null });

  return (
    <>
      <section className="sg-suggest" aria-label={`About ${title}`}>
        <div className="sg-live-analysis__head">
          <span className="sg-result__category">{category}</span>
          {!full && <Badge tone={summary.epitaphOrigin === 'manual_edit' ? 'green' : 'muted'}>
            {epitaphProvenanceLabel(summary.epitaphOrigin, summary.epitaphProvider ?? null)}
          </Badge>}
          {classUncertain && <Badge tone="muted">Marked uncertain</Badge>}
        </div>

        {read.phase === 'loading' && <p role="status" className="sg-muted">Loading the saved analysis…</p>}
        {read.phase === 'error' && (
          <div className="sg-revive__row" role="status">
            <span>The full analysis could not be loaded. Showing the saved summary.</span>
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        )}
        {read.phase === 'missing' && (
          <div className="sg-revive__row" role="status">
            <span>The server did not return a saved analysis for this screenshot. Showing the gallery summary.</span>
            <Button size="sm" onClick={onRetry}>Retry</Button>
          </div>
        )}
        {conflicts && (
          <div className="sg-revive__row" role="status">
            <span>The current analysis differs from the gallery summary. Suggestions are unavailable.</span>
            <Button size="sm" onClick={onRetry}>Refresh analysis</Button>
          </div>
        )}

        <dl className="sg-facts">
          <dt>Epitaph</dt>
          <dd>{full ? full.epitaph.text : summary.epitaph}</dd>
          {full && (
            <>
              <dt>Visible facts</dt>
              <dd>
                {full.epitaph.visibleFacts || 'None recorded.'}
                {full.epitaph.visibleFacts && <small className="sg-muted"> ({describeAuxiliaryResultOrigin(full.epitaph.origin, full.epitaph.provider ?? null)})</small>}
              </dd>
              {full.epitaph.inferredIntent !== null && full.epitaph.inferredIntent !== '' && (
                <>
                  <dt>Possible reason</dt>
                  <dd>
                    {full.epitaph.inferredIntent} (a guess, not a fact)
                    <small className="sg-muted"> ({describeAuxiliaryResultOrigin(full.epitaph.origin, full.epitaph.provider ?? null)})</small>
                  </dd>
                </>
              )}
              <dt>Source</dt>
              <dd>
                Category {describeResultOrigin(full.classification.origin, full.classification.provider ?? null)}; Epitaph{' '}
                {describeResultOrigin(full.epitaph.origin, full.epitaph.provider ?? null)}.
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="sg-next" aria-label="Next step">
        <h3 className="sg-next__title">Next step</h3>
        {!choice && autoChosen && auto?.route ? (
          <div className="sg-next__suggested" role="status">
            <p>
              <Badge tone="violet">Chosen automatically · can be wrong</Badge>{' '}
              <b>{LIVE_ACTIONS[auto.route.action as LiveActionId].label}</b>
            </p>
            <p className="sg-muted">{auto.route.reason} Review the draft below, or choose something else.</p>
          </div>
        ) : choice ? (
          <div className="sg-next__chosen" role="status">
            <p>
              <Badge tone="green">Chosen by you</Badge> <b>{LIVE_ACTIONS[choice.action].label}</b>
              {choice.basis === 'accepted_suggestion' && <span className="sg-muted"> (you accepted the suggestion)</span>}
            </p>
            {choice.category !== null && choice.category !== category && (
              <p className="sg-muted">The category changed since you chose this. Check that it still fits.</p>
            )}
          </div>
        ) : rule.kind === 'suggest' ? (
          <div className="sg-next__suggested" role="status">
            <p>
              <Badge tone="violet">{rule.source === 'ai' ? 'Suggested by AI · can be wrong' : 'Suggested · rule-based'}</Badge>{' '}
              <b>{LIVE_ACTIONS[rule.action].label}</b>
            </p>
            <p className="sg-muted">
              {rule.source === 'ai'
                ? `${rule.reason} Check that it fits before you choose it.`
                : `${rule.reason} This is a fixed rule in this app, not an AI recommendation.`}
            </p>
          </div>
        ) : (
          <p className="sg-muted" role="status">
            No suggestion. {rule.reason}
          </p>
        )}

        <div className="sg-alt__row">
          {!choice && !autoChosen && rule.kind === 'suggest' && (
            <Button size="sm" variant="primary" onClick={() => choose(rule.action, 'accepted_suggestion')}>
              Choose {LIVE_ACTIONS[rule.action].label}
            </Button>
          )}
          <MenuButton
            label={choice || autoChosen || rule.kind === 'suggest' ? 'Something else' : 'Choose a next step'}
            icon="dots"
            items={others.map((a) => ({ id: a, label: LIVE_ACTIONS[a].label }))}
            onSelect={(a) => choose(a as LiveActionId, 'your_choice')}
            className="sg-alt__menu"
          />
          {choice && (
            <Button size="sm" variant="ghost" onClick={() => onChoose(null)}>
              Clear choice
            </Button>
          )}
        </div>

        {choice && choice.action !== 'make_notes' && choice.action !== 'add_calendar' && (
          <div className="sg-next__ready" role="note" aria-label="Ready to prepare">
            <p>
              <Icon name="check" size={15} /> <b>Ready to prepare.</b> {LIVE_ACTIONS[choice.action].hint}.
            </p>
            <Button size="sm" disabled aria-describedby="sg-prepare-why">
              Prepare draft
            </Button>
            <p className="sg-muted" id="sg-prepare-why">
              Preparing a draft for {LIVE_ACTIONS[choice.action].label} is not available yet; only Make Notes and Add
              to Calendar can be prepared in this version. Nothing has been created, saved or sent. Your choice is kept on this page only
              and is lost when you reload.
            </p>
          </div>
        )}
        {/* Persisted on the server: shown whenever a draft exists, even after a reload. */}
        <MakeNotesDraft
          key={`notes-${id}-${epoch}`}
          screenshot={shot}
          providerMode={providerMode}
          canStart={choice?.action === 'make_notes'}
        />
        <CalendarDraft
          key={`calendar-${id}-${epoch}`}
          screenshot={shot}
          providerMode={providerMode}
          canStart={choice?.action === 'add_calendar'}
        />
      </section>
    </>
  );
}
