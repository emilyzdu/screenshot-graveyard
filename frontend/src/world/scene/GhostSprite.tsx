import { memo } from 'react';
import { ghostArt } from '../illustrated/art';
import type { GhostView } from '../model/ghostView';
import { ghostStages, toolMarks } from '../model/lifecycle';
import type { Slot } from '../model/slots';

interface GhostSpriteProps {
  ghost: GhostView; slot: Slot; selected: boolean; near: boolean; reducedMotion: boolean; demo: boolean;
  onSelect: (id: number, opener: HTMLElement) => void;
}

export const GhostSprite = memo(function GhostSprite({ ghost, slot, selected, near, reducedMotion, demo, onSelect }: GhostSpriteProps) {
  const stage = ghost.stage && ghostStages[ghost.stage];
  const label = `${ghost.filename}${demo ? ' (demo)' : ''}: ${ghost.label}${ghost.tools?.length ? `, ${ghost.tools.map((tool) => toolMarks[tool]?.label ?? tool).join(', ')}` : ''}`;
  return (
    <button type="button" className="pw-ghost" aria-label={label} aria-pressed={selected} title={label}
      data-ghost-id={ghost.id} data-location={ghost.location} data-ghost-state={ghost.stage} data-near={near || undefined} data-reduced={reducedMotion || undefined}
      style={{ left: slot.x, top: slot.y, zIndex: 20 + slot.y, animationDelay: `${-(ghost.id % 7) / 4}s` }}
      onClick={(event) => onSelect(ghost.id, event.currentTarget)}>
      <span className="pw-ghost__figure">
        <img className="pw-ghost__body" src={ghostArt[stage ? stage.pose : 'waiting']} alt="" draggable={false} />
        {stage && <span className="pw-ghost__mark" aria-hidden="true">{stage.mark}</span>}
      </span>
      {!!ghost.tools?.length && <span className="pw-ghost__tools" aria-hidden="true">{ghost.tools.map((tool) => <span key={tool}>{toolMarks[tool]?.mark ?? '·'}</span>)}</span>}
    </button>
  );
});
