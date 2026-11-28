import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api/ai';
import type { ActionPlan, Execution, Integrations } from '../api/tools';

// External tools UI. Both API modules are mocked; nothing is sent anywhere.
const tools = vi.hoisted(() => ({
  getIntegrations: vi.fn<() => Promise<ApiResult<Integrations>>>(),
  connectToolkit: vi.fn(),
  refreshToolkit: vi.fn(),
  disconnectToolkit: vi.fn(),
  requestActionPlan: vi.fn(),
  getLatestActionPlan: vi.fn(),
  getPlanOperation: vi.fn(),
  getActionPlan: vi.fn<(id: number) => Promise<ApiResult<ActionPlan>>>(),
  saveActionPlanRevision: vi.fn(),
  executeAction: vi.fn<() => Promise<ApiResult<Execution>>>(),
  getExecution: vi.fn<() => Promise<ApiResult<Execution>>>(),
}));
vi.mock('../api/tools', async (orig) => ({ ...(await orig<typeof import('../api/tools')>()), ...tools }));
const ai = vi.hoisted(() => ({ approveVersion: vi.fn() }));
vi.mock('../api/ai', async (orig) => ({ ...(await orig<typeof import('../api/ai')>()), ...ai }));

import { ActionPlanPanel } from './ActionPlanPanel';
import { ConnectedApps } from './ConnectedApps';
import { parseExecution } from '../api/tools';

const integrations = (over: Partial<Integrations> = {}): ApiResult<Integrations> => ({
  ok: true,
  data: {
    mode: 'fake', enabled: true, simulated: true, liveWrites: false,
    toolkits: [
      { toolkit: 'googlecalendar', label: 'Google Calendar', configured: true, status: 'active', connectionId: 1, simulated: true, tools: ['GOOGLECALENDAR_CREATE_EVENT'], liveVerifiedTools: [] },
      { toolkit: 'notion', label: 'Notion', configured: true, status: 'not_connected', connectionId: null, simulated: false, tools: ['NOTION_CREATE_NOTION_PAGE'], liveVerifiedTools: [] },
    ],
    ...over,
  },
});

const execution = (status: Execution['status'], over: Partial<Execution> = {}): Execution => ({
  executionId: 5, versionId: 11, actionIndex: 0, attempt: 1, tool: 'GOOGLECALENDAR_CREATE_EVENT', status,
  simulated: true, receipt: status === 'succeeded' ? { externalId: 'evt_123', url: null, verified: true } : null,
  detail: status === 'unknown' ? 'No reliable answer from the app.' : null, createdAt: 'x', completedAt: null, ...over,
});

const withHistory = (p: ActionPlan): ActionPlan => ({
  ...p, actions: p.actions.map((a) => ({ ...a, deliveryHistory: p.executions.filter((e) => e.actionIndex === a.index) })),
});
const plan = (over: Partial<ActionPlan> = {}): ActionPlan => withHistory({
  artifactId: 7, versionId: 11, versionNumber: 1, origin: 'ai_generate', isCurrent: true, contentSha256: 'a'.repeat(64),
  screenshotId: 3, decision: 'act', rationale: 'The screenshot shows a lab meeting on 3 Dec 2026.',
  clarificationQuestion: null, plannerProvider: 'openai', simulated: true,
  actions: [{
    index: 0, tool: 'GOOGLECALENDAR_CREATE_EVENT', toolkit: 'googlecalendar', appLabel: 'Google Calendar',
    actionLabel: 'Create a Google Calendar event', toolkitVersion: 'fake-1', enabled: true,
    rationale: 'A dated meeting is shown.', confidence: 0.9, argumentBlock: 'calendar',
    arguments: { title: 'Lab meeting', start_date: '2026-12-03', start_time: '14:00', end_date: '2026-12-03', end_time: '15:00', all_day: false, time_zone: 'Europe/London', location: null, description: null },
    problems: [], destination: { connectionId: 1, simulated: true },
    toolArguments: { summary: 'Lab meeting', send_updates: 'none' },
    deliveryHistory: [],
  }],
  approvalReadiness: { eligible: true, reasons: [], requiredAcknowledgements: [] },
  tools: { mode: 'fake', enabled: true, simulated: true, liveWrites: false },
  approval: { state: 'not_approved', approvedAt: null },
  executions: [],
  ...over,
} as ActionPlan);

beforeEach(() => {
  vi.clearAllMocks();
  tools.getIntegrations.mockResolvedValue(integrations());
  tools.getLatestActionPlan.mockResolvedValue({ ok: true, data: { operationId: 1, status: 'successful', artifactId: 7, errorDetail: null } });
});

describe('ActionPlanPanel', () => {
  it('shows nothing when external apps are off', async () => {
    tools.getIntegrations.mockResolvedValue(integrations({ enabled: false, mode: 'off' }));
    const { container } = render(<ActionPlanPanel screenshotId={3} providerMode="openai" />);
    await act(async () => { await Promise.resolve(); });
    expect(container).toBeEmptyDOMElement();
    expect(tools.getLatestActionPlan).not.toHaveBeenCalled();
  });

  it('shows the selected tool, rationale and exact arguments; Run appears only after approval', async () => {
    tools.getActionPlan.mockResolvedValue({ ok: true, data: plan() });
    render(<ActionPlanPanel screenshotId={3} providerMode="openai" />);
    expect(await screen.findByTestId('plan-rationale')).toHaveTextContent('lab meeting');
    expect(screen.getByText('Create a Google Calendar event')).toBeInTheDocument();
    expect(screen.getByText(/A dated meeting is shown/)).toBeInTheDocument();
    expect(screen.getByText('GOOGLECALENDAR_CREATE_EVENT')).toBeInTheDocument();
    expect(screen.getByText(/Exact data that would be sent/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    const approveBtn = screen.getByRole('button', { name: 'Approve this version' });
    expect(approveBtn).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I reviewed version 1/));
    ai.approveVersion.mockResolvedValue({ ok: true, data: {} });
    tools.getActionPlan.mockResolvedValue({ ok: true, data: plan({ approval: { state: 'approved', approvedAt: 'now' } }) });
    fireEvent.click(approveBtn);
    await waitFor(() => expect(ai.approveVersion).toHaveBeenCalledWith(7, 11, []));
    const run = await screen.findByRole('button', { name: 'Run' });
    expect(run).toBeDisabled(); // separate explicit confirmation
    expect(tools.executeAction).not.toHaveBeenCalled();
  });

  it('runs only after confirmation and shows the receipt as simulated, never "delivered"', async () => {
    tools.getActionPlan.mockResolvedValue({ ok: true, data: plan({ approval: { state: 'approved', approvedAt: 'now' } }) });
    render(<ActionPlanPanel screenshotId={3} providerMode="fake" />);
    fireEvent.click(await screen.findByLabelText(/Create this in Google Calendar now/));
    tools.executeAction.mockResolvedValue({ ok: true, data: execution('succeeded') });
    tools.getActionPlan.mockResolvedValue({ ok: true, data: plan({ approval: { state: 'approved', approvedAt: 'now' }, executions: [execution('succeeded')] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByTestId('execution-0')).toHaveTextContent(/Created in Google Calendar \(simulated/);
    expect(screen.getByText('evt_123')).toBeInTheDocument();
    expect(tools.executeAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument(); // no second run
    expect(document.body.textContent).not.toMatch(/delivered/i);
  });

  it('blocks another Run after a lost dispatch even if an older attempt was known to fail', async () => {
    const approvedPlan = plan({ screenshotId: 91, approval: { state: 'approved', approvedAt: 'now' }, executions: [execution('failed')] });
    tools.getActionPlan.mockResolvedValue({ ok: true, data: approvedPlan });
    tools.executeAction.mockResolvedValue({ ok: false, status: 0, code: 'network', message: 'Network request failed' });
    render(<ActionPlanPanel screenshotId={91} providerMode="fake" />);
    fireEvent.click(await screen.findByLabelText(/Create this in Google Calendar now/));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText(/Run is unavailable until this dispatch can be reconciled/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check execution record' }));
    expect(tools.executeAction).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown outcome honestly and offers no retry', async () => {
    tools.getActionPlan.mockResolvedValue({ ok: true, data: plan({ approval: { state: 'approved', approvedAt: 'now' }, executions: [execution('unknown')] }) });
    render(<ActionPlanPanel screenshotId={3} providerMode="openai" />);
    expect(await screen.findByTestId('execution-0')).toHaveTextContent(/Outcome unknown/);
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
  });

  it('surfaces an unresolved write from an earlier plan and offers no Run', async () => {
    const earlier = execution('unknown', { executionId: 99 });
    const p = plan({ approval: { state: 'approved', approvedAt: 'now' } });
    p.actions[0].deliveryHistory = [earlier];
    tools.getActionPlan.mockResolvedValue({ ok: true, data: p });
    render(<ActionPlanPanel screenshotId={3} providerMode="openai" />);
    expect(await screen.findByText(/From an earlier plan/)).toBeInTheDocument();
    expect(screen.getByText('Outcome unknown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
  });

  it('labels an unverified receipt', async () => {
    const done = execution('succeeded', { receipt: { externalId: 'pg_1', url: null, verified: false } });
    tools.getActionPlan.mockResolvedValue({ ok: true, data: plan({ approval: { state: 'approved', approvedAt: 'now' }, executions: [done] }) });
    render(<ActionPlanPanel screenshotId={3} providerMode="openai" />);
    expect(await screen.findByTestId('execution-0')).toHaveTextContent(/not independently matched/);
  });

  it('shows no-action and clarification plans without approval controls', async () => {
    tools.getActionPlan.mockResolvedValue({ ok: true, data: plan({ decision: 'needs_clarification', actions: [], clarificationQuestion: 'Note or event?' }) });
    render(<ActionPlanPanel screenshotId={3} providerMode="openai" />);
    expect(await screen.findByText(/Note or event\?/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve this version' })).not.toBeInTheDocument();
  });

  it('explains missing details and keeps approval disabled', async () => {
    const p = plan({ approvalReadiness: { eligible: false, reasons: [{ field: 'a0.start_date', code: 'missing', message: 'Add a start date.' }], requiredAcknowledgements: [] } });
    p.actions[0].problems = [{ field: 'start_date', message: 'Add a start date.' }];
    tools.getActionPlan.mockResolvedValue({ ok: true, data: p });
    render(<ActionPlanPanel screenshotId={3} providerMode="openai" />);
    expect((await screen.findAllByText('Add a start date.')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText(/I reviewed version 1/));
    expect(screen.getByRole('button', { name: 'Approve this version' })).toBeDisabled();
  });
});

describe('ConnectedApps', () => {
  it('shows server-reported status and labels simulated connections', async () => {
    render(<ConnectedApps />);
    expect(await screen.findByTestId('app-status-googlecalendar')).toHaveTextContent('Connected (simulated)');
    expect(screen.getByTestId('app-status-notion')).toHaveTextContent('Not connected');
    expect(screen.getByText(/Nothing reaches a real account/)).toBeInTheDocument();
  });

  it('connects through the server and never follows a non-https link', async () => {
    tools.connectToolkit.mockResolvedValue({ ok: true, data: { connection: {}, redirectUrl: null } });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<ConnectedApps />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(tools.connectToolkit).toHaveBeenCalledWith('notion'));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('read-only mode has no buttons', async () => {
    render(<ConnectedApps readOnly />);
    await screen.findByTestId('connected-apps');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('completeConnectionFromUrl', () => {
  it('posts the single-use attempt once and strips it from the address bar', async () => {
    const actual = await vi.importActual<typeof import('../api/tools')>('../api/tools');
    window.history.replaceState({}, '', '/?view=world&sg_attempt=' + 'a'.repeat(43) + '&status=success&connected_account_id=ca_1');
    const f = vi.fn(async () => new Response(JSON.stringify({ connection: { toolkit: 'notion', label: 'Notion', configured: true, status: 'active' } }), { status: 200 }));
    const r = await actual.completeConnectionFromUrl(f as unknown as typeof fetch);
    expect(r && r.ok).toBe(true);
    expect(window.location.search).toBe('?view=world');
    const [, init] = (f.mock.calls[0] as unknown) as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ attempt: 'a'.repeat(43), connectedAccountId: 'ca_1' });
    expect(await actual.completeConnectionFromUrl(f as unknown as typeof fetch)).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('parseExecution', () => {
  it('accepts a receipt only for a succeeded execution and only https links', () => {
    const base = { executionId: 1, versionId: 1, actionIndex: 0, attempt: 1, tool: 't', simulated: false, createdAt: 'x' };
    expect(parseExecution({ ...base, status: 'unknown', receipt: { externalId: 'x' } })!.receipt).toBeNull();
    expect(parseExecution({ ...base, status: 'succeeded', receipt: { externalId: 'x', url: 'javascript:alert(1)' } })!.receipt).toEqual({ externalId: 'x', url: null, verified: false });
    expect(parseExecution({ ...base, status: 'delivered' })).toBeNull();
  });
});
