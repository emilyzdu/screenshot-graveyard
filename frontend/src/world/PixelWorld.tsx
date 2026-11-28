import { useMemo, useRef, useState } from 'react';
import './world.css';
import { useWorldGallery } from './data/useWorldGallery';
import { archivedCount, deriveGhostViews } from './model/ghostView';
import { layoutGhosts } from './model/slots';
import type { OverlayId, WorldLocation } from './model/locations';
import { SceneViewport } from './scene/SceneViewport';
import { LumiPortrait } from './hud/LumiPortrait';
import { Toolbar } from './hud/Toolbar';
import { WorldErrorBoundary } from './WorldErrorBoundary';
import { useReducedMotion } from './scene/useReducedMotion';
import { OverlayHost } from './overlays/OverlayHost';
import { ActionCard, type CardChoice } from './overlays/ActionCard';
import { QuickQueue } from './overlays/QuickQueue';
import { PortalInfo } from './overlays/PortalInfo';
import { CryptOverlay } from './overlays/CryptOverlay';
import { SettingsOverlay } from './overlays/SettingsOverlay';
import { UploadWell } from './overlays/UploadWell';
import { ApprovalAltar } from './overlays/ApprovalAltar';

// Full text stays available to assistive tech and as a tooltip; sighted users see a small badge.
const MODE_NOTE = {
  live: null,
  demo: { badge: 'Demo Mode', full: 'Demo data (prototype): synthetic ghosts, no backend calls.' },
  fallback: { badge: 'Offline Demo', full: 'Backend not reachable: showing synthetic demo ghosts (prototype data, not your screenshots).' },
} as const;

const TITLES: Record<OverlayId, string> = {
  upload: 'Upload Well', calendar: 'Clock Tower: calendar', notes: 'Library: notes', altar: 'Approval Altar',
  crypt: 'The Crypt', portal: 'Portal', queue: 'Quick Queue', settings: 'Settings',
};

type Open = { kind: OverlayId } | { kind: 'card'; id: number; choice: CardChoice };

export default function PixelWorld() {
  const gallery = useWorldGallery();
  const reduced = useReducedMotion();
  const ghosts = useMemo(() => deriveGhostViews(gallery.screenshots), [gallery.screenshots]);
  const layout = useMemo(() => layoutGhosts(ghosts), [ghosts]);
  const crypt = archivedCount(gallery.screenshots);
  const archived = useMemo(() => gallery.screenshots.filter((s) => s.state === 'archived'), [gallery.screenshots]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [opened, setOpened] = useState<Open | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const synthetic = gallery.mode !== 'live';

  const openTool = (id: OverlayId, el: HTMLElement | null) => {
    opener.current = el ?? (rootRef.current?.querySelector<HTMLElement>('[role="application"]') ?? null);
    setSelectedId(null); setOpened({ kind: id });
  };
  const openCard = (id: number, el: HTMLElement | null, choice: CardChoice = null) => {
    if (el && !(opened && el.closest('[data-world-overlay]'))) opener.current = el;
    else if (!opener.current) opener.current = rootRef.current?.querySelector<HTMLElement>('[role="application"]') ?? null;
    setSelectedId(id); setOpened({ kind: 'card', id, choice });
  };
  const close = () => {
    setOpened(null); setSelectedId(null);
    const el = opener.current;
    // Wait for the dialog to unmount, then hand focus back to whoever opened it.
    setTimeout(() => { if (el && el.isConnected) el.focus(); }, 0);
  };

  const analyzed = ghosts.filter((g) => g.category !== null);
  const card = opened?.kind === 'card' ? opened : null;
  const cardGhost = card ? ghosts.find((g) => g.id === card.id) ?? null : null;
  const cardShot = card ? gallery.screenshots.find((s) => s.screenshotId === card.id) ?? null : null;
  const title = card ? (cardGhost ? `Screenshot ${cardGhost.filename}` : 'Screenshot') : opened && opened.kind !== 'card' ? TITLES[opened.kind] : '';

  return (
    <div className="pw-root" data-testid="pixel-world" data-mode={gallery.mode} ref={rootRef}>
      <header className="pw-hud">
        <LumiPortrait ghostCount={ghosts.length} />
        <div className="pw-title">
          <h1>The Lantern Graveyard</h1>
          {MODE_NOTE[gallery.mode] && (
            <p className="pw-mode" role="status" title={MODE_NOTE[gallery.mode]!.full}>
              <span aria-hidden="true" className="pw-mode__dot" />
              <span aria-hidden="true">{MODE_NOTE[gallery.mode]!.badge}</span>
              <span className="pw-sr">{MODE_NOTE[gallery.mode]!.full}</span>
            </p>
          )}
        </div>
        <Toolbar onOpen={openTool} active={opened && opened.kind !== 'card' ? opened.kind : null} />
      </header>
      <WorldErrorBoundary>
        {gallery.loading ? (
          <p className="pw-loading" role="status">Lighting the lanterns…</p>
        ) : (
          <SceneViewport
            layout={layout} selectedId={selectedId} demo={synthetic} controlsEnabled={opened === null}
            onSelectGhost={(id, el) => openCard(id, el)}
            onOpenLocation={(l: WorldLocation, el) => openTool(l.overlay, el)}
            onOpenCrowd={(_c, el) => openTool('queue', el)}
          />
        )}
        <section className="pw-status" aria-live="polite">
          <p>Walk with WASD or the arrow keys. Press E near a building, or click a ghost to open its card.</p>
          <p className="pw-crypt-count">Crypt: {crypt} {crypt === 1 ? 'resting screenshot' : 'resting screenshots'}</p>
        </section>
      </WorldErrorBoundary>
      {opened && (
        <OverlayHost key={card ? `card-${card.id}` : opened.kind} title={title} onClose={close} wide={opened.kind === 'card'}>
          {card ? (
            cardGhost ? (
              <ActionCard ghost={cardGhost} shot={cardShot} synthetic={synthetic} initialChoice={card.choice} onChanged={gallery.refresh} />
            ) : <p role="status">This screenshot is no longer in the graveyard.</p>
          ) : opened.kind === 'queue' ? (
            <QuickQueue ghosts={ghosts} onPick={(id, el) => openCard(id, el)} />
          ) : opened.kind === 'calendar' ? (
            <QuickQueue ghosts={analyzed} onPick={(id, el) => openCard(id, el, 'add_calendar')}
              hint={analyzed.length ? 'Pick an analyzed screenshot to prepare a calendar draft in its card. Nothing is sent until you press Prepare there.' : 'No analyzed screenshots yet. Revive one first.'} />
          ) : opened.kind === 'notes' ? (
            <QuickQueue ghosts={analyzed} onPick={(id, el) => openCard(id, el, 'make_notes')}
              hint={analyzed.length ? 'Pick an analyzed screenshot to prepare notes in its card. Nothing is sent until you press Prepare there.' : 'No analyzed screenshots yet. Revive one first.'} />
          ) : opened.kind === 'upload' ? (
            <UploadWell synthetic={synthetic} onUploaded={gallery.refresh} />
          ) : opened.kind === 'altar' ? (
            <ApprovalAltar ghosts={ghosts} synthetic={synthetic} reducedMotion={reduced} onPick={(id, el) => openCard(id, el)} />
          ) : opened.kind === 'crypt' ? (
            <CryptOverlay archived={archived} synthetic={synthetic} onChanged={gallery.refresh} />
          ) : opened.kind === 'portal' ? (
            <PortalInfo synthetic={synthetic} />
          ) : <SettingsOverlay synthetic={synthetic} />}
        </OverlayHost>
      )}
    </div>
  );
}
