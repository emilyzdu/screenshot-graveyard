import type { WorldLocation } from '../model/locations';

export function LocationHotspot({ location, near, onOpen }: { location: WorldLocation; near: boolean; onOpen: (l: WorldLocation, opener: HTMLElement) => void }) {
  const s = location.sprite;
  return (
    <button
      type="button" className={`pw-hotspot${near ? ' is-near' : ''}`} data-location={location.id}
      aria-label={location.label}
      style={{ left: s.x, top: s.y, width: s.w, height: s.h, zIndex: 1 }}
      onClick={(e) => onOpen(location, e.currentTarget)}
    >
      <span className="pw-hotspot__plate" aria-hidden="true">{location.label}</span>
    </button>
  );
}
