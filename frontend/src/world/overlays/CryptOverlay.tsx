import { useRef, useState } from 'react';
import { imageUrl, restoreScreenshot, type Screenshot } from '../../api/client';
import { useProviderStatus } from '../../ai/PrivacyNotice';
import { ArchivedDrafts } from '../../shell/ArchivedDrafts';
import { ghostArt } from '../illustrated/art';

function Drafts({ shot }: { shot: Screenshot }) {
  const provider = useProviderStatus();
  return <ArchivedDrafts screenshot={shot} providerMode={provider.mode} />;
}

function Item({ shot, synthetic, busy, onResurrect }: { shot: Screenshot; synthetic: boolean; busy: boolean; onResurrect: (s: Screenshot) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="pw-crypt__item">
      <img className="pw-crypt__ghost" src={ghostArt.sleep} alt="" />
      <div className="pw-row">
        <span className="pw-list__name">{shot.originalFilename || `Screenshot #${shot.screenshotId}`}</span>
        <span className="pw-muted">#{shot.screenshotId} · {shot.uploadedAt.slice(0, 10)}</span>
      </div>
      <div className="pw-row">
        {!synthetic && <button type="button" className="pw-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide inspection' : 'Inspect screenshot'}</button>}
        <button type="button" className="pw-btn" disabled={synthetic || busy} onClick={() => onResurrect(shot)}
          aria-label={`Resurrect ${shot.originalFilename}`}>
          {synthetic ? 'Resurrect (not in demo)' : 'Resurrect'}
        </button>
      </div>
      {open && !synthetic && <div className="pw-crypt__inspection">
        <img className="pw-card__img" src={imageUrl(shot.screenshotId)} alt={`Preview of ${shot.originalFilename}`} loading="lazy" />
        {shot.analysis?.epitaph && <blockquote>{shot.analysis.epitaph}</blockquote>}
        <Drafts shot={shot} />
      </div>}
    </li>
  );
}

/** Read-only archived list. Resurrect is the existing restore call, run only on a click. */
export function CryptOverlay({ archived, synthetic, loading, onChanged, onRestored }: { archived: readonly Screenshot[]; synthetic: boolean; loading: boolean; onChanged: () => void; onRestored: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ error: boolean; text: string } | null>(null);
  const inFlight = useRef(false);

  const resurrect = async (s: Screenshot) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMsg(null);
    try {
      const r = await restoreScreenshot(s.screenshotId);
      if (r.ok && r.status === 'successful') {
        setMsg({ error: false, text: `${s.originalFilename} was resurrected and is back in the graveyard.` });
        onRestored(s.screenshotId);
      }
      else if (!r.ok && r.outcome === 'rejected') setMsg({ error: true, text: `Could not resurrect ${s.originalFilename}. ${r.error}` });
      else setMsg({ error: true, text: `The result of resurrecting ${s.originalFilename} is not confirmed. The list was re-read; check it before trying again.` });
    } finally {
      inFlight.current = false; setBusy(false); onChanged();
    }
  };

  return (
    <div>
      {synthetic && <p>These resting screenshots are synthetic. Resurrection is available in a connected workspace.</p>}
      {loading ? <p role="status">Opening the Crypt…</p> : archived.length === 0 ? <p role="status">The Crypt is empty.</p> : (
        <ul className="pw-list" aria-label="Archived screenshots">
          {archived.map((s) => <Item key={s.screenshotId} shot={s} synthetic={synthetic} busy={busy} onResurrect={(x) => void resurrect(x)} />)}
        </ul>
      )}
      {msg && <p role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
    </div>
  );
}
