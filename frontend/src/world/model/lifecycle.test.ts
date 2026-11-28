import { describe, expect, it } from 'vitest';
import type { Screenshot } from '../../api/client';
import type { ActionPlan, Execution, PlanAction } from '../../api/tools';
import { ghostStage, type RecordStatus } from './lifecycle';

const screenshot: Screenshot = {
  screenshotId: 1, originalFilename: 'sample.png', state: 'active', mimeType: 'image/png',
  isDuplicate: false, duplicateOf: null, byteSize: 100, uploadedAt: '2026-11-28T00:00:00Z', analysis: null,
};
function phase(override: Partial<RecordStatus>, fresh = false) {
  return ghostStage(screenshot, override, fresh);
}
function execution(tool: string, executionId: number, status: Execution['status']): Execution {
  return { tool, executionId, status, versionId: 2, actionIndex: executionId - 1, simulated: true,
    attempt: 1, createdAt: '', completedAt: null, detail: null, receipt: null };
}
function action(tool: string, index: number, deliveryHistory: Execution[] = []): PlanAction {
  return { tool, index, deliveryHistory, toolkit: tool, appLabel: tool, actionLabel: tool, toolkitVersion: '1',
    enabled: true, rationale: '', confidence: 1, argumentBlock: tool === 'calendar' ? 'calendar' : 'gmail',
    arguments: {}, problems: [], destination: null, toolArguments: null };
}
function plan(actions: PlanAction[], approval: ActionPlan['approval']['state'] = 'approved'): ActionPlan {
  return { actions, artifactId: 1, versionId: 2, versionNumber: 2, origin: 'manual_edit', isCurrent: true,
    contentSha256: '', screenshotId: 1, decision: 'act', rationale: '', clarificationQuestion: null,
    plannerProvider: 'fake', simulated: true, approvalReadiness: { eligible: true, reasons: [], requiredAcknowledgements: [] },
    tools: null, approval: { state: approval, approvedAt: null }, executions: [] };
}

describe('screenshot ghost lifecycle', () => {
  it('reflects real consent and pending operations', () => {
    expect(phase({ consent: false }, true)).toBe('new');
    expect(phase({ consent: false })).toBe('consent');
    expect(phase({ consent: true })).toBe('unprocessed');
    expect(phase({ consent: true, revive: 'analyzing' })).toBe('analyzing');
    expect(phase({ planning: true })).toBe('planning');
  });

  it('keeps approval and success distinct and does not hide an unknown action in a mixed plan', () => {
    const first = action('calendar', 0, [execution('calendar', 1, 'succeeded')]);
    expect(phase({ plan: plan([first, action('gmail', 1)]) })).toBe('approved');
    expect(phase({ plan: plan([first, action('gmail', 1, [execution('gmail', 2, 'executing')])]) })).toBe('executing');
    expect(phase({ plan: plan([first, action('gmail', 1, [execution('gmail', 2, 'unknown')])]) })).toBe('unknown');
    expect(phase({ plan: plan([first, action('gmail', 1, [execution('gmail', 2, 'succeeded')])]) })).toBe('succeeded');
    expect(phase({ plan: plan([first]), dispatchUnconfirmed: true })).toBe('unknown');
    expect(ghostStage({ ...screenshot, state: 'archived' }, { plan: plan([first]) }, false)).toBe('archived');
  });

  it('distinguishes editable review from missing information', () => {
    const ready = plan([action('calendar', 0)], 'not_approved');
    expect(phase({ plan: ready })).toBe('review');
    ready.actions[0].problems = [{ field: 'date', message: 'Choose a start date' }];
    expect(phase({ plan: ready })).toBe('clarification');
  });
});
