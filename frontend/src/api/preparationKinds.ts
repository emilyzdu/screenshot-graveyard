/** The actions the server can prepare a draft for. */
export type PreparationAction = 'make_notes' | 'add_calendar';

/** The ONLY operation kind each action's preparation may run as (mirrors the server). */
export const OPERATION_KIND_BY_ACTION = {
  make_notes: 'study_note',
  add_calendar: 'event_draft',
} as const satisfies Record<PreparationAction, string>;
