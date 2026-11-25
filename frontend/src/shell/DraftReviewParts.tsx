import { useState } from 'react';
import type { FieldOrigins, VersionInfo } from '../api/ai';
import { imageUrl } from '../api/client';
import { Badge, Button } from '../ui/primitives';
import { isKnownOrigin, originLabel } from './draftHistory';

/** Ordered version list. Selecting a version only shows it. */
export function VersionHistory({
  versions,
  shownId,
  provider,
  onShow,
  disabled,
}: {
  versions: VersionInfo[] | null;
  shownId: number;
  provider: string | null;
  onShow: (versionId: number) => void;
  disabled?: boolean;
}) {
  if (versions === null) return <p className="sg-muted">The version history could not be loaded.</p>;
  return (
    <nav aria-label="Version history" className="sg-history">
      <h5>Version history</h5>
      <ol>
        {versions.map((v) => (
          <li key={v.versionId}>
            <span>
              Version {v.versionNumber}, {originLabel(v.origin, provider)}
              {v.isCurrent && ' (current)'}
            </span>{' '}
            {v.versionId === shownId ? (
              <Badge tone="muted">Shown</Badge>
            ) : (
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onShow(v.versionId)}>
                View version {v.versionNumber}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Where one field's value came from, as derived by the server from the history. */
export function FieldOriginTag({ origins, field, provider }: { origins: FieldOrigins | null | undefined; field: string; provider: string | null }) {
  const o = origins?.[field];
  if (!o) return null;
  const text = !isKnownOrigin(o.origin)
    ? `origin unknown (v${o.versionNumber})` // an unfamiliar value is never shown as AI or as you
    : o.origin === 'manual_edit'
      ? `edited by you (v${o.versionNumber})`
      : provider === 'fake'
        ? `Fake AI, not checked by you (v${o.versionNumber})`
        : `AI, not checked by you (v${o.versionNumber})`;
  return <span className="sg-origin">{text}</span>;
}

export function FieldHistoryNotice({ origins }: { origins: FieldOrigins | null | undefined }) {
  if (origins === null) return <p className="sg-muted">Which fields you edited could not be determined for this version.</p>;
  return null;
}

/** Opens the private original in a new tab (a plain GET of the image; no AI processing). */
export function SourceLink({ screenshotId }: { screenshotId: number }) {
  return (
    <a className="sg-source-link" href={imageUrl(screenshotId)} target="_blank" rel="noopener noreferrer">
      Open source screenshot #{screenshotId}
    </a>
  );
}

/** Banner for an earlier version: read-only, with a way back. */
export function EarlierVersionBanner({ versionNumber, onBack }: { versionNumber: number; onBack: () => void }) {
  return (
    <div className="sg-uncertain" role="note">
      <p>
        Viewing version {versionNumber}, an earlier version. It is read-only; the current version is unchanged.
      </p>
      <Button size="sm" onClick={onBack}>Back to current version</Button>
    </div>
  );
}

/**
 * Recovery after a conflict or an unknown save outcome: inspect the latest
 * saved version without touching the form, or load it after an explicit
 * warning that the unsaved edits will be discarded.
 */
export function SaveRecoveryActions({
  checking,
  onCheck,
  onDiscardAndLoad,
}: {
  checking: boolean;
  onCheck: () => void;
  onDiscardAndLoad: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button size="sm" disabled={checking} onClick={onCheck}>
        {checking ? 'Checking…' : 'Check latest saved version'}
      </Button>
      {confirming ? (
        <div className="sg-uncertain" role="alertdialog" aria-label="Discard your unsaved edits?" aria-describedby="sg-discard-why">
          <p id="sg-discard-why">Loading the latest saved version replaces this form. Your unsaved edits will be lost.</p>
          <Button size="sm" onClick={onDiscardAndLoad}>Discard my edits and load latest</Button>
          <Button size="sm" onClick={() => setConfirming(false)}>Keep editing</Button>
        </div>
      ) : (
        <Button size="sm" onClick={() => setConfirming(true)}>Load latest version…</Button>
      )}
    </>
  );
}
