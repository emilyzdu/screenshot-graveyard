import type { WorldLocation } from '../model/locations';
import { platePosition } from './platePosition';
export function LocationHotspot({ location, near, onOpen }: { location: WorldLocation; near: boolean; onOpen: (l: WorldLocation, opener: HTMLElement) => void }) {
  const s = location.sprite;
  const plate = platePosition(s);
  return (
    <>
      <button
        type="button" className={`pw-hotspot${near ? ' is-near' : ''}`} data-location={location.id}
        aria-label={location.label}
        style={{ left: s.x, top: s.y, width: s.w, height: s.h, zIndex: 1 }}
        onClick={(e) => onOpen(location, e.currentTarget)}
      />
      {/* Sibling, not child: the button's z-index would otherwise trap the plate under sprites and the canopy. */}
      <span className="pw-hotspot__plate" data-plate={location.id} aria-hidden="true" style={{ left: plate.x, top: plate.y }}>{location.label}</span>
    </>
  );
}
