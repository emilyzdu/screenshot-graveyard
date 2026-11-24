import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, ApiResult, EventDraftVersion, Operation, Preparation, ProviderMode } from '../api/ai';
import type { ListResult, Screenshot, ScreenshotAnalysis } from '../api/client';

// Batch 4B: the Add to Calendar Prepare → Persist → Reopen flow in the Live
// Workspace. API modules are mocked; nothing touches the network, a provider
// or any calendar.

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
  requestMakeNotesDraft: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Preparation>>>(),
  getStudyNote: vi.fn(),
  getEventDraftPreparation: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Preparation>>>(),
  requestEventDraft: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Preparation>>>(),
  getEventDraft: vi.fn<(artifactId: number, f?: typeof fetch) => Promise<ApiResult<EventDraftVersion>>>(),
}));
vi.mock('../api/ai', () => ai);

import LiveWorkspace from './LiveWorkspace';
import { CalendarDraft } from './CalendarDraft';

const sum = (category: string): ScreenshotAnalysis => ({ category, uncertain: false, epitaph: 'Epi', epitaphOrigin: 'ai_generate' });
const shot = (id: number, name: string, category = 'Reference/Document'): Screenshot => ({
  screenshotId: id, state: 'active', mimeType: 'image/png', originalFilename: name,
  isDuplicate: false, duplicateOf: null, byteSize: 9, uploadedAt: '2026-11-19T20:00:00Z', analysis: sum(category),
});
const analysis = (id: number, category = 'Reference/Document'): Analysis => ({
  screenshotId: id,
  classification: { category: category as Analysis['classification']['category'], confidence: 0.75, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
  epitaph: { text: 'Epi', visibleFacts: 'Synthetic adapter does not interpret image content.', inferredIntent: null, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
});
const prep = (id: number, over: Partial<Preparation> = {}): Preparation => ({
  screenshotId: id, action: 'add_calendar', operationId: 80, status: 'pending', artifactId: null,
  errorDetail: null, provider: 'fake', reused: false, ...over,
});
const UNKNOWN = ['start_date', 'start_time', 'end_date', 'end_time', 'all_day', 'time_zone', 'location'] as const;
const simulated = (artifactId: number, sources: number[]): EventDraftVersion => ({
  artifactId, versionId: 1, versionNumber: 1, origin: 'ai_generate', sourceScreenshotIds: sources,
  content: {
    title: 'Simulated event draft (Fake AI)', startDate: null, startTime: null, endDate: null, endTime: null,
    allDay: null, timeZone: null, location: null,
    description: 'Placeholder text from the Fake AI. It did not read your screenshot, so no date, time, time zone or location was extracted.',
    missingFields: [...UNKNOWN], uncertainFields: ['title'], references: sources,
  },
});
const op = (status: Operation['status'], artifactId: number | null = null, errorDetail: string | null = null): ApiResult<Operation> =>
  ({ ok: true, data: { operationId: 80, kind: 'event_draft', status, errorDetail, artifactId } });
const fail = (status: number, code: string): ApiResult<never> => ({ ok: false, status, code, message: code });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
  vi.clearAllMocks();
  client.getWorkspace.mockResolvedValue({ ok: true, active: true });
  client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [shot(1, 'poster.png'), shot(2, 'flyer.png')] });
  ai.getProviderMode.mockResolvedValue({ ok: true, data: 'fake' });
  ai.getConsent.mockResolvedValue({ ok: true, data: true });
  ai.getAnalysis.mockImplementation(async (id) => ({ ok: true, data: analysis(id) }));
  ai.getMakeNotesPreparation.mockResolvedValue(fail(404, 'no_preparation'));
  ai.getEventDraftPreparation.mockResolvedValue(fail(404, 'no_preparation'));
  ai.getOperation.mockResolvedValue(op('uncertain', 601));
  ai.getEventDraft.mockImplementation(async (aid) => ({ ok: true, data: simulated(aid, [1]) }));
});

const A = () => screen.getByTestId('live-assistant');
const region = () => within(A()).getByRole('region', { name: 'Calendar event draft' });
const select = async (n: string) => { await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: `Select ${n}` })); }); };
const choose = async (label: string) => {
  fireEvent.click(within(A()).getByRole('button', { name: /Something else|Choose a next step/ }));
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: label })); });
};
async function chooseCalendar() {
  await select('poster.png');
  await within(A()).findByText('Visible facts');
  await choose('Add to Calendar');
  return within(A()).findByRole('button', { name: 'Prepare event draft' });
}
const capture = (btn: HTMLElement) => {
  const key = Object.keys(btn).find((k) => k.startsWith('__reactProps'))!;
  return (btn as unknown as Record<string, { onClick: () => void }>)[key].onClick;
};
// Anything claiming the event reached a calendar, unless explicitly negated.
const CALENDAR_CLAIM = /(?<!not )(?<!Not )(added to (google )?calendar|sent to (google )?calendar|synced|scheduled)/i;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const CLOCK = /\b([01]\d|2[0-3]):[0-5]\d\b/;

describe('Add to Calendar: prepare, persist, reopen', () => {
  it('explicit Prepare → pending → Draft ready · Needs details (simulated) → Open draft shows only Missing markers', async () => {
    ai.requestEventDraft.mockResolvedValue({ ok: true, data: prep(1) });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    const btn = await chooseCalendar();
    expect(ai.requestEventDraft).not.toHaveBeenCalled(); // choosing alone sends nothing
    expect(within(region()).getByText(/does not read dates or times from your screenshot/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(btn); });
    expect(ai.requestEventDraft).toHaveBeenCalledTimes(1);
    expect(ai.requestEventDraft).toHaveBeenCalledWith(1, expect.any(Function));
    expect(ai.requestMakeNotesDraft).not.toHaveBeenCalled();
    expect(await within(region()).findByText('Draft ready')).toBeInTheDocument();
    expect(ai.getOperation).toHaveBeenCalledWith(80, expect.any(Function));
    expect(within(region()).getByText('Needs details')).toBeInTheDocument();
    expect(within(region()).getByText('Simulated draft · Fake AI')).toBeInTheDocument();
    expect(within(region()).getByText(/draft #601\. Not added to Google Calendar or any other/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: 'Open draft' })); });
    expect(ai.getEventDraft).toHaveBeenCalledWith(601, expect.any(Function));
    const body = within(region()).getByRole('article', { name: /Event draft/ });
    expect(within(body).getByText(/the Fake AI did not read your screenshot/)).toBeInTheDocument();
    expect(within(body).getAllByText('Missing')).toHaveLength(UNKNOWN.length);
    expect(within(body).getByText('Uncertain')).toBeInTheDocument(); // the simulated title
    expect(within(body).getByText('Screenshot #1')).toBeInTheDocument();
    expect(within(body).getByText(/Version 1, generated by AI \(Fake AI, simulated\)/)).toBeInTheDocument();
    // No date or clock time appears anywhere: nothing was invented or defaulted.
    expect(A().textContent ?? '').not.toMatch(ISO_DATE);
    expect(body.textContent ?? '').not.toMatch(CLOCK);
    expect(A().textContent ?? '').not.toMatch(CALENDAR_CLAIM);
    expect(screen.queryByRole('button', { name: /approve|add to google|send/i })).not.toBeInTheDocument();
  });

  it('after a reload the saved event draft reopens without choosing again and without any POST', async () => {
    ai.getEventDraftPreparation.mockResolvedValue({ ok: true, data: prep(1, { status: 'uncertain', artifactId: 601 }) });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    await select('poster.png');
    expect(await within(region()).findByText('Draft ready')).toBeInTheDocument();
    expect(ai.getEventDraftPreparation).toHaveBeenCalledWith(1, expect.any(Function));
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: 'Open draft' })); });
    expect(within(region()).getByText('Simulated event draft (Fake AI)')).toBeInTheDocument();
    expect(ai.requestEventDraft).not.toHaveBeenCalled();
  });

  it('a running preparation on reopen is resumed by polling the same operation, not re-sent', async () => {
    ai.getEventDraftPreparation.mockResolvedValue({ ok: true, data: prep(1) });
    ai.getOperation.mockResolvedValueOnce(op('pending')).mockResolvedValue(op('uncertain', 601));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select poster.png' })); await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    } finally {
      vi.useRealTimers();
    }
    expect(within(region()).getByText('Draft ready')).toBeInTheDocument();
    expect(ai.getOperation.mock.calls.every(([opId]) => opId === 80)).toBe(true);
    expect(ai.requestEventDraft).not.toHaveBeenCalled();
  });

  it('rapid repeated clicks send one request', async () => {
    const post = deferred<ApiResult<Preparation>>();
    ai.requestEventDraft.mockReturnValue(post.promise);
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    const onClick = capture(await chooseCalendar());
    await act(async () => { onClick(); onClick(); onClick(); });
    expect(ai.requestEventDraft).toHaveBeenCalledTimes(1);
    await act(async () => { post.resolve({ ok: true, data: prep(1, { status: 'uncertain', artifactId: 601, reused: true }) }); });
    expect(within(region()).getByText('Draft ready')).toBeInTheDocument();
    expect(ai.requestEventDraft).toHaveBeenCalledTimes(1);
  });

  it('a lost Prepare response is reconciled with a read, never re-sent', async () => {
    ai.requestEventDraft.mockResolvedValue(fail(0, 'network'));
    ai.getEventDraftPreparation
      .mockResolvedValueOnce(fail(404, 'no_preparation'))
      .mockResolvedValue({ ok: true, data: prep(1, { status: 'uncertain', artifactId: 601 }) });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    const btn = await chooseCalendar();
    await act(async () => { fireEvent.click(btn); });
    expect(await within(region()).findByText('Draft ready')).toBeInTheDocument();
    expect(ai.requestEventDraft).toHaveBeenCalledTimes(1);
  });

  it('a draft that does not belong to this screenshot is not shown', async () => {
    ai.getEventDraftPreparation.mockResolvedValue({ ok: true, data: prep(1, { status: 'uncertain', artifactId: 601 }) });
    ai.getEventDraft.mockResolvedValue({ ok: true, data: simulated(601, [2]) });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    await select('poster.png');
    await within(region()).findByText('Draft ready');
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: 'Open draft' })); });
    expect(within(region()).getByText('The draft could not be loaded. Try opening it again.')).toBeInTheDocument();
    expect(within(region()).queryByText('Simulated event draft (Fake AI)')).not.toBeInTheDocument();
  });

  it('known values are shown exactly as saved: no time zone conversion or reformatting', async () => {
    ai.getEventDraftPreparation.mockResolvedValue({ ok: true, data: prep(1, { status: 'successful', artifactId: 601, provider: 'openai' }) });
    ai.getEventDraft.mockResolvedValue({
      ok: true,
      data: {
        ...simulated(601, [1]),
        content: {
          title: 'Seminar', startDate: '2026-12-01', startTime: '15:00', endDate: '2026-12-01', endTime: '16:00',
          allDay: false, timeZone: 'Asia/Tokyo', location: 'Room 4', description: null,
          missingFields: [], uncertainFields: ['location'], references: [1],
        },
      },
    });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    await select('poster.png');
    await within(region()).findByText('Draft ready');
    expect(within(region()).queryByText('Needs details')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: 'Open draft' })); });
    const body = within(region()).getByRole('article', { name: 'Event draft: Seminar' });
    expect(within(body).getAllByText('2026-12-01')).toHaveLength(2);
    expect(within(body).getByText('15:00')).toBeInTheDocument();
    expect(within(body).getByText('16:00')).toBeInTheDocument();
    expect(within(body).getByText('Asia/Tokyo')).toBeInTheDocument();
    expect(within(body).getByText('Uncertain')).toBeInTheDocument(); // the location
    expect(within(body).getByText('Not set')).toBeInTheDocument(); // description, unknown but optional
    expect(within(body).queryByText(/the Fake AI did not read/)).not.toBeInTheDocument();
    expect(within(region()).getByText('AI-generated draft · can be wrong')).toBeInTheDocument();
  });

  it('with a real provider mode Prepare stays disabled and says why', async () => {
    ai.getProviderMode.mockResolvedValue({ ok: true, data: 'openai' });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    const btn = await chooseCalendar();
    expect(btn).toBeDisabled();
    expect(within(region()).getByText(/turned off with a real AI provider/)).toBeInTheDocument();
    fireEvent.click(btn);
    expect(ai.requestEventDraft).not.toHaveBeenCalled();
  });

  it.each([
    ['consent required', fail(403, 'consent_required'), /Open it and allow AI processing first/],
    ['archived', fail(409, 'screenshot_archived'), /Resurrect it before preparing a draft/],
    ['quota', fail(429, 'quota_exceeded'), /allowance is used up/],
  ])('server refusal (%s) is shown and nothing is polled', async (_n, res, text) => {
    ai.requestEventDraft.mockResolvedValue(res as ApiResult<Preparation>);
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    const btn = await chooseCalendar();
    await act(async () => { fireEvent.click(btn); });
    expect(within(region()).getByText(text)).toBeInTheDocument();
    expect(ai.getOperation).not.toHaveBeenCalled();
  });
});

describe('Add to Calendar: retry follows the current action', () => {
  async function failOnce() {
    ai.requestEventDraft.mockResolvedValue({ ok: true, data: prep(1) });
    ai.getOperation.mockResolvedValue(op('failed', null, 'AI output failed validation'));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    const btn = await chooseCalendar();
    await act(async () => { fireEvent.click(btn); });
    await within(region()).findByText(/Preparation failed\./);
    expect(ai.requestEventDraft).toHaveBeenCalledTimes(1);
  }
  const retryBtn = () => within(region()).queryByRole('button', { name: 'Retry preparation' });

  it('Add to Calendar selected: Retry is one explicit new request', async () => {
    await failOnce();
    ai.getOperation.mockResolvedValue(op('uncertain', 602));
    await act(async () => { fireEvent.click(retryBtn()!); });
    expect(await within(region()).findByText(/draft #602/)).toBeInTheDocument();
    expect(ai.requestEventDraft).toHaveBeenCalledTimes(2);
  });

  it('Make Notes selected: the calendar failure stays readable but no calendar retry is offered', async () => {
    await failOnce();
    await choose('Make Notes');
    expect(within(region()).getByText(/Preparation failed\./)).toBeInTheDocument();
    expect(retryBtn()).not.toBeInTheDocument();
    expect(within(region()).getByText('Choose Add to Calendar to try again.')).toBeInTheDocument();
    expect(ai.requestEventDraft).toHaveBeenCalledTimes(1);
  });

  it('cleared selection: no retry is offered', async () => {
    await failOnce();
    await act(async () => { fireEvent.click(within(A()).getByRole('button', { name: 'Clear choice' })); });
    expect(within(region()).getByText(/Preparation failed\./)).toBeInTheDocument();
    expect(retryBtn()).not.toBeInTheDocument();
  });

  it('a Retry handler captured before switching to Make Notes is rejected when invoked', async () => {
    await failOnce();
    const stale = capture(retryBtn()!);
    await choose('Make Notes');
    await act(async () => { stale(); });
    expect(ai.requestEventDraft).toHaveBeenCalledTimes(1);
    expect(ai.requestMakeNotesDraft).not.toHaveBeenCalled();
  });

  it('a Retry handler captured before switching screenshots never submits for the earlier screenshot', async () => {
    await failOnce();
    const stale = capture(retryBtn()!);
    await select('poster.png');
    await select('flyer.png');
    await within(A()).findByText('Visible facts');
    await act(async () => { stale(); });
    expect(ai.requestEventDraft).toHaveBeenCalledTimes(1);
  });
});

describe('Add to Calendar alongside Make Notes', () => {
  it('both saved drafts stay readable whichever action is chosen, with no POST', async () => {
    ai.getEventDraftPreparation.mockResolvedValue({ ok: true, data: prep(1, { status: 'uncertain', artifactId: 601 }) });
    ai.getMakeNotesPreparation.mockResolvedValue({
      ok: true, data: { ...prep(1, { status: 'successful', artifactId: 501 }), action: 'make_notes', operationId: 70 },
    });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    await select('poster.png');
    await within(region()).findByText('Draft ready');
    const notes = within(A()).getByRole('region', { name: 'Make Notes draft' });
    expect(within(notes).getByText('Draft ready')).toBeInTheDocument();
    await choose('Make Notes');
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: 'Open draft' })); });
    expect(within(region()).getByText('Simulated event draft (Fake AI)')).toBeInTheDocument();
    expect(within(region()).queryByRole('button', { name: /Prepare event draft|Retry/ })).not.toBeInTheDocument();
    expect(ai.requestEventDraft).not.toHaveBeenCalled();
    expect(ai.requestMakeNotesDraft).not.toHaveBeenCalled();
  });

  it('choosing Add to Calendar never offers to prepare Make Notes, and vice versa', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    await chooseCalendar();
    expect(within(A()).queryByRole('region', { name: 'Make Notes draft' })).not.toBeInTheDocument();
    await choose('Make Notes');
    expect(within(A()).queryByRole('region', { name: 'Calendar event draft' })).not.toBeInTheDocument();
    expect(within(A()).getByRole('region', { name: 'Make Notes draft' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Batch 4B remediation (Codex reproductions).
describe('B2: polling only accepts the expected operation', () => {
  const wrong = {
    kind: (o: ApiResult<Operation>) => (o.ok ? { ok: true as const, data: { ...o.data, kind: 'study_note' as const } } : o),
    id: (o: ApiResult<Operation>) => (o.ok ? { ok: true as const, data: { ...o.data, operationId: 999 } } : o),
  };
  async function prepareWithFakeTimers(advanceMs: number) {
    ai.requestEventDraft.mockResolvedValue({ ok: true, data: prep(1) });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    const btn = await chooseCalendar();
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(btn); await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(advanceMs); });
    } finally {
      vi.useRealTimers();
    }
  }

  it.each(['kind', 'id'] as const)('a successful answer with the wrong %s is never shown as Draft ready', async (which) => {
    ai.getOperation.mockResolvedValue(wrong[which](op('successful', 501)));
    await prepareWithFakeTimers(10_000);
    expect(within(region()).queryByText('Draft ready')).not.toBeInTheDocument();
    expect(within(region()).getByText(/its status could not be read/)).toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: 'Check status' })).toBeInTheDocument();
    expect(ai.getEventDraft).not.toHaveBeenCalled();
    expect(ai.requestEventDraft).toHaveBeenCalledTimes(1); // never re-sent
  });

  it('a delayed correct answer after a mismatched one is accepted', async () => {
    ai.getOperation
      .mockResolvedValueOnce(wrong.kind(op('successful', 501)))
      .mockResolvedValueOnce(op('pending'))
      .mockResolvedValue(op('uncertain', 601));
    await prepareWithFakeTimers(5_000);
    expect(within(region()).getByText('Draft ready')).toBeInTheDocument();
    expect(within(region()).getByText(/draft #601\./)).toBeInTheDocument();
    expect(ai.requestEventDraft).toHaveBeenCalledTimes(1);
  });

  it('a mismatched lookup on reopen is not shown either', async () => {
    ai.getEventDraftPreparation.mockResolvedValue({ ok: true, data: prep(1) });
    ai.getOperation.mockResolvedValue(wrong.kind(op('successful', 501)));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'poster.png' });
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select poster.png' })); await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    } finally {
      vi.useRealTimers();
    }
    expect(within(region()).queryByText('Draft ready')).not.toBeInTheDocument();
    expect(ai.requestEventDraft).not.toHaveBeenCalled();
  });
});

describe('B1: an archived screenshot keeps its saved drafts readable', () => {
  const archivedList = () =>
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [{ ...shot(1, 'poster.png'), state: 'archived' }] });
  async function openCryptDrawer() {
    render(<LiveWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /The Crypt/ }));
    const opener = await screen.findByRole('button', { name: 'Open details for poster.png' });
    await act(async () => { fireEvent.click(opener); });
    return screen.getByRole('dialog');
  }
  const noWrites = () => {
    expect(ai.requestEventDraft).not.toHaveBeenCalled();
    expect(ai.requestMakeNotesDraft).not.toHaveBeenCalled();
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
    expect(ai.setConsent).not.toHaveBeenCalled();
    expect(client.restoreScreenshot).not.toHaveBeenCalled();
  };

  it('the Crypt drawer opens the saved calendar draft read-only, and Resurrection stays available', async () => {
    archivedList();
    ai.getEventDraftPreparation.mockResolvedValue({ ok: true, data: prep(1, { status: 'uncertain', artifactId: 601 }) });
    const d = await openCryptDrawer();
    const saved = within(d).getByRole('region', { name: 'Saved drafts' });
    const calendar = within(saved).getByRole('region', { name: 'Calendar event draft' });
    expect(await within(calendar).findByText('Draft ready')).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(calendar).getByRole('button', { name: 'Open draft' })); });
    expect(within(calendar).getByText('Simulated event draft (Fake AI)')).toBeInTheDocument();
    expect(ai.getEventDraft).toHaveBeenCalledWith(601, expect.any(Function));
    expect(within(d).queryByRole('button', { name: /Prepare|Retry|Try again/ })).not.toBeInTheDocument();
    expect(within(saved).getByText(/read-only while it is in The Crypt/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resurrection' })).toBeEnabled();
    noWrites();
  });

  it('shows a saved Make Notes draft the same way', async () => {
    archivedList();
    ai.getMakeNotesPreparation.mockResolvedValue({
      ok: true, data: { ...prep(1, { status: 'successful', artifactId: 501 }), action: 'make_notes', operationId: 70 },
    });
    ai.getStudyNote.mockResolvedValue({
      ok: true,
      data: { artifactId: 501, versionId: 1, versionNumber: 1, origin: 'ai_generate', sourceScreenshotIds: [1],
        content: { topic: 'Synthetic study note fixture', main_concepts: [], extracted_code: [], code_explanations: [], pitfalls: [], uncertain_content: [], references: [1] } },
    });
    const d = await openCryptDrawer();
    const notes = within(d).getByRole('region', { name: 'Make Notes draft' });
    expect(await within(notes).findByText('Draft ready')).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(notes).getByRole('button', { name: 'Open draft' })); });
    expect(within(notes).getByText('Synthetic study note fixture')).toBeInTheDocument();
    noWrites();
  });

  it('with no saved drafts it says so honestly', async () => {
    archivedList();
    const d = await openCryptDrawer();
    expect(await within(d).findByText('No saved drafts for this screenshot.')).toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: /Prepare/ })).not.toBeInTheDocument();
    noWrites();
  });

  it('an archived screenshot lookup denied with a generic 404 reports unavailable, not no saved drafts', async () => {
    archivedList();
    ai.getEventDraftPreparation.mockResolvedValue(fail(404, 'not_found'));
    ai.getMakeNotesPreparation.mockResolvedValue(fail(404, 'not_found'));
    const d = await openCryptDrawer();
    expect(await within(d).findByText('Could not check whether a calendar event draft exists for this screenshot.')).toBeInTheDocument();
    expect(within(d).getByText('Could not check whether a Make Notes draft exists for this screenshot.')).toBeInTheDocument();
    expect(within(d).queryByText('No saved drafts for this screenshot.')).not.toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: /Prepare|Retry preparation/ })).not.toBeInTheDocument();
    noWrites();
  });

  it('a failed preparation is shown without Retry, pointing to Resurrection', async () => {
    archivedList();
    ai.getEventDraftPreparation.mockResolvedValue({
      ok: true, data: prep(1, { status: 'failed', artifactId: null, errorDetail: 'Screenshot archived' }),
    });
    const d = await openCryptDrawer();
    const calendar = within(d).getByRole('region', { name: 'Calendar event draft' });
    expect(await within(calendar).findByText(/Preparation failed\./)).toBeInTheDocument();
    expect(within(calendar).queryByRole('button', { name: /Retry|Try again/ })).not.toBeInTheDocument();
    expect(within(calendar).getByText('Resurrect this screenshot to prepare a new draft.')).toBeInTheDocument();
    noWrites();
  });

  it('a draft that cannot be read is reported as unavailable, not invented', async () => {
    archivedList();
    ai.getEventDraftPreparation.mockResolvedValue({ ok: true, data: prep(1, { status: 'uncertain', artifactId: 601 }) });
    ai.getEventDraft.mockResolvedValue(fail(503, 'service_unavailable'));
    const d = await openCryptDrawer();
    const calendar = within(d).getByRole('region', { name: 'Calendar event draft' });
    await within(calendar).findByText('Draft ready');
    await act(async () => { fireEvent.click(within(calendar).getByRole('button', { name: 'Open draft' })); });
    expect(within(calendar).getByText('The draft could not be loaded. Try opening it again.')).toBeInTheDocument();
    noWrites();
  });

  it('an active screenshot drawer does not duplicate the assistant draft panels', async () => {
    ai.getEventDraftPreparation.mockResolvedValue({ ok: true, data: prep(1, { status: 'uncertain', artifactId: 601 }) });
    render(<LiveWorkspace />);
    const opener = await screen.findByRole('button', { name: 'Open details for poster.png' });
    await act(async () => { fireEvent.click(opener); });
    expect(within(screen.getByRole('dialog')).queryByRole('region', { name: 'Saved drafts' })).not.toBeInTheDocument();
  });
});

describe('B1: readOnly always wins over canStart', () => {
  it.each([
    ['no draft', fail(404, 'no_preparation')],
    ['a failed preparation', { ok: true as const, data: prep(1, { status: 'failed', artifactId: null, errorDetail: 'AI analysis failed' }) }],
  ])('with %s a read-only panel offers nothing to start, even when told the action is chosen', async (_n, lookup) => {
    ai.getEventDraftPreparation.mockResolvedValue(lookup as ApiResult<Preparation>);
    const presence: string[] = [];
    render(<CalendarDraft screenshot={{ ...shot(1, 'poster.png'), state: 'archived' }} providerMode="fake" canStart readOnly onPresence={(p) => presence.push(p)} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /Prepare|Retry|Try again/ })).not.toBeInTheDocument();
    expect(presence).toEqual([lookup.ok ? 'present' : 'none']);
    expect(ai.requestEventDraft).not.toHaveBeenCalled();
  });
});
