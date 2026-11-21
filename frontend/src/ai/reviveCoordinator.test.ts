import { describe, expect, it, vi } from 'vitest';

const ai = vi.hoisted(() => ({ getOperation: vi.fn() }));
vi.mock('../api/ai', () => ai);
import {
  acquireRevive,
  getReviveEntry,
  getReviveSuccess,
  markReviveActive,
  markReviveOutcomeUnknown,
  markReviveUnresolved,
  recordReviveSuccess,
  releaseRevive,
  resetReviveCoordinator,
} from './reviveCoordinator';

describe('markReviveOutcomeUnknown', () => {
  it('blocks a new submission without an operation id until explicitly released', async () => {
    expect(await acquireRevive(5)).toEqual({ ok: true });
    markReviveOutcomeUnknown(5);
    expect(getReviveEntry(5)).toEqual({ phase: 'unresolved', operationId: null });
    expect(await acquireRevive(5)).toEqual({ ok: false, reason: 'unresolved', operationId: null });
    expect(await acquireRevive(5)).toEqual({ ok: false, reason: 'unresolved', operationId: null });
    expect(ai.getOperation).not.toHaveBeenCalled(); // nothing to reconcile without an id
    releaseRevive(5);
    expect(await acquireRevive(5)).toEqual({ ok: true });
  });

  it('leaves other screenshots independent', async () => {
    markReviveOutcomeUnknown(6);
    expect(await acquireRevive(7)).toEqual({ ok: true });
  });
});

describe('confirmed Revive successes', () => {
  it('refuse any further submission for that screenshot, even after release', async () => {
    expect(await acquireRevive(9)).toEqual({ ok: true });
    recordReviveSuccess(9, 7);
    releaseRevive(9);
    expect(await acquireRevive(9)).toEqual({ ok: false, reason: 'succeeded', operationId: 7 });
    expect(ai.getOperation).not.toHaveBeenCalled();
  });

  it('keep a known operation id and stay per screenshot', async () => {
    recordReviveSuccess(10, 7);
    recordReviveSuccess(10, null);
    expect(getReviveSuccess(10)).toEqual({ operationId: 7 });
    expect(getReviveSuccess(11)).toBeUndefined();
    expect(await acquireRevive(11)).toEqual({ ok: true });
  });

  it('are cleared only by the test reset', () => {
    recordReviveSuccess(12, 7);
    resetReviveCoordinator();
    expect(getReviveSuccess(12)).toBeUndefined();
  });
});

describe('reconciliation of a kept operation', () => {
  const opStatus = (status: string) =>
    Promise.resolve({ ok: true, data: { operationId: 7, kind: 'classify', status, errorDetail: null, artifactId: null } });
  const keepUnresolved = async (id: number) => {
    expect(await acquireRevive(id)).toEqual({ ok: true });
    markReviveActive(id, 7);
    markReviveUnresolved(id);
  };

  it('successful: records the success with its operation id and refuses with reason "succeeded"', async () => {
    await keepUnresolved(20);
    ai.getOperation.mockImplementationOnce(() => opStatus('successful'));
    expect(await acquireRevive(20)).toEqual({ ok: false, reason: 'succeeded', operationId: 7 });
    expect(getReviveSuccess(20)).toEqual({ operationId: 7 });
    expect(getReviveEntry(20)).toBeUndefined();
    // Later attempts are refused from the record, without asking the server again.
    ai.getOperation.mockClear();
    expect(await acquireRevive(20)).toEqual({ ok: false, reason: 'succeeded', operationId: 7 });
    expect(ai.getOperation).not.toHaveBeenCalled();
  });

  it.each(['failed', 'uncertain'])('%s: still grants a new submission and records no success', async (status) => {
    await keepUnresolved(21);
    ai.getOperation.mockImplementationOnce(() => opStatus(status));
    expect(await acquireRevive(21)).toEqual({ ok: true });
    expect(getReviveSuccess(21)).toBeUndefined();
  });
});
