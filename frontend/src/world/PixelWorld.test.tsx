import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListResult, Screenshot, WorkspaceResult } from '../api/client';

const client = vi.hoisted(() => ({
  getWorkspace: vi.fn<() => Promise<WorkspaceResult>>(),
  listScreenshots: vi.fn<() => Promise<ListResult>>(),
}));
vi.mock('../api/client', () => ({ ...client, imageUrl: (id: number) => `/api/screenshots/${id}/image` }));
const down = vi.hoisted(() => () => Promise.resolve({ ok: false as const, status: 503, code: 'down', message: 'down' }));
vi.mock('../api/ai', async (orig) => ({
  ...(await orig<typeof import('../api/ai')>()),
  getProviderMode: down, getConsent: down, getDisclosure: down, getAnalysis: down, getAutomation: down,
  getMakeNotesPreparation: down, getEventDraftPreparation: down,
}));

import PixelWorld from './PixelWorld';

const shot = (id: number, over: Partial<Screenshot> = {}): Screenshot => ({
  screenshotId: id, state: 'active', mimeType: 'image/png', originalFilename: `real-${id}.png`, isDuplicate: false,
  duplicateOf: null, byteSize: 1, uploadedAt: '2026-01-01T00:00:00Z', analysis: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/?view=world');
  client.getWorkspace.mockResolvedValue({ ok: true, active: true });
});

describe('PixelWorld', () => {
  it('renders real ghosts as labelled buttons and counts the crypt', async () => {
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [shot(1), shot(2), shot(3), shot(4, { state: 'archived' })] });
    render(<PixelWorld />);
    const ghosts = await waitFor(() => {
      const g = document.querySelectorAll('button[data-ghost-id]'); expect(g).toHaveLength(3); return g;
    });
    expect(ghosts[0]).toHaveAccessibleName(/real-1\.png: Not analyzed yet/);
    expect(screen.getByText(/Crypt: 1 resting screenshot/)).toBeInTheDocument();
    expect(screen.queryByText(/Demo data|not reachable/)).not.toBeInTheDocument();
    fireEvent.click(ghosts[1]);
    expect(screen.getByRole('dialog', { name: /real-2\.png/ })).toBeInTheDocument();
  });

  it('collapses more than 24 ghosts into a crowd marker', async () => {
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: Array.from({ length: 27 }, (_, i) => shot(i + 1)) });
    render(<PixelWorld />);
    await waitFor(() => expect(document.querySelectorAll('button[data-ghost-id]')).toHaveLength(24));
    expect(screen.getByRole('button', { name: /3 more screenshots/ })).toBeInTheDocument();
  });

  it('labels synthetic data when the backend is unreachable', async () => {
    client.listScreenshots.mockResolvedValue({ ok: false, error: 'Network request failed' });
    render(<PixelWorld />);
    expect(await screen.findByText(/Backend not reachable/)).toBeInTheDocument();
    expect(document.querySelectorAll('button[data-ghost-id]').length).toBeGreaterThan(0);
  });

  it('uses demo fixtures without any API call for ?demo=1', async () => {
    window.history.replaceState({}, '', '/?view=world&demo=1');
    render(<PixelWorld />);
    expect(await screen.findByText(/Demo data \(prototype\)/)).toBeInTheDocument();
    expect(client.getWorkspace).not.toHaveBeenCalled();
    expect(client.listScreenshots).not.toHaveBeenCalled();
  });

  it('offers building hotspots, a toolbar and a list view link; Lumi ignores keys in inputs', async () => {
    window.history.replaceState({}, '', '/?view=world&demo=1');
    render(<PixelWorld />);
    const tower = await screen.findByRole('button', { name: 'Clock Tower' });
    fireEvent.click(tower);
    expect(screen.getByRole('dialog', { name: /Clock Tower/ })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /List view/ })[0]).toHaveAttribute('href', '?');
    const lumi = screen.getByTestId('lumi');
    const before = lumi.style.transform;
    const input = document.createElement('input'); document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    await new Promise((r) => setTimeout(r, 120));
    expect(lumi.style.transform).toBe(before);
    input.remove();
  });
});
