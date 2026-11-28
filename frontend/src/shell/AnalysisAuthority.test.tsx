import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import LiveWorkspace from './LiveWorkspace';

const shot = (id: number, originalFilename: string, epitaphOrigin: unknown = 'ai_generate') => ({
  screenshotId: id, originalFilename, state: 'active', mimeType: 'image/png', byteSize: 10,
  isDuplicate: false, duplicateOf: null, uploadedAt: '2026-11-19T20:00:00Z',
  analysis: { category: 'Study/Knowledge', uncertain: false, epitaph: 'Saved notes', epitaphOrigin },
});
const a = shot(41, 'alpha.png');
const b = shot(42, 'beta.png');
const analysis = (s: ReturnType<typeof shot>, category = 'Study/Knowledge', origin: unknown = 'ai_generate') => ({
  screenshotId: s.screenshotId,
  classification: { category, confidence: 0.75, uncertain: false, versionNumber: 2, origin },
  epitaph: { text: s.analysis.epitaph, visibleFacts: 'Original auxiliary facts', inferredIntent: 'Original auxiliary guess',
    uncertain: false, versionNumber: 2, origin: s.analysis.epitaphOrigin },
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const fail = (status: number) => json({ error: { code: 'unavailable', message: 'Unavailable' } }, status);
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};
function fakeServer(
  records: ReturnType<typeof shot>[],
  respond: (url: string) => Response | Promise<Response>,
  provider: 'fake' | 'openai' = 'fake',
) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') throw new Error('Unexpected mutation');
    if (url === '/api/workspace') return json({ workspaceActive: true });
    if (url === '/api/ai/provider-mode') return json({ mode: provider });
    if (url === '/api/screenshots') return json({ screenshots: records });
    if (url.endsWith('/consent')) return json({ granted: true });
    if (url.endsWith('/analysis')) return respond(url);
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const assistant = () => within(screen.getByRole('complementary', { name: 'Quiet Assistant' }));
const card = (filename: string) => screen.getByRole('article', { name: filename });
async function select(filename: string) {
  await screen.findByRole('article', { name: filename });
  fireEvent.click(within(card(filename)).getByRole('checkbox'));
}
afterEach(() => vi.unstubAllGlobals());

it('withholds suggestions during validation and reconciles the card with newer sensitive detail', async () => {
  const pending = deferred();
  fakeServer([b], () => pending.promise);
  render(<LiveWorkspace />);
  await select('beta.png');
  expect.soft(assistant().queryByRole('button', { name: 'Choose Make Notes' })).not.toBeInTheDocument();
  expect.soft(card('beta.png')).not.toHaveTextContent('Suggested');
  await act(async () => pending.resolve(json(analysis(b, 'Potentially Sensitive'))));
  await assistant().findByText('Potentially Sensitive');
  expect(card('beta.png')).toHaveTextContent('Potentially Sensitive');
  expect(card('beta.png')).not.toHaveTextContent('Suggested');
  expect(assistant().queryByRole('button', { name: 'Choose Make Notes' })).not.toBeInTheDocument();
  await select('beta.png');
  expect(card('beta.png')).toHaveTextContent('Potentially Sensitive');
});

it.each([404, 503])('does not turn the gallery fallback after a %s into an automatic suggestion', async (status) => {
  fakeServer([b], () => fail(status));
  render(<LiveWorkspace />);
  await select('beta.png');
  await assistant().findByText(/did not return a saved analysis|full analysis could not be loaded/);
  expect(assistant().queryByRole('button', { name: 'Choose Make Notes' })).not.toBeInTheDocument();
  expect(card('beta.png')).not.toHaveTextContent('Suggested');
});

it.each(['assistant', 'drawer'])('rejects a mismatched analysis in the %s and offers a read-only retry', async (surface) => {
  let wrong = true;
  const fetcher = fakeServer([a, b], () => json(wrong
    ? { ...analysis(a), epitaph: { ...analysis(a).epitaph, text: 'Alpha private text' } }
    : analysis(b)));
  render(<LiveWorkspace />);
  await screen.findByRole('article', { name: 'beta.png' });
  if (surface === 'assistant') await select('beta.png');
  else fireEvent.click(screen.getByRole('button', { name: 'Open details for beta.png' }));
  const scope = surface === 'assistant' ? assistant() : within(screen.getByRole('dialog'));
  const retry = await scope.findByRole('button', { name: /Retry|Try again/ });
  expect(scope.queryByText('Alpha private text')).not.toBeInTheDocument();
  expect(scope.queryByRole('button', { name: 'Choose Make Notes' })).not.toBeInTheDocument();
  wrong = false;
  fireEvent.click(retry);
  await scope.findByText('Visible facts');
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/analysis')).map(([url]) => url))
    .toEqual(['/api/screenshots/42/analysis', '/api/screenshots/42/analysis']);
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it.each(['unrecognized_origin', null, 7])('does not guess provenance for the origin %s', async (origin) => {
  const unknown = shot(42, 'beta.png', origin);
  fakeServer([unknown], () => json(analysis(unknown, 'Study/Knowledge', origin)));
  render(<LiveWorkspace />);
  await select('beta.png');
  expect(card('beta.png')).toHaveTextContent('Epitaph: source unconfirmed');
  await assistant().findByText('Visible facts');
  expect(assistant().queryByText(/simulated result|generated by the demo AI/i)).not.toBeInTheDocument();
});

it('shows mixed field provenance without attributing retained auxiliary fields to the editor', async () => {
  const edited = shot(42, 'beta.png', 'manual_edit');
  fakeServer([edited], () => json(analysis(edited, 'Study/Knowledge', 'manual_edit')));
  render(<LiveWorkspace />);
  await select('beta.png');
  await assistant().findByText('Visible facts');
  expect(assistant().queryByText('Edited by you', { exact: true })).not.toBeInTheDocument();
  expect(assistant().getByText(/Category edited by you; Epitaph edited by you/)).toBeInTheDocument();
  expect(assistant().getAllByText(/field source unavailable/i)).toHaveLength(2);
});

it('withholds numeric confidence for unknown origin even under mocked OpenAI mode', async () => {
  const fetcher = fakeServer([b], () => json(analysis(b, 'Study/Knowledge', 'unrecognized_origin')), 'openai');
  render(<LiveWorkspace />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open details for beta.png' }));
  const result = within(await screen.findByLabelText('Classification result'));
  expect(result.getByText('Confidence').nextElementSibling).not.toHaveTextContent(/75%|reported by the model/);
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
