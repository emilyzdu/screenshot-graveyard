import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult, Disclosure, ProviderMode } from '../api/ai';
import type { ListResult, Screenshot } from '../api/client';

// Milestone 1 items 10-19. Both API modules are mocked; nothing touches the network or an AI provider.
const client = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  listScreenshots: vi.fn<() => Promise<ListResult>>(),
  uploadScreenshots: vi.fn(),
  archiveScreenshot: vi.fn(),
  restoreScreenshot: vi.fn(),
}));
vi.mock('../api/client', () => ({ ...client, imageUrl: (id: number) => `/api/screenshots/${id}/image` }));
const notFound = () => Promise.resolve({ ok: false as const, status: 404, code: 'no_preparation', message: 'No preparation yet' });
const ai = vi.hoisted(() => ({
  getProviderMode: vi.fn<() => Promise<ApiResult<ProviderMode>>>(),
  getConsent: vi.fn(),
  setConsent: vi.fn(),
  getDisclosure: vi.fn<() => Promise<ApiResult<Disclosure>>>(),
  classifyScreenshot: vi.fn(),
  getOperation: vi.fn(),
  getAnalysis: vi.fn(),
  getMakeNotesPreparation: vi.fn(),
  requestMakeNotesDraft: vi.fn(),
  getEventDraftPreparation: vi.fn(),
  requestEventDraft: vi.fn(),
  listStudyNoteVersions: vi.fn(),
  listEventDraftVersions: vi.fn(),
  getApprovalStatus: vi.fn(),
  getAutomation: vi.fn(),
  setAutomation: vi.fn(),
  getAutoProcess: vi.fn(),
  startAutoProcess: vi.fn(),
  requestRedo: vi.fn(),
}));
vi.mock('../api/ai', async (orig) => ({ ...(await orig<typeof import('../api/ai')>()), ...ai }));
const sceneMock = vi.hoisted(() => ({ throws: false }));
vi.mock('./scene/SceneViewport', async (orig) => {
  const real = await orig<typeof import('./scene/SceneViewport')>();
  return { SceneViewport: (p: Parameters<typeof real.SceneViewport>[0]) => { if (sceneMock.throws) throw new Error('boom'); return real.SceneViewport(p); } };
});

import PixelWorld from './PixelWorld';

const shot = (id: number, over: Partial<Screenshot> = {}): Screenshot => ({
  screenshotId: id, state: 'active', mimeType: 'image/png', originalFilename: `real-${id}.png`, isDuplicate: false,
  duplicateOf: null, byteSize: 1, uploadedAt: '2026-01-01T00:00:00Z', analysis: null, ...over,
});
const analyzed = { category: 'Study/Knowledge', uncertain: false, epitaph: 'Here lies a lecture.', epitaphOrigin: 'ai_generate' };
const PAID = [ai.classifyScreenshot, ai.startAutoProcess, ai.requestEventDraft, ai.requestMakeNotesDraft, ai.setConsent, ai.requestRedo];
const hot = (name: string) => document.querySelector<HTMLElement>(`.pw-hotspot[aria-label="${name}"]`)!;
const expectNoPaidCalls = () => PAID.forEach((f) => expect(f).not.toHaveBeenCalled());

beforeEach(() => {
  vi.clearAllMocks();
  sceneMock.throws = false;
  window.history.replaceState({}, '', '/?view=world');
  client.getWorkspace.mockResolvedValue({ ok: true, active: true });
  client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [shot(1), shot(2, { analysis: analyzed }), shot(3), shot(4, { state: 'archived' })] });
  ai.getProviderMode.mockResolvedValue({ ok: true, data: 'openai' });
  ai.getDisclosure.mockResolvedValue({ ok: true, data: { provider: 'openai', revision: 'rev', text: 'Revive sends the image to OpenAI.' } });
  ai.getConsent.mockResolvedValue({ ok: true, data: false });
  ai.getAnalysis.mockResolvedValue({ ok: false, status: 404, code: 'not_found', message: 'not_found' });
  ai.getMakeNotesPreparation.mockImplementation(notFound);
  ai.getEventDraftPreparation.mockImplementation(notFound);
  ai.getAutomation.mockResolvedValue({ ok: true, data: false });
});
afterEach(() => vi.useRealTimers());

const ghostButtons = () => waitFor(() => {
  const g = document.querySelectorAll<HTMLButtonElement>('button[data-ghost-id]'); expect(g.length).toBeGreaterThan(0); return g;
});

describe('PixelWorld overlays', () => {
  it('11: clicking a ghost or pressing Enter on it opens the Action Card with RevivePanel', async () => {
    render(<PixelWorld />);
    const ghosts = await ghostButtons();
    fireEvent.click(ghosts[0]);
    const dialog = await screen.findByRole('dialog', { name: /real-1\.png/ });
    expect(within(dialog).getByText(/#1 · real-1\.png/)).toBeInTheDocument();
    await waitFor(() => expect(ai.getConsent).toHaveBeenCalledWith(1, expect.anything()));
    expect(within(dialog).getByRole('button', { name: /Allow AI processing/ })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // A button's Enter key press is a click in browsers; confirm keyboard focus reaches it.
    (await ghostButtons())[1].focus();
    expect(document.activeElement).toBe((await ghostButtons())[1]);
  });

  it.each([['Clock Tower', /Clock Tower/], ['Memory Library', /Library/], ['Crypt', /Crypt/], ['Portal Hall', /Portal/], ['Upload Well', /Upload Well/], ['Approval Altar', /Approval Altar/]])(
    '12: the %s hotspot opens its overlay at once', async (name, title) => {
      render(<PixelWorld />);
      await screen.findByTestId('lumi'); fireEvent.click(hot(name));
      expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
    });

  it('13: Escape closes the overlay and returns focus to the opener', async () => {
    render(<PixelWorld />);
    await screen.findByTestId('lumi'); const tower = hot('Crypt');
    tower.focus(); fireEvent.click(tower);
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(tower));
    const toolbarBtn = document.querySelector<HTMLButtonElement>('[data-tool="settings"]')!;
    toolbarBtn.focus(); fireEvent.click(toolbarBtn);
    await screen.findByRole('dialog', { name: /Settings/ });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(toolbarBtn));
  });

  it('14: movement keys do nothing while focus is inside an overlay input', async () => {
    render(<PixelWorld />);
    await screen.findByTestId('lumi'); fireEvent.click(hot('Upload Well'));
    const lumi = screen.getByTestId('lumi'); const before = lumi.style.transform;
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    expect(input).toBeTruthy();
    fireEvent.keyDown(input, { key: 'ArrowRight' }); fireEvent.keyDown(input, { key: 'd' });
    await new Promise((r) => setTimeout(r, 120));
    expect(lumi.style.transform).toBe(before);
  });

  it('15: a scripted sweep of ghosts, hotspots and tools makes zero paid calls', async () => {
    render(<PixelWorld />);
    const ghosts = await ghostButtons();
    for (const g of Array.from(ghosts)) {
      fireEvent.click(g); await screen.findByRole('dialog'); await act(async () => { await Promise.resolve(); });
      fireEvent.keyDown(window, { key: 'Escape' }); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
    for (const name of ['Clock Tower', 'Memory Library', 'Upload Well', 'Approval Altar', 'Crypt', 'Portal Hall']) {
      fireEvent.click(hot(name)); await screen.findByRole('dialog');
      fireEvent.keyDown(window, { key: 'Escape' }); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
    for (const t of ['queue', 'settings', 'upload']) {
      fireEvent.click(document.querySelector(`[data-tool="${t}"]`)!); await screen.findByRole('dialog');
      fireEvent.keyDown(window, { key: 'Escape' }); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
    for (let i = 0; i < 20; i++) { fireEvent.keyDown(window, { key: 'ArrowRight' }); await new Promise((r) => setTimeout(r, 5)); }
    fireEvent.keyUp(window, { key: 'ArrowRight' });
    expectNoPaidCalls();
    expect(client.uploadScreenshots).not.toHaveBeenCalled();
    expect(client.restoreScreenshot).not.toHaveBeenCalled();
  });

  it('15b: demo mode never calls the API from any overlay', async () => {
    window.history.replaceState({}, '', '/?view=world&demo=1');
    render(<PixelWorld />);
    fireEvent.click((await ghostButtons())[0]);
    expect(await screen.findByText(/synthetic screenshot/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    for (const name of ['Crypt', 'Upload Well', 'Approval Altar', 'Portal Hall']) {
      fireEvent.click(hot(name)); await screen.findByRole('dialog');
      fireEvent.keyDown(window, { key: 'Escape' }); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
    fireEvent.click(document.querySelector('[data-tool="settings"]')!); await screen.findByRole('dialog');
    for (const [k, m] of Object.entries({ ...client, ...ai })) expect(m, k).not.toHaveBeenCalled();
  });

  it('16: the Portal surfaces a connection read error without inventing a delivery', async () => {
    render(<PixelWorld />);
    await screen.findByTestId('lumi'); fireEvent.click(hot('Portal Hall'));
    const dialog = screen.getByRole('dialog', { name: /Portal/ });
    expect(await within(dialog).findByText('Connected apps could not be loaded.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/delivered/i);
  });

  it('17: with reduced motion, ghosts have no wander transform updates', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false, onchange: null })) as typeof window.matchMedia;
    try {
      window.history.replaceState({}, '', '/?view=world&demo=1');
      render(<PixelWorld />);
      const ghosts = Array.from(await ghostButtons());
      const before = ghosts.map((g) => g.style.transform);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-ghost-id]')).map((g) => g.style.transform)).toEqual(before);
    } finally { window.matchMedia = mm; }
  });

  it('18: if the scene throws, the fallback shows a List view link and the toolbar still works', async () => {
    sceneMock.throws = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.replaceState({}, '', '/?view=world&demo=1');
    render(<PixelWorld />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: 'List view' })).toHaveAttribute('href', '?');
    fireEvent.click(document.querySelector('[data-tool="queue"]')!);
    expect(screen.getByRole('dialog', { name: /Quick Queue/ })).toBeInTheDocument();
    spy.mockRestore();
  });

  it('19: keyboard-only path reaches the card consent controls', async () => {
    render(<PixelWorld />);
    const g = (await ghostButtons())[0]; g.focus();
    fireEvent.click(g); // Enter on a button
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).queryAllByRole('checkbox').length + within(dialog).queryAllByRole('button').length).toBeGreaterThan(1));
    expect(dialog).toHaveFocus();
    expect(dialog.querySelector('input[type="checkbox"], button')).toBeTruthy();
  });

  it('Quick Queue lists every ghost and opens its card; Crypt resurrects only on click', async () => {
    client.restoreScreenshot.mockResolvedValue({ ok: true, screenshotId: 4, status: 'successful', state: 'active' });
    render(<PixelWorld />);
    await ghostButtons();
    fireEvent.click(document.querySelector('[data-tool="queue"]')!);
    const list = await screen.findByRole('list', { name: 'Screenshots' });
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(hot('Crypt'));
    expect(client.restoreScreenshot).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Resurrect real-4.png' }));
    await waitFor(() => expect(client.restoreScreenshot).toHaveBeenCalledWith(4));
    expect(await screen.findByText(/was resurrected/)).toBeInTheDocument();
  });

  it('Settings links to List View and the Altar opens the real action card', async () => {
    render(<PixelWorld />);
    fireEvent.click(document.querySelector('[data-tool="settings"]')!);
    expect(await screen.findByTestId('provider-badge')).toHaveTextContent(/Real AI/);
    expect(within(screen.getByRole('dialog')).getByRole('link', { name: /List View/i })).toHaveAttribute('href', '?');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(hot('Approval Altar'));
    expect(screen.getByText(/approve the saved version/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /real-1.png/ }));
    expect(await screen.findByRole('dialog', { name: /real-1.png/ })).toBeInTheDocument();
    expectNoPaidCalls();
  });
});
