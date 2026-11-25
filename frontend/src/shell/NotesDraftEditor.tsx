import { useRef, useState } from 'react';
import { saveStudyNoteEdit, type EditResult, type StudyNoteContent, type StudyNoteVersion } from '../api/ai';
import { Button } from '../ui/primitives';
import { SaveRecoveryActions } from './DraftReviewParts';
import { describeSaveFailure, originLabel, useLatestCheck, type SaveOutcomeText } from './draftHistory';

const LIST_SECTIONS = [
  { key: 'main_concepts', label: 'Main concepts' },
  { key: 'code_explanations', label: 'Code explanations' },
  { key: 'pitfalls', label: 'Pitfalls' },
  { key: 'uncertain_content', label: 'Uncertain points' },
] as const;
type ListKey = (typeof LIST_SECTIONS)[number]['key'] | 'extracted_code';

/** One saved item, edited in place. `added` items left empty are not saved. */
interface Item {
  text: string;
  added: boolean;
}
const toItems = (values: string[]): Item[] => values.map((text) => ({ text, added: false }));
/** Lossless: every saved item (even an empty one) is kept exactly; only blank NEW items are dropped. */
const fromItems = (items: Item[]): string[] => items.filter((i) => !(i.added && i.text.trim() === '')).map((i) => i.text);

interface Props {
  note: StudyNoteVersion;
  request: () => typeof fetch;
  onSaved: (saved: StudyNoteVersion & { editResult: EditResult }) => void;
  onCancel: () => void;
  /** Reload the latest version (discarding the form), only after the user confirms. */
  onLoadLatest: () => void;
  /** Read the latest saved version without touching the form. */
  checkLatest: () => Promise<StudyNoteVersion | null>;
  provider: string | null;
}

/**
 * Edits the CURRENT version of a notes draft into a new version, keeping the
 * structured sections (the approved Study Note contract). Each list item is
 * edited in its own field, so item boundaries, blank lines and whitespace are
 * kept exactly: a section you do not touch is sent byte-for-byte as stored,
 * and the server's field history therefore marks only what you changed.
 * Source references are never editable: the server keeps them.
 */
export function NotesDraftEditor({ note, request, onSaved, onCancel, onLoadLatest, checkLatest, provider }: Props) {
  const c = note.content;
  const [topic, setTopic] = useState(c.topic);
  const [lists, setLists] = useState<Record<ListKey, Item[]>>({
    main_concepts: toItems(c.main_concepts),
    code_explanations: toItems(c.code_explanations),
    pitfalls: toItems(c.pitfalls),
    uncertain_content: toItems(c.uncertain_content),
    extracted_code: toItems(c.extracted_code),
  });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState<SaveOutcomeText | null>(null);
  const [conflict, setConflict] = useState(false);
  const [uncertainOutcome, setUncertainOutcome] = useState(false);
  // Once an attempt's outcome is unknown, later rejections cannot prove it failed.
  const hadUnknown = useRef(false);
  const [everUnknown, setEverUnknown] = useState(false);

  const setItem = (key: ListKey, index: number, text: string) =>
    setLists((l) => ({ ...l, [key]: l[key].map((it, i) => (i === index ? { ...it, text } : it)) }));
  const addItem = (key: ListKey) => setLists((l) => ({ ...l, [key]: [...l[key], { text: '', added: true }] }));
  const removeItem = (key: ListKey, index: number) => setLists((l) => ({ ...l, [key]: l[key].filter((_, i) => i !== index) }));

  const currentContent = (): StudyNoteContent => ({
    topic, // sent exactly as shown; an untouched topic is unchanged
    main_concepts: fromItems(lists.main_concepts),
    extracted_code: fromItems(lists.extracted_code),
    code_explanations: fromItems(lists.code_explanations),
    pitfalls: fromItems(lists.pitfalls),
    uncertain_content: fromItems(lists.uncertain_content),
  });

  // Raw lists (including added-but-empty items) so ANY edit to the form invalidates a check.
  const latestCheck = useLatestCheck<StudyNoteVersion>(JSON.stringify({ topic, lists }));

  /** Inspect the latest saved version; never changes the form or saves anything. */
  const onCheck = () => {
    const mine = currentContent(); // exactly what Save sends
    const keys = Object.keys(mine) as (keyof StudyNoteContent)[];
    return latestCheck.check(
      checkLatest,
      (latest) => keys.every((k) => JSON.stringify(mine[k]) === JSON.stringify(latest.content[k])),
      (latest) => `The latest saved version is version ${latest.versionNumber}, ${originLabel(latest.origin, provider)}.`,
    );
  };

  const onSave = async () => {
    if (busyRef.current) return;
    if (topic.trim() === '') {
      setMessage({ kind: 'error', text: 'A topic is required. Nothing was saved.' });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const content = currentContent();
      const res = await saveStudyNoteEdit(note.artifactId, content, note.versionId, request());
      if (res.ok) {
        onSaved(res.data);
        return;
      }
      const outcome = describeSaveFailure(
        res.status === 422 ? { ...res, status: 400, message: 'Some content is not valid.' } : res,
        hadUnknown.current,
      );
      if (outcome.uncertain) {
        hadUnknown.current = true;
        setEverUnknown(true);
      }
      setMessage(outcome);
      setConflict(res.status === 409 && res.code === 'version_conflict');
      setUncertainOutcome(outcome.uncertain === true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const section = (key: ListKey, label: string, itemName: string, code = false) => (
    <fieldset className="sg-edit__row" key={key} disabled={busy}>
      <legend>{label}</legend>
      {lists[key].map((item, i) => (
        <div key={i} className={code ? 'sg-edit__code' : 'sg-edit__item'}>
          <textarea
            aria-label={`${itemName} ${i + 1}`}
            rows={code ? 4 : 2}
            spellCheck={!code}
            value={item.text}
            onChange={(e) => setItem(key, i, e.target.value)}
          />
          <Button size="sm" variant="ghost" onClick={() => removeItem(key, i)}>
            Remove {itemName} {i + 1}
          </Button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => addItem(key)}>Add {itemName}</Button>
    </fieldset>
  );

  return (
    <form
      className="sg-edit"
      aria-label="Edit notes draft"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      <p className="sg-muted">
        Editing version {note.versionNumber}. Saving creates a new version; earlier versions are kept. Sections you do
        not change are saved exactly as they are.
      </p>
      <div className="sg-edit__row">
        <label htmlFor="sg-note-topic">Topic</label>
        <input id="sg-note-topic" value={topic} disabled={busy} onChange={(e) => setTopic(e.target.value)} />
      </div>
      {LIST_SECTIONS.map(({ key, label }) => section(key, label, `${label} item`))}
      {section('extracted_code', 'Code blocks (kept exactly as typed)', 'Code block', true)}
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p>}
      <div className="sg-edit__actions">
        <Button type="submit" size="sm" variant="primary" disabled={busy || conflict}>
          {busy ? 'Saving…' : uncertainOutcome ? 'Save again' : 'Save changes'}
        </Button>
        <Button size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
        {(conflict || everUnknown) && (
          <SaveRecoveryActions checking={latestCheck.checking} onCheck={() => void onCheck()} onDiscardAndLoad={onLoadLatest} />
        )}
      </div>
      {latestCheck.text && <p role="status">{latestCheck.text}</p>}
    </form>
  );
}
