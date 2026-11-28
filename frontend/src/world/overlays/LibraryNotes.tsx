import { useEffect, useState } from 'react';
import { listStudyNotes, type StudyNoteSummary } from '../../api/ai';
import { StudyNoteView } from '../../ai/StudyNoteView';

export function LibraryNotes() {
  const [notes, setNotes] = useState<StudyNoteSummary[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    void listStudyNotes().then((result) => {
      if (!current) return;
      setError(!result.ok);
      if (result.ok) setNotes(result.data);
    });
    return () => { current = false; };
  }, [revision]);

  return (
    <section className="pw-library-notes" aria-label="Saved workspace study notes">
      <h3>Saved study notes</h3>
      {error ? <p role="alert">Study notes could not be loaded. <button className="pw-btn" type="button" onClick={() => setRevision((n) => n + 1)}>Try again</button></p> :
        notes === null ? <p role="status">Opening the shelves…</p> : notes.length === 0 ? <p className="pw-muted">No saved study notes.</p> :
          <ul className="pw-list">
            {notes.map((note) => <li key={note.artifactId}>
              <button type="button" aria-expanded={selected === note.artifactId} className="pw-list__item"
                onClick={() => setSelected(selected === note.artifactId ? null : note.artifactId)}>
                <span>{note.topic}</span><span>Version {note.versionNumber}</span>
              </button>
            </li>)}
          </ul>}
      {selected !== null && <StudyNoteView key={selected} artifactId={selected} onVersionsChanged={() => setRevision((n) => n + 1)} />}
    </section>
  );
}
