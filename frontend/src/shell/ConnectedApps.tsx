import { useCallback, useEffect, useState } from 'react';
import {
  connectToolkit,
  disconnectToolkit,
  getIntegrations,
  refreshToolkit,
  type Connection,
  type Integrations,
} from '../api/tools';

type State = { t: 'loading' } | { t: 'error'; message: string } | { t: 'ready'; data: Integrations };

const STATUS_TEXT: Record<Connection['status'], string> = {
  not_connected: 'Not connected',
  pending: 'Waiting for you to finish authorizing',
  active: 'Connected',
  failed: 'Needs reconnecting',
};

function modeNote(d: Pick<Integrations, 'mode' | 'liveWrites'>): string {
  if (d.mode === 'fake') return 'Simulated apps: connections and results are pretend. Nothing reaches a real account.';
  if (d.mode === 'composio' && !d.liveWrites) return 'Real accounts can be connected, but this server does not write to them yet.';
  if (d.mode === 'composio') return 'Real accounts. Each write still needs your approval and a separate Run click.';
  return '';
}

/** Server-reported connection state for Google Calendar, Notion and Gmail, with connect/disconnect. */
export function ConnectedApps({ readOnly = false }: { readOnly?: boolean }) {
  const [state, setState] = useState<State>({ t: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await getIntegrations();
    setState(r.ok ? { t: 'ready', data: r.data } : { t: 'error', message: 'Connected apps could not be loaded.' });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (toolkit: string, kind: 'connect' | 'refresh' | 'disconnect') => {
    setBusy(toolkit);
    setNote(null);
    if (kind === 'connect') {
      const r = await connectToolkit(toolkit);
      if (!r.ok) setNote(r.message);
      else if (r.data.redirectUrl) {
        // The provider's hosted authorization page. Come back and press "Check status".
        window.open(r.data.redirectUrl, '_blank', 'noopener,noreferrer');
        setNote('Finish authorizing in the new tab, then press Check status.');
      }
    } else if (kind === 'refresh') {
      const r = await refreshToolkit(toolkit);
      if (!r.ok) setNote(r.message);
    } else {
      const r = await disconnectToolkit(toolkit);
      if (!r.ok) setNote(r.message);
      else if (!r.data.removedAtProvider) setNote('Disconnected here. The app could not confirm removal, so you may also want to remove access in that app’s settings.');
    }
    await load();
    setBusy(null);
  };

  if (state.t === 'loading') return <p className="pw-muted" role="status">Checking connected apps…</p>;
  if (state.t === 'error') return <p className="pw-muted" role="status">{state.message}</p>;
  const d = state.data;
  if (!d.enabled) return <p className="pw-muted" data-testid="apps-off">External apps are not enabled on this server.</p>;
  return (
    <section aria-label="Connected apps" data-testid="connected-apps">
      <p className="pw-muted">{modeNote(d)}</p>
      <ul className="sg-apps">
        {d.toolkits.map((t) => (
          <li key={t.toolkit} data-toolkit={t.toolkit}>
            <strong>{t.label}</strong>{' '}
            <span className="pw-badge-text" data-testid={`app-status-${t.toolkit}`}>
              {t.configured ? STATUS_TEXT[t.status] : 'Not set up on this server'}
              {t.status === 'active' && t.simulated ? ' (simulated)' : ''}
            </span>
            {t.status === 'active' && !t.simulated && t.liveVerifiedTools.length === 0 && (
              <span className="pw-muted"> Not yet verified with a real write.</span>
            )}
            {!readOnly && t.configured && (
              <span className="pw-row">
                {t.status !== 'active' && (
                  <button type="button" className="pw-btn" disabled={busy !== null} onClick={() => void act(t.toolkit, 'connect')}>
                    {t.status === 'failed' ? 'Reconnect' : 'Connect'}
                  </button>
                )}
                {t.status === 'pending' && (
                  <button type="button" className="pw-btn" disabled={busy !== null} onClick={() => void act(t.toolkit, 'refresh')}>Check status</button>
                )}
                {t.status !== 'not_connected' && (
                  <button type="button" className="pw-btn" disabled={busy !== null} onClick={() => void act(t.toolkit, 'disconnect')}>Disconnect</button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      {note && <p role="status">{note}</p>}
    </section>
  );
}
