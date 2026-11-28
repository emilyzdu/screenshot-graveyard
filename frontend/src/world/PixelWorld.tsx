import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './world.css';
import { useWorldGallery } from './data/useWorldGallery';
import { useWorldRecords } from './data/useWorldRecords';
import { deriveGhostViews } from './model/ghostView';
import { ghostStage, ghostStages, type RecordStatus } from './model/lifecycle';
import { layoutGhosts } from './model/slots';
import type { OverlayId } from './model/locations';
import type { LumiActivity, LumiReaction } from './lumi/character';
import { SceneViewport } from './scene/SceneViewport';
import { LumiPortrait } from './hud/LumiPortrait';
import { Toolbar } from './hud/Toolbar';
import { WorldErrorBoundary } from './WorldErrorBoundary';
import { OverlayHost } from './overlays/OverlayHost';
import { ActionCard, type CardChoice } from './overlays/ActionCard';
import { QuickQueue } from './overlays/QuickQueue';
import { PortalInfo } from './overlays/PortalInfo';
import { CryptOverlay } from './overlays/CryptOverlay';
import { SettingsOverlay } from './overlays/SettingsOverlay';
import { UploadWell } from './overlays/UploadWell';
import { RecordRooms } from './overlays/RecordRooms';
import { LibraryNotes } from './overlays/LibraryNotes';
import type { Execution } from '../api/tools';
import type { PlanActivity } from '../shell/ActionPlanPanel';

const TITLES: Record<OverlayId, string> = {
  upload: 'Upload Well', calendar: 'Clock Tower', notes: 'Memory Library', altar: 'Approval Altar',
  crypt: 'Crypt', portal: 'Portal Hall', queue: 'Quick Queue', settings: 'Settings',
};

type Open = { kind: OverlayId } | { kind: 'card'; id: number; choice: CardChoice; previous: OverlayId | null };
type Reaction = { state: LumiReaction; token: number };

export default function PixelWorld() {
  const gallery = useWorldGallery();
  const [opened, setOpened] = useState<Open | null>(null);
  const [reaction, setReaction] = useState<Reaction | null>(null);
  const [fresh, setFresh] = useState<number[]>([]);
  const [transition, setTransition] = useState('');
  const freshTimer = useRef(0);
  const transitionTimer = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const slots = useRef(new Map<number, number>());
  const lastExecution = useRef(new Map<number, Execution['status']>());
  const synthetic = gallery.mode !== 'live';

  const targets = gallery.screenshots.filter((shot) => shot.state === 'active')
    .map((shot) => `${shot.screenshotId}:${shot.analysis ? 'yes' : 'no'}`).sort().join(',');
  const { records, loading: recordsLoading, error: recordsError, refresh: refreshRecords, update, watchRevive } =
    useWorldRecords(targets, !synthetic && !gallery.loading, opened?.kind === 'card' ? opened.id : null, gallery.refresh);
  const byId = useMemo(() => new Map(gallery.screenshots.map((shot) => [shot.screenshotId, shot])), [gallery.screenshots]);
  const ghosts = useMemo(() => deriveGhostViews(gallery.screenshots).map((ghost) => {
    const shot = byId.get(ghost.id);
    const status = records[ghost.id];
    const stage = shot && ghostStage(shot, status, fresh.includes(ghost.id));
    return { ...ghost, stage, label: stage ? ghostStages[stage].label : ghost.label,
      tools: status?.plan?.actions.map((action) => action.argumentBlock) };
  }), [byId, fresh, gallery.screenshots, records]);
  const layout = useMemo(() => layoutGhosts(ghosts, slots.current), [ghosts]);
  const archived = useMemo(() => gallery.screenshots.filter((shot) => shot.state === 'archived'), [gallery.screenshots]);

  useEffect(() => {
    if (!reaction) return;
    const timer = window.setTimeout(() => setReaction(null), 2400);
    return () => window.clearTimeout(timer);
  }, [reaction]);
  useEffect(() => () => { window.clearTimeout(freshTimer.current); window.clearTimeout(transitionTimer.current); }, []);

  const react = useCallback((state: LumiReaction) => setReaction({ state, token: performance.now() }), []);
  const observeExecution = useCallback((execution: Execution) => {
    if (lastExecution.current.get(execution.executionId) === execution.status) return;
    lastExecution.current.set(execution.executionId, execution.status);
    if (execution.status === 'succeeded') react('celebrating');
    if (execution.status === 'unknown' || execution.status === 'failed' || execution.status === 'rejected') react('concerned');
  }, [react]);
  useEffect(() => {
    for (const { execution } of Object.values(records)) if (execution) observeExecution(execution);
  }, [records, observeExecution]);

  const flash = (state: string) => {
    setTransition(state);
    window.clearTimeout(transitionTimer.current);
    transitionTimer.current = window.setTimeout(() => setTransition(''), 420);
  };
  const viewport = () => rootRef.current?.querySelector<HTMLElement>('[role="application"]') ?? null;
  const openTool = (kind: OverlayId, source: HTMLElement | null) => {
    opener.current = source ?? viewport();
    setOpened({ kind });
  };
  const openCard = (id: number, source: HTMLElement | null, choice: CardChoice = null) => {
    const previous = opened && opened.kind !== 'card' ? opened.kind : null;
    if (!previous) opener.current = source ?? viewport();
    setOpened({ kind: 'card', id, choice, previous });
  };
  const close = () => {
    flash(opened?.kind === 'card' ? 'close-card' : 'return');
    setOpened(null);
    const source = opener.current;
    window.setTimeout(() => {
      if (source?.isConnected) source.focus();
      else viewport()?.focus();
    }, 0);
  };

  const planActivity = (id: number, activity: PlanActivity) => {
    if (activity.kind === 'plan') {
      const before = records[id]?.plan;
      update(id, { plan: activity.plan, planning: false });
      const needsInput = activity.plan.decision === 'needs_clarification' || activity.plan.actions.some((action) => action.enabled && action.problems.length > 0);
      if (needsInput && before?.versionId !== activity.plan.versionId) react('confused');
    } else if (activity.kind === 'planning') {
      update(id, { planning: activity.pending });
    } else if (activity.kind === 'approved') react('blessing');
    else if (activity.kind === 'dispatch-unconfirmed') {
      update(id, { dispatchUnconfirmed: true });
      react('concerned');
    }
    else {
      const execution = activity.execution;
      update(id, { execution, dispatchUnconfirmed: false });
    }
  };

  const card = opened?.kind === 'card' ? opened : null;
  const cardGhost = card ? ghosts.find((ghost) => ghost.id === card.id) : null;
  const cardShot = card ? byId.get(card.id) ?? null : null;
  const title = card ? 'Screenshot Action Card' : opened ? TITLES[opened.kind as OverlayId] : '';
  const statuses = ghosts.map((ghost) => records[ghost.id]);
  const activity: LumiActivity | null = ghosts.some((ghost) => ghost.stage === 'executing') ? 'delivering' :
    statuses.some((status) => status?.revive === 'analyzing') ? 'analyzing' : statuses.some((status) => status?.planning) ? 'thinking' : null;
  const waiting = ghosts.filter((ghost) => ghost.stage !== 'succeeded').length;

  return (
    <div className="pw-root" data-testid="pixel-world" data-mode={gallery.mode} data-transition={transition} ref={rootRef}>
      <div className="pw-exterior" aria-hidden={opened ? true : undefined} ref={(element) => { element?.toggleAttribute('inert', !!opened); }}>
        <WorldErrorBoundary>
          <SceneViewport layout={layout} selectedId={card?.id ?? null} demo={synthetic} controlsEnabled={!opened}
            activity={activity} reaction={reaction?.state ?? null} onSelectGhost={openCard}
            onOpenLocation={(location, source) => openTool(location.overlay, source)}
            onOpenCrowd={(_crowd, source) => openTool('queue', source)} />
        </WorldErrorBoundary>
        <header className="pw-hud">
          <LumiPortrait ghostCount={waiting} />
          <Toolbar onOpen={openTool} active={opened && opened.kind !== 'card' ? opened.kind : null} />
        </header>
        <h1 className="pw-sr">The Lantern Graveyard</h1>
        {gallery.loading && <p className="pw-world-status" role="status">Lighting the lanterns…</p>}
        {gallery.error && <div className="pw-world-status" role="alert">Screenshot records are unavailable. <button className="pw-btn" type="button" onClick={gallery.refresh}>Try again</button></div>}
        {gallery.mode === 'demo' && <p className="pw-mode" role="status">Demo Mode <span className="pw-sr">Synthetic screenshots.</span></p>}
        <footer className="pw-status" aria-label="Movement controls">
          <span><kbd>WASD</kbd> <span className="pw-control-separator">/</span> <kbd>↑↓←→</kbd> Move</span>
          <span><kbd>E</kbd> Interact</span>
          <span><kbd>Esc</kbd> Back</span>
        </footer>
      </div>
      {opened && (
        <OverlayHost key={card ? `card-${card.id}` : opened.kind} kind={opened.kind} title={title} label={cardGhost ? `${title} · ${cardGhost.filename}` : undefined} onClose={close}
          onBack={card?.previous ? () => { if (card.previous) setOpened({ kind: card.previous }); } : undefined}
          expression={activity ?? reaction?.state ?? null}>
          {gallery.mode === 'fallback' && <p role="status">The workspace is unavailable. Return to the graveyard to retry.</p>}
          {card ? (
            cardGhost ? (
              <ActionCard ghost={cardGhost} shot={cardShot} synthetic={synthetic} initialChoice={card.choice} onChanged={gallery.refresh}
                onArchived={() => { gallery.refresh(); close(); flash('archive'); }}
                onStatus={(status) => update(card.id, status)}
                onActivity={(status) => planActivity(card.id, status)}
                onRevive={(state: RecordStatus['revive'], operationId) => {
                  update(card.id, { revive: state });
                  watchRevive(card.id, operationId);
                  if (state === 'unknown' || state === 'failed') react('concerned');
                }} />
            ) : <p role="status">{fresh.includes(card.id) ? 'Loading the uploaded screenshot…' : 'This screenshot is no longer in the graveyard.'}</p>
          ) : opened.kind === 'queue' ? (
            <QuickQueue ghosts={ghosts} showListLink onPick={openCard} />
          ) : opened.kind === 'upload' ? (
            <UploadWell synthetic={synthetic} onPick={openCard} onUploaded={(ids) => {
              setFresh(ids);
              gallery.refresh();
              react('greeting');
              window.clearTimeout(freshTimer.current);
              freshTimer.current = window.setTimeout(() => setFresh([]), 4200);
            }} />
          ) : opened.kind === 'crypt' ? (
            <CryptOverlay archived={archived} synthetic={synthetic} loading={gallery.loading} onChanged={gallery.refresh}
              onRestored={() => { react('greeting'); flash('restore'); }} />
          ) : opened.kind === 'settings' ? <SettingsOverlay synthetic={synthetic} /> : (
            <>
              {opened.kind === 'portal' && <PortalInfo synthetic={synthetic} />}
              {opened.kind === 'notes' && !synthetic && <LibraryNotes />}
              <RecordRooms room={opened.kind as 'portal' | 'altar' | 'notes' | 'calendar'} ghosts={ghosts}
                records={records} loading={recordsLoading || gallery.loading} error={recordsError ?? gallery.error} onRefresh={refreshRecords}
                onPick={(id, source, choice) => openCard(id, source, choice ?? (opened.kind === 'altar' ? 'review_plan' : opened.kind === 'portal' ? 'deliver' : null))} />
            </>
          )}
        </OverlayHost>
      )}
    </div>
  );
}
