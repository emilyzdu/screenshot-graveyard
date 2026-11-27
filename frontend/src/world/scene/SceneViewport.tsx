import { useEffect, useMemo, useRef, useState } from 'react';
import { assetUrl } from '../assets';
import { LUMI_START, LOCATIONS, PROPS, COLLIDERS, STAGE, nearestLocation, type WorldLocation } from '../model/locations';
import type { Layout, Crowd } from '../model/slots';
import { initialLumi, isIdle, step, type LumiState } from '../lumi/lumiController';
import { useLumiInput } from '../lumi/useLumiInput';
import { GhostSprite } from './GhostSprite';
import { LocationHotspot } from './LocationHotspot';
import { LumiSprite } from './LumiSprite';
import { stageScale } from './stageScale';
import { useReducedMotion } from './useReducedMotion';

export interface SceneViewportProps {
  layout: Layout;
  selectedId: number | null;
  demo: boolean;
  /** When false (an overlay is open) Lumi ignores the keyboard. */
  controlsEnabled: boolean;
  onSelectGhost: (id: number, opener: HTMLElement) => void;
  onOpenLocation: (l: WorldLocation, opener: HTMLElement | null) => void;
  onOpenCrowd: (c: Crowd, opener: HTMLElement) => void;
}

const FACE_COL = { down: 0, up: 1, left: 2, right: 3 } as const;

export function SceneViewport({ layout, selectedId, demo, controlsEnabled, onSelectGhost, onOpenLocation, onOpenCrowd }: SceneViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const lumiRef = useRef<HTMLDivElement>(null);
  const lumi = useRef<LumiState>(initialLumi(LUMI_START.x, LUMI_START.y));
  const nearRef = useRef<WorldLocation | null>(null);
  const [near, setNear] = useState<WorldLocation | null>(null);
  const [scale, setScale] = useState(1);
  const reduced = useReducedMotion();
  const openRef = useRef(onOpenLocation); openRef.current = onOpenLocation;

  const input = useLumiInput({
    enabled: controlsEnabled,
    onInteract: () => { if (nearRef.current) openRef.current(nearRef.current, null); },
  });

  // Stage scale follows the host width and the window height.
  useEffect(() => {
    const host = hostRef.current; if (!host) return;
    const measure = () => {
      const w = host.clientWidth || STAGE.w;
      const h = Math.max(240, (window.innerHeight || STAGE.h) - 150);
      setScale(stageScale(w, h));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(host);
    return () => { window.removeEventListener('resize', measure); ro?.disconnect(); };
  }, []);

  // One animation loop; pauses while the tab is hidden.
  const inputRef = useRef(input); inputRef.current = input;
  useEffect(() => {
    let raf = 0; let last = performance.now(); let frameClock = 0;
    const paint = () => {
      const el = lumiRef.current; if (!el) return;
      const s = lumi.current;
      const idle = isIdle(s);
      frameClock = Math.floor((performance.now() / (s.moving ? 160 : 480)) % 2);
      const frame = reduced ? 0 : frameClock;
      el.style.transform = `translate(${Math.round(s.x) - 14}px, ${Math.round(s.y) - 32}px)`;
      el.style.zIndex = String(10 + Math.round(s.y));
      el.dataset.facing = s.facing; el.dataset.state = s.moving ? 'walk' : idle ? 'idle' : 'still';
      el.style.setProperty('--pw-lx', `${-FACE_COL[s.facing] * 28}px`);
      el.style.setProperty('--pw-ly', `${-frame * 34}px`);
    };
    const tick = (now: number) => {
      const dt = Math.min(now - last, 50); last = now;
      if (!document.hidden) {
        lumi.current = step(lumi.current, inputRef.current.read(), dt, COLLIDERS);
        paint();
        const n = nearestLocation(lumi.current.x, lumi.current.y);
        if (n?.id !== nearRef.current?.id) { nearRef.current = n; setNear(n); }
      }
      raf = requestAnimationFrame(tick);
    };
    paint(); raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  const props = useMemo(() => PROPS, []);
  const scaledStyle = { width: STAGE.w * scale, height: STAGE.h * scale } as const;

  return (
    <div className="pw-stage-host" ref={hostRef}>
      <div className="pw-stage-frame" style={scaledStyle}>
        <div className="pw-stage" role="application" aria-label="The Lantern Graveyard. Move Lumi with WASD or the arrow keys." data-scale={scale}
          style={{ transform: `scale(${scale})` }}>
          <img className="pw-layer" src={assetUrl('bg-sky')} alt="" style={{ top: 0 }} />
          <img className="pw-layer" src={assetUrl('moon')} alt="" style={{ left: 270, top: 10, width: 96, height: 96 }} />
          <img className="pw-layer" src={assetUrl('bg-far')} alt="" style={{ top: 0, height: 190 }} />
          <img className="pw-layer" src={assetUrl('ground')} alt="" style={{ top: 0 }} />

          {LOCATIONS.map((l) => (
            <img key={l.id} className="pw-sprite" src={assetUrl(l.asset)} alt="" data-sprite={l.id}
              style={{ left: l.sprite.x, top: l.sprite.y, width: l.sprite.w, height: l.sprite.h, zIndex: 10 + l.footprint.y + l.footprint.h }} />
          ))}
          {props.map((p) => (
            <img key={p.id} className="pw-sprite" src={assetUrl(p.asset)} alt="" data-sprite={p.id}
              style={{ left: p.x, top: p.y, width: p.w, height: p.h, zIndex: 10 + (p.solid ? p.solid.y + p.solid.h : p.y + p.h) }} />
          ))}
          {[[440, 238], [560, 276], [60, 164], [500, 152]].map(([x, y]) => (
            <img key={`${x}-${y}`} className="pw-glow pw-glow--lamp" src={assetUrl('glow-lamp')} alt="" style={{ left: x - 36, top: y - 36 }} />
          ))}
          <img className="pw-glow pw-glow--portal" src={assetUrl('glow-portal')} alt="" style={{ left: 556 + 36 - 60, top: 184 + 46 - 60 }} />

          {LOCATIONS.map((l) => <LocationHotspot key={l.id} location={l} near={near?.id === l.id} onOpen={onOpenLocation} />)}

          {layout.placed.map(({ ghost, slot }) => (
            <GhostSprite key={ghost.id} ghost={ghost} slot={slot} selected={ghost.id === selectedId} reducedMotion={reduced} demo={demo} onSelect={onSelectGhost} />
          ))}
          {layout.crowds.map((c) => (
            <button key={c.location} type="button" className="pw-crowd" data-crowd={c.location}
              aria-label={`${c.count} more screenshots ${c.location === 'well' ? 'at the Upload Well' : 'at the Lantern Crossroads'}`}
              style={{ left: c.slot.x - 10, top: c.slot.y - 24, zIndex: 400 }} onClick={(e) => onOpenCrowd(c, e.currentTarget)}>
              <img src={assetUrl('prop-lamp')} alt="" />
              <span className="pw-crowd__count">+{c.count}</span>
            </button>
          ))}

          <LumiSprite ref={lumiRef} />

          <img className="pw-layer pw-fg" src={assetUrl('foreground')} alt="" style={{ top: 0, zIndex: 500 }} />
          <img className="pw-fg" src={assetUrl('wisteria-canopy')} alt="" style={{ left: 0, top: 0, width: 200, zIndex: 501 }} />
          <img className="pw-fg" src={assetUrl('wisteria-canopy')} alt="" style={{ left: 440, top: 0, width: 200, zIndex: 501, transform: 'scaleX(-1)' }} />
          <div className="pw-vignette" />
          {near && controlsEnabled && <div className="pw-hint" style={{ zIndex: 600 }}><kbd>E</kbd> {near.label}</div>}
        </div>
      </div>
    </div>
  );
}
