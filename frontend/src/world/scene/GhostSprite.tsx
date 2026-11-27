import { memo, useEffect, useState } from 'react';
import { assetUrl } from '../assets';
import { hash, ACCESSORIES, type GhostView } from '../model/ghostView';
import type { Slot } from '../model/slots';
import { Badge } from './Badge';

const WANDER_RADIUS = 12;

export interface GhostSpriteProps {
  ghost: GhostView; slot: Slot; selected: boolean; reducedMotion: boolean; demo: boolean;
  onSelect: (id: number, opener: HTMLElement) => void;
}

function GhostSpriteImpl({ ghost, slot, selected, reducedMotion, demo, onSelect }: GhostSpriteProps) {
  const [off, setOff] = useState({ x: 0, y: 0 });
  const idle = reducedMotion || selected;
  useEffect(() => {
    if (idle) return;
    let n = hash(ghost.id); let t: number;
    const next = () => {
      n = hash(n);
      const a = ((n & 0xff) / 255) * Math.PI * 2, r = (((n >>> 8) & 0xff) / 255) * WANDER_RADIUS;
      setOff({ x: Math.round(Math.cos(a) * r), y: Math.round((Math.sin(a) * r) / 2) });
      t = window.setTimeout(next, 2000 + ((n >>> 16) % 3000));
    };
    t = window.setTimeout(next, 600 + (n % 2400));
    return () => window.clearTimeout(t);
  }, [ghost.id, idle]);
  const shown = idle ? { x: 0, y: 0 } : off;
  const accessory = ACCESSORIES[ghost.accessory];
  const label = `${ghost.filename}${demo ? ' (demo)' : ''}: ${ghost.label}${ghost.category ? `, ${ghost.category}` : ''}${ghost.isDuplicate ? ', duplicate upload' : ''}`;
  return (
    <button
      type="button" className={`pw-ghost${selected ? ' is-selected' : ''}`} aria-label={label} aria-pressed={selected}
      data-ghost-id={ghost.id} data-accessory={accessory} data-location={ghost.location}
      style={{ left: slot.x - 16, top: slot.y - 40, zIndex: 10 + slot.y, transform: `translate(${shown.x}px, ${shown.y}px)`, ['--pw-gx' as string]: `${-ghost.tint * 48}px`, ['--pw-gx2' as string]: `${-ghost.tint * 48 - 24}px`, ['--pw-gy' as string]: `${-ghost.accessory * 28}px`, ['--pw-sheet' as string]: `url(${assetUrl('ghost-sheet')})` }}
      onClick={(e) => onSelect(ghost.id, e.currentTarget)}
    >
      <span className="pw-ghost__badge">
        {ghost.badge !== 'none' ? <Badge kind={ghost.badge} /> : <span className="pw-ghost__dot" aria-hidden="true" />}
      </span>
      <span className="pw-ghost__body" aria-hidden="true" />
      {ghost.isDuplicate && <span className="pw-ghost__dup" aria-hidden="true">2</span>}
      {selected && <img className="pw-ghost__brackets" src={assetUrl('selection-brackets')} alt="" />}
    </button>
  );
}
export const GhostSprite = memo(GhostSpriteImpl);
