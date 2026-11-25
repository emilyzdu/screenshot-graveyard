# PRD v2.0 Additions (additive spec)

This file adds requirements and tasks. It does not edit, reorder or reopen any
item in `requirements.md`, `design.md` or `tasks.md`. Completed history stays
as written. Where an addition touches an existing open task, that task is named
and left as is.

## Source limitation

The PRD v2.0 `.docx` was unavailable as readable text. These additions come from
the stated product vision (quiet assistant, minimalist, progressive disclosure,
privacy, reversibility, Playful Gothic) and the existing specs and code. They
are proposals. Re-supply the PRD as text or Markdown and reconcile before
treating any item as approved. See `docs/prd-v2-gap-analysis.md`.

## Safety invariants preserved

INV-1 to INV-10 apply unchanged (see `.kiro/steering/safety.md`). In addition:

- No suggestion, assistant surface or view change may call the AI adapter
  without the existing per-screenshot consent.
- Accepting a suggestion only invokes existing endpoints.
- Dismissing or hiding a suggestion never modifies a screenshot, artifact or
  version.
- No delete path is added. No external write is added.
- The UI reflects server-confirmed results only.

## Out of scope for these additions

Real OneNote or Calendar auth, external app writes, autonomous deletion, live
OpenAI calls, long-term memory, external undo, and everything on the P2 list.

## Additional requirements

### Requirement 18: Calm navigation and progressive disclosure (P0 UX)

**User Story:** As a solo user, I want a small number of clear views and a
card that shows the screenshot first, so that the app feels quiet and I see
detail only when I ask.

1. THE System SHALL present separate views for active screenshots, The Crypt,
   and study notes, reachable by keyboard and with accessible names.
2. THE System SHALL show each screenshot card with the image as the dominant
   element and no more than one primary action visible by default.
3. THE System SHALL reveal secondary actions, consent, version and provenance
   detail only on explicit user request.
4. THE System SHALL keep Ghost, Revived and Crypt labels mapped to real states.
5. WHERE the user prefers reduced motion, THE System SHALL minimize animation
   (see open task 4.4).

### Requirement 19: Quiet Assistant suggestions (P0 UX, frontend-derived)

**User Story:** As a solo user, I want at most one unobtrusive suggestion per
analyzed screenshot that I can accept or dismiss, so that I get help without
being pushed.

1. WHEN a screenshot has a successful analysis, THE System MAY show at most one
   suggestion derived from its confirmed category.
2. THE System SHALL label the suggestion as derived from the category, and
   SHALL NOT present it as inferred user intent.
3. THE System SHALL NOT start any AI operation from a suggestion until the user
   accepts it and consent is already granted or is granted in the normal flow.
4. WHEN the user dismisses a suggestion, THE System SHALL hide it and SHALL NOT
   modify any screenshot or artifact.
5. THE System SHALL NOT show suggestions for screenshots without a successful
   analysis, and SHALL NOT show suggestions that rely on uncertain output as if
   it were certain.

### Requirement 20: Intent inference and tool planning (P1, deferred)

1. WHERE intent inference is enabled, THE AI_Adapter SHALL return a validated
   structured plan of proposed actions, each with a confidence and a reason.
2. THE System SHALL treat every planned action as a proposal that needs user
   confirmation before it runs.
3. THE System SHALL preserve INV-1 to INV-10 for every planned action.

### Requirement 21: Calendar event draft (P1, internal draft only)
**User Story:** As a solo user, I want to choose Add to Calendar for one
screenshot and get a saved event draft I can reopen later, so that I can review
it before anything is put on a real calendar.
1. WHEN the user explicitly chooses Add to Calendar for ONE active, owned
   screenshot and asks to prepare it, THE System SHALL create at most one
   persisted event draft for that screenshot (idempotent per screenshot and
   provider), retained as an append-only versioned artifact with a source
   reference to the screenshot.
2. THE System SHALL check per-screenshot consent before creating the
   operation, before reading the original and again before the adapter call;
   without consent THE System SHALL NOT call the adapter.
3. THE event draft SHALL hold title, start/end date, start/end local time,
   all-day flag, IANA time zone, optional location and description, plus
   explicit `missing_fields` and `uncertain_fields`. Every unknown core field
   SHALL be empty AND listed as missing. THE System SHALL NOT default any value
   (no "today", no browser time zone, no assumed duration) and SHALL reject a
   time without an explicit time zone and an end before the start.
4. THE System SHALL NOT present Fake AI output as extracted from the
   screenshot. A simulated draft SHALL be labelled as simulated and SHALL
   contain no date, time, time zone or location.
5. THE System SHALL let a reloaded page reopen the saved draft without
   preparing again, and SHALL keep it readable when another action is chosen
   or the screenshot is archived.
6. Retry SHALL be offered only while Add to Calendar is the current choice for
   that screenshot.
7. THE System SHALL NOT write to any external calendar or application. Review,
   editing, approval and delivery are separate later requirements.
8. Event draft preparation SHALL count toward the per-workspace AI quota and,
   until tasks.md 7.1 is closed, SHALL run only with the Fake provider.

### Requirement 22: Review, edit and version history of drafts (P1, Batch 5A)
**User Story:** As a solo user, I want to review a saved Notes or Calendar draft,
correct it, and see every earlier version, so that nothing the AI wrote is
mistaken for something I checked.
1. THE System SHALL show a saved draft read-only first, with its current
   version, its source screenshot and its version history; editing starts only
   when the user chooses Edit.
2. WHEN the user saves an edit, THE System SHALL append exactly one new
   `manual_edit` version atomically, never modify an earlier version, and keep
   the source references server-side (never accepted from the client).
3. A save SHALL name the version it was based on. IF that version is no longer
   current, THEN THE System SHALL refuse the save with a conflict and SHALL NOT
   change the current version, except that an exact repeat of the save that
   produced the current version returns that version without a new one. A save
   identical to the current version SHALL create nothing.
4. Calendar edits SHALL pass the full Requirement 21 validation (including
   daylight-saving gaps and repeated hours). Unknown fields stay empty and
   missing; nothing is defaulted. An unchanged AI value SHALL keep its
   uncertainty; the user can add uncertainty to any value.
5. Field provenance SHALL be derived from the version history (the version that
   last changed each field). An unchanged AI field SHALL NOT be shown as checked
   by the user. If the history cannot be read, THE System SHALL say provenance
   is unknown.
6. Drafts of an archived screenshot SHALL stay readable (all versions) but SHALL
   NOT be editable until the screenshot is resurrected.
7. Editing SHALL NOT call an AI adapter or write to any external application.

**Design note (refinement, not a replacement):** design.md's "Concurrent Redo /
Manual Edit" guarantee (both commit, via bounded retry) is unchanged at the
service layer: `save_edit` without a base version and AI Redo are not
base-checked. Requirement 22.3 adds optimistic concurrency only at the user
edit boundary (the HTTP edit routes, which always send `baseVersionId`), so a
user save based on a version that a Redo or another tab has since replaced is
refused rather than silently replacing it as current.

### Open conflict: external destination for a future calendar delivery
Requirement 21 adds no external write. A later Google Calendar delivery
(planned as "Batch 6") would conflict with existing requirements that are NOT
changed here: ASSUMPTION A6 and Requirement 17.3 (the single P1 external
destination is OneNote, Google Docs as fallback) and Requirement 17.6 (no
multiple external integrations). Before any calendar delivery is built, the
product owner must either replace the approved destination or record an
explicit exception, and the Delivery_Service rules (INV-8, INV-9) apply.

## Additional tasks

Numbering uses an `A` prefix so no existing task number changes. Dependencies
refer to existing task numbers where relevant.

- [ ] A.1 Design tokens and Playful Gothic styling baseline
  - Centralize color, type scale, spacing and focus styles as CSS variables in `App.css`. No behavior change.
  - **Dependencies:** 4.1
  - **Requirements:** 11.4, 18.5
  - **Acceptance test:** existing Vitest suite passes unchanged. Contrast of text and focus ring is checked in tests or documented.
  - **Priority:** P0

- [ ] A.2 View navigation (Inbox, Crypt, Notes)
  - Add a small keyboard-accessible view switcher without adding a router dependency unless justified. Counts shown match real state.
  - **Dependencies:** A.1, 4.1
  - **Requirements:** 18.1, 18.4
  - **Acceptance test:** Testing Library tests assert each view lists exactly its items, and the switcher has accessible names and keyboard operation.
  - **Priority:** P0

- [ ] A.3 Screenshot-first card with progressive disclosure
  - Image-dominant card, one primary action, secondary actions behind a disclosure control. Safe Burial copy still states bytes are retained.
  - **Dependencies:** A.2
  - **Requirements:** 18.2, 18.3, 10.5
  - **Acceptance test:** tests assert the default card shows one primary action and the disclosure reveals the rest. Existing archive, restore and revive tests still pass.
  - **Priority:** P0

- [ ] A.4 Quiet Assistant suggestion (frontend-derived)
  - Single dismissible suggestion per analyzed screenshot from confirmed category. Accept routes into the existing consent and classify or study-note flow. Dismissal is client-side and non-destructive.
  - **Dependencies:** A.3
  - **Requirements:** 19.1 to 19.5
  - **Acceptance test:** tests assert no AI call on render or dismiss, suggestion absent without successful analysis, label says derived from category.
  - **Priority:** P0

- [ ] A.5 Reconcile with open UX tasks
  - Re-check 4.2, 4.3 and 4.4 against A.1 to A.4 and adjust implementation order. Do not edit those tasks' text.
  - **Dependencies:** A.4
  - **Priority:** P0

- [ ] A.7 `[P1, deferred, NOT implemented]` Intent inference and tool-planning backend
  - Follow-up task. The Quiet Assistant foundation (frontend/src/assistant) is in place and uses deterministic app rules only, labelled "Suggested by app rules". It does not infer intent. This item replaces those rules, or adds to them, with backend proposals labelled "AI suggestion". Add an adapter capability that returns a Pydantic-validated action plan (action type, target screenshot ids, confidence, reason). Add a service that stores plans as proposals only, an endpoint to read them, and UI that shows them through the A.4 surface. Execution of any action stays behind explicit user confirmation and existing endpoints. Fake adapter first, tests with the fake adapter only, no live OpenAI. No long-term memory, no external writes.
  - **Dependencies:** A.4, 2.1, 2.2, 2.3
  - **Requirements:** 20.1 to 20.3, INV-1 to INV-10
  - **Acceptance test:** plan output fails closed on schema violation, no action runs without confirmation, consent gate still blocks adapter calls, property tests keep INV-1 and INV-4.
  - **Priority:** P1, not started

- [ ] A.8 `[P1]` Calendar event draft for one screenshot (Batch 4B)
  - Add an `event_draft` adapter capability (Fake returns a clearly simulated draft with every date, time, time zone and location missing; the OpenAI adapter refuses), an `event_draft` operation and artifact kind, `add_calendar` on the existing preparation endpoint, and read-only `GET /api/event-drafts/{id}` and `/versions`. Frontend: Prepare Event Draft when Add to Calendar is chosen, honest states, read-only draft view. No migration, no external write, no editing or approval.
  - **Dependencies:** Batch 4A preparation endpoint, 2.1, 2.3, 2.4
  - **Requirements:** 21.1 to 21.8, INV-1, INV-4 to INV-7
  - **Acceptance test:** backend router and schema tests (idempotency, two-connection concurrency and archive race, consent at each boundary, cross-workspace 404, quota, provider fail-closed, no network), a property test that accepted drafts declare every unknown and invent nothing, frontend tests for states, reload, retry gating and stale handlers, and an isolated browser run with Fake AI.
  - **Priority:** P1
- [ ] A.9 `[P1]` Review, edit and version history for Notes and Calendar drafts (Batch 5A)
  - `POST /api/event-drafts/{id}/edits` (new) and `POST /api/study-notes/{id}/edits` (now requires `baseVersionId`), field provenance derived from history on every version read, archived drafts read-only. Gothic review/edit UI with version history. No migration, no approval, no external write.
  - **Dependencies:** A.8, 2.8, 3.1
  - **Requirements:** 22.1 to 22.7, INV-5 to INV-7
  - **Acceptance test:** backend tests for new versions, ordered history, stale-base conflicts on two real SQLite connections, replay/unchanged, validation and DST, provenance, cross-workspace and wrong-kind, archived refusal, no AI or network; frontend tests for read-only first, edit/save/cancel, conflicts, validation, provenance and archived read-only; an isolated browser run with Fake AI.
  - **Priority:** P1

## Dependency-aware plan

```
A.1 -> A.2 -> A.3 -> A.4 -> A.5
                       \-> A.7 (deferred)
```

Suggested waves: Wave 1 (A.1), Wave 2 (A.2), Wave 3 (A.3), Wave 4 (A.4),
Wave 5 (A.5). A.7 starts only after the PRD is re-supplied and A.4 is stable.

## Implemented vs planned

| Item | Status |
| --- | --- |
| Consent gate, reversible versions, Crypt, Markdown export | Implemented (earlier tasks) |
| A.1 to A.5 | Planned |
| A.7 intent inference and tool planning | Planned, deferred, not implemented |
| A.8 calendar event draft (internal draft only) | Implemented in Batch 4B |
| A.9 review, edit and version history | Implemented in Batch 5A, pending review |

## Addendum: updates after reading the real PRD v2.0

- A.7 stays deferred. The PRD (section 9) asks for a narrow controlled planner
  and suggestions, not generic intent inference.
- New acceptance rules for the Quiet Assistant: consent is re-read when the
  window regains focus and before each image in a batch; a provider-status
  loading state is shown separately from an unconfirmed (failed) state.
- Open items from the PRD: one primary CTA per view (per-card Revive buttons
  conflict), explicit "phone gallery is not changed" copy in the Crypt, a
  floating selection Action Bar, and a bottom-drawer Assistant on narrow
  screens (needs real-browser acceptance).
- The "re-supply the PRD" next step is done. The comparison is in
  `docs/prd-v2-gap-analysis.md`.
