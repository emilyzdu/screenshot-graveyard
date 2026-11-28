import { Icon, type IconName } from '../../ui/Icon';
import type { OverlayId } from '../model/locations';

const ITEMS: { id: OverlayId; label: string; icon: IconName }[] = [
  { id: 'queue', label: 'Quick Queue', icon: 'list' },
  { id: 'upload', label: 'Upload', icon: 'upload' },
  { id: 'settings', label: 'Settings', icon: 'shield' },
];

export function Toolbar({ onOpen, active = null }: { onOpen: (id: OverlayId, opener: HTMLElement) => void; active?: OverlayId | null }) {
  return (
    <nav className="pw-toolbar" aria-label="World tools">
      {ITEMS.map((i) => (
        <button key={i.id} type="button" className="pw-tool" data-tool={i.id} aria-label={i.label} title={i.label}
          aria-haspopup="dialog" aria-expanded={active === i.id} onClick={(e) => onOpen(i.id, e.currentTarget)}>
          <Icon name={i.icon} size={17} /><span>{i.label}</span>
        </button>
      ))}
    </nav>
  );
}
