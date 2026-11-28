import { useCallback, useEffect, useRef, useState } from 'react';
import { getConsent, getOperation } from '../../api/ai';
import { getActionPlan, getExecution, getLatestActionPlan } from '../../api/tools';
import { planExecutions, type RecordStatus } from '../model/lifecycle';

async function readPlan(id: number): Promise<RecordStatus | null> {
  const latest = await getLatestActionPlan(id);
  if (!latest.ok) return latest.status === 404 ? { planning: false } : null;
  if (latest.data.artifactId === null) return { planning: latest.data.status === 'pending' };
  const plan = await getActionPlan(latest.data.artifactId);
  return plan.ok ? { plan: plan.data, planning: false } : null;
}

export function useWorldRecords(targets: string, enabled: boolean, openedId: number | null, onAnalysis: () => void) {
  const [records, setRecords] = useState<Record<number, RecordStatus>>({});
  const [loaded, setLoaded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const checked = useRef(new Set<string>());
  const watchedRevive = useRef(new Map<number, number>());
  const live = useRef({ records, openedId });
  live.current = { records, openedId };
  const refresh = useCallback(() => {
    checked.current.clear();
    setRevision((n) => n + 1);
  }, []);
  const update = useCallback((id: number, patch: RecordStatus) => {
    setRecords((old) => ({ ...old, [id]: { ...old[id], ...patch } }));
  }, []);
  const watchRevive = useCallback((id: number, operationId: number | null) => {
    if (operationId === null) watchedRevive.current.delete(id);
    else watchedRevive.current.set(id, operationId);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer = 0;
    let failed = false;
    let index = 0;
    const remaining = targets.split(',').filter((key) => key && !checked.current.has(key));
    const load = async () => {
      const batch = remaining.slice(index, index + 5);
      index += batch.length;
      await Promise.all(batch.map(async (key) => {
        const [text, analyzed] = key.split(':');
        const id = Number(text);
        // Saved analysis and plans are authoritative. Consent lookups alone are
        // sufficient for untouched uploads until a user chooses to process one.
        const consent = analyzed === 'yes' ? null : await getConsent(id);
        const plan = analyzed === 'yes' || (consent?.ok && consent.data) ? await readPlan(id) : {};
        if (!alive) return;
        if (consent && !consent.ok || !plan) failed = true;
        else checked.current.add(key);
        if (live.current.openedId === id) return; // the open Action Card is the current reader
        update(id, { ...(consent?.ok ? { consent: consent.data } : {}), ...plan });
      }));
      if (!alive) return;
      if (index < remaining.length) {
        // Yield the request budget to card interactions on large galleries.
        timer = window.setTimeout(() => void load(), index >= 15 ? 6000 : 150);
        return;
      }
      setLoaded(targets);
      setError(failed ? 'Some action records could not be loaded.' : null);
    };
    void load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [enabled, targets, revision, update]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let polling = false;
    const poll = async () => {
      if (polling || document.hidden) return;
      const { records: snapshot, openedId: current } = live.current;
      polling = true;
      try {
        for (const [key, state] of Object.entries(snapshot)) {
          const id = Number(key);
          if (id === current || !alive) continue;
          const opId = watchedRevive.current.get(id);
          const inFlight = state.execution ?? planExecutions(state.plan).find((e) => e.status === 'reserved' || e.status === 'executing');
          if (opId !== undefined) {
            const result = await getOperation(opId);
            if (!alive) return;
            if (result.ok && result.data.status !== 'pending' && watchedRevive.current.get(id) === opId) {
              watchedRevive.current.delete(id);
              if (result.data.status === 'successful') onAnalysis();
              update(id, { revive: result.data.status === 'failed' ? 'failed' : result.data.status === 'uncertain' ? 'unknown' : undefined });
            } else if (!result.ok && result.status === 404 && watchedRevive.current.get(id) === opId) {
              watchedRevive.current.delete(id);
              update(id, { revive: undefined });
            }
          }
          const executing = inFlight?.status === 'reserved' || inFlight?.status === 'executing';
          if (state.planning || executing) {
            const result = executing ? await getExecution(inFlight.executionId) : null;
            if (!alive) return;
            if (result?.ok && live.current.openedId !== id) update(id, { execution: result.data });
            if (state.planning || (result?.ok && result.data.status !== 'reserved' && result.data.status !== 'executing')) {
              const plan = await readPlan(id);
              if (alive && plan && live.current.openedId !== id) update(id, plan);
            }
          }
        }
      } finally { polling = false; }
    };
    const timer = window.setInterval(() => void poll(), 3500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [enabled, onAnalysis, update]);

  return { records, loading: enabled && loaded !== targets, error, refresh, update, watchRevive };
}
