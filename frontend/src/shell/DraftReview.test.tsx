import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Analysis, ApiResult, EventDraftVersion, FieldOrigins, Operation, Preparation, ProviderMode, StudyNoteVersion, VersionInfo,
} from '../api/ai';
import type { ListResult, Screenshot, ScreenshotAnalysis } from '../api/client';

// Batch 5A: review, edit and version history in the Gothic Quiet Assistant and
// the Crypt drawer. API modules are mocked; edits are asserted at the API call.

const client = vi.hoisted(() => ({
  getWorkspace: vi.fn(), listScreenshots: vi.fn<() => Promise<ListResult>>(), uploadScreenshots: vi.fn(),
  archiveScreenshot: vi.fn(), restoreScreenshot: vi.fn(),
}));
vi.mock('../api/client', () => ({ ...client, imageUrl: (id: number) => `/api/screenshots/${id}/image` }));

const ai = vi.hoisted(() => ({
  getProviderMode: vi.fn<() => Promise<ApiResult<ProviderMode>>>(),
  getConsent: vi.fn(), setConsent: vi.fn(), classifyScreenshot: vi.fn(),
  getOperation: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Operation>>>(),
  getAnalysis: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Analysis>>>(),
  getMakeNotesPreparation: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Preparation>>>(),
  requestMakeNotesDraft: vi.fn(),
  getStudyNote: vi.fn<(artifactId: number, versionId?: number, f?: typeof fetch) => Promise<ApiResult<StudyNoteVersion>>>(),
  listStudyNoteVersions: vi.fn<(artifactId: number, f?: typeof fetch) => Promise<ApiResult<VersionInfo[]>>>(),
  saveStudyNoteEdit: vi.fn(),
  getEventDraftPreparation: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Preparation>>>(),
  requestEventDraft: vi.fn(),
  getEventDraft: vi.fn<(artifactId: number, f?: typeof fetch, versionId?: number) => Promise<ApiResult<EventDraftVersion>>>(),
  listEventDraftVersions: vi.fn<(artifactId: number, f?: typeof fetch) => Promise<ApiResult<VersionInfo[]>>>(),
  saveEventDraftEdit: vi.fn(),
}));
vi.mock('../api/ai', () => ai);

import LiveWorkspace from './LiveWorkspace';

const sum = (category: string): ScreenshotAnalysis => ({ category, uncertain: false, epitaph: 'Epi', epitaphOrigin: 'ai_generate' });
const shot = (id: number, name: string, state: 'active' | 'archived' = 'active'): Screenshot => ({
  screenshotId: id, state, mimeType: 'image/png', originalFilename: name,
  isDuplicate: false, duplicateOf: null, byteSize: 9, uploadedAt: '2026-11-19T20:00:00Z', analysis: sum('Reference/Document'),
});
const analysis = (id: number): Analysis => ({
  screenshotId: id,
  classification: { category: 'Reference/Document', confidence: 0.75, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
  epitaph: { text: 'Epi', visibleFacts: 'Synthetic adapter does not interpret image content.', inferredIntent: null, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
});
const EVENT_FIELDS = ['title', 'start_date', 'start_time', 'end_date', 'end_time', 'all_day', 'time_zone', 'location', 'description'];
const allFrom = (origin: string, versionNumber = 1): FieldOrigins =>
  Object.fromEntries(EVENT_FIELDS.map((f) => [f, { origin, versionNumber }]));
const UNKNOWN = ['start_date', 'start_time', 'end_date', 'end_time', 'all_day', 'time_zone', 'location'] as const;
const eventV1: EventDraftVersion = {
  artifactId: 601, versionId: 11, versionNumber: 1, origin: 'ai_generate', sourceScreenshotIds: [1],
  fieldOrigins: allFrom('ai_generate'),
  content: {
    title: 'Simulated event draft (Fake AI)', startDate: null, startTime: null, endDate: null, endTime: null,
    allDay: null, timeZone: null, location: null, description: 'Placeholder text from the Fake AI.',
    missingFields: [...UNKNOWN], uncertainFields: ['title'], references: [1],
  },
};
const eventV2: EventDraftVersion = {
  ...eventV1, versionId: 12, versionNumber: 2, origin: 'manual_edit',
  fieldOrigins: { ...allFrom('ai_generate'), title: { origin: 'manual_edit', versionNumber: 2 }, start_date: { origin: 'manual_edit', versionNumber: 2 } },
  content: { ...eventV1.content, title: 'Study group', startDate: '2026-12-01', uncertainFields: [],
    missingFields: ['start_time', 'end_date', 'end_time', 'all_day', 'time_zone', 'location'] },
};
const noteV1: StudyNoteVersion = {
  artifactId: 501, versionId: 21, versionNumber: 1, origin: 'ai_generate', sourceScreenshotIds: [1],
  fieldOrigins: Object.fromEntries(['topic', 'main_concepts', 'extracted_code', 'code_explanations', 'pitfalls', 'uncertain_content'].map((f) => [f, { origin: 'ai_generate', versionNumber: 1 }])),
  content: {
    topic: 'Synthetic study note fixture', main_concepts: ['Deterministic test fixture'], extracted_code: ['def f():\n\treturn 1  '],
    code_explanations: [], pitfalls: [], uncertain_content: [], references: [1],
  },
};
const list = (...vs: { versionId: number; versionNumber: number; origin: string }[]): ApiResult<VersionInfo[]> =>
  ({ ok: true, data: vs.map((v, i) => ({ ...v, isCurrent: i === vs.length - 1 })) });
const prep = (action: 'make_notes' | 'add_calendar', artifactId: number): Preparation => ({
  screenshotId: 1, action, operationId: action === 'make_notes' ? 70 : 80, status: action === 'make_notes' ? 'successful' : 'uncertain',
  artifactId, errorDetail: null, provider: 'fake', reused: false,
});
const fail = (status: number, code: string, message = code, field?: string): ApiResult<never> =>
  ({ ok: false, status, code, message, ...(field ? { field } : {}) });

let eventCurrent: EventDraftVersion;
beforeEach(() => {
  vi.clearAllMocks();
  eventCurrent = eventV1;
  client.getWorkspace.mockResolvedValue({ ok: true, active: true });
  client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [shot(1, 'poster.png')] });
  ai.getProviderMode.mockResolvedValue({ ok: true, data: 'fake' });
  ai.getConsent.mockResolvedValue({ ok: true, data: true });
  ai.getAnalysis.mockImplementation(async (id) => ({ ok: true, data: analysis(id) }));
  ai.getMakeNotesPreparation.mockResolvedValue(fail(404, 'no_preparation'));
  ai.getEventDraftPreparation.mockResolvedValue({ ok: true, data: prep('add_calendar', 601) });
  ai.getEventDraft.mockImplementation(async (_id, _f, versionId) => {
    if (versionId === undefined) return { ok: true, data: eventCurrent };
    const v = [eventV1, eventV2].find((x) => x.versionId === versionId);
    return v ? { ok: true, data: v } : fail(404, 'not_found');
  });
  ai.listEventDraftVersions.mockImplementation(async () =>
    eventCurrent === eventV1 ? list(eventV1) : list(eventV1, eventV2));
  ai.getStudyNote.mockResolvedValue({ ok: true, data: noteV1 });
  ai.listStudyNoteVersions.mockResolvedValue(list(noteV1));
});

const A = () => screen.getByTestId('live-assistant');
const calendar = (root: HTMLElement = A()) => within(root).getByRole('region', { name: 'Calendar event draft' });
const notes = (root: HTMLElement = A()) => within(root).getByRole('region', { name: 'Make Notes draft' });
async function openCalendar() {
  render(<LiveWorkspace />);
  await screen.findByRole('article', { name: 'poster.png' });
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select poster.png' })); });
  await within(calendar()).findByText('Draft ready');
  await act(async () => { fireEvent.click(within(calendar()).getByRole('button', { name: 'Open draft' })); });
  return within(calendar()).getByRole('article', { name: /Event draft/ });
}
const startEdit = async () => {
  await act(async () => { fireEvent.click(within(calendar()).getByRole('button', { name: 'Edit draft' })); });
  return within(calendar()).getByRole('form', { name: 'Edit calendar event draft' });
};
const change = (form: HTMLElement, label: RegExp, value: string) =>
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });
const noAiOrPrepare = () => {
  expect(ai.requestEventDraft).not.toHaveBeenCalled();
  expect(ai.requestMakeNotesDraft).not.toHaveBeenCalled();
  expect(ai.classifyScreenshot).not.toHaveBeenCalled();
  expect(ai.setConsent).not.toHaveBeenCalled();
};

describe('Calendar draft: review then edit', () => {
  it('opens read-only on the current version, with source, history and honest field origins', async () => {
    const body = await openCalendar();
    expect(within(calendar()).queryByRole('form')).not.toBeInTheDocument();
    expect(within(body).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(body).getAllByText('Missing')).toHaveLength(UNKNOWN.length);
    // Only the two present values carry an origin tag (title, description); missing ones show Missing.
    expect(within(body).getAllByText(/Fake AI, not checked by you \(v1\)/)).toHaveLength(2);
    expect(within(body).queryByText(/edited by you/)).not.toBeInTheDocument();
    const link = within(body).getByRole('link', { name: 'Open source screenshot #1' });
    expect(link).toHaveAttribute('href', '/api/screenshots/1/image');
    expect(link).toHaveAttribute('target', '_blank');
    expect(within(calendar()).getByRole('navigation', { name: 'Version history' })).toHaveTextContent('Version 1, simulated by the Fake AI (current)');
    expect(within(calendar()).getByRole('button', { name: 'Edit draft' })).toBeInTheDocument();
    noAiOrPrepare();
  });

  it('Save changes sends every field with unknowns kept empty and creates version 2', async () => {
    await openCalendar();
    const form = await startEdit();
    // Nothing is pre-filled: no browser time zone, no date, no duration.
    expect(within(form).getByLabelText(/^Time zone/)).toHaveValue('');
    expect(within(form).getByLabelText(/^Start date/)).toHaveValue('');
    change(form, /^Title/, 'Study group');
    change(form, /^Start date/, '2026-12-01');
    eventCurrent = eventV2;
    ai.saveEventDraftEdit.mockResolvedValue({ ok: true, data: { ...eventV2, editResult: 'created' } });
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(ai.saveEventDraftEdit).toHaveBeenCalledTimes(1);
    expect(ai.saveEventDraftEdit).toHaveBeenCalledWith(601, 11, {
      title: 'Study group', start_date: '2026-12-01', start_time: null, end_date: null, end_time: null,
      all_day: null, time_zone: null, location: null, description: 'Placeholder text from the Fake AI.',
    }, [], expect.any(Function));
    expect(await within(calendar()).findByText(/Saved as version 2\. Earlier versions are kept/)).toBeInTheDocument();
    const body = within(calendar()).getByRole('article', { name: 'Event draft: Study group' });
    expect(within(body).getAllByText(/edited by you \(v2\)/)).toHaveLength(2); // title and start date
    expect(within(body).getAllByText(/Fake AI, not checked by you \(v1\)/)).toHaveLength(1); // description untouched
    expect(within(calendar()).getByText(/draft #601, version 2\./)).toBeInTheDocument();
    await waitFor(() => expect(within(calendar()).getByRole('navigation', { name: 'Version history' })).toHaveTextContent('Version 2, edited by you (current)'));
    noAiOrPrepare();
  });

  it('an earlier version opens read-only without changing the current one', async () => {
    eventCurrent = eventV2;
    await openCalendar();
    await act(async () => { fireEvent.click(within(calendar()).getByRole('button', { name: 'View version 1' })); });
    expect(within(calendar()).getByText(/Viewing version 1, an earlier version\. It is read-only/)).toBeInTheDocument();
    expect(within(calendar()).getByRole('article', { name: 'Event draft: Simulated event draft (Fake AI)' })).toBeInTheDocument();
    expect(within(calendar()).queryByRole('button', { name: 'Edit draft' })).not.toBeInTheDocument();
    expect(ai.getEventDraft).toHaveBeenCalledWith(601, expect.any(Function), 11);
    await act(async () => { fireEvent.click(within(calendar()).getByRole('button', { name: 'Back to current version' })); });
    expect(within(calendar()).getByRole('article', { name: 'Event draft: Study group' })).toBeInTheDocument();
    expect(ai.saveEventDraftEdit).not.toHaveBeenCalled();
  });

  it('an unchanged uncertain AI value stays uncertain: its Not sure box is locked on', async () => {
    await openCalendar();
    const form = await startEdit();
    const box = within(form).getByRole('checkbox', { name: 'Not sure about Title' });
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    change(form, /^Title/, 'Mine now');
    expect(within(form).getByRole('checkbox', { name: 'Not sure about Title' })).not.toBeChecked();
    expect(within(form).getByRole('checkbox', { name: 'Not sure about Title' })).toBeEnabled();
  });

  it('values the user flags as Not sure are sent as uncertain', async () => {
    await openCalendar();
    const form = await startEdit();
    change(form, /^Location/, 'Cafe?');
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Not sure about Location' }));
    ai.saveEventDraftEdit.mockResolvedValue(fail(503, 'service_unavailable'));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(ai.saveEventDraftEdit.mock.calls[0][3]).toEqual(['location']);
  });

  it('all-day events send no times', async () => {
    await openCalendar();
    const form = await startEdit();
    change(form, /^Start date/, '2026-12-24');
    change(form, /^Start time/, '09:00');
    fireEvent.click(within(form).getByRole('radio', { name: 'Yes' }));
    expect(within(form).getByLabelText(/^Start time/)).toBeDisabled();
    ai.saveEventDraftEdit.mockResolvedValue(fail(503, 'service_unavailable'));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    const sent = ai.saveEventDraftEdit.mock.calls[0][2];
    expect(sent).toMatchObject({ all_day: true, start_time: null, end_time: null, start_date: '2026-12-24' });
  });

  it('a stale save is a conflict: nothing is claimed, typed values stay, and the latest can be loaded', async () => {
    await openCalendar();
    const form = await startEdit();
    change(form, /^Title/, 'Tab B');
    ai.saveEventDraftEdit.mockResolvedValue(fail(409, 'version_conflict'));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(within(form).getByRole('alert')).toHaveTextContent('changed somewhere else');
    expect(within(form).getByRole('alert')).toHaveTextContent('Your changes were not saved');
    expect(within(form).getByLabelText(/^Title/)).toHaveValue('Tab B');
    expect(within(form).getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(within(calendar()).queryByText(/Saved as version/)).not.toBeInTheDocument();
    eventCurrent = eventV2;
    const reads = ai.getEventDraft.mock.calls.length;
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: /Load latest version/ })); });
    expect(ai.getEventDraft.mock.calls.length).toBe(reads); // nothing discarded or loaded before confirming
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Discard my edits and load latest' })); });
    expect(ai.getEventDraft.mock.calls.length).toBeGreaterThan(reads);
    expect(await within(calendar()).findByRole('article', { name: 'Event draft: Study group' })).toBeInTheDocument();
    expect(within(calendar()).queryByRole('form')).not.toBeInTheDocument();
    expect(ai.saveEventDraftEdit).toHaveBeenCalledTimes(1);
  });

  it('a validation error names the field and saves nothing', async () => {
    await openCalendar();
    const form = await startEdit();
    change(form, /^Start date/, '2026-03-08');
    ai.saveEventDraftEdit.mockResolvedValue(fail(400, 'invalid_content', 'start_time does not exist in America/Los_Angeles on 2026-03-08', 'start_time'));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(within(form).getByRole('alert')).toHaveTextContent('start_time does not exist in America/Los_Angeles on 2026-03-08 Nothing was saved.');
    expect(within(form).getByLabelText(/^Start time/)).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('a lost response is reported as unconfirmed, never as saved', async () => {
    await openCalendar();
    const form = await startEdit();
    change(form, /^Title/, 'x');
    ai.saveEventDraftEdit.mockResolvedValue(fail(0, 'network'));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(within(form).getByRole('alert')).toHaveTextContent('could not confirm whether your changes were saved');
    expect(within(calendar()).queryByText(/Saved as version/)).not.toBeInTheDocument();
  });

  it('rapid repeated Save clicks send one request', async () => {
    await openCalendar();
    const form = await startEdit();
    change(form, /^Title/, 'x');
    let resolve!: (v: unknown) => void;
    ai.saveEventDraftEdit.mockReturnValue(new Promise((r) => { resolve = r; }));
    const btn = within(form).getByRole('button', { name: 'Save changes' });
    const key = Object.keys(btn).find((k) => k.startsWith('__reactProps'))!;
    const handlers = (btn as unknown as Record<string, { onClick?: () => void }>)[key];
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.submit(form);
      fireEvent.submit(form);
      handlers.onClick?.();
    });
    expect(ai.saveEventDraftEdit).toHaveBeenCalledTimes(1);
    eventCurrent = eventV2;
    await act(async () => { resolve({ ok: true, data: { ...eventV2, editResult: 'created' } }); });
  });

  it('replayed and unchanged saves say no new version was created', async () => {
    await openCalendar();
    let form = await startEdit();
    ai.saveEventDraftEdit.mockResolvedValue({ ok: true, data: { ...eventV1, editResult: 'unchanged' } });
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(within(calendar()).getByText('No changes to save. Nothing new was created.')).toBeInTheDocument();
    form = await startEdit();
    ai.saveEventDraftEdit.mockResolvedValue({ ok: true, data: { ...eventV2, editResult: 'replayed' } });
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(within(calendar()).getByText('Already saved as version 2. No duplicate was created.')).toBeInTheDocument();
  });

  it('Cancel leaves the saved version untouched', async () => {
    await openCalendar();
    const form = await startEdit();
    change(form, /^Title/, 'Throw away');
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Cancel' })); });
    expect(within(calendar()).getByRole('article', { name: 'Event draft: Simulated event draft (Fake AI)' })).toBeInTheDocument();
    expect(ai.saveEventDraftEdit).not.toHaveBeenCalled();
  });

  it('after a reload the summary reflects the saved current version, not the original preparation', async () => {
    eventCurrent = { ...eventV2, content: { ...eventV2.content, missingFields: [] , startTime: '09:00', endDate: '2026-12-01', endTime: '10:00', allDay: false, timeZone: 'UTC', location: 'Hall' } };
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select poster.png' })); });
    expect(await within(calendar()).findByText(/draft #601, version 2\./)).toBeInTheDocument();
    expect(within(calendar()).queryByText('Needs details')).not.toBeInTheDocument();
    expect(within(calendar()).getByText('Edited by you · started from a simulated draft')).toBeInTheDocument();
  });

  it('when field history cannot be determined it says so instead of guessing', async () => {
    eventCurrent = { ...eventV2, fieldOrigins: null };
    const body = await openCalendar();
    expect(within(body).getByText('Which fields you edited could not be determined for this version.')).toBeInTheDocument();
    expect(within(body).queryByText(/edited by you \(v/)).not.toBeInTheDocument();
  });
});

describe('Unreadable drafts', () => {
  it('a read that throws is reported as unreadable, never left loading', async () => {
    ai.getEventDraft.mockRejectedValue(new Error('boom'));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select poster.png' })); });
    await within(calendar()).findByText('Draft ready');
    await act(async () => { fireEvent.click(within(calendar()).getByRole('button', { name: 'Open draft' })); });
    expect(await within(calendar()).findByText('The draft could not be loaded. Try opening it again.')).toBeInTheDocument();
    expect(within(calendar()).getByRole('button', { name: 'Open draft' })).toBeEnabled();
    expect(within(calendar()).queryByRole('button', { name: 'Edit draft' })).not.toBeInTheDocument();
  });
});

describe('Notes draft: review then edit', () => {
  beforeEach(() => {
    ai.getEventDraftPreparation.mockResolvedValue(fail(404, 'no_preparation'));
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep('make_notes', 501) });
  });

  it('edits the structured sections into version 2, keeping code exactly and the base version', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select poster.png' })); });
    await within(notes()).findByText('Draft ready');
    await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Open draft' })); });
    const body = within(notes()).getByRole('article', { name: /Notes draft/ });
    expect(within(body).getByRole('link', { name: 'Open source screenshot #1' })).toBeInTheDocument();
    expect(within(notes()).queryByRole('form')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Edit draft' })); });
    const form = within(notes()).getByRole('form', { name: 'Edit notes draft' });
    expect(within(form).getByLabelText('Code block 1')).toHaveValue('def f():\n\treturn 1  ');
    fireEvent.click(within(form).getByRole('button', { name: 'Add Pitfalls item' }));
    fireEvent.change(within(form).getByLabelText('Pitfalls item 1'), { target: { value: 'Off-by-one' } });
    const saved: StudyNoteVersion = {
      ...noteV1, versionId: 22, versionNumber: 2, origin: 'manual_edit',
      fieldOrigins: { ...noteV1.fieldOrigins!, pitfalls: { origin: 'manual_edit', versionNumber: 2 } },
      content: { ...noteV1.content, pitfalls: ['Off-by-one'] },
    };
    ai.saveStudyNoteEdit.mockResolvedValue({ ok: true, data: { ...saved, editResult: 'created' } });
    ai.listStudyNoteVersions.mockResolvedValue(list(noteV1, saved));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(ai.saveStudyNoteEdit).toHaveBeenCalledWith(501, {
      topic: 'Synthetic study note fixture', main_concepts: ['Deterministic test fixture'],
      extracted_code: ['def f():\n\treturn 1  '], code_explanations: [], pitfalls: ['Off-by-one'], uncertain_content: [],
    }, 21, expect.any(Function));
    expect(await within(notes()).findByText(/Saved as version 2/)).toBeInTheDocument();
    const after = within(notes()).getByRole('article', { name: /Notes draft/ });
    expect(within(after).getByText(/edited by you \(v2\)/)).toBeInTheDocument();
    expect(within(after).getAllByText(/Fake AI, not checked by you \(v1\)/).length).toBeGreaterThan(0);
    expect(within(after).getByText(/sections marked "Fake AI" were written by the Fake AI/)).toBeInTheDocument();
    noAiOrPrepare();
  });

  it('an empty topic is refused before any request', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select poster.png' })); });
    await within(notes()).findByText('Draft ready');
    await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Open draft' })); });
    await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Edit draft' })); });
    const form = within(notes()).getByRole('form', { name: 'Edit notes draft' });
    fireEvent.change(within(form).getByLabelText('Topic'), { target: { value: '  ' } });
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(within(form).getByRole('alert')).toHaveTextContent('A topic is required. Nothing was saved.');
    expect(ai.saveStudyNoteEdit).not.toHaveBeenCalled();
  });
});

describe('Archived drafts stay read-only in The Crypt', () => {
  it('versions can be reviewed, but there is no Edit, Prepare or save', async () => {
    eventCurrent = eventV2;
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [shot(1, 'poster.png', 'archived')] });
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep('make_notes', 501) });
    render(<LiveWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /The Crypt/ }));
    const opener = await screen.findByRole('button', { name: 'Open details for poster.png' });
    await act(async () => { fireEvent.click(opener); });
    const d = screen.getByRole('dialog');
    const cal = calendar(d);
    await within(cal).findByText('Draft ready');
    await act(async () => { fireEvent.click(within(cal).getByRole('button', { name: 'Open draft' })); });
    expect(within(cal).getByRole('article', { name: 'Event draft: Study group' })).toBeInTheDocument();
    // The CURRENT version is shown, and still nothing can be edited.
    expect(within(cal).queryByRole('button', { name: 'Edit draft' })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(within(cal).getByRole('button', { name: 'View version 1' })); });
    expect(within(cal).getByText(/Viewing version 1/)).toBeInTheDocument();
    await within(notes(d)).findByText('Draft ready');
    await act(async () => { fireEvent.click(within(notes(d)).getByRole('button', { name: 'Open draft' })); });
    expect(within(d).queryByRole('button', { name: /Edit draft|Prepare|Retry|Save changes/ })).not.toBeInTheDocument();
    expect(within(d).queryByRole('form')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resurrection' })).toBeEnabled();
    expect(ai.saveEventDraftEdit).not.toHaveBeenCalled();
    expect(ai.saveStudyNoteEdit).not.toHaveBeenCalled();
    noAiOrPrepare();
    expect(client.restoreScreenshot).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Codex blockers (Batch 5A remediation).
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

describe('B1: a delayed history read never replaces an active editor', () => {
  it('Calendar: version 1 arriving after Edit started leaves the editor and typed text alone', async () => {
    eventCurrent = eventV2;
    const slow = deferred<ApiResult<EventDraftVersion>>();
    await openCalendar();
    ai.getEventDraft.mockImplementationOnce(() => slow.promise);
    await act(async () => { fireEvent.click(within(calendar()).getByRole('button', { name: 'View version 1' })); });
    const form = await startEdit();
    change(form, /^Title/, 'Unsaved title');
    await act(async () => { slow.resolve({ ok: true, data: eventV1 }); });
    const still = within(calendar()).getByRole('form', { name: 'Edit calendar event draft' });
    expect(within(still).getByLabelText(/^Title/)).toHaveValue('Unsaved title');
    expect(within(calendar()).queryByText(/Viewing version 1/)).not.toBeInTheDocument();
    // After Cancel the current version is shown, not the stale earlier read.
    await act(async () => { fireEvent.click(within(still).getByRole('button', { name: 'Cancel' })); });
    expect(within(calendar()).getByRole('article', { name: 'Event draft: Study group' })).toBeInTheDocument();
  });

  it('Notes: version 1 arriving after Edit started leaves the editor and typed text alone', async () => {
    ai.getEventDraftPreparation.mockResolvedValue(fail(404, 'no_preparation'));
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep('make_notes', 501) });
    const noteV2: StudyNoteVersion = { ...noteV1, versionId: 22, versionNumber: 2, origin: 'manual_edit', content: { ...noteV1.content, topic: 'Two' } };
    ai.getStudyNote.mockImplementation(async (_id, versionId) => ({ ok: true, data: versionId === 21 ? noteV1 : noteV2 }));
    ai.listStudyNoteVersions.mockResolvedValue(list(noteV1, noteV2));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select poster.png' })); });
    await within(notes()).findByText('Draft ready');
    await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Open draft' })); });
    const slow = deferred<ApiResult<StudyNoteVersion>>();
    ai.getStudyNote.mockImplementationOnce(() => slow.promise);
    await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'View version 1' })); });
    await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Edit draft' })); });
    const form = within(notes()).getByRole('form', { name: 'Edit notes draft' });
    fireEvent.change(within(form).getByLabelText('Topic'), { target: { value: 'Unsaved topic' } });
    await act(async () => { slow.resolve({ ok: true, data: noteV1 }); });
    expect(within(notes()).getByRole('form', { name: 'Edit notes draft' })).toBeInTheDocument();
    expect(within(notes()).getByLabelText('Topic')).toHaveValue('Unsaved topic');
  });
});

describe('B2: editing the notes topic changes nothing else', () => {
  const rich: StudyNoteVersion = {
    ...noteV1,
    content: {
      topic: '  Spaced topic  ',
      main_concepts: ['First paragraph.\n\nSecond paragraph of the SAME concept.', 'Another concept', ''],
      extracted_code: ['def f():\n\n\treturn 1  ', ''],
      code_explanations: ['Line one\nline two'],
      pitfalls: ['  leading and trailing  '],
      uncertain_content: ['a', 'b'],
      references: [1],
    },
  };
  async function openRichEditor() {
    ai.getEventDraftPreparation.mockResolvedValue(fail(404, 'no_preparation'));
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep('make_notes', 501) });
    ai.getStudyNote.mockResolvedValue({ ok: true, data: rich });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select poster.png' })); });
    await within(notes()).findByText('Draft ready');
    await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Open draft' })); });
    await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Edit draft' })); });
    ai.saveStudyNoteEdit.mockResolvedValue(fail(503, 'service_unavailable'));
    return within(notes()).getByRole('form', { name: 'Edit notes draft' });
  }
  const { references: _refs, ...untouched } = rich.content;
  void _refs;

  it('a topic-only edit sends every other section byte-for-byte', async () => {
    const form = await openRichEditor();
    fireEvent.change(within(form).getByLabelText('Topic'), { target: { value: 'New topic' } });
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(ai.saveStudyNoteEdit).toHaveBeenCalledWith(501, { ...untouched, topic: 'New topic' }, 21, expect.any(Function));
  });

  it('saving without changes sends the stored content exactly (including the untrimmed topic)', async () => {
    const form = await openRichEditor();
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(ai.saveStudyNoteEdit).toHaveBeenCalledWith(501, untouched, 21, expect.any(Function));
  });

  it('editing one item keeps the other items and their boundaries', async () => {
    const form = await openRichEditor();
    fireEvent.change(within(form).getByLabelText('Main concepts item 2'), { target: { value: 'Edited concept' } });
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(ai.saveStudyNoteEdit.mock.calls[0][1].main_concepts).toEqual([
      'First paragraph.\n\nSecond paragraph of the SAME concept.', 'Edited concept', '',
    ]);
  });

  it('a newly added item left empty is not saved; removing an item removes only that item', async () => {
    const form = await openRichEditor();
    fireEvent.click(within(form).getByRole('button', { name: 'Add Pitfalls item' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Remove Uncertain points item 1' }));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    const sent = ai.saveStudyNoteEdit.mock.calls[0][1];
    expect(sent.pitfalls).toEqual(['  leading and trailing  ']);
    expect(sent.uncertain_content).toEqual(['b']);
    expect(sent.extracted_code).toEqual(['def f():\n\n\treturn 1  ', '']);
  });
});

describe('B5: an uncertain save outcome is never reported as "not saved"', () => {
  it.each([
    ['503', fail(503, 'service_unavailable')],
    ['500', fail(500, 'http_500')],
    ['network', fail(0, 'network')],
  ])('Calendar %s: typed values stay, status is unknown, and saving again is offered', async (_n, res) => {
    await openCalendar();
    const form = await startEdit();
    change(form, /^Title/, 'Maybe saved');
    ai.saveEventDraftEdit.mockResolvedValue(res);
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    const alert = within(form).getByRole('alert');
    expect(alert).toHaveTextContent('could not confirm whether your changes were saved');
    expect(alert).not.toHaveTextContent('Nothing was saved');
    expect(within(form).getByLabelText(/^Title/)).toHaveValue('Maybe saved');
    expect(within(form).getByRole('button', { name: 'Save again' })).toBeEnabled();
    // Saving again is the safe check: an earlier success comes back as "replayed".
    eventCurrent = eventV2;
    ai.saveEventDraftEdit.mockResolvedValue({ ok: true, data: { ...eventV2, editResult: 'replayed' } });
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save again' })); });
    expect(within(calendar()).getByText('Already saved as version 2. No duplicate was created.')).toBeInTheDocument();
    expect(ai.saveEventDraftEdit.mock.calls[1][1]).toBe(11); // same base: a retry, not a new edit
  });

  it('Notes 503: typed values stay and the status is unknown', async () => {
    ai.getEventDraftPreparation.mockResolvedValue(fail(404, 'no_preparation'));
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep('make_notes', 501) });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select poster.png' })); });
    await within(notes()).findByText('Draft ready');
    await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Open draft' })); });
    await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Edit draft' })); });
    const form = within(notes()).getByRole('form', { name: 'Edit notes draft' });
    fireEvent.change(within(form).getByLabelText('Topic'), { target: { value: 'Maybe saved' } });
    ai.saveStudyNoteEdit.mockResolvedValue(fail(503, 'service_unavailable'));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(within(form).getByRole('alert')).toHaveTextContent('could not confirm whether your changes were saved');
    expect(within(form).getByRole('alert')).not.toHaveTextContent('Nothing was saved');
    expect(within(form).getByLabelText('Topic')).toHaveValue('Maybe saved');
  });

  it.each([
    ['a validation error', fail(400, 'invalid_content', 'Enter the start date as YYYY-MM-DD.', 'start_date'), 'Nothing was saved'],
    ['a conflict', fail(409, 'version_conflict'), 'Your changes were not saved'],
  ])('%s is still reported as definitely not saved', async (_n, res, text) => {
    await openCalendar();
    const form = await startEdit();
    change(form, /^Title/, 'x');
    ai.saveEventDraftEdit.mockResolvedValue(res);
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    expect(within(form).getByRole('alert')).toHaveTextContent(text);
  });
});

describe('B6: an unrecognised origin is shown as unknown, never as Fake AI', () => {
  it('field tags, version history and the summary badge do not guess', async () => {
    eventCurrent = { ...eventV2, origin: 'mystery', fieldOrigins: { ...allFrom('ai_generate'), title: { origin: 'mystery', versionNumber: 2 } } };
    ai.listEventDraftVersions.mockResolvedValue(list(eventV1, { versionId: 12, versionNumber: 2, origin: 'mystery' }));
    const body = await openCalendar();
    expect(within(body).getByText('origin unknown (v2)')).toBeInTheDocument();
    expect(within(calendar()).getByRole('navigation', { name: 'Version history' })).toHaveTextContent('Version 2, origin not recorded (current)');
    expect(within(calendar()).getByText('Source not recorded')).toBeInTheDocument();
    expect(within(calendar()).queryByText('Simulated draft · Fake AI')).not.toBeInTheDocument();
    // The notice speaks only about fields that are tagged Fake AI, not the whole unknown version.
    expect(within(body).queryByText(/the Fake AI did not read your screenshot\. No date/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Final Codex blockers (F1 navigation intent, F2 unknown write outcomes).
const noteV2: StudyNoteVersion = { ...noteV1, versionId: 22, versionNumber: 2, origin: 'manual_edit', content: { ...noteV1.content, topic: 'Two' } };
function useNotesWithTwoVersions() {
  ai.getEventDraftPreparation.mockResolvedValue(fail(404, 'no_preparation'));
  ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep('make_notes', 501) });
  ai.getStudyNote.mockImplementation(async (_id, versionId) => ({ ok: true, data: versionId === 21 ? noteV1 : noteV2 }));
  ai.listStudyNoteVersions.mockResolvedValue(list(noteV1, noteV2));
}
async function openNotes() {
  render(<LiveWorkspace />);
  await screen.findByRole('article', { name: 'poster.png' });
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select poster.png' })); });
  await within(notes()).findByText('Draft ready');
  await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Open draft' })); });
}
type Panel = { region: () => HTMLElement; open: () => Promise<unknown>; hold: (d: { promise: Promise<unknown> }) => void; v1: string; current: string; v1Data: unknown };
const PANELS: Record<'Calendar' | 'Notes', () => Panel> = {
  Calendar: () => {
    eventCurrent = eventV2;
    return {
      region: () => calendar(), open: openCalendar,
      hold: (d) => { ai.getEventDraft.mockImplementationOnce(() => d.promise as Promise<ApiResult<EventDraftVersion>>); },
      v1: 'Event draft: Simulated event draft (Fake AI)', current: 'Event draft: Study group', v1Data: { ok: true, data: eventV1 },
    };
  },
  Notes: () => {
    useNotesWithTwoVersions();
    return {
      region: () => notes(), open: openNotes,
      hold: (d) => { ai.getStudyNote.mockImplementationOnce(() => d.promise as Promise<ApiResult<StudyNoteVersion>>); },
      v1: 'Notes draft: Synthetic study note fixture', current: 'Notes draft: Two', v1Data: { ok: true, data: noteV1 },
    };
  },
};

describe.each(['Calendar', 'Notes'] as const)('F1 (%s): a held history read never overrides newer navigation', (name) => {
  const article = (p: Panel) => within(p.region()).getByRole('article', { name: /draft/ }).getAttribute('aria-label');

  it('Back to current while a version-2 read is held: the late answer does not pull the panel back', async () => {
    const p = PANELS[name]();
    // Three versions: v3 current; v1 shown first, then a held request for v2.
    if (name === 'Calendar') {
      const v3: EventDraftVersion = { ...eventV2, versionId: 13, versionNumber: 3, content: { ...eventV2.content, title: 'Three' } };
      eventCurrent = v3;
      ai.listEventDraftVersions.mockResolvedValue(list(eventV1, eventV2, v3));
    } else {
      const v3: StudyNoteVersion = { ...noteV2, versionId: 23, versionNumber: 3, content: { ...noteV1.content, topic: 'Three' } };
      ai.getStudyNote.mockImplementation(async (_id, versionId) => ({ ok: true, data: versionId === 21 ? noteV1 : versionId === 22 ? noteV2 : v3 }));
      ai.listStudyNoteVersions.mockResolvedValue(list(noteV1, noteV2, v3));
    }
    const currentLabel = name === 'Calendar' ? 'Event draft: Three' : 'Notes draft: Three';
    await p.open();
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'View version 1' })); });
    expect(article(p)).toBe(p.v1);
    const held = deferred<unknown>();
    p.hold(held);
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'View version 2' })); });
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'Back to current version' })); });
    expect(article(p)).toBe(currentLabel);
    await act(async () => { held.resolve(name === 'Calendar' ? { ok: true, data: eventV2 } : { ok: true, data: noteV2 }); });
    expect(article(p)).toBe(currentLabel);
    expect(within(p.region()).queryByText(/Viewing version/)).not.toBeInTheDocument();
  });

  it('Hide draft and reopen while version 1 is held: the reopened panel shows the current version', async () => {
    const p = PANELS[name]();
    await p.open();
    const held = deferred<unknown>();
    p.hold(held);
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'View version 1' })); });
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'Hide draft' })); });
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'Open draft' })); });
    await act(async () => { held.resolve(p.v1Data); });
    expect(article(p)).toBe(p.current);
    expect(within(p.region()).queryByText(/Viewing version 1/)).not.toBeInTheDocument();
  });

  it('a held read that fails after navigating away does not replace the view with an error', async () => {
    const p = PANELS[name]();
    await p.open();
    const held = deferred<unknown>();
    p.hold(held);
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'View version 1' })); });
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'Hide draft' })); });
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'Open draft' })); });
    await act(async () => { held.resolve(fail(503, 'service_unavailable')); });
    expect(within(p.region()).queryByText('The draft could not be loaded. Try opening it again.')).not.toBeInTheDocument();
    expect(article(p)).toBe(p.current);
  });

  it('a newer history request still works after an older one was cancelled', async () => {
    const p = PANELS[name]();
    await p.open();
    const held = deferred<unknown>();
    p.hold(held);
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'View version 1' })); });
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'Hide draft' })); });
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'Open draft' })); });
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'View version 1' })); });
    expect(article(p)).toBe(p.v1);
    await act(async () => { held.resolve(p.v1Data); });
    await act(async () => { fireEvent.click(within(p.region()).getByRole('button', { name: 'Back to current version' })); });
    expect(article(p)).toBe(p.current);
  });
});

describe('F1: out-of-order history answers', () => {
  it('the later request wins even when the earlier one answers last', async () => {
    const v3: EventDraftVersion = { ...eventV2, versionId: 13, versionNumber: 3, content: { ...eventV2.content, title: 'Three' } };
    eventCurrent = v3;
    ai.listEventDraftVersions.mockResolvedValue(list(eventV1, eventV2, v3));
    await openCalendar();
    const first = deferred<ApiResult<EventDraftVersion>>();
    const second = deferred<ApiResult<EventDraftVersion>>();
    ai.getEventDraft.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    await act(async () => { fireEvent.click(within(calendar()).getByRole('button', { name: 'View version 1' })); });
    await act(async () => { fireEvent.click(within(calendar()).getByRole('button', { name: 'View version 2' })); });
    await act(async () => { second.resolve({ ok: true, data: eventV2 }); });
    await act(async () => { first.resolve({ ok: true, data: eventV1 }); });
    expect(within(calendar()).getByText(/Viewing version 2/)).toBeInTheDocument();
    expect(within(calendar()).getByRole('article', { name: 'Event draft: Study group' })).toBeInTheDocument();
  });
});

type EditorCase = { open: () => Promise<HTMLElement>; save: typeof ai.saveEventDraftEdit; type: (form: HTMLElement) => void; typed: (form: HTMLElement) => string };
const EDITORS: Record<'Calendar' | 'Notes', () => EditorCase> = {
  Calendar: () => ({
    open: async () => { await openCalendar(); return startEdit(); },
    save: ai.saveEventDraftEdit,
    type: (form) => change(form, /^Title/, 'My unsaved title'),
    typed: (form) => (within(form).getByLabelText(/^Title/) as HTMLInputElement).value,
  }),
  Notes: () => {
    ai.getEventDraftPreparation.mockResolvedValue(fail(404, 'no_preparation'));
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep('make_notes', 501) });
    return {
      open: async () => {
        await openNotes();
        await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Edit draft' })); });
        return within(notes()).getByRole('form', { name: 'Edit notes draft' });
      },
      save: ai.saveStudyNoteEdit,
      type: (form) => fireEvent.change(within(form).getByLabelText('Topic'), { target: { value: 'My unsaved title' } }),
      typed: (form) => (within(form).getByLabelText('Topic') as HTMLInputElement).value,
    };
  },
};
const UNKNOWN_TEXT = 'could not confirm whether your changes were saved';
const D_TEXT = 'This retry was rejected because the draft has changed. Your earlier save may still be in version history. Your edits are preserved.';

describe.each(['Calendar', 'Notes'] as const)('F2 (%s): unknown write outcomes stay unknown', (name) => {
  const saveBtn = (form: HTMLElement) => within(form).getByRole('button', { name: /^Save (changes|again)$/ });
  async function attempt(form: HTMLElement, e: EditorCase, res: unknown) {
    e.save.mockResolvedValueOnce(res);
    await act(async () => { fireEvent.click(saveBtn(form)); });
    return within(form).getByRole('alert').textContent ?? '';
  }

  it('a malformed or truncated 200 body is an unknown outcome, not a failure', async () => {
    const e = EDITORS[name](); const form = await e.open(); e.type(form);
    const text = await attempt(form, e, { ok: false, status: 200, code: 'bad_shape', message: 'Unexpected response shape' });
    expect(text).toContain(UNKNOWN_TEXT);
    expect(text).not.toMatch(/could not be saved|not saved\./);
    expect(e.typed(form)).toBe('My unsaved title');
    expect(within(form).getByRole('button', { name: 'Save again' })).toBeEnabled();
  });

  it.each([['a network loss', fail(0, 'network')], ['a 5xx', fail(502, 'http_502')]])('%s is unknown and keeps input', async (_n, res) => {
    const e = EDITORS[name](); const form = await e.open(); e.type(form);
    expect(await attempt(form, e, res)).toContain(UNKNOWN_TEXT);
    expect(e.typed(form)).toBe('My unsaved title');
  });

  it('unknown → retry replayed: confirmed saved, no duplicate', async () => {
    const e = EDITORS[name](); const form = await e.open(); e.type(form);
    await attempt(form, e, fail(0, 'network'));
    const saved = name === 'Calendar' ? { ...eventV2, editResult: 'replayed' } : { ...noteV2, editResult: 'replayed' };
    if (name === 'Calendar') eventCurrent = eventV2;
    e.save.mockResolvedValueOnce({ ok: true, data: saved });
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save again' })); });
    const region = name === 'Calendar' ? calendar() : notes();
    expect(within(region).getByText('Already saved as version 2. No duplicate was created.')).toBeInTheDocument();
    expect(e.save).toHaveBeenCalledTimes(2);
  });

  it('unknown → retry 409: the retry was rejected, the earlier save may be in history, input is kept', async () => {
    const e = EDITORS[name](); const form = await e.open(); e.type(form);
    await attempt(form, e, fail(0, 'network'));
    const text = await attempt(form, e, fail(409, 'version_conflict'));
    expect(text).toContain(D_TEXT);
    expect(text).not.toContain('Your changes were not saved');
    expect(e.typed(form)).toBe('My unsaved title');
    // A later different rejection does not erase the earlier uncertainty either.
    expect(within(form).getByRole('button', { name: 'Check latest saved version' })).toBeEnabled();
  });

  it('an initial 409 with no earlier unknown attempt says this attempt was not saved', async () => {
    const e = EDITORS[name](); const form = await e.open(); e.type(form);
    const text = await attempt(form, e, fail(409, 'version_conflict'));
    expect(text).toContain('Your changes were not saved');
    expect(text).not.toContain('may still be in version history');
    expect(e.typed(form)).toBe('My unsaved title');
  });

  it('a validation rejection is a definite "not saved"', async () => {
    const e = EDITORS[name](); const form = await e.open(); e.type(form);
    const res = name === 'Calendar'
      ? fail(400, 'invalid_content', 'Enter the start date as YYYY-MM-DD.', 'start_date')
      : fail(422, 'http_422');
    const text = await attempt(form, e, res);
    expect(text).toContain('Nothing was saved');
    expect(text).not.toContain(UNKNOWN_TEXT);
  });

  it('loading the latest version asks before discarding, and Keep editing keeps the input', async () => {
    const e = EDITORS[name](); const form = await e.open(); e.type(form);
    await attempt(form, e, fail(0, 'network'));
    await attempt(form, e, fail(409, 'version_conflict'));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: /Load latest version/ })); });
    expect(within(form).getByRole('alertdialog', { name: 'Discard your unsaved edits?' })).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Keep editing' })); });
    expect(e.typed(form)).toBe('My unsaved title');
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: /Load latest version/ })); });
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Discard my edits and load latest' })); });
    const region = name === 'Calendar' ? calendar() : notes();
    expect(within(region).queryByRole('form')).not.toBeInTheDocument();
  });

  it('Check latest saved version reads without discarding and says whether it already has your edits', async () => {
    const e = EDITORS[name](); const form = await e.open(); e.type(form);
    await attempt(form, e, fail(0, 'network'));
    await attempt(form, e, fail(409, 'version_conflict'));
    // The latest saved version already contains exactly these edits (the earlier save went through).
    if (name === 'Calendar') {
      eventCurrent = { ...eventV2, content: { ...eventV1.content, title: 'My unsaved title', uncertainFields: [] } };
    } else {
      ai.getStudyNote.mockResolvedValue({ ok: true, data: { ...noteV2, content: { ...noteV1.content, topic: 'My unsaved title' } } });
    }
    const writes = e.save.mock.calls.length;
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Check latest saved version' })); });
    expect(within(form).getByRole('status')).toHaveTextContent(/The latest saved version is version 2.*It already contains your edits/);
    expect(e.typed(form)).toBe('My unsaved title');
    expect(e.save.mock.calls.length).toBe(writes);
  });
});

describe.each(['Calendar', 'Notes'] as const)('F2 (%s): checking the latest version is honest', (name) => {
  it('says so when the latest saved version does NOT contain your edits', async () => {
    const e = EDITORS[name](); const form = await e.open(); e.type(form);
    e.save.mockResolvedValueOnce(fail(0, 'network'));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    if (name === 'Calendar') eventCurrent = eventV2; // someone else's v2 ("Study group")
    else ai.getStudyNote.mockResolvedValue({ ok: true, data: noteV2 }); // topic "Two"
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Check latest saved version' })); });
    expect(within(form).getByRole('status')).toHaveTextContent('The latest saved version is version 2, edited by you. It does not contain exactly your edits.');
    expect(e.typed(form)).toBe('My unsaved title');
  });
});

describe('F2: the API client keeps a malformed 2xx distinguishable', () => {
  it('a truncated 200 body is reported with status 200 and code bad_shape, never as a rejection', async () => {
    const real = await vi.importActual<typeof import('../api/ai')>('../api/ai');
    const f = (async () => new Response('{"artifactId": 6', { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    const r = await real.saveEventDraftEdit(6, 1, {
      title: 'x', start_date: null, start_time: null, end_date: null, end_time: null, all_day: null, time_zone: null, location: null, description: null,
    }, [], f);
    expect(r).toMatchObject({ ok: false, status: 200, code: 'bad_shape' });
  });
});

// ---------------------------------------------------------------------------
// Final recheck: "Check latest saved version" must never confirm falsely.
const MATCH = 'It already contains your edits.';
const NO_MATCH = 'It does not contain exactly your edits.';
const NOT_CONFIRMED = 'The save status could not be confirmed';
const checkBtn = (form: HTMLElement) => within(form).getByRole('button', { name: 'Check latest saved version' });
const statusText = (form: HTMLElement) => within(form).queryByRole('status')?.textContent ?? '';

async function calendarUnknown(flagTitle: boolean) {
  await openCalendar();
  const form = await startEdit();
  change(form, /^Title/, 'My unsaved title');
  if (flagTitle) fireEvent.click(within(form).getByRole('checkbox', { name: 'Not sure about Title' }));
  ai.saveEventDraftEdit.mockResolvedValueOnce(fail(0, 'network'));
  await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
  return form;
}
const savedEvent = (over: Partial<EventDraftVersion['content']>): EventDraftVersion =>
  ({ ...eventV2, content: { ...eventV1.content, title: 'My unsaved title', uncertainFields: [], ...over } });

describe('Check latest (Calendar): compares the full effective edit, including uncertainty', () => {
  it('same title but a different uncertainty flag is NOT a match', async () => {
    const form = await calendarUnknown(true);
    eventCurrent = savedEvent({ uncertainFields: [] });
    await act(async () => { fireEvent.click(checkBtn(form)); });
    expect(statusText(form)).toContain(NO_MATCH);
  });

  it('same values and the same uncertainty flags IS a match, and the request is a read only', async () => {
    const form = await calendarUnknown(true);
    eventCurrent = savedEvent({ uncertainFields: ['title'] });
    const writes = ai.saveEventDraftEdit.mock.calls.length;
    await act(async () => { fireEvent.click(checkBtn(form)); });
    expect(statusText(form)).toContain(MATCH);
    expect(ai.saveEventDraftEdit.mock.calls.length).toBe(writes);
    // What a Save would send equals what is stored: verify the actual payload.
    ai.saveEventDraftEdit.mockResolvedValueOnce(fail(503, 'service_unavailable'));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save again' })); });
    const calls = ai.saveEventDraftEdit.mock.calls;
    const [, , sentContent, sentUncertain] = calls[calls.length - 1];
    const stored = eventCurrent.content;
    expect(sentContent).toEqual({
      title: stored.title, start_date: stored.startDate, start_time: stored.startTime, end_date: stored.endDate,
      end_time: stored.endTime, all_day: stored.allDay, time_zone: stored.timeZone, location: stored.location, description: stored.description,
    });
    expect(sentUncertain).toEqual(stored.uncertainFields);
  });

  it.each([
    ['ticking "Not sure"', (form: HTMLElement) => fireEvent.click(within(form).getByRole('checkbox', { name: 'Not sure about Title' }))],
    ['changing the title', (form: HTMLElement) => change(form, /^Title/, 'Changed while checking')],
  ])('%s while a check is in flight: the stale answer is ignored', async (_n, edit) => {
    const form = await calendarUnknown(false);
    const held = deferred<ApiResult<EventDraftVersion>>();
    ai.getEventDraft.mockImplementationOnce(() => held.promise);
    await act(async () => { fireEvent.click(checkBtn(form)); });
    edit(form);
    await act(async () => { held.resolve({ ok: true, data: savedEvent({}) }); }); // matches the OLD form
    expect(statusText(form)).not.toContain(MATCH);
    expect(statusText(form)).toContain(NOT_CONFIRMED);
  });

  it.each([
    ['location', (f: HTMLElement) => change(f, /^Location/, 'Hall')],
    ['start date', (f: HTMLElement) => change(f, /^Start date/, '2026-12-01')],
    ['all day', (f: HTMLElement) => fireEvent.click(within(f).getByRole('radio', { name: 'Yes' }))],
    ['description', (f: HTMLElement) => change(f, /^Description/, 'Other')],
  ])('a positive match disappears as soon as the %s changes', async (_n, edit) => {
    const form = await calendarUnknown(false);
    eventCurrent = savedEvent({});
    await act(async () => { fireEvent.click(checkBtn(form)); });
    expect(statusText(form)).toContain(MATCH);
    edit(form);
    expect(statusText(form)).not.toContain(MATCH);
  });

  it('two checks answering out of order: only the newest may publish', async () => {
    const form = await calendarUnknown(false);
    const first = deferred<ApiResult<EventDraftVersion>>();
    const second = deferred<ApiResult<EventDraftVersion>>();
    ai.getEventDraft.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    await act(async () => { fireEvent.click(checkBtn(form)); });
    change(form, /^Title/, 'Newer title');
    await act(async () => { fireEvent.click(checkBtn(form)); });
    await act(async () => { second.resolve({ ok: true, data: savedEvent({ title: 'Something else' }) }); });
    expect(statusText(form)).toContain(NO_MATCH);
    await act(async () => { first.resolve({ ok: true, data: savedEvent({}) }); }); // old form's match arrives late
    expect(statusText(form)).toContain(NO_MATCH);
    expect(statusText(form)).not.toContain(MATCH);
  });

  it.each([
    ['an error answer', () => ai.getEventDraft.mockResolvedValueOnce(fail(503, 'service_unavailable'))],
    ['a thrown read', () => ai.getEventDraft.mockRejectedValueOnce(new Error('boom'))],
  ])('%s never produces a positive confirmation', async (_n, arrange) => {
    const form = await calendarUnknown(false);
    arrange();
    await act(async () => { fireEvent.click(checkBtn(form)); });
    expect(statusText(form)).toContain(NOT_CONFIRMED);
    expect(statusText(form)).not.toContain(MATCH);
    expect(within(form).getByLabelText(/^Title/)).toHaveValue('My unsaved title');
  });
});

describe('Check latest (Calendar): AI uncertainty the user did not change', () => {
  it('an unchanged AI-uncertain title stays part of the comparison', async () => {
    await openCalendar();
    const form = await startEdit(); // title untouched: it stays uncertain (locked "Not sure")
    change(form, /^Location/, 'Hall');
    ai.saveEventDraftEdit.mockResolvedValueOnce(fail(0, 'network'));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    // Stored exactly as the server derives it: the Fake title still uncertain.
    eventCurrent = { ...eventV2, content: { ...eventV1.content, location: 'Hall', missingFields: eventV1.content.missingFields.filter((f) => f !== 'location') } };
    await act(async () => { fireEvent.click(checkBtn(form)); });
    expect(statusText(form)).toContain(MATCH);
    // The same values with the uncertainty dropped is not what this Save would store.
    eventCurrent = { ...eventCurrent, content: { ...eventCurrent.content, uncertainFields: [] } };
    await act(async () => { fireEvent.click(checkBtn(form)); });
    expect(statusText(form)).toContain(NO_MATCH);
  });
});

describe('Check latest (Notes): freshness', () => {
  async function notesUnknown() {
    ai.getEventDraftPreparation.mockResolvedValue(fail(404, 'no_preparation'));
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep('make_notes', 501) });
    ai.getStudyNote.mockResolvedValue({ ok: true, data: { ...noteV1, content: { ...noteV1.content, main_concepts: ['Deterministic test fixture'] } } });
    await openNotes();
    await act(async () => { fireEvent.click(within(notes()).getByRole('button', { name: 'Edit draft' })); });
    const form = within(notes()).getByRole('form', { name: 'Edit notes draft' });
    fireEvent.change(within(form).getByLabelText('Topic'), { target: { value: 'My topic' } });
    ai.saveStudyNoteEdit.mockResolvedValueOnce(fail(0, 'network'));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); });
    return form;
  }
  const savedNote = { ...noteV2, content: { ...noteV1.content, topic: 'My topic' } };

  it('an identical stored note with an unchanged form IS a match', async () => {
    const form = await notesUnknown();
    ai.getStudyNote.mockResolvedValueOnce({ ok: true, data: savedNote });
    await act(async () => { fireEvent.click(checkBtn(form)); });
    expect(statusText(form)).toContain(MATCH);
  });

  it.each([
    ['the topic', (f: HTMLElement) => fireEvent.change(within(f).getByLabelText('Topic'), { target: { value: 'Changed' } })],
    ['a structured item', (f: HTMLElement) => fireEvent.change(within(f).getByLabelText('Main concepts item 1'), { target: { value: 'Changed' } })],
  ])('changing %s while a check is in flight: the stale answer is ignored', async (_n, edit) => {
    const form = await notesUnknown();
    const held = deferred<ApiResult<StudyNoteVersion>>();
    ai.getStudyNote.mockImplementationOnce(() => held.promise);
    await act(async () => { fireEvent.click(checkBtn(form)); });
    edit(form);
    await act(async () => { held.resolve({ ok: true, data: savedNote }); });
    expect(statusText(form)).not.toContain(MATCH);
    expect(statusText(form)).toContain(NOT_CONFIRMED);
  });

  it('a positive match disappears after a later edit, and nothing is written', async () => {
    const form = await notesUnknown();
    ai.getStudyNote.mockResolvedValueOnce({ ok: true, data: savedNote });
    const writes = ai.saveStudyNoteEdit.mock.calls.length;
    await act(async () => { fireEvent.click(checkBtn(form)); });
    expect(statusText(form)).toContain(MATCH);
    fireEvent.change(within(form).getByLabelText('Main concepts item 1'), { target: { value: 'Edited after the check' } });
    expect(statusText(form)).not.toContain(MATCH);
    expect(ai.saveStudyNoteEdit.mock.calls.length).toBe(writes);
    expect(within(form).getByLabelText('Main concepts item 1')).toHaveValue('Edited after the check');
  });
});
