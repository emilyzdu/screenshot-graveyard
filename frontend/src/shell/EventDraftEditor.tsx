import { useRef, useState } from 'react';
import {
  saveEventDraftEdit,
  type EditResult,
  type EventDraftEdit,
  type EventDraftField,
  type EventDraftVersion,
} from '../api/ai';
import { Button } from '../ui/primitives';
import { SaveRecoveryActions } from './DraftReviewParts';
import { describeSaveFailure, originLabel, useLatestCheck, type SaveOutcomeText } from './draftHistory';

type TextField = Exclude<EventDraftField, 'all_day'>;
type AllDay = 'yes' | 'no' | 'unknown';

const TEXT_FIELDS: { field: TextField; label: string; type: 'text' | 'date' | 'time' | 'textarea'; hint?: string }[] = [
  { field: 'title', label: 'Title', type: 'text' },
  { field: 'start_date', label: 'Start date', type: 'date', hint: 'YYYY-MM-DD' },
  { field: 'start_time', label: 'Start time', type: 'time', hint: 'HH:MM, 24-hour' },
  { field: 'end_date', label: 'End date', type: 'date', hint: 'YYYY-MM-DD' },
  { field: 'end_time', label: 'End time', type: 'time', hint: 'HH:MM, 24-hour' },
  { field: 'time_zone', label: 'Time zone', type: 'text', hint: 'IANA name, for example Europe/London' },
  { field: 'location', label: 'Location', type: 'text' },
  { field: 'description', label: 'Description', type: 'textarea' },
];
const TIME_FIELDS = new Set<EventDraftField>(['start_time', 'end_time']);

const KEY: Record<EventDraftField, keyof EventDraftVersion['content']> = {
  title: 'title',
  start_date: 'startDate',
  start_time: 'startTime',
  end_date: 'endDate',
  end_time: 'endTime',
  all_day: 'allDay',
  time_zone: 'timeZone',
  location: 'location',
  description: 'description',
};

const toAllDay = (v: boolean | null): AllDay => (v === null ? 'unknown' : v ? 'yes' : 'no');
const fromAllDay = (v: AllDay): boolean | null => (v === 'unknown' ? null : v === 'yes');
const blankToNull = (v: string): string | null => (v.trim() === '' ? null : v.trim());

interface Props {
  draft: EventDraftVersion;
  /** The panel's lifetime-bound fetch for the POST. */
  request: () => typeof fetch;
  onSaved: (saved: EventDraftVersion & { editResult: EditResult }) => void;
  onCancel: () => void;
  /** Reload the latest version (discarding the form), only after the user confirms. */
  onLoadLatest: () => void;
  /** Read the latest saved version without touching the form. */
  checkLatest: () => Promise<EventDraftVersion | null>;
  provider: string | null;
}

/**
 * Edits the CURRENT version of a calendar draft into a new version. Unknown
 * values stay empty (nothing is pre-filled from the browser's time zone or
 * today's date); the server re-derives missing and uncertain fields and runs
 * the full validation, including daylight-saving gaps and repeated hours.
 */
export function EventDraftEditor({ draft, request, onSaved, onCancel, onLoadLatest, checkLatest, provider }: Props) {
  const c = draft.content;
  const [values, setValues] = useState<Record<TextField, string>>(() => {
    const out = {} as Record<TextField, string>;
    for (const { field } of TEXT_FIELDS) out[field] = (c[KEY[field]] as string | null) ?? '';
    return out;
  });
  const [allDay, setAllDay] = useState<AllDay>(toAllDay(c.allDay));
  const [flags, setFlags] = useState<Set<EventDraftField>>(new Set());
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState<SaveOutcomeText | null>(null);
  const [badField, setBadField] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [uncertainOutcome, setUncertainOutcome] = useState(false);
  // Once an attempt's outcome is unknown, later rejections cannot prove it failed.
  const hadUnknown = useRef(false);
  const [everUnknown, setEverUnknown] = useState(false);

  const isAllDay = allDay === 'yes';
  const valueOf = (field: EventDraftField): string | boolean | null => {
    if (field === 'all_day') return fromAllDay(allDay);
    if (isAllDay && TIME_FIELDS.has(field)) return null; // times do not apply to an all-day event
    return blankToNull(values[field]);
  };
  const unchanged = (field: EventDraftField) => valueOf(field) === c[KEY[field]];
  /** An AI value the user has not changed stays uncertain: only changing it can clear that. */
  const lockedUncertain = (field: EventDraftField) => c.uncertainFields.includes(field) && unchanged(field);

  const FIELDS = Object.keys(KEY) as EventDraftField[];
  /** Exactly what Save sends. */
  const payload = () => ({
    content: Object.fromEntries(FIELDS.map((f) => [f, valueOf(f)])) as unknown as EventDraftEdit,
    uncertain: FIELDS.filter((f) => flags.has(f) && valueOf(f) !== null),
  });
  /**
   * The uncertainty a Save would produce on the server: the fields you flag,
   * plus AI-uncertain fields whose value you have not changed.
   */
  const effectiveUncertain = () =>
    FIELDS.filter((f) => valueOf(f) !== null && (flags.has(f) || lockedUncertain(f)));
  const latestCheck = useLatestCheck<EventDraftVersion>(
    JSON.stringify({ ...payload(), flags: [...flags].sort(), allDay }),
  );

  const toggleFlag = (field: EventDraftField) =>
    setFlags((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });

  const onSave = async () => {
    if (busyRef.current) return; // duplicate-click guard; the server also de-duplicates
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    setBadField(null);
    try {
      const { content, uncertain } = payload();
      const res = await saveEventDraftEdit(draft.artifactId, draft.versionId, content, uncertain, request());
      if (res.ok) {
        onSaved(res.data);
        return;
      }
      const outcome = describeSaveFailure(res, hadUnknown.current);
      if (outcome.uncertain) {
        hadUnknown.current = true;
        setEverUnknown(true);
      }
      setMessage(outcome);
      setBadField(res.status === 400 ? (res.field ?? null) : null);
      setConflict(res.status === 409 && res.code === 'version_conflict');
      setUncertainOutcome(outcome.uncertain === true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /** Inspect the latest saved version; never changes the form or saves anything. */
  const onCheck = () => {
    const { content } = payload();
    const mine = [...effectiveUncertain()].sort();
    return latestCheck.check(
      checkLatest,
      (latest) =>
        FIELDS.every((f) => content[f] === latest.content[KEY[f]]) &&
        JSON.stringify([...latest.content.uncertainFields].sort()) === JSON.stringify(mine),
      (latest) => `The latest saved version is version ${latest.versionNumber}, ${originLabel(latest.origin, provider)}.`,
    );
  };

  const errorId = (field: string) => (badField === field ? 'sg-edit-error' : undefined);

  return (
    <form
      className="sg-edit"
      aria-label="Edit calendar event draft"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      <p className="sg-muted">
        Editing version {draft.versionNumber}. Saving creates a new version; earlier versions are kept. Leave a field
        empty if you do not know it yet.
      </p>
      {TEXT_FIELDS.map(({ field, label, type, hint }) => {
        const disabled = busy || (isAllDay && TIME_FIELDS.has(field));
        const id = `sg-edit-${field}`;
        const common = {
          id,
          value: disabled && isAllDay && TIME_FIELDS.has(field) ? '' : values[field],
          disabled,
          'aria-invalid': badField === field || undefined,
          'aria-describedby': errorId(field),
          onChange: (e: { target: { value: string } }) => setValues((v) => ({ ...v, [field]: e.target.value })),
        };
        return (
          <div className="sg-edit__row" key={field}>
            <label htmlFor={id}>
              {label}
              {hint && <span className="sg-muted"> ({hint})</span>}
            </label>
            {type === 'textarea' ? <textarea rows={3} {...common} /> : <input type={type} {...common} />}
            <UncertainBox field={field} label={label} locked={lockedUncertain(field)} checked={flags.has(field)} disabled={busy || valueOf(field) === null} onToggle={toggleFlag} />
          </div>
        );
      })}
      <fieldset className="sg-edit__row" disabled={busy}>
        <legend>All day</legend>
        {(['yes', 'no', 'unknown'] as AllDay[]).map((v) => (
          <label key={v}>
            <input type="radio" name="sg-edit-all-day" checked={allDay === v} onChange={() => setAllDay(v)} />{' '}
            {v === 'yes' ? 'Yes' : v === 'no' ? 'No' : 'Not known'}
          </label>
        ))}
        {isAllDay && <p className="sg-muted">Start and end times are not used for an all-day event.</p>}
      </fieldset>
      {message && (
        <p id="sg-edit-error" role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      <div className="sg-edit__actions">
        <Button type="submit" size="sm" variant="primary" disabled={busy || conflict}>
          {busy ? 'Saving…' : uncertainOutcome ? 'Save again' : 'Save changes'}
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
        {(conflict || everUnknown) && (
          <SaveRecoveryActions checking={latestCheck.checking} onCheck={() => void onCheck()} onDiscardAndLoad={onLoadLatest} />
        )}
      </div>
      {latestCheck.text && <p role="status">{latestCheck.text}</p>}
    </form>
  );
}

function UncertainBox({
  field,
  label,
  locked,
  checked,
  disabled,
  onToggle,
}: {
  field: EventDraftField;
  label: string;
  locked: boolean;
  checked: boolean;
  disabled: boolean;
  onToggle: (f: EventDraftField) => void;
}) {
  return (
    <label className="sg-edit__flag">
      <input
        type="checkbox"
        aria-label={`Not sure about ${label}`}
        checked={locked || checked}
        disabled={locked || disabled}
        onChange={() => onToggle(field)}
      />{' '}
      Not sure
      {locked && <span className="sg-muted"> (stays uncertain until you change this value)</span>}
    </label>
  );
}
