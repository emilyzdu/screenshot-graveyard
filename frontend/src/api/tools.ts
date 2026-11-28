// Typed client for connected apps, AI action plans and authorized tool executions.
//
// Same-origin only; the workspace travels in the HttpOnly cookie. State-changing
// requests send the `X-Requested-With` CSRF header. The server never returns an
// API key, a provider user id or a connected account id, and this module never
// sends one: connections are identified by toolkit, destinations are bound by
// the server. Every status shown in the UI comes from these responses.
import type { ApiResult } from './ai';

type Fetch = typeof fetch;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

async function call<T>(path: string, method: 'GET' | 'POST', json: unknown, parse: (b: unknown) => T | null, f: Fetch): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') headers['X-Requested-With'] = 'fetch';
  let body: string | undefined;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let response: Response;
  try {
    response = await f(path, { method, headers, credentials: 'same-origin', body });
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
  if (data === null) return { ok: false, status: response.status, code: 'bad_shape', message: 'Unexpected response shape' };
  return { ok: true, data };
}

// ------------------------------------------------------------- connections
export type ToolsMode = 'off' | 'fake' | 'composio';
export type ConnectionStatus = 'not_connected' | 'pending' | 'active' | 'failed';
export interface Connection {
  toolkit: string;
  label: string;
  configured: boolean;
  status: ConnectionStatus;
  connectionId: number | null;
  simulated: boolean;
  tools: string[];
  liveVerifiedTools: string[];
}
export interface ToolsStatus {
  mode: ToolsMode;
  enabled: boolean;
  simulated: boolean;
  liveWrites: boolean;
}
export interface Integrations extends ToolsStatus {
  toolkits: Connection[];
}

const CONN_STATUSES: ConnectionStatus[] = ['not_connected', 'pending', 'active', 'failed'];
function parseConnection(b: unknown): Connection | null {
  if (!isObj(b) || typeof b.toolkit !== 'string' || typeof b.label !== 'string') return null;
  if (!CONN_STATUSES.includes(b.status as ConnectionStatus) || typeof b.configured !== 'boolean') return null;
  return {
    toolkit: b.toolkit, label: b.label, configured: b.configured, status: b.status as ConnectionStatus,
    connectionId: typeof b.connectionId === 'number' ? b.connectionId : null,
    simulated: b.simulated === true,
    tools: Array.isArray(b.tools) ? b.tools.filter((x): x is string => typeof x === 'string') : [],
    liveVerifiedTools: Array.isArray(b.liveVerifiedTools) ? b.liveVerifiedTools.filter((x): x is string => typeof x === 'string') : [],
  };
}
function parseToolsStatus(b: unknown): ToolsStatus | null {
  if (!isObj(b) || !['off', 'fake', 'composio'].includes(b.mode as string)) return null;
  return { mode: b.mode as ToolsMode, enabled: b.enabled === true, simulated: b.simulated === true, liveWrites: b.liveWrites === true };
}

export function getIntegrations(f: Fetch = fetch) {
  return call('/api/integrations', 'GET', undefined, (b) => {
    const s = parseToolsStatus(b);
    if (!s || !isObj(b) || !Array.isArray(b.toolkits)) return null;
    const toolkits = b.toolkits.map(parseConnection);
    return toolkits.every(Boolean) ? { ...s, toolkits: toolkits as Connection[] } : null;
  }, f);
}

export function connectToolkit(toolkit: string, f: Fetch = fetch) {
  return call(`/api/integrations/${encodeURIComponent(toolkit)}/connect`, 'POST', undefined, (b) => {
    if (!isObj(b)) return null;
    const connection = parseConnection(b.connection);
    // Only a hosted https page is ever followed.
    const url = typeof b.redirectUrl === 'string' && b.redirectUrl.startsWith('https://') ? b.redirectUrl : null;
    return connection ? { connection, redirectUrl: url } : null;
  }, f);
}

export function refreshToolkit(toolkit: string, f: Fetch = fetch) {
  return call(`/api/integrations/${encodeURIComponent(toolkit)}/refresh`, 'POST', undefined,
    (b) => (isObj(b) ? parseConnection(b.connection) : null), f);
}

export function disconnectToolkit(toolkit: string, f: Fetch = fetch) {
  return call(`/api/integrations/${encodeURIComponent(toolkit)}/disconnect`, 'POST', undefined, (b) => {
    if (!isObj(b)) return null;
    const connection = parseConnection(b.connection);
    return connection ? { connection, removedAtProvider: b.removedAtProvider === true } : null;
  }, f);
}

// ------------------------------------------------------------ action plans
export type Decision = 'act' | 'no_action' | 'needs_clarification';
export type ArgumentBlock = 'calendar' | 'notion' | 'gmail';
export interface NotionArgs { title: string; markdown: string; parent_id: string | null }
export interface GmailArgs { recipient_email: string | null; subject: string; body: string }
export interface Problem { field: string; message: string }
export interface PlanAction {
  index: number;
  tool: string;
  toolkit: string;
  appLabel: string;
  actionLabel: string;
  toolkitVersion: string;
  enabled: boolean;
  rationale: string;
  confidence: number;
  argumentBlock: ArgumentBlock;
  arguments: Record<string, unknown>;
  problems: Problem[];
  destination: { connectionId: number; simulated: boolean } | null;
  toolArguments: Record<string, unknown> | null;
  /** Executions of this tool for this screenshot and app from ANY plan (replans included). */
  deliveryHistory: Execution[];
}
export type ExecutionStatus = 'reserved' | 'executing' | 'cancelled' | 'succeeded' | 'failed' | 'rejected' | 'unknown';
export interface Execution {
  executionId: number;
  versionId: number;
  actionIndex: number;
  attempt: number;
  tool: string;
  status: ExecutionStatus;
  simulated: boolean;
  /** verified: the app's answer carried this request's marker (Calendar). */
  receipt: { externalId: string; url: string | null; verified: boolean } | null;
  detail: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface ActionPlan {
  artifactId: number;
  versionId: number;
  versionNumber: number;
  origin: string;
  isCurrent: boolean;
  contentSha256: string;
  screenshotId: number;
  decision: Decision;
  rationale: string;
  clarificationQuestion: string | null;
  plannerProvider: string;
  simulated: boolean;
  actions: PlanAction[];
  approvalReadiness: { eligible: boolean; reasons: { field: string | null; code: string; message: string }[]; requiredAcknowledgements: string[] };
  tools: ToolsStatus | null;
  approval: { state: 'approved' | 'not_approved' | 'unknown'; approvedAt: string | null };
  executions: Execution[];
}
export interface PlanOperation {
  operationId: number;
  status: 'pending' | 'successful' | 'failed' | 'uncertain';
  artifactId: number | null;
  errorDetail: string | null;
}

const EXEC_STATUSES: ExecutionStatus[] = ['reserved', 'executing', 'cancelled', 'succeeded', 'failed', 'rejected', 'unknown'];
export function parseExecution(b: unknown): Execution | null {
  if (!isObj(b) || typeof b.executionId !== 'number' || !EXEC_STATUSES.includes(b.status as ExecutionStatus)) return null;
  const r = b.receipt;
  // A receipt is accepted only for a succeeded execution that names the created item.
  const receipt = b.status === 'succeeded' && isObj(r) && typeof r.externalId === 'string'
    ? { externalId: r.externalId, url: typeof r.url === 'string' && r.url.startsWith('https://') ? r.url : null, verified: r.verified === true }
    : null;
  return {
    executionId: b.executionId, versionId: Number(b.versionId), actionIndex: Number(b.actionIndex),
    attempt: Number(b.attempt), tool: String(b.tool), status: b.status as ExecutionStatus,
    simulated: b.simulated === true, receipt, detail: typeof b.detail === 'string' ? b.detail : null,
    createdAt: String(b.createdAt), completedAt: typeof b.completedAt === 'string' ? b.completedAt : null,
  };
}

function parsePlanOperation(b: unknown): PlanOperation | null {
  if (!isObj(b) || typeof b.operationId !== 'number') return null;
  if (!['pending', 'successful', 'failed', 'uncertain'].includes(b.status as string)) return null;
  return {
    operationId: b.operationId, status: b.status as PlanOperation['status'],
    artifactId: typeof b.artifactId === 'number' ? b.artifactId : null,
    errorDetail: typeof b.errorDetail === 'string' ? b.errorDetail : null,
  };
}

function parsePlan(b: unknown): ActionPlan | null {
  if (!isObj(b) || typeof b.artifactId !== 'number' || typeof b.versionId !== 'number') return null;
  if (typeof b.contentSha256 !== 'string' || !Array.isArray(b.actions) || !isObj(b.approvalReadiness)) return null;
  if (!['act', 'no_action', 'needs_clarification'].includes(b.decision as string)) return null;
  const executions = Array.isArray(b.executions) ? b.executions.map(parseExecution) : [];
  if (!executions.every(Boolean)) return null;
  return {
    artifactId: b.artifactId, versionId: b.versionId, versionNumber: Number(b.versionNumber), origin: String(b.origin),
    isCurrent: b.isCurrent === true, contentSha256: b.contentSha256, screenshotId: Number(b.screenshotId),
    decision: b.decision as Decision, rationale: String(b.rationale),
    clarificationQuestion: typeof b.clarificationQuestion === 'string' ? b.clarificationQuestion : null,
    plannerProvider: String(b.plannerProvider), simulated: b.simulated === true,
    actions: (b.actions as PlanAction[]).map((a) => ({
      ...a,
      deliveryHistory: Array.isArray(a.deliveryHistory)
        ? a.deliveryHistory.map(parseExecution).filter((e): e is Execution => e !== null)
        : [],
    })),
    approvalReadiness: b.approvalReadiness as ActionPlan['approvalReadiness'],
    tools: parseToolsStatus(b.tools),
    approval: isObj(b.approval) && (b.approval.state === 'approved' || b.approval.state === 'not_approved')
      ? { state: b.approval.state, approvedAt: typeof b.approval.approvedAt === 'string' ? b.approval.approvedAt : null }
      : { state: 'unknown', approvedAt: null },
    executions: executions as Execution[],
  };
}

export function requestActionPlan(screenshotId: number, replan = false, f: Fetch = fetch) {
  return call(`/api/screenshots/${screenshotId}/action-plan`, 'POST', { replan }, parsePlanOperation, f);
}
export function getLatestActionPlan(screenshotId: number, f: Fetch = fetch) {
  return call(`/api/screenshots/${screenshotId}/action-plan`, 'GET', undefined, parsePlanOperation, f);
}
export function getPlanOperation(operationId: number, f: Fetch = fetch) {
  return call(`/api/operations/${operationId}`, 'GET', undefined, parsePlanOperation, f);
}
export function getActionPlan(artifactId: number, f: Fetch = fetch) {
  return call(`/api/action-plans/${artifactId}`, 'GET', undefined, parsePlan, f);
}
export function saveActionPlanRevision(plan: ActionPlan, actions: { index: number; enabled: boolean; block: ArgumentBlock; args: Record<string, unknown> }[], f: Fetch = fetch) {
  return call(`/api/action-plans/${plan.artifactId}/revisions`, 'POST', {
    baseVersionId: plan.versionId,
    actions: actions.map((a) => ({ index: a.index, enabled: a.enabled, [a.block]: a.args })),
  }, parsePlan, f);
}
export function executeAction(plan: ActionPlan, actionIndex: number, f: Fetch = fetch) {
  return call(`/api/action-plans/${plan.artifactId}/executions`, 'POST', {
    versionId: plan.versionId, actionIndex, contentSha256: plan.contentSha256, confirmExecute: true,
  }, (b) => (isObj(b) ? parseExecution(b.execution) : null), f);
}
/**
 * The browser returning from Composio's hosted page presents the single-use
 * attempt from its callback URL. The server binds it to this workspace and
 * re-checks the account with the provider; the URL parameters are then removed.
 */
export async function completeConnectionFromUrl(f: Fetch = fetch): Promise<ApiResult<Connection> | null> {
  const url = new URL(window.location.href);
  const attempt = url.searchParams.get('sg_attempt');
  if (!attempt) return null;
  const account = url.searchParams.get('connected_account_id');
  for (const k of ['sg_attempt', 'connected_account_id', 'status']) url.searchParams.delete(k);
  window.history.replaceState(window.history.state, '', url.toString());
  return call('/api/integrations/callback', 'POST', { attempt, ...(account ? { connectedAccountId: account } : {}) },
    (b) => (isObj(b) ? parseConnection(b.connection) : null), f);
}

export function getExecution(executionId: number, f: Fetch = fetch) {
  return call(`/api/tool-executions/${executionId}`, 'GET', undefined, (b) => (isObj(b) ? parseExecution(b.execution) : null), f);
}
