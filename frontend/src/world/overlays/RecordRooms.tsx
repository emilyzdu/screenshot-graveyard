import type { PlanAction } from '../../api/tools';
import { ExecutionLine } from '../../shell/ActionPlanPanel';
import type { GhostView } from '../model/ghostView';
import { executionFor, type RecordStatus } from '../model/lifecycle';
import { QuickQueue } from './QuickQueue';
import type { CardChoice } from './ActionCard';

type Room = 'calendar' | 'notes' | 'altar' | 'portal';

const EMPTY: Record<Room, string> = {
  calendar: 'No calendar plans yet. Open a revived screenshot to prepare an event or review its action plan.',
  notes: 'No Notion action plans yet.',
  altar: 'No action plans waiting here. Open a screenshot to review or create a plan.',
  portal: 'Approved actions and their execution records will appear here.',
};

function CalendarFields({ action }: { action: PlanAction }) {
  const args = action.arguments;
  const text = (field: string) => typeof args[field] === 'string' ? String(args[field]) : '';
  return (
    <dl className="pw-event">
      <div><dt>Starts</dt><dd>{[text('start_date'), text('start_time')].filter(Boolean).join(' · ') || 'Needs a date'}{args.all_day === true ? ' · All day' : ''}</dd></div>
      {!!text('end_date') && <div><dt>Ends</dt><dd>{text('end_date')} {text('end_time')}</dd></div>}
      <div><dt>Time zone</dt><dd>{text('time_zone') || 'Unspecified'}</dd></div>
      {!!text('description') && <div><dt>Description</dt><dd>{text('description')}</dd></div>}
    </dl>
  );
}

export function RecordRooms({ room, ghosts, records, loading, error, onRefresh, onPick }: {
  room: Room; ghosts: readonly GhostView[]; records: Record<number, RecordStatus>;
  loading: boolean; error: string | null; onRefresh: () => void;
  onPick: (id: number, source: HTMLElement, choice?: CardChoice) => void;
}) {
  const entries = ghosts.flatMap((ghost) => {
    const plan = records[ghost.id]?.plan;
    if (!plan) return [];
    const actions = plan.actions.filter((action) => {
      if (room === 'calendar' || room === 'notes') return action.argumentBlock === (room === 'calendar' ? 'calendar' : 'notion');
      if (room === 'portal') return !!executionFor(plan, action.tool) || (plan.approval.state === 'approved' && action.enabled);
      return true;
    });
    return actions.length || room === 'altar' ? [{ ghost, plan, actions }] : [];
  });
  const withPlan = new Set(entries.map(({ ghost }) => ghost.id));
  const sources = room === 'calendar' || room === 'notes'
    ? ghosts.filter((ghost) => ghost.category && !withPlan.has(ghost.id))
    : room === 'altar' ? ghosts.filter((ghost) => !withPlan.has(ghost.id)) : [];

  return (
    <section className="pw-records" aria-label={room === 'portal' ? 'Approved actions and execution records' : 'Screenshot plans'}>
      {room === 'portal' && <h3>Approved actions and execution records</h3>}
      {room === 'notes' && <p>Study notes and Epitaphs stay in this workspace. Notion actions have their own plan and delivery record.</p>}
      {room === 'altar' && <p>Review the exact outgoing data, edit individual actions and approve the saved version.</p>}
      {loading && <p role="status">Loading screenshot records…</p>}
      {error && <div role="alert">{error} <button className="pw-btn" type="button" onClick={onRefresh}>Refresh records</button></div>}
      {!loading && entries.length === 0 && <p className="pw-empty" role="status">{EMPTY[room]}</p>}
      {entries.map(({ ghost, plan, actions }) => (
        <article className="pw-room-record" key={ghost.id}>
          <h4>{ghost.filename}</h4>
          <p className="pw-muted">Version {plan.versionNumber} · {ghost.label}</p>
          {room === 'notes' && ghost.epitaph && <q>{ghost.epitaph}</q>}
          {actions.map((action) => {
            const last = executionFor(plan, action.tool);
            return <section key={action.index}>
              <strong>{String(action.arguments.title ?? action.arguments.subject ?? action.actionLabel)}</strong>
              {room === 'calendar' && <CalendarFields action={action} />}
              {last ? <ExecutionLine e={last} app={action.appLabel} otherPlan={last.versionId !== plan.versionId} /> :
                <p className="pw-muted">{!action.enabled ? 'Excluded from the plan' : plan.approval.state === 'approved' ? 'Approved · awaiting Run' : 'Proposed action'}</p>}
            </section>;
          })}
          <button className="pw-btn" onClick={(event) => onPick(ghost.id, event.currentTarget)} type="button">
            {room === 'portal' ? 'View action and execution' : 'Open screenshot and plan'}
          </button>
        </article>
      ))}
      {room === 'notes' && sources.map((ghost) => <article key={ghost.id} className="pw-room-record pw-parchment">
        <h4>{ghost.filename}</h4>
        {ghost.epitaph && <blockquote>{ghost.epitaph}</blockquote>}
        <button type="button" className="pw-btn" onClick={(event) => onPick(ghost.id, event.currentTarget, 'make_notes')}>Review source and notes</button>
      </article>)}
      {room !== 'notes' && sources.length > 0 && <QuickQueue ghosts={sources} title={room === 'altar' ? 'Other screenshots' : 'Screenshots available for calendar review'}
        onPick={(id, source) => onPick(id, source, room === 'calendar' ? 'add_calendar' : null)} />}
    </section>
  );
}
