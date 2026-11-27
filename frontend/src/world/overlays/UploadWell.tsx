import { useRef, useState } from 'react';
import { uploadScreenshots } from '../../api/client';
import { UploadDropZone } from '../../shell/Workspace';
import { PrototypeTag } from './OverlayHost';

export function UploadWell({ synthetic, onUploaded }: { synthetic: boolean; onUploaded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ error: boolean; text: string } | null>(null);
  const inFlight = useRef(false);

  const upload = async (files: File[]) => {
    if (synthetic || inFlight.current) return;
    inFlight.current = true; setBusy(true); setMsg(null);
    try {
      const r = await uploadScreenshots(files);
      if (!r.ok) { setMsg({ error: true, text: `Upload failed. ${r.error}` }); return; }
      const rejected = r.results.filter((f) => f.status === 'rejected').map((f) => `${f.filename}: ${f.error ?? 'Could not save this file.'}`);
      setMsg({ error: rejected.length > 0, text: [`Saved ${r.accepted} screenshot${r.accepted === 1 ? '' : 's'}.`, ...rejected].join(' ') });
      if (r.accepted > 0) onUploaded();
    } finally { inFlight.current = false; setBusy(false); }
  };

  return (
    <div>
      {synthetic && <p><PrototypeTag>Prototype</PrototypeTag> Demo mode: nothing is uploaded. Files you choose here are ignored.</p>}
      <UploadDropZone onFiles={(f) => void upload(f)} disabled={synthetic || busy} filterByMime={false}
        hint="PNG, JPEG or WebP, up to 15 MB each. Files are stored in your private workspace. Uploading does not analyze anything." />
      {busy && <p role="status">Uploading screenshots…</p>}
      {msg && <p role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
    </div>
  );
}
