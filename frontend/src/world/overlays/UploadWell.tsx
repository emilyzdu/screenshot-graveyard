import { useRef, useState } from 'react';
import { uploadScreenshots } from '../../api/client';
import { UploadDropZone } from '../../shell/Workspace';

const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_BYTES = 15 * 1024 * 1024;
const LIMIT = 20;

export function UploadWell({ synthetic, onUploaded, onPick }: {
  synthetic: boolean;
  onUploaded: (ids: number[]) => void;
  onPick: (id: number, source: HTMLElement) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number>();
  const [message, setMessage] = useState<{ errors: string[]; saved: { id: number; name: string }[] } | null>(null);
  const inFlight = useRef(false);

  const upload = async (files: File[]) => {
    if (synthetic || inFlight.current) return;
    const errors: string[] = [];
    if (files.length > LIMIT) {
      setMessage({ errors: [`Choose up to ${LIMIT} screenshots per upload.`], saved: [] });
      return;
    }
    const valid = files.filter((file) => {
      if (file.size > 0 && file.size <= MAX_BYTES && (TYPES.has(file.type) || (!file.type && /\.(png|jpe?g|webp)$/i.test(file.name)))) return true;
      errors.push(`${file.name}: choose a PNG, JPEG or WebP file between 1 byte and 15 MB.`);
      return false;
    });
    if (valid.length === 0) { setMessage({ errors, saved: [] }); return; }

    inFlight.current = true;
    setBusy(true);
    setProgress(undefined);
    setMessage(null);
    try {
      const result = await uploadScreenshots(valid, fetch, setProgress);
      if (!result.ok) { setMessage({ errors: [...errors, `Upload failed. ${result.error}`], saved: [] }); return; }
      const saved = result.results.flatMap((file) => {
        if (file.status === 'accepted' && file.screenshotId !== null) return [{ id: file.screenshotId, name: file.filename }];
        errors.push(`${file.filename}: ${file.error ?? 'Could not confirm that this file was saved.'}`);
        return [];
      });
      setMessage({ errors, saved });
      if (saved.length) onUploaded(saved.map((file) => file.id));
    } finally { inFlight.current = false; setBusy(false); }
  };

  return (
    <div className="pw-upload">
      <p>Add screenshots to the graveyard. AI processing requires separate consent for each screenshot.</p>
      {synthetic && <p role="note">Uploads are unavailable in gallery preview.</p>}
      <UploadDropZone onFiles={(files) => void upload(files)} disabled={synthetic || busy} filterByMime={false}
        hint="PNG, JPEG or WebP · up to 15 MB per file" />
      {busy && <div role="status">{progress === 1 ? 'Saving screenshots…' : 'Uploading screenshots…'} <progress aria-label="Uploading screenshots" max={1} value={progress} /></div>}
      {!!message?.errors.length && <ul role="alert">{message.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
      {!!message?.saved.length && <div className="pw-summoned">
        <p role="status">Summoned {message.saved.length} {message.saved.length === 1 ? 'screenshot ghost' : 'screenshot ghosts'}.</p>
        {message.saved.map((file) => <button key={file.id} className="pw-btn" type="button" onClick={(event) => onPick(file.id, event.currentTarget)}>
          Review AI consent for {file.name}
        </button>)}
      </div>}
    </div>
  );
}
