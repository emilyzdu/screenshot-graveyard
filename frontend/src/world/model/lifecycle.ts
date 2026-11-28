import type { Screenshot } from '../../api/client';
import type { ActionPlan, Execution } from '../../api/tools';

export type GhostStage = 'new' | 'consent' | 'unprocessed' | 'analyzing' | 'planning' | 'planned' | 'clarification' |
  'review' | 'approved' | 'pending' | 'executing' | 'succeeded' | 'failed' | 'unknown' | 'archived';

type Pose = 'new' | 'waiting' | 'study' | 'plan' | 'working' | 'receipt' | 'sleep';
export const ghostStages: Record<GhostStage, { label: string; mark: string; pose: Pose }> = {
  new: { label: 'Newly uploaded', mark: '✦', pose: 'new' },
  consent: { label: 'Awaiting AI consent', mark: '◇', pose: 'waiting' },
  unprocessed: { label: 'Ready for analysis', mark: '▧', pose: 'waiting' },
  analyzing: { label: 'Analyzing', mark: '◌', pose: 'study' },
  planning: { label: 'Planning actions', mark: '…', pose: 'study' },
  planned: { label: 'Planned', mark: '≡', pose: 'plan' },
  clarification: { label: 'Needs clarification', mark: '?', pose: 'study' },
  review: { label: 'Awaiting approval', mark: '✎', pose: 'plan' },
  approved: { label: 'Approved · awaiting Run', mark: '✓', pose: 'plan' },
  pending: { label: 'Execution pending', mark: '◷', pose: 'working' },
  executing: { label: 'Executing', mark: '✷', pose: 'working' },
  succeeded: { label: 'Successfully executed', mark: '✉', pose: 'receipt' },
  failed: { label: 'Action failed', mark: '!', pose: 'study' },
  unknown: { label: 'Outcome unknown', mark: '≈', pose: 'study' },
  archived: { label: 'Archived', mark: 'z', pose: 'sleep' },
};

export interface RecordStatus {
  consent?: boolean;
  plan?: ActionPlan;
  planning?: boolean;
  revive?: 'analyzing' | 'failed' | 'unknown';
  execution?: Execution;
  dispatchUnconfirmed?: boolean;
}

export function planExecutions(plan?: ActionPlan): Execution[] {
  if (!plan) return [];
  return [...new Map([...plan.executions, ...plan.actions.flatMap((a) => a.deliveryHistory)]
    .map((execution) => [execution.executionId, execution])).values()].sort((a, b) => a.executionId - b.executionId);
}

export function executionFor(plan: ActionPlan, tool: string): Execution | undefined {
  const executions = planExecutions(plan).filter((execution) => execution.tool === tool);
  return [...executions].reverse().find((execution) => execution.status === 'unknown' || execution.status === 'executing' || execution.status === 'reserved')
    ?? executions[executions.length - 1];
}

export function ghostStage(shot: Screenshot, status: RecordStatus | undefined, fresh: boolean): GhostStage | undefined {
  if (shot.state === 'archived') return 'archived';
  const plan = status?.plan;
  const executions = planExecutions(plan);
  const active = status?.execution;
  if (active?.status === 'executing' || executions.some((e) => e.status === 'executing')) return 'executing';
  if (active?.status === 'reserved' || executions.some((e) => e.status === 'reserved')) return 'pending';
  if (status?.dispatchUnconfirmed || active?.status === 'unknown' || executions.some((e) => e.status === 'unknown')) return 'unknown';
  if (status?.revive === 'analyzing') return 'analyzing';
  if (status?.revive === 'unknown') return 'unknown';
  if (status?.revive === 'failed') return 'failed';
  if (fresh) return 'new';
  if (status?.planning) return 'planning';
  if (plan) {
    if (plan.decision === 'needs_clarification' || plan.actions.some((a) => a.enabled && a.problems.length > 0)) return 'clarification';
    const current = plan.actions.filter((a) => a.enabled);
    const outcomes = current.map((action) => executionFor(plan, action.tool)?.status);
    if (outcomes.length > 0 && outcomes.every((state) => state === 'succeeded')) return 'succeeded';
    if (outcomes.some((state) => state === 'failed' || state === 'rejected')) return 'failed';
    if (plan.approval.state === 'approved') return 'approved';
    return plan.decision === 'act' && plan.approvalReadiness.eligible ? 'review' : 'planned';
  }
  if (shot.analysis) return undefined;
  if (status?.consent === false) return 'consent';
  if (status?.consent === true) return 'unprocessed';
  return undefined;
}

export const toolMarks: Record<string, { mark: string; label: string }> = {
  calendar: { mark: '◷', label: 'Calendar' }, notion: { mark: '▤', label: 'Notion' }, gmail: { mark: '✉', label: 'Gmail draft' },
};
