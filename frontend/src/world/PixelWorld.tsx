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

const MODE_NOTE = {
  live: null,
  demo: 'Demo data (prototype): synthetic ghosts, no backend calls.',
  fallback: 'Backend not reachable: showing synthetic demo ghosts (prototype data, not your screenshots).',
} as const;

export default function PixelWorld() {
  const gallery = useWorldGallery();
  const ghosts = useMemo(() => deriveGhostViews(gallery.screenshots), [gallery.screenshots]);
  const layout = useMemo(() => layoutGhosts(ghosts), [ghosts]);
  const crypt = archivedCount(gallery.screenshots);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [opened, setOpened] = useState<OverlayId | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const selected = ghosts.find((g) => g.id === selectedId) ?? null;
  const synthetic = gallery.mode !== 'live';

  const open = (id: OverlayId, el: HTMLElement | null) => { opener.current = el; setOpened(id); };

  return (
    <div className="pw-root" data-testid="pixel-world" data-mode={gallery.mode}>
      <WorldErrorBoundary>
        <header className="pw-hud">
          <LumiPortrait ghostCount={ghosts.length} />
          <div className="pw-title">
            <h1>The Lantern Graveyard</h1>
            {MODE_NOTE[gallery.mode] && <p className="pw-mode" role="status">{MODE_NOTE[gallery.mode]}</p>}
          </div>
          <Toolbar onOpen={(id, el) => open(id, el)} />
        </header>
        {gallery.loading ? (
          <p className="pw-loading" role="status">Lighting the lanterns…</p>
        ) : (
          <SceneViewport
            layout={layout} selectedId={selectedId} demo={synthetic} controlsEnabled={opened === null}
            onSelectGhost={(id, el) => { opener.current = el; setSelectedId(id); }}
            onOpenLocation={(l: WorldLocation, el) => open(l.overlay, el)}
            onOpenCrowd={(_c, el) => open('queue', el)}
          />
        )}
        <section className="pw-status" aria-live="polite">
          {selected ? (
            <div className="pw-inspect" data-testid="inspect">
              <strong>{selected.filename}</strong>{synthetic && <em> (demo)</em>}
              <span>{selected.label}{selected.category ? ` · ${selected.category}` : ''}{selected.isDuplicate ? ' · duplicate upload' : ''}</span>
              {selected.epitaph && <q>{selected.epitaph}</q>}
              <button type="button" onClick={() => setSelectedId(null)}>Clear selection</button>
            </div>
          ) : (
            <p>Walk with WASD or the arrow keys. Press E near a building, or click a ghost to inspect it.</p>
          )}
          <p className="pw-crypt-count">Crypt: {crypt} {crypt === 1 ? 'resting screenshot' : 'resting screenshots'}</p>
          {opened && <p className="pw-pending" data-testid="opened">Opened: {opened} (panel arrives with the overlays build)</p>}
          {opened && <button type="button" onClick={() => { setOpened(null); opener.current?.focus(); }}>Close</button>}
        </section>
      </WorldErrorBoundary>
    </div>
  );
}
