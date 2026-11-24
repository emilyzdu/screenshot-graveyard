import { useState } from 'react';
import type { ProviderMode } from '../api/ai';
import type { Screenshot } from '../api/client';
import { CalendarDraft } from './CalendarDraft';
import { MakeNotesDraft } from './MakeNotesDraft';
import type { DraftPresence } from './usePreparation';

/**
 * Saved drafts of an ARCHIVED screenshot, shown read-only in its Crypt drawer.
 *
 * Reuses the same workspace-scoped lookups and draft reads as the assistant
 * panels; nothing is prepared, retried, regenerated or written. Resurrection
 * (in the drawer footer) is the only way back to preparing.
 */
export function ArchivedDrafts({ screenshot, providerMode }: { screenshot: Screenshot; providerMode: ProviderMode | 'unknown' }) {
  const [notes, setNotes] = useState<DraftPresence | null>(null);
  const [calendar, setCalendar] = useState<DraftPresence | null>(null);
  const id = screenshot.screenshotId;
  return (
    <section className="sg-draft-list" role="region" aria-label="Saved drafts">
      <h4>Saved drafts</h4>
      <p className="sg-muted">
        Drafts are read-only while it is in The Crypt. Resurrect the screenshot to prepare or retry a draft.
      </p>
      <MakeNotesDraft key={`notes-${id}`} screenshot={screenshot} providerMode={providerMode} canStart={false} readOnly onPresence={setNotes} />
      <CalendarDraft key={`calendar-${id}`} screenshot={screenshot} providerMode={providerMode} canStart={false} readOnly onPresence={setCalendar} />
      {notes === 'none' && calendar === 'none' && <p role="status">No saved drafts for this screenshot.</p>}
    </section>
  );
}
