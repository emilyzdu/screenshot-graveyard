import type { WorldLocation } from '../model/locations';

export function LocationHotspot({ location, near, onOpen }: { location: WorldLocation; near: boolean; onOpen: (l: WorldLocation, opener: HTMLElement) => void }) {
  const { sprite, entrance } = location;
  return (
    <button type="button" className={`pw-hotspot${near ? ' is-near' : ''}`} data-location={location.id}
      aria-label={location.label}
      style={{ left: sprite.x, top: sprite.y, width: sprite.w, height: Math.min(sprite.h, entrance.y - sprite.y + 4), zIndex: 2 }}
      onClick={(event) => onOpen(location, event.currentTarget)}>
      <span className="pw-hotspot__plate" data-plate={location.id} aria-hidden="true">{location.label}</span>
    </button>
  );
}
