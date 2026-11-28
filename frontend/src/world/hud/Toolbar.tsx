import { Icon, type IconName } from '../../ui/Icon';
import type { OverlayId } from '../model/locations';

const ITEMS: { id: OverlayId; label: string; icon: IconName }[] = [
  { id: 'queue', label: 'Quick Queue', icon: 'list' },
  { id: 'upload', label: 'Upload', icon: 'upload' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'notes', label: 'Notes', icon: 'file' },
  { id: 'crypt', label: 'Crypt', icon: 'crypt' },
  { id: 'settings', label: 'Settings', icon: 'shield' },
];

export function Toolbar({ onOpen, active = null }: { onOpen: (id: OverlayId, opener: HTMLElement) => void; active?: OverlayId | null }) {
  return (
    <nav className="pw-toolbar" aria-label="World tools">
      {ITEMS.map((i) => (
        <button key={i.id} type="button" className="pw-tool" data-tool={i.id} data-active={active === i.id || undefined} onClick={(e) => onOpen(i.id, e.currentTarget)}>
          <Icon name={i.icon} size={16} /><span>{i.label}</span>
        </button>
      ))}
      <a className="pw-tool" href="?" data-tool="list"><Icon name="grid" size={16} /><span>List view</span></a>
    </nav>
  );
}
