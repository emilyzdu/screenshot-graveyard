import { useEffect, useState } from 'react';
import { getIntegrations, type Integrations } from '../../api/tools';
import { ConnectedApps } from '../../shell/ConnectedApps';
import { PrototypeTag } from './OverlayHost';

/** Demo data: nothing is connected and nothing is called. */
function DemoPortal() {
  return (
    <div>
      <p className="pw-big" role="status">Not connected</p>
      <PrototypeTag>Prototype</PrototypeTag>
      <p>The Portal sends approved actions to your own apps. Demo data never connects to anything, so nothing is sent from here.</p>
      <ul>
        <li>Google Calendar: not connected</li>
        <li>Notion: not connected</li>
        <li>Gmail (drafts only): not connected</li>
      </ul>
      <p className="pw-muted">Open the world with the backend running to connect apps.</p>
    </div>
  );
}

/**
 * The Portal reports only what the server says: which apps are connected. It
 * never claims a send; results appear on each ghost's card, with the item id
 * the app returned.
 */
function LivePortal() {
  const [data, setData] = useState<Integrations | null>(null);
  useEffect(() => {
    let alive = true;
    void getIntegrations().then((r) => { if (alive && r.ok) setData(r.data); });
    return () => { alive = false; };
  }, []);
  const connected = data?.enabled ? data.toolkits.filter((t) => t.status === 'active').length : 0;
  return (
    <div>
      <p className="pw-big" role="status">{connected === 0 ? 'Not connected' : `${connected} app${connected > 1 ? 's' : ''} connected${data?.simulated ? ' (simulated)' : ''}`}</p>
      <p>Approved actions from a ghost&apos;s card go through here. Each one needs your approval of the exact version and a separate Run click.</p>
      <ConnectedApps readOnly />
      <p className="pw-muted">Connect or disconnect apps in Settings.</p>
    </div>
  );
}

export function PortalInfo({ synthetic = true }: { synthetic?: boolean }) {
  return synthetic ? <DemoPortal /> : <LivePortal />;
}
