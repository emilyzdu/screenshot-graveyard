// Typed client for the AI workflow endpoints (Task 2.10).
//
// Same-origin only. The workspace travels in the HttpOnly cookie; this module
// never sends or reads a workspace id. State-changing requests send the
// `X-Requested-With` header required by the server's CSRF defence. Failures keep
// the HTTP status and server error code so the UI can distinguish consent (403),
// quota (429), not-found (404) and outages (503) without guessing.

import { normalizeAnalysisOrigin, normalizeResultProvider, type ResultProvider } from './analysisOrigin';
import { OPERATION_KIND_BY_ACTION, type PreparationAction } from './preparationKinds';

export interface ApiFailure {
  ok: false;
  /** HTTP status, or 0 for a network failure / unparseable response. */
  status: number;
  code: string;
  message: string;
  /** For a 400 on an edit: the field the server's validation is about (safe to show). */
  field?: string;
}
export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

export type OperationStatus = 'pending' | 'successful' | 'failed' | 'uncertain';
export type OperationKind = 'classify' | 'study_note' | 'redo' | 'event_draft';
export type ProviderMode = 'fake' | 'openai';

export const CATEGORIES = [
  'Study/Knowledge',
  'Reference/Document',
  'Shopping/Inspiration',
  'Memory/Entertainment',
  'Unknown/Needs Review',
  'Potentially Sensitive',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Operation {
  operationId: number;
  kind: OperationKind;
  status: OperationStatus;
  errorDetail: string | null;
  artifactId: number | null;
}
export interface Accepted extends Operation {
  warning: string | null;
}
export type SuggestedAction = 'make_notes' | 'add_calendar';
export interface Analysis {
  screenshotId: number;
  classification: {
    category: Category;
    confidence: number;
    uncertain: boolean;
    versionNumber: number;
    origin: string;
    /**
     * Batch 6A: the AI's suggested next step for this classification version,
     * from what it saw in the screenshot. `null` when there is none (always for
     * the Fake AI, and after the user corrects the category).
     */
    suggestedAction?: SuggestedAction | null;
    /** Batch 6A (P2-E): who generated THIS version; `null` = not recorded or written by you. */
    provider?: ResultProvider;
  };
  epitaph: {
    text: string;
    visibleFacts: string;
    inferredIntent: string | null;
    uncertain: boolean;
    versionNumber: number;
    origin: string;
    provider?: ResultProvider;
  };
}
export interface StudyNoteContent {
  topic: string;
  main_concepts: string[];
  extracted_code: string[];
  code_explanations: string[];
  pitfalls: string[];
  uncertain_content: string[];
}
/** Per field: the origin and version number of the version that last changed it. */
export type FieldOrigins = Record<string, { origin: string; versionNumber: number }>;

export interface StudyNoteVersion {
  artifactId: number;
  versionId: number;
  versionNumber: number;
  origin: string;
  content: StudyNoteContent & { references: number[] };
  sourceScreenshotIds: number[];
  /** Derived by the server from the version history; null = could not be established. */
  fieldOrigins?: FieldOrigins | null;
}

/** What an edit save did: a new version, an already-saved replay, or nothing to save. */
export type EditResult = 'created' | 'replayed' | 'unchanged';
export interface StudyNoteSummary {
  artifactId: number;
  versionNumber: number;
  origin: string;
  topic: string;
  sourceScreenshotIds: number[];
}
export interface VersionInfo {
  versionId: number;
  versionNumber: number;
  origin: string;
  isCurrent: boolean;
}

type Fetch = typeof fetch;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isIntArr = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'number');
const STATUSES = ['pending', 'successful', 'failed', 'uncertain'];

async function call<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; json?: unknown },
  parse: (body: unknown) => T | null,
  fetchImpl: Fetch,
): Promise<ApiResult<T>> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') headers['X-Requested-With'] = 'fetch';
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method,
      headers,
      credentials: 'same-origin',
      body,
    });
  } catch {
    return { ok: false, status: 0, code: 'network', message: 'Network request failed' };
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const err = isObj(parsed) && isObj(parsed.error) ? parsed.error : {};
    return {
      ok: false,
      status: response.status,
      code: typeof err.code === 'string' ? err.code : `http_${response.status}`,
      message: typeof err.message === 'string' ? err.message : `HTTP ${response.status}`,
      ...(typeof err.field === 'string' ? { field: err.field } : {}),
    };
  }
  const data = parse(parsed);
  if (data === null) {
    return { ok: false, status: response.status, code: 'bad_shape', message: 'Unexpected response shape' };
  }
  return { ok: true, data };
}

function parseOperation(b: unknown): Operation | null {
  if (!isObj(b)) return null;
  if (typeof b.operationId !== 'number' || typeof b.status !== 'string') return null;
  if (!STATUSES.includes(b.status)) return null;
  if (b.kind !== 'classify' && b.kind !== 'study_note' && b.kind !== 'redo' && b.kind !== 'event_draft') return null;
  return {
    operationId: b.operationId,
    kind: b.kind,
    status: b.status as OperationStatus,
    errorDetail: typeof b.errorDetail === 'string' ? b.errorDetail : null,
    artifactId: typeof b.artifactId === 'number' ? b.artifactId : null,
  };
}
function parseAccepted(b: unknown): Accepted | null {
  const op = parseOperation(b);
  if (!op || !isObj(b)) return null;
  return { ...op, warning: typeof b.warning === 'string' ? b.warning : null };
}
function parseAnalysis(b: unknown, screenshotId: number): Analysis | null {
  if (!isObj(b) || b.screenshotId !== screenshotId) return null;
  const c = b.classification;
  const e = b.epitaph;
  if (!isObj(c) || !isObj(e)) return null;
  if (!CATEGORIES.includes(c.category as Category)) return null;
  if (typeof c.confidence !== 'number' || typeof c.uncertain !== 'boolean') return null;
  if (typeof c.versionNumber !== 'number') return null;
  if (typeof e.text !== 'string' || typeof e.visibleFacts !== 'string') return null;
  if (typeof e.uncertain !== 'boolean') return null;
  if (typeof e.versionNumber !== 'number') return null;
  if (e.inferredIntent !== null && typeof e.inferredIntent !== 'string') return null;
  return {
    screenshotId,
    classification: {
      category: c.category as Category,
      confidence: c.confidence,
      uncertain: c.uncertain,
      versionNumber: c.versionNumber,
      origin: normalizeAnalysisOrigin(c.origin),
      // Advisory only: anything unrecognised is treated as no suggestion, never guessed.
      suggestedAction: c.suggestedAction === 'make_notes' || c.suggestedAction === 'add_calendar' ? c.suggestedAction : null,
      provider: normalizeResultProvider(c.provider),
    },
    epitaph: {
      text: e.text,
      visibleFacts: e.visibleFacts,
      inferredIntent: e.inferredIntent as string | null,
      uncertain: e.uncertain,
      versionNumber: e.versionNumber,
      origin: normalizeAnalysisOrigin(e.origin),
      provider: normalizeResultProvider(e.provider),
    },
  };
}
function parseContent(c: unknown): (StudyNoteContent & { references: number[] }) | null {
  if (!isObj(c) || typeof c.topic !== 'string') return null;
  if (
    !isStrArr(c.main_concepts) ||
    !isStrArr(c.extracted_code) ||
    !isStrArr(c.code_explanations) ||
    !isStrArr(c.pitfalls) ||
    !isStrArr(c.uncertain_content) ||
    !isIntArr(c.references)
  ) {
    return null;
  }
  return {
    topic: c.topic,
    main_concepts: c.main_concepts,
    extracted_code: c.extracted_code,
    code_explanations: c.code_explanations,
    pitfalls: c.pitfalls,
    uncertain_content: c.uncertain_content,
    references: c.references,
  };
}
function parseNoteVersion(b: unknown): StudyNoteVersion | null {
  if (!isObj(b)) return null;
  const content = parseContent(b.content);
  if (
    !content ||
    typeof b.artifactId !== 'number' ||
    typeof b.versionId !== 'number' ||
    typeof b.versionNumber !== 'number' ||
    typeof b.origin !== 'string' ||
    !isIntArr(b.sourceScreenshotIds)
  ) {
    return null;
  }
  return {
    artifactId: b.artifactId,
    versionId: b.versionId,
    versionNumber: b.versionNumber,
    origin: b.origin,
    content,
    sourceScreenshotIds: b.sourceScreenshotIds,
    ...(b.fieldOrigins !== undefined ? { fieldOrigins: parseFieldOrigins(b.fieldOrigins) } : {}),
  };
}

function parseFieldOrigins(v: unknown): FieldOrigins | null {
  if (!isObj(v)) return null;
  const out: FieldOrigins = {};
  for (const [k, o] of Object.entries(v)) {
    if (!isObj(o) || typeof o.origin !== 'string' || typeof o.versionNumber !== 'number') return null;
    out[k] = { origin: o.origin, versionNumber: o.versionNumber };
  }
  return out;
}

function parseEditResult(b: unknown): EditResult | null {
  if (!isObj(b)) return null;
  return b.editResult === 'created' || b.editResult === 'replayed' || b.editResult === 'unchanged' ? b.editResult : null;
}

// ------------------------------------------------------------------ consent

export function getConsent(id: number, f: Fetch = fetch) {
  return call(
    `/api/screenshots/${id}/consent`,
    {},
    (b) => (isObj(b) && typeof b.granted === 'boolean' ? b.granted : null),
    f,
  );
}
export function getProviderMode(f: Fetch = fetch) {
  return call('/api/ai/provider-mode', {}, (b): ProviderMode | null =>
    isObj(b) && (b.mode === 'fake' || b.mode === 'openai') ? b.mode : null, f);
}
/**
 * Batch 6A (P1-A): the server's AI processing disclosure. It is shown to the
 * user verbatim, and a grant must echo its `provider` and `revision`.
 */
export interface Disclosure {
  provider: ProviderMode;
  revision: string;
  text: string;
}
export function getDisclosure(f: Fetch = fetch) {
  return call('/api/ai/disclosure', {}, (b): Disclosure | null =>
    isObj(b) && (b.provider === 'fake' || b.provider === 'openai') && typeof b.revision === 'string' && b.revision.length > 0 &&
    typeof b.text === 'string' && b.text.length > 0
      ? { provider: b.provider, revision: b.revision, text: b.text }
      : null, f);
}
/**
 * Record consent. A GRANT carries the provider and revision of the disclosure
 * the user was shown; without one it is refused by the server (409
 * `disclosure_changed`), which is never retried automatically. Withdrawing
 * needs no disclosure.
 */
export function setConsent(id: number, granted: boolean, f: Fetch = fetch, shown?: Pick<Disclosure, 'provider' | 'revision'>) {
  return call(
    `/api/screenshots/${id}/consent`,
    {
      method: 'POST',
      json: granted && shown ? { granted, provider: shown.provider, disclosureRevision: shown.revision } : { granted },
    },
    (b) => (isObj(b) && typeof b.granted === 'boolean' ? b.granted : null),
    f,
  );
}

// ------------------------------------------------------- classification (Revive)

export function classifyScreenshot(id: number, f: Fetch = fetch) {
  return call(`/api/screenshots/${id}/classify`, { method: 'POST' }, parseAccepted, f);
}
export function getOperation(operationId: number, f: Fetch = fetch) {
  return call(`/api/operations/${operationId}`, {}, parseOperation, f);
}
export function getAnalysis(id: number, f: Fetch = fetch) {
  return call(`/api/screenshots/${id}/analysis`, {}, (body) => parseAnalysis(body, id), f);
}
export function editAnalysis(
  id: number,
  edit: { category?: Category; epitaphText?: string },
  f: Fetch = fetch,
) {
  return call(`/api/screenshots/${id}/analysis/edits`, { method: 'POST', json: edit }, (body) => parseAnalysis(body, id), f);
}

// -------------------------------------------------------------- study notes

export function generateStudyNote(screenshotIds: number[], f: Fetch = fetch) {
  return call('/api/study-notes', { method: 'POST', json: { screenshotIds } }, parseAccepted, f);
}
export function listStudyNotes(f: Fetch = fetch) {
  return call(
    '/api/study-notes',
    {},
    (b): StudyNoteSummary[] | null => {
      if (!isObj(b) || !Array.isArray(b.notes)) return null;
      const out: StudyNoteSummary[] = [];
      for (const n of b.notes) {
        if (
          !isObj(n) ||
          typeof n.artifactId !== 'number' ||
          typeof n.versionNumber !== 'number' ||
          typeof n.origin !== 'string' ||
          typeof n.topic !== 'string' ||
          !isIntArr(n.sourceScreenshotIds)
        ) {
          return null;
        }
        out.push({
          artifactId: n.artifactId,
          versionNumber: n.versionNumber,
          origin: n.origin,
          topic: n.topic,
          sourceScreenshotIds: n.sourceScreenshotIds,
        });
      }
      return out;
    },
    f,
  );
}
// ------------------------------------------- draft preparation (Batch 4A / 4B)
export type { PreparationAction } from './preparationKinds';
/**
 * One draft preparation for one screenshot and action. `provider` is what the server
 * recorded when it accepted the request ("fake" = simulated draft), not the
 * current provider mode. `reused` is true when the server returned an existing
 * running or finished preparation instead of starting a new one.
 */
export interface Preparation {
  screenshotId: number;
  action: PreparationAction;
  operationId: number;
  status: OperationStatus;
  artifactId: number | null;
  errorDetail: string | null;
  provider: string | null;
  reused: boolean;
}

function parsePreparation(b: unknown, screenshotId: number, action: PreparationAction): Preparation | null {
  if (!isObj(b) || b.screenshotId !== screenshotId || b.action !== action) return null;
  if (b.kind !== OPERATION_KIND_BY_ACTION[action]) return null; // another action's operation is never accepted
  if (typeof b.operationId !== 'number' || typeof b.status !== 'string' || !STATUSES.includes(b.status)) return null;
  if (b.artifactId !== null && typeof b.artifactId !== 'number') return null;
  return {
    screenshotId,
    action,
    operationId: b.operationId,
    status: b.status as OperationStatus,
    artifactId: b.artifactId as number | null,
    errorDetail: typeof b.errorDetail === 'string' ? b.errorDetail : null,
    provider: typeof b.provider === 'string' ? b.provider : null,
    reused: b.reused === true,
  };
}

function requestPreparation(screenshotId: number, action: PreparationAction, f: Fetch) {
  return call(
    `/api/screenshots/${screenshotId}/preparations`,
    { method: 'POST', json: { action } },
    (b) => parsePreparation(b, screenshotId, action),
    f,
  );
}

function getPreparation(screenshotId: number, action: PreparationAction, f: Fetch) {
  return call(
    `/api/screenshots/${screenshotId}/preparations/${action}`,
    {},
    (b) => parsePreparation(b, screenshotId, action),
    f,
  );
}

/** Explicitly start (or reuse) the Make Notes draft for one screenshot. CSRF-guarded POST. */
export function requestMakeNotesDraft(screenshotId: number, f: Fetch = fetch) {
  return requestPreparation(screenshotId, 'make_notes', f);
}

/** The newest Make Notes preparation for one screenshot (404 `no_preparation` when none). */
export function getMakeNotesPreparation(screenshotId: number, f: Fetch = fetch) {
  return getPreparation(screenshotId, 'make_notes', f);
}

/** Explicitly start (or reuse) the calendar event draft for one screenshot (Batch 4B). CSRF-guarded POST. */
export function requestEventDraft(screenshotId: number, f: Fetch = fetch) {
  return requestPreparation(screenshotId, 'add_calendar', f);
}

/** The newest calendar event draft preparation for one screenshot (404 `no_preparation` when none). */
export function getEventDraftPreparation(screenshotId: number, f: Fetch = fetch) {
  return getPreparation(screenshotId, 'add_calendar', f);
}

// ------------------------------------------------------ event draft (Batch 4B)
export const EVENT_DRAFT_FIELDS = [
  'title', 'start_date', 'start_time', 'end_date', 'end_time', 'all_day', 'time_zone', 'location', 'description',
] as const;
export type EventDraftField = (typeof EVENT_DRAFT_FIELDS)[number];

/**
 * A persisted calendar event DRAFT. Unknown values are `null` and named in
 * `missingFields`; nothing is defaulted. Dates are `YYYY-MM-DD`, times are
 * local `HH:MM` in `timeZone` (IANA). Nothing here has been sent to a calendar.
 */
export interface EventDraftContent {
  title: string | null;
  startDate: string | null;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  allDay: boolean | null;
  timeZone: string | null;
  location: string | null;
  description: string | null;
  missingFields: EventDraftField[];
  uncertainFields: EventDraftField[];
  references: number[];
  /**
   * Batch 6A: other events visible in the same screenshot that this draft does
   * not cover (short labels). Shown so nothing is silently dropped.
   */
  otherEvents?: string[];
}

export interface EventDraftVersion {
  artifactId: number;
  versionId: number;
  versionNumber: number;
  origin: string;
  sourceScreenshotIds: number[];
  content: EventDraftContent;
  fieldOrigins?: FieldOrigins | null;
}

/** The editable event fields (wire names). `null` = unknown; every key is always sent. */
export interface EventDraftEdit {
  title: string | null;
  start_date: string | null;
  start_time: string | null;
  end_date: string | null;
  end_time: string | null;
  all_day: boolean | null;
  time_zone: string | null;
  location: string | null;
  description: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const strOrNull = (v: unknown, re?: RegExp): v is string | null =>
  v === null || (typeof v === 'string' && v.length > 0 && (re === undefined || re.test(v)));
const fieldList = (v: unknown): v is EventDraftField[] =>
  Array.isArray(v) && v.every((x) => (EVENT_DRAFT_FIELDS as readonly unknown[]).includes(x));

function parseEventDraft(b: unknown): EventDraftVersion | null {
  if (!isObj(b) || !isObj(b.content)) return null;
  const c = b.content;
  if (
    typeof b.artifactId !== 'number' ||
    typeof b.versionId !== 'number' ||
    typeof b.versionNumber !== 'number' ||
    typeof b.origin !== 'string' ||
    !isIntArr(b.sourceScreenshotIds)
  ) {
    return null;
  }
  if (
    !strOrNull(c.title) ||
    !strOrNull(c.start_date, DATE_RE) ||
    !strOrNull(c.start_time, TIME_RE) ||
    !strOrNull(c.end_date, DATE_RE) ||
    !strOrNull(c.end_time, TIME_RE) ||
    !(c.all_day === null || typeof c.all_day === 'boolean') ||
    !strOrNull(c.time_zone) ||
    !strOrNull(c.location) ||
    !strOrNull(c.description) ||
    !fieldList(c.missing_fields) ||
    !fieldList(c.uncertain_fields) ||
    !isIntArr(c.references)
  ) {
    return null;
  }
  // A missing field must really be empty: never show a value the server called unknown.
  const content = c as Record<EventDraftField, unknown>;
  if (c.missing_fields.some((f) => content[f] !== null)) return null;
  const otherEvents = c.other_events === undefined ? [] : c.other_events;
  if (!Array.isArray(otherEvents) || otherEvents.length > 10 || !otherEvents.every((x) => typeof x === 'string' && x.length > 0)) {
    return null;
  }
  return {
    artifactId: b.artifactId,
    versionId: b.versionId,
    versionNumber: b.versionNumber,
    origin: b.origin,
    sourceScreenshotIds: b.sourceScreenshotIds,
    ...(b.fieldOrigins !== undefined ? { fieldOrigins: parseFieldOrigins(b.fieldOrigins) } : {}),
    content: {
      title: c.title,
      startDate: c.start_date,
      startTime: c.start_time,
      endDate: c.end_date,
      endTime: c.end_time,
      allDay: c.all_day,
      timeZone: c.time_zone,
      location: c.location,
      description: c.description,
      missingFields: c.missing_fields,
      uncertainFields: c.uncertain_fields,
      references: c.references,
      otherEvents: otherEvents as string[],
    },
  };
}

/** Read one persisted event draft (current version by default). Read-only. */
export function getEventDraft(artifactId: number, f: Fetch = fetch, versionId?: number) {
  const q = versionId === undefined ? '' : `?versionId=${versionId}`;
  return call(`/api/event-drafts/${artifactId}${q}`, {}, parseEventDraft, f);
}

function parseVersionList(b: unknown): VersionInfo[] | null {
  if (!isObj(b) || !Array.isArray(b.versions)) return null;
  const out: VersionInfo[] = [];
  for (const v of b.versions) {
    if (!isObj(v) || typeof v.versionId !== 'number' || typeof v.versionNumber !== 'number' ||
        typeof v.origin !== 'string' || typeof v.isCurrent !== 'boolean') {
      return null;
    }
    out.push({ versionId: v.versionId, versionNumber: v.versionNumber, origin: v.origin, isCurrent: v.isCurrent });
  }
  return out;
}

/** All retained versions of an event draft, oldest first. Read-only. */
export function listEventDraftVersions(artifactId: number, f: Fetch = fetch) {
  return call(`/api/event-drafts/${artifactId}/versions`, {}, parseVersionList, f);
}

/**
 * Save a manual edit of an event draft as a new version (Batch 5A). The server
 * derives missing/uncertain fields; `uncertainFields` only lists the fields the
 * user explicitly flags. A stale `baseVersionId` is a 409 `version_conflict`.
 */
export function saveEventDraftEdit(
  artifactId: number,
  baseVersionId: number,
  content: EventDraftEdit,
  uncertainFields: EventDraftField[],
  f: Fetch = fetch,
) {
  return call(
    `/api/event-drafts/${artifactId}/edits`,
    { method: 'POST', json: { baseVersionId, content, uncertainFields } },
    (b) => {
      const version = parseEventDraft(b);
      const result = parseEditResult(b);
      return version && result ? { ...version, editResult: result } : null;
    },
    f,
  );
}

export function getStudyNote(artifactId: number, versionId?: number, f: Fetch = fetch) {
  const q = versionId === undefined ? '' : `?versionId=${versionId}`;
  return call(`/api/study-notes/${artifactId}${q}`, {}, parseNoteVersion, f);
}
export function listStudyNoteVersions(artifactId: number, f: Fetch = fetch) {
  return call(
    `/api/study-notes/${artifactId}/versions`,
    {},
    (b): VersionInfo[] | null => {
      if (!isObj(b) || !Array.isArray(b.versions)) return null;
      const out: VersionInfo[] = [];
      for (const v of b.versions) {
        if (
          !isObj(v) ||
          typeof v.versionId !== 'number' ||
          typeof v.versionNumber !== 'number' ||
          typeof v.origin !== 'string' ||
          typeof v.isCurrent !== 'boolean'
        ) {
          return null;
        }
        out.push({
          versionId: v.versionId,
          versionNumber: v.versionNumber,
          origin: v.origin,
          isCurrent: v.isCurrent,
        });
      }
      return out;
    },
    f,
  );
}
/**
 * Save a manual edit as a new version. `baseVersionId` is the version being
 * edited: a stale base is a 409 `version_conflict` and nothing is saved.
 */
export function saveStudyNoteEdit(artifactId: number, content: StudyNoteContent, baseVersionId: number, f: Fetch = fetch) {
  return call(
    `/api/study-notes/${artifactId}/edits`,
    { method: 'POST', json: { baseVersionId, content } },
    (b) => {
      const version = parseNoteVersion(b);
      const result = parseEditResult(b);
      return version && result ? { ...version, editResult: result } : null;
    },
    f,
  );
}
/** Server-generated Markdown download for a retained version (GET; cookie auth). */
export function studyNoteExportUrl(artifactId: number, versionId?: number): string {
  const q = versionId === undefined ? '' : `?versionId=${versionId}`;
  return `/api/study-notes/${artifactId}/export${q}`;
}

// ------------------------------------------------------ approval (Batch 5B)
/** One durable approval of one exact saved version. The approver is this workspace (no user accounts). */
export interface ApprovalRecord {
  approvalId: number;
  artifactId: number;
  versionId: number;
  versionNumber: number;
  /** ISO-8601 with offset, as recorded by the server. */
  approvedAt: string;
  approvedBy: 'workspace';
  acknowledgedUncertain: string[];
  /** Fields whose value came from AI and that the user had not changed when approving. */
  aiOriginFields: string[];
}
export type ApprovalState = 'current_approved' | 'older_approved' | 'never_approved';
export interface ApprovalReason {
  field: string | null;
  code: string;
  message: string;
}
export interface ApprovalStatus {
  artifactId: number;
  kind: 'study_note' | 'event_draft';
  currentVersionId: number;
  currentVersionNumber: number;
  status: ApprovalState;
  approvals: ApprovalRecord[];
  eligibility: {
    eligible: boolean;
    reasons: ApprovalReason[];
    requiredAcknowledgements: string[];
    aiOriginFields: string[];
  };
}
export interface ApproveResult {
  approval: ApprovalRecord;
  approvalResult: 'created' | 'existing';
}

const APPROVAL_STATES: readonly string[] = ['current_approved', 'older_approved', 'never_approved'];

function parseApprovalRecord(v: unknown, artifactId: number): ApprovalRecord | null {
  if (
    !isObj(v) || typeof v.approvalId !== 'number' || v.artifactId !== artifactId ||
    typeof v.versionId !== 'number' || typeof v.versionNumber !== 'number' ||
    typeof v.approvedAt !== 'string' || Number.isNaN(Date.parse(v.approvedAt)) || v.approvedBy !== 'workspace' ||
    !isStrArr(v.acknowledgedUncertain) || !isStrArr(v.aiOriginFields)
  ) {
    return null;
  }
  return {
    approvalId: v.approvalId, artifactId, versionId: v.versionId, versionNumber: v.versionNumber,
    approvedAt: v.approvedAt, approvedBy: 'workspace',
    acknowledgedUncertain: v.acknowledgedUncertain, aiOriginFields: v.aiOriginFields,
  };
}

function parseApprovalStatus(b: unknown, artifactId: number): ApprovalStatus | null {
  if (!isObj(b) || b.artifactId !== artifactId || (b.kind !== 'study_note' && b.kind !== 'event_draft')) return null;
  if (typeof b.currentVersionId !== 'number' || typeof b.currentVersionNumber !== 'number') return null;
  if (typeof b.status !== 'string' || !APPROVAL_STATES.includes(b.status) || !Array.isArray(b.approvals)) return null;
  const e = b.eligibility;
  if (!isObj(e) || typeof e.eligible !== 'boolean' || !Array.isArray(e.reasons) ||
      !isStrArr(e.requiredAcknowledgements) || !isStrArr(e.aiOriginFields)) {
    return null;
  }
  const reasons: ApprovalReason[] = [];
  for (const r of e.reasons) {
    if (!isObj(r) || (r.field !== null && typeof r.field !== 'string') || typeof r.code !== 'string' || typeof r.message !== 'string') return null;
    reasons.push({ field: r.field as string | null, code: r.code, message: r.message });
  }
  const approvals: ApprovalRecord[] = [];
  for (const a of b.approvals) {
    const rec = parseApprovalRecord(a, artifactId);
    if (!rec) return null;
    approvals.push(rec);
  }
  const status = b.status as ApprovalState;
  // The state must agree with the records; anything else is not trusted.
  const currentApproved = approvals.some((a) => a.versionId === b.currentVersionId);
  const consistent =
    (status === 'current_approved' && currentApproved) ||
    (status === 'older_approved' && !currentApproved && approvals.length > 0) ||
    (status === 'never_approved' && approvals.length === 0);
  if (!consistent || (e.eligible && reasons.length > 0)) return null;
  return {
    artifactId, kind: b.kind, currentVersionId: b.currentVersionId, currentVersionNumber: b.currentVersionNumber,
    status, approvals,
    eligibility: { eligible: e.eligible, reasons, requiredAcknowledgements: e.requiredAcknowledgements, aiOriginFields: e.aiOriginFields },
  };
}

/** Approval history and the current version's eligibility (read-only). */
export function getApprovalStatus(artifactId: number, f: Fetch = fetch) {
  return call(`/api/artifacts/${artifactId}/approval`, {}, (b) => parseApprovalStatus(b, artifactId), f);
}

/**
 * Approve ONE exact saved version (the current one). The server re-checks that
 * it is still current, complete and consistent. Repeating it is safe: an
 * existing approval is returned, never duplicated. Nothing is sent anywhere.
 */
export function approveVersion(artifactId: number, versionId: number, acknowledgeUncertain: string[], f: Fetch = fetch) {
  return call(
    `/api/artifacts/${artifactId}/approvals`,
    { method: 'POST', json: { versionId, confirmReviewed: true, acknowledgeUncertain } },
    (b): ApproveResult | null => {
      if (!isObj(b) || (b.approvalResult !== 'created' && b.approvalResult !== 'existing')) return null;
      const approval = parseApprovalRecord(b.approval, artifactId);
      return approval && approval.versionId === versionId ? { approval, approvalResult: b.approvalResult } : null;
    },
    f,
  );
}

// ---------------------------------------------------------------- Batch 6B: auto-processing

/** The workspace's opt-in automation preference. It is not consent. */
export function getAutomation(f: Fetch = fetch) {
  return call('/api/workspace/automation', {}, (b) => (isObj(b) && typeof b.autoPrepare === 'boolean' ? b.autoPrepare : null), f);
}
/** Turn automatic analysis -> routing -> draft preparation on or off. CSRF-guarded POST. */
export function setAutomation(enabled: boolean, f: Fetch = fetch) {
  return call(
    '/api/workspace/automation',
    { method: 'POST', json: { autoPrepare: enabled } },
    (b) => (isObj(b) && b.autoPrepare === enabled ? enabled : null),
    f,
  );
}

export const AUTO_STAGES = [
  'archived', 'awaiting_consent', 'not_started', 'analyzing', 'analysis_failed', 'routing',
  'ready_to_prepare', 'preparing', 'ready_for_review', 'preparation_failed', 'needs_choice',
  'recommended', 'reference',
] as const;
export type AutoStage = (typeof AUTO_STAGES)[number];
export type RouteDecision = 'auto' | 'recommend' | 'keep_reference' | 'needs_choice';
export interface AutoRoute {
  decision: RouteDecision;
  action: SuggestedAction | null;
  reasonCode: string;
  reason: string;
}
export interface AutoStep {
  operationId: number;
  status: OperationStatus;
  artifactId: number | null;
  errorDetail: string | null;
  provider: string | null;
  action?: SuggestedAction;
  /** Who started it, from the server's durable record. null = not recorded (shown neutrally). */
  trigger: 'auto' | 'manual' | null;
}
export interface AutoProcessState {
  screenshotId: number;
  autoPrepare: boolean;
  consent: boolean;
  stage: AutoStage;
  route: AutoRoute | null;
  analysis: AutoStep | null;
  preparation: AutoStep | null;
  running: boolean;
}
/** In-progress stages: the server is (or may be) doing work right now. */
export const AUTO_IN_PROGRESS: ReadonlySet<AutoStage> = new Set<AutoStage>(['analyzing', 'routing', 'preparing']);

function parseAutoStep(b: unknown, withAction: boolean): AutoStep | null | undefined {
  if (b === null) return null;
  if (!isObj(b) || typeof b.operationId !== 'number' || typeof b.status !== 'string' || !STATUSES.includes(b.status)) return undefined;
  if (b.artifactId !== null && typeof b.artifactId !== 'number') return undefined;
  const step: AutoStep = {
    operationId: b.operationId,
    status: b.status as OperationStatus,
    artifactId: b.artifactId as number | null,
    errorDetail: typeof b.errorDetail === 'string' ? b.errorDetail : null,
    provider: typeof b.provider === 'string' ? b.provider : null,
    trigger: b.trigger === 'auto' || b.trigger === 'manual' ? b.trigger : null,
  };
  if (withAction) {
    if (b.action !== 'make_notes' && b.action !== 'add_calendar') return undefined;
    step.action = b.action;
  }
  return step;
}
function parseAutoState(b: unknown, screenshotId: number): AutoProcessState | null {
  if (!isObj(b) || b.screenshotId !== screenshotId) return null;
  if (typeof b.autoPrepare !== 'boolean' || typeof b.consent !== 'boolean' || typeof b.running !== 'boolean') return null;
  if (typeof b.stage !== 'string' || !(AUTO_STAGES as readonly string[]).includes(b.stage)) return null;
  let route: AutoRoute | null = null;
  if (b.route !== null) {
    const r = b.route;
    if (!isObj(r) || typeof r.reason !== 'string' || typeof r.reasonCode !== 'string') return null;
    if (r.decision !== 'auto' && r.decision !== 'recommend' && r.decision !== 'keep_reference' && r.decision !== 'needs_choice') return null;
    if (r.action !== null && r.action !== 'make_notes' && r.action !== 'add_calendar') return null;
    route = { decision: r.decision, action: r.action, reasonCode: r.reasonCode, reason: r.reason };
  }
  const analysis = parseAutoStep(b.analysis, false);
  const preparation = parseAutoStep(b.preparation, true);
  if (analysis === undefined || preparation === undefined) return null;
  return { screenshotId, autoPrepare: b.autoPrepare, consent: b.consent, stage: b.stage as AutoStage, route, analysis, preparation, running: b.running };
}
/** The derived pipeline state for one screenshot. A safe read: it never starts anything. */
export function getAutoProcess(screenshotId: number, f: Fetch = fetch) {
  return call(`/api/screenshots/${screenshotId}/auto-process`, {}, (b) => parseAutoState(b, screenshotId), f);
}
/**
 * Explicitly continue automatically for one screenshot (202 = work scheduled,
 * 200 = nothing new needed). Idempotent on the server. CSRF-guarded POST.
 */
export function startAutoProcess(screenshotId: number, f: Fetch = fetch) {
  return call(`/api/screenshots/${screenshotId}/auto-process`, { method: 'POST' }, (b) => parseAutoState(b, screenshotId), f);
}
