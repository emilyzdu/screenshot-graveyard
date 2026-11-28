import { useEffect, useRef, useState } from 'react';
import { backdrops } from '../illustrated/art';
import { LUMI_START, LOCATIONS, COLLIDERS, STAGE, nearestLocation, distance, type WorldLocation } from '../model/locations';
import type { Layout, Crowd, Placed } from '../model/slots';
import { initialLumi, step } from '../lumi/lumiController';
import { characterState, expressions, type LumiActivity, type LumiReaction } from '../lumi/character';
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
  controlsEnabled: boolean;
  activity: LumiActivity | null;
  reaction: LumiReaction | null;
  onSelectGhost: (id: number, opener: HTMLElement) => void;
  onOpenLocation: (l: WorldLocation, opener: HTMLElement | null) => void;
  onOpenCrowd: (c: Crowd, opener: HTMLElement) => void;
}

type Target = { kind: 'location'; location: WorldLocation; label: string; key: string } |
  { kind: 'ghost'; placed: Placed; label: string; key: string };

export function SceneViewport(props: SceneViewportProps) {
  const { layout, selectedId, demo, controlsEnabled, onSelectGhost, onOpenLocation, onOpenCrowd } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lumiRef = useRef<HTMLDivElement>(null);
  const lumi = useRef(initialLumi(LUMI_START.x, LUMI_START.y));
  const targetRef = useRef<Target | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [scale, setScale] = useState(1);
  const reduced = useReducedMotion();
  const propsRef = useRef(props);
  propsRef.current = props;

  const input = useLumiInput({
    enabled: controlsEnabled,
    onInteract: () => {
      lumi.current.idleMs = 0;
      const nearest = targetRef.current;
      if (nearest?.kind === 'location') propsRef.current.onOpenLocation(nearest.location, stageRef.current);
      else if (nearest?.kind === 'ghost' && stageRef.current) propsRef.current.onSelectGhost(nearest.placed.ghost.id, stageRef.current);
    },
  });
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setScale(stageScale(host.clientWidth || STAGE.w, host.clientHeight || STAGE.h));
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(host);
    return () => { window.removeEventListener('resize', measure); observer?.disconnect(); };
  }, []);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.max(0, Math.min(now - last, 50));
      last = now;
      const current = propsRef.current;
      const element = lumiRef.current;
      if (!document.hidden && element) {
        if (current.controlsEnabled) lumi.current = step(lumi.current, inputRef.current.read(), dt, COLLIDERS);
        const position = lumi.current;
        const location = nearestLocation(position.x, position.y);
        let range = location ? distance(position, location.entrance) : 26;
        let nearest: Target | null = location ? { kind: 'location', location, label: location.label, key: location.id } : null;
        for (const placed of current.layout.placed) {
          const gap = distance(position, placed.slot);
          if (gap < range) { range = gap; nearest = { kind: 'ghost', placed, label: placed.ghost.filename, key: String(placed.ghost.id) }; }
        }
        if (nearest?.key !== targetRef.current?.key || nearest?.label !== targetRef.current?.label) {
          targetRef.current = nearest;
          setTarget(nearest);
        }
        const state = characterState(current.activity, current.reaction, current.controlsEnabled && position.moving,
          position.facing, position.idleMs, current.controlsEnabled && nearest?.kind === 'ghost');
        const x = Math.round(position.x), y = Math.round(position.y);
        element.style.transform = `translate(${x}px, ${y}px)`;
        element.style.zIndex = String(21 + y);
        element.dataset.x = String(x);
        element.dataset.y = String(y);
        element.dataset.facing = position.facing;
        if (element.dataset.state !== state) {
          element.dataset.state = state;
          const expression = element.querySelector('.pw-lumi__expression');
          if (expression) expression.textContent = expressions[state] ?? '';
        }
      }
      frame = requestAnimationFrame(tick);
    };
    const wake = () => { lumi.current.idleMs = 0; };
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    tick(last);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);

  return (
    <div className="pw-stage-host" ref={hostRef}>
      <div className="pw-stage-frame" style={{ width: STAGE.w * scale, height: STAGE.h * scale }}>
        <div className="pw-stage" ref={stageRef} role="application" tabIndex={-1} aria-label="The Lantern Graveyard. Move Lumi with WASD or the arrow keys."
          data-scale={scale} style={{ transform: `scale(${scale})` }}>
          <img className="pw-world-art" src={backdrops.graveyard} alt="" draggable={false} />
          <span className="pw-world-shimmer" aria-hidden="true" />
          {LOCATIONS.map((location) => <LocationHotspot key={location.id} location={location}
            near={controlsEnabled && target?.key === location.id} onOpen={onOpenLocation} />)}
          {layout.placed.map(({ ghost, slot }) => (
            <GhostSprite key={ghost.id} ghost={ghost} slot={slot} selected={ghost.id === selectedId}
              near={controlsEnabled && target?.key === String(ghost.id)} reducedMotion={reduced} demo={demo} onSelect={onSelectGhost} />
          ))}
          {layout.crowds.map((crowd) => (
            <button key={crowd.location} type="button" className="pw-crowd" data-crowd={crowd.location}
              aria-label={`${crowd.count} more screenshots in Quick Queue`}
              style={{ left: crowd.slot.x, top: crowd.slot.y, zIndex: 400 }} onClick={(event) => onOpenCrowd(crowd, event.currentTarget)}>
              +{crowd.count}
            </button>
          ))}
          <LumiSprite ref={lumiRef} />
        </div>
      </div>
      {target && controlsEnabled && <div className="pw-hint" role="status"><kbd>E</kbd><span>{target.label}</span></div>}
    </div>
  );
}
