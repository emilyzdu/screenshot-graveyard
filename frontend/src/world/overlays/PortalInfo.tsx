import { ConnectedApps } from '../../shell/ConnectedApps';

export function PortalInfo({ synthetic }: { synthetic: boolean }) {
  if (synthetic) return <p role="status">Simulated gallery preview. Connect and manage apps in a running workspace.</p>;
  return (
    <div className="pw-portal-apps">
      <p>Send an approved action with its own Run confirmation. Gmail creates drafts.</p>
      <ConnectedApps />
    </div>
  );
}
