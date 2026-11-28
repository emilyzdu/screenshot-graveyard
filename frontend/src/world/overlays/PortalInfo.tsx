import { PrototypeTag } from './OverlayHost';

/** The Portal never reports a successful send: nothing is connected yet. */
export function PortalInfo() {
  return (
    <div>
      <p className="pw-big" role="status">Not connected</p>
      <PrototypeTag>Prototype</PrototypeTag>
      <p>The Portal will one day send approved drafts to other apps. No app is connected, so nothing is sent from here.</p>
      <ul>
        <li>Google Calendar: not connected</li>
        <li>Notion: not connected</li>
      </ul>
      <p className="pw-muted">Calendar and notes drafts stay inside Screenshot Graveyard. Review and edit them in a ghost&apos;s card.</p>
    </div>
  );
}
