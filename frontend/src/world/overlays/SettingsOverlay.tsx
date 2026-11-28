import { AutomationToggle } from '../../shell/AutomationToggle';
import { useAutomation } from '../../shell/useAutomation';
import { useProviderStatus } from '../../ai/PrivacyNotice';
import { ConnectedApps } from '../../shell/ConnectedApps';

function LiveSettings() {
  const provider = useProviderStatus();
  const automation = useAutomation(true);
  const label = provider.loading ? 'Checking…' : provider.mode === 'openai' ? 'Real AI (OpenAI): images are sent only after you allow it per screenshot'
    : provider.mode === 'fake' ? 'Fake AI: simulated, nothing leaves your machine' : 'Unknown: AI actions stay closed';
  return (
    <>
      <p><strong>AI provider</strong> <span className="pw-badge-text" data-testid="provider-badge">{label}</span></p>
      <AutomationToggle automation={automation} providerMode={provider.mode} />
      <h3>Connected apps</h3>
      <ConnectedApps />
    </>
  );
}

export function SettingsOverlay({ synthetic }: { synthetic: boolean }) {
  return (
    <div>
      {synthetic ? (
        <p role="note">Provider and automation settings are read from the backend, which demo data does not use. Open the world with the backend running to see them.</p>
      ) : <LiveSettings />}
      <p><a className="pw-btn" href="?">List view</a></p>
    </div>
  );
}
