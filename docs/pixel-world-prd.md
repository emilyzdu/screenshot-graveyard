# Screenshot Graveyard: The Lantern Graveyard (Pixel World) PRD

Status: provisionally approved; revised with product decisions D1–D4 and the delivery
scope correction (see §O, "Decision log"). Planning only; nothing here is implemented.
Baseline: branch `feature/visual-ui-redesign`, commit `beab558` (Batch 6B).
Companion documents: [`pixel-world-technical-design.md`](pixel-world-technical-design.md),
[`pixel-world-asset-spec.md`](pixel-world-asset-spec.md).

Tagline: **A playable AI world where forgotten screenshots become real actions.**

## Visual references

The three approved mockups are in `docs/design/pixel-world/`. Their original Desktop file
names did not match their content; they were renamed by content, and this document
always refers to them by the content label in the first column.

| Label used here | Repo file (original Desktop name, mapped by image content) | What it actually shows |
|---|---|---|
| **M-World** (overall world) | `docs/design/pixel-world/m-world.png` (was `01-graveyard-world.png.png`) | The full village: clock tower with a calendar banner, library with a book sign, crypt, swirling portal, central arch altar with an open book, ghosts carrying cards, Lumi with lantern, a pond with a cat, a top-left Lumi portrait with a bar and 4 dots, and a top-right icon toolbar |
| **M-Card** (AI Action Card) | `docs/design/pixel-world/m-card.png` (was ` 03-approval-portal.png`, leading space) | The world on the left with signs (Calendar, Notes, Crypt, Portal), the upload well and a selected ghost with orange corner brackets. On the right, a panel: "Screenshot · Analyzed", preview, "AI Interpretation", Calendar Draft, Notes Draft, Approve |
| **M-Approve** (approval and delivery) | `docs/design/pixel-world/m-approve.png` (was `  02-ai-action-card.png`, two leading spaces) | Lumi stamping a ghost at the altar. Left card: "Screenshot #4287", Calendar, Epitaph, "Action: Create calendar event", Approved. Right: a Delivery panel (Approved, Delivering…, Delivered, Google Calendar) and a "Delivery Receipt: Event created". Bottom-left icon dock |

All three are 1672×941 single flattened images. They are art direction, not sprites,
tilemaps or layout specifications. Before production, copy them into
`docs/design/pixel-world/` with correct names; tracked in the asset spec.

**Concept-art features that do not exist yet:** the Delivery panel, Delivering/Delivered,
"Google Calendar", "Delivery Receipt / Event created" and the "Action: Create calendar
event" checkbox in **M-Approve**. They depend on external delivery, which is **not
implemented today** (no delivery endpoint, model or OAuth exists). Google Calendar
delivery **is a hackathon target**, built as a parallel workstream (§B-15, §L, §M
Phase D). These parts of M-Approve may be shown only once that workstream returns
verified results; until then the Portal shows its true connection state. M-Card's one
"Approve" for two drafts at once also does not match the real contract: approval is
per draft artifact and per exact version (§B-11).

---

## A. Product overview

**Vision.** Screenshot Graveyard is a consent-aware AI screenshot agent. It understands a
screenshot, decides what it is useful for, prepares a calendar or notes draft
automatically, and lets the user review, correct and approve it. Approved drafts can be
delivered to external apps later; that part is not built.

**Problem.** People keep screenshots that hold a task ("this event", "these lecture
notes") and never act on them. The existing app solves the workflow, but its
Gothic Visual Workspace shows status as text on cards and in a side panel. The pipeline
state (analyzing, routing, preparing, waiting for review) is invisible until the user
opens a drawer.

**Why a playable world, beyond novelty.** The world is an at-a-glance status board where
place means state:
- Every screenshot is a ghost standing where its real workflow step happens: at the
  Upload Well while it is analyzed, at the Clock Tower while a calendar draft is
  prepared, in front of the Approval Altar when it needs review.
- The user can see at a glance how many screenshots need them and where. The ghosts'
  movement reflects real server state, so the scene doubles as a live progress view.
- It is the hackathon's differentiator ("Kiroween": functional Halloween UX, per
  `.kiro/steering/product.md`, where every metaphor maps to a real state).

**Intended users.** The hackathon judges, and a solo, anonymous visitor with a backlog
of screenshots. There are no accounts: each visitor gets an isolated workspace (cookie
`sg_workspace`, `backend/app/middleware/workspace.py`).

**Value proposition.** Upload, allow once per screenshot, and watch the ghost walk to the
right building. Then review and approve a real draft in a readable overlay.

**Design goals.**
1. Truthful: the scene only shows server-confirmed state. An animation is never the
   source of truth.
2. No slower than the existing UI: every action is reachable by one click on an overlay
   or toolbar, without walking.
3. Zero new paid AI paths: the world triggers AI only through existing explicit user
   actions (Allow, Continue, Prepare, Redo).
4. Reuse: the same API client, hooks and draft components as the Visual Workspace.
5. Accessible: keyboard, screen reader and reduced-motion support, plus a one-click
   fallback to the Visual Workspace.

**Non-goals.** An RPG (stats, inventory, quests), multiple maps, pathfinding AI, sound
(MVP), persisting ghost positions, a second backend, and rebuilding upload, consent, AI
routing, drafts or approval. External delivery is **not** a non-goal: it is a separate,
coordinated workstream (§M Phase D). The world only renders its real states.

**Public AI provider (decision D2).** The public app targets real OpenAI Vision, with a
clearly labeled Demo Mode fallback (the existing frontend-only `?demo=1`, which uses
synthetic fixtures and never calls the API). Demo data is never presented as real AI
inference. The spending and abuse protections are in §K-2.

**Relationship to the existing app.** The world is a third view of the same workspace,
alongside the Visual Workspace (default, `frontend/src/shell/LiveWorkspace.tsx`) and the
classic view (`?view=classic`). It uses the same cookie, the same APIs and the same
state. Proposed entry: `?view=world`, lazy-loaded like `DemoApp` in
`frontend/src/App.tsx`.

**Deadline constraints.** The deadline is 2026-12-04 14:00 PT, about 8 days from
baseline. There is no public deployment yet (README: "There is no public production
deployment or live demo URL"). Deployment is a hard dependency for submission and is
scheduled independently of the world (§M, Phase 0). The world ships behind
`?view=world`. It becomes the default view **only after** the functional, visual,
accessibility, playability and integration acceptance in §N passes (decision D4). The
switch is not tied to a date. If acceptance does not pass, the Visual Workspace stays the
default, and it is kept as a fallback in every case.

---

## B. User journeys

Shared notation:
- **BE** = backend behavior (existing unless marked).
- **World** = scene response.
- **Overlay** = React UI response.

"Action Card" is the new right-side overlay from M-Card (§G).

### B-1 First-time visitor
- **Entry:** opens `/?view=world`.
- **User action:** none.
- **BE:** `GET /api/workspace` mints the workspace and cookie. `GET /api/screenshots`
  returns an empty list. `GET /api/workspace/automation` returns
  `{autoPrepare:false}`. `GET /api/ai/provider-mode` gives `fake` or `openai`.
- **World:** an empty graveyard. Lumi idles at the plaza and the Upload Well glows
  softly.
- **Overlay:** a one-time welcome toast: "Drop a screenshot into the Upload Well, or
  press Upload." It also shows the provider badge ("Real AI · OpenAI" / "Fake AI ·
  simulated").
- **Success:** the scene is interactive.
- **Failure:** if the workspace cannot start, show the same error and Try again as
  `LiveWorkspace` ("Could not start your workspace."), with no scene.

### B-2 Screenshot upload
- **Entry:** toolbar Upload, a click on the Upload Well, or dragging files anywhere onto
  the scene.
- **User action:** pick or drop up to 20 files (`MAX_FILES_PER_BATCH`), 15 MB each.
- **BE:** `POST /api/screenshots` (multipart). The server validates the content, stores
  the file as an immutable original, deduplicates, and returns a result per file.
- **World:** one new ghost rises out of the well per accepted file. A duplicate rises
  with a small "same image" mark (`isDuplicate`).
- **Overlay:** the result notice from `LiveWorkspace` ("Saved N screenshots", plus
  per-file rejection messages).
- **Single-file shortcut:** when automation is on and exactly one file is accepted, its
  Action Card opens at the consent step. This reuses the Batch 6B behavior.
- **Success:** the ghost exists after a reload, because it is derived from
  `GET /api/screenshots`.
- **Failure:** no ghost for rejected files, and an inline reason per file. If the list
  refresh fails: "Could not refresh the list. Reload to see it."

### B-3 AI consent
- **Entry:** select a ghost in state awaiting consent (it shows a "?" bubble), or the
  Action Card opens automatically.
- **User action:** read the disclosure, then Allow or Decline.
- **BE:** `GET /api/ai/disclosure` provides the provider-bound text and revision. Allow
  sends `POST /api/screenshots/{id}/consent` with `{granted, provider,
  disclosureRevision}`. A 409 `disclosure_changed` means the disclosure is re-read
  (6A C2/D2).
- **World:** none until the server confirms. After a confirmed grant, the ghost's "?"
  becomes a lantern spark.
- **Overlay:** `RevivePanel` renders the disclosure verbatim, with Allow, Decline and
  Withdraw.
- **Success:** consent is recorded for this one screenshot. If automation is on, B-4
  starts with no further click (`RevivePanel.onConsentGranted` triggers
  `AutoPilot.startSignal`).
- **Failure:** the existing messages for a changed disclosure, an unconfirmed
  withdrawal, or an unknown provider. Nothing is sent.

### B-4 Automatic screenshot understanding
- **Entry:** consent was granted with automation on, or Continue automatically.
- **BE:** `POST /api/screenshots/{id}/auto-process` returns 202. Inside, the keyed
  classify operation runs, the consent dispatch boundary re-checks at dispatch, there is
  exactly one provider call, and the analysis is saved.
- **World:** the ghost hovers over the well while the well swirls (stage `analyzing`).
- **Overlay:** `AutoPilot` shows "Understanding screenshot…".
- **Success:** the classification and Epitaph are saved.
- **Failure:** stage `analysis_failed`. The ghost shows "!" and the overlay text explains
  that nothing was saved, and that after a timeout the provider may still have
  processed it. Try again is explicit (B-14).

### B-5 AI routing to Calendar
- **Entry:** automatic, once the analysis is saved.
- **BE:** `action_router.route_from_analysis` returns `auto/add_calendar`, which needs a
  real date and event words. The automatic preparation (`prepare:add_calendar:…:auto:`)
  is created under the workspace lock and re-checked at dispatch and on return.
- **World:** the ghost drifts to the Lantern Crossroads (stage `routing`, usually
  instant), then floats into the Clock Tower. The tower clock spins (stage `preparing`).
- **Overlay:** "Preparing your calendar event…" with the route reason.
- **Success:** stage `ready_for_review`. The ghost walks to the Approval Altar queue with
  a calendar badge.
- **Failure:** `preparation_failed` (or a superseded result: the detail starts with
  "Superseded:"). The ghost returns to the crossroads with "!" and the overlay offers
  "Try preparing again" (explicit).

### B-6 AI routing to Notes
Same as B-5 with `make_notes`, via the Magic Library instead of the Clock Tower. The
library window pages flutter. The overlay says "Preparing your study notes…".

### B-7 Reference screenshot
- **BE:** the route is `keep_reference`, so stage `reference` and no draft.
- **World:** the ghost wanders the lawn near the gravestones with an "image" badge, at
  low priority.
- **Overlay:** "Kept as a reference. No draft was prepared." with the reason and a
  "Choose a step anyway" button.
- **Success:** no further calls.

### B-8 Uncertain or ambiguous screenshot
- **BE:** stage `recommended` (a weak or instruction-like signal) or `needs_choice`
  (sensitive, unknown, uncertain or user-edited).
- **World:** the ghost waits at the crossroads with "?". A sensitive one shows a closed
  padlock badge.
- **Overlay:** "Recommended: Add to Calendar" with the reason and a Prepare button. For
  `needs_choice`: "Your choice." plus the choice controls. Nothing runs without a click.

### B-9 Calendar draft review and edit
- **Entry:** select a ghost that is ready for review, or a Quick Queue row.
- **BE:** `GET /api/screenshots/{id}/preparations/add_calendar` and
  `GET /api/event-drafts/{artifactId}`. Edits go to
  `POST /api/event-drafts/{artifactId}/edits`, which creates a new immutable version.
  History comes from `GET /api/event-drafts/{artifactId}/versions`.
- **World:** while the card is open, the selected ghost stays in front of the altar,
  framed by orange corner brackets (M-Card).
- **Overlay:** the Action Card embeds the existing `CalendarDraft`: summary, Open draft,
  editor, version history, missing and uncertain fields, and the approval section.
- **Success:** "Saved as version N."
- **Failure:** the existing conflict and unknown-outcome handling in `CalendarDraft` and
  `DraftReview`.

### B-10 Notes draft review and edit
Same as B-9, with `MakeNotesDraft` and the study-note endpoints:
- `GET /api/study-notes/{id}`;
- `/versions`;
- `/edits`;
- `/export` (Markdown).

### B-11 Approval
- **Entry:** in the Action Card, "Approve version N" for one draft.
- **BE:** `POST /api/artifacts/{artifactId}/approvals` with `{versionId,
  confirmReviewed, acknowledgeUncertain}`. The ledger binds the approval to the exact
  version and its content SHA-256. Status comes from
  `GET /api/artifacts/{id}/approval`.
- **Overlay:** the existing `ApprovalSection` confirmation dialog, including the
  required acknowledgements for uncertain fields. Approval is never one click: M-Card's
  big Approve button opens this dialog for that draft.
- **World:** only after the server confirms (a 201, then the approval re-read shows
  `current_approved`), Lumi plays the stamp animation at the altar (M-Approve without the
  delivery parts). The ghost gets a green check and rests by the altar.
- **Success:** "Approved · version N". The text says nothing was sent anywhere.
- **Failure:** the existing ineligibility and conflict messages. No stamp animation.

### B-12 Safe Burial
- **Entry:** Bury in the Action Card footer (mirrors the drawer footer in
  `LiveWorkspace`).
- **BE:** `POST /api/screenshots/{id}/archive`. Outcomes are confirmed, failed or
  unknown, with reconciliation by reading the gallery (`LiveWorkspace.runLifecycle` and
  `reconcile`).
- **World:** after confirmation, the ghost floats into the Crypt and the Crypt's count
  goes up by one.
- **Overlay:** "Moved to The Crypt…". If unknown: "Checking whether Safe Burial
  completed…" with Check status.
- **Failure:** the ghost stays. An unknown outcome blocks further lifecycle actions on
  that screenshot until it is resolved.

### B-13 Resurrection
- **Entry:** Crypt (toolbar, or a click on the building), then the Crypt overlay listing
  archived screenshots.
- **BE:** `POST /api/screenshots/{id}/restore`. The server checks the SHA-256 of the
  original; a failed check means the screenshot stays archived.
- **World:** the ghost rises out of the Crypt and returns to the location its stage
  implies.
- **Overlay:** archived drafts stay readable through the existing `ArchivedDrafts`.
- **Failure:** "Resurrection failed an integrity check. The screenshot stayed in The
  Crypt."

### B-14 Failed AI request and recovery
- **Trigger:** `analysis_failed` or `preparation_failed`, or a lost POST response.
- **World:** the ghost stays where it failed with a "!" badge, plus a slow, sad bob.
- **Overlay:** the `AutoPilot` failure copy:
  - it explains when the provider may have processed the request;
  - it says nothing is retried automatically;
  - Try again or Try preparing again are explicit buttons, and the text says a retry
    sends the screenshot again.
  - A lost POST: "We could not confirm whether the request reached the server…". The
    client reconciles by reading, never by re-sending.
- **Success:** the ghost resumes normal flow after an explicit retry.

### B-15 External app connection and delivery (parallel workstream; not built yet)
Google Calendar is the hackathon target. Notion is second priority, subject to OAuth,
account-binding security and deployment feasibility. Both depend on the delivery
workstream (§M Phase D). The world renders only the state that workstream reports.

- **Entry:** the Portal, or "Send to Google Calendar" in the Action Card of an
  **approved** calendar draft.
- **Portal states** (each derived from server data; none is a cosmetic default):

  | Portal state | Condition (source) | Portal visual | Overlay |
  |---|---|---|---|
  | Not connected | No delivery capability on the server (today), or the destination is disabled by config | Dim, padlock rune | "Sending to Google Calendar is not available yet. Approved drafts stay in your workspace." |
  | Connection required | Delivery is enabled, but this workspace has no verified account binding | Dim, a key rune glows | "Connect Google Calendar" (starts OAuth; explains what access is requested) |
  | Ready for delivery | Connected, and an approved version exists that has not been delivered | Portal swirls softly | "Send version N to Google Calendar" (one explicit click) |
  | Delivering | A delivery operation is `pending` | Card flies into the portal (loops while pending) | "Sending…"; nothing is claimed yet |
  | Delivered | Delivery operation `successful` **with verified evidence** (the external event id the provider returned, re-read) | A burst, then a receipt seal on the ghost | "Delivered · Event created" with an external link to the returned event |
  | Failed / uncertain | Operation `failed`, or the outcome is unknown (timeout, lost response) | Portal flickers; ghost "!" or a faint dot | Failed: the reason plus an explicit retry. Uncertain: "We could not confirm whether the event was created. Checking…", reconciled through the idempotency key, **never** by blindly re-sending (INV-9) |

- **User action:** connect once, then send each approved version explicitly. Never
  automatic.
- **BE (to be built, Phase D):** a Delivery_Service per
  `.kiro/specs/screenshot-graveyard/requirements.md` Requirement 8.4/8.5 (INV-8, INV-9),
  on the existing `operation` model:
  - `kind` "delivery" (already anticipated in the `models.py` comment);
  - `idempotency_key` (already reserved "for external writes (P1)");
  - bound to the approved artifact version and its content SHA-256 in the approval
    ledger.
- **World:** the Portal animations above, only while the server reports those states.
- **Success:** "Delivered" appears only after verified evidence; a reload shows the same
  state.
- **Failure:** Failed or uncertain as above. A ghost's approval is never revoked by a
  failed delivery.

---

## C. World information architecture

The world adds no database. Every displayed value comes from existing endpoints.

| Location | Purpose / real feature | What the user sees | Click | Lumi interaction | Data | Empty | Error | MVP |
|---|---|---|---|---|---|---|---|---|
| **Upload Well** | Upload (`POST /api/screenshots`) and the analysis stage | A stone well with a purple glow; it swirls while any ghost is `analyzing` | Opens the file picker | Inspect near the well opens the picker | Count of ghosts analyzing | Soft idle glow | Upload error toast | Must |
| **Lantern Crossroads** (signpost in front of the altar) | Routing and the user's choice (`routing`, `recommended`, `needs_choice`, failed) | A signpost with three arrows | Opens Quick Queue filtered to "Needs your choice" | Inspect opens the same | Ghosts waiting with "?" | Signpost only | n/a | Must (a prop, not a building) |
| **Clock Tower** ("Calendar" sign) | Calendar drafts (`add_calendar`) | Tower clock; hands spin while a calendar draft is `preparing` | Opens the Drafts overlay, Calendar tab | Inspect opens the same | Calendar drafts preparing or ready | "No calendar drafts yet" | Shows a "!" flag if any failed | Must |
| **Magic Library** ("Notes" sign) | Notes drafts (`make_notes`) | Lit windows; pages flutter while `preparing` | Drafts overlay, Notes tab | Same | Notes drafts | "No notes drafts yet" | "!" flag | Must |
| **Approval Altar** | Review and approval queue (`ready_for_review`, approved) | Candles light per waiting ghost; the stamp plays after a confirmed approval | Opens Quick Queue filtered to "Ready for review" | Inspect next to a waiting ghost opens its Action Card | Counts waiting and approved | Candles unlit | n/a | Must |
| **Crypt** | Safe Burial, The Crypt, Resurrection | A mausoleum with a count plaque | Opens the Crypt overlay (archived list with Resurrection) | Inspect opens the same | Archived count and list | "The Crypt is empty." | Lifecycle errors in the overlay | Must |
| **Portal / Midnight Post** | External delivery (Google Calendar first, Notion second) | Portal in one of six states (§B-15) | Opens the Portal panel for that state | Inspect opens the same | Connection state; ghosts ready to send, delivering or delivered | "Not connected" (today's true state) | Failed / uncertain state with reconciliation | Must: renders the real state. Delivery itself ships through Phase D |
| **Graveyard lawn** | Reference screenshots | Gravestones and flowers; reference ghosts wander | n/a | Walking only | n/a | n/a | n/a | Must (the background) |
| **Pond with cat** | Atmosphere only | Shimmer and a sleeping cat | Optional easter egg (cat purrs) | Inspect: cat purr emote | none | n/a | n/a | Nice-to-have |

HUD (from M-World, simplified):
- **Top-right toolbar:** Upload, Calendar drafts, Notes drafts, Crypt, Settings.
- **Top-left Lumi portrait:** opens Quick Queue. A count chip shows how many items need
  you.
- **Not adopted:** the mockup's progress bar and 4 dots have no real data to show. They
  are omitted rather than invented.
- **Not adopted:** M-Approve's bottom-left dock duplicates the toolbar.

---

## D. Lumi interaction design

- **Role:** Lumi is cosmetic and optional. Lumi never triggers API calls (§K).
- **Keyboard movement:**
  - WASD and arrow keys move Lumi only while the scene region has focus. The region is a
    `role="application"` element with `tabIndex=0` and the label "Graveyard scene. Arrow
    keys move Lumi, E to inspect".
  - Keys are ignored while focus is in an overlay, input, textarea, select or dialog, so
    typing in a draft editor never moves Lumi.
  - Shift is not used. Diagonal movement is normalized.
  - Speed: 72 logical px/s (about 4.5 tiles/s).
- **Pointer:**
  - Clicking the ground moves Lumi in a straight line to that point, clamped to walkable
    areas.
  - Clicking a ghost or building acts immediately: the overlay opens at once while Lumi
    floats there for show. The player is never required to walk.
- **Idle:** a 2-frame bob, lantern flicker, and a look toward the selected ghost.
- **Proximity:** "interactable" means within 28 logical px of an object's anchor. The
  nearest one shows an "E" hint bubble. E, Enter or Space (with the scene focused) opens
  it, the same as clicking it.
- **Inspect:** a short lantern raise (3 frames), then the same `select(ghostId)` intent
  that a click sends.
- **Approval animation:** plays only after approval is confirmed (B-11). Lumi glides to
  the altar and plays the stamp animation (6 frames, about 700 ms), then the ghost's
  check badge appears. With reduced motion, the badge appears at once and there is no
  movement.
- **Collision:** a handful of axis-aligned rectangles for building footprints, the pond
  and the fence. Lumi is clamped, with no physics, slopes or pathfinding. Ghosts ignore
  collisions (they float).
- **Focus conflicts:** Escape closes the top overlay and returns focus to the element
  that opened it. Tab never gets trapped in the scene. Overlays use the existing
  `Drawer` focus handling in `frontend/src/shell/DetailDrawer.tsx`, or the same pattern.
- **Accessibility alternatives:**
  - every ghost is a real `<button>` in DOM order with a label, for example "event.png,
    ready for review, calendar draft";
  - Quick Queue lists every actionable screenshot;
  - the toolbar reaches every location;
  - Lumi is never required.

---

## E. Screenshot Ghost system

- **Identity:** one ghost per screenshot, keyed by `screenshotId` from
  `GET /api/screenshots`, so it is stable across reloads. A duplicate upload is its own
  record and its own ghost, marked with `isDuplicate`. There is no ghost without a
  screenshot and no screenshot without a ghost, except for the overflow aggregation
  below.
- **Visual variants:** cosmetic only, from `hash(screenshotId)`. One of 5 pastel tints
  and one of 4 accessories (none, bow, leaf, scarf). The same screenshot always looks
  the same.
- **Type badge** (the speech-bubble icon), in priority order:
  1. `preparation.action` (calendar or book), if a draft exists;
  2. otherwise `route.action`, if one is recommended;
  3. otherwise the category icon from `analysis.category`: image (Reference, Memory,
     Shopping), book (Study), "?" (Unknown), padlock (Potentially Sensitive);
  4. no analysis yet: no badge.
- **Status indicator** (a ring or emote under or above the badge): "?" for consent or
  choice needed; a spinning sparkle while in progress; a green check when approved; an
  amber "!" when failed; a faint dot when the outcome is unknown. Full mapping in §F.
- **Autonomous movement:**
  - each derived state has a target location (§F);
  - a ghost interpolates toward a free slot there at 40 px/s, then idles inside a
    small wander radius (12 px), choosing a new local point every 2 to 5 seconds;
  - all of this is seeded and client-side only.
- **Destination changes:** when the derived state changes after a confirmed server read,
  the ghost travels to the new location. Travel time is about 0.5 to 2 seconds and has
  no business meaning.
- **Selection:** a click or keyboard activation on the ghost button selects it and opens
  the Action Card. The selected ghost gets the orange corner brackets (M-Card) and stops
  wandering.
- **Priority display:** z-order and size do not change. Priority affects only Quick
  Queue order and which ghosts get rendered first under the cap:
  1. failed or unknown;
  2. needs consent;
  3. needs choice;
  4. ready for review;
  5. in progress;
  6. approved;
  7. reference.
- **Maximum rendered:** 24 individual ghosts (performance and legibility at 640×360).
  The rest are grouped per location as a "lantern crowd" (a lantern with a count). A
  click on it opens Quick Queue filtered to that location.
- **Refresh persistence:** state comes from the server. Positions are recomputed: slot =
  f(location, rank of `screenshotId` within that location). No coordinates are stored.
- **Archived ghosts:** never rendered outside. They count on the Crypt plaque and are
  listed in the Crypt overlay. Resurrection removes them from the plaque and makes them
  rise.

---

## F. AI state-to-world mapping

**Sources.** The backend has no event stream. State is derived on read.

| Read | Endpoint | Fields used |
|---|---|---|
| (a) Screenshot list | `GET /api/screenshots` | `state`, `analysis` summary, `isDuplicate` |
| (b) Auto-process state | `GET /api/screenshots/{id}/auto-process` | `stage`, `consent`, `route`, `analysis` operation, `preparation` (`action`, `status`, `artifactId`, `trigger`, `provider`), `running` |
| (c) Approval status | `GET /api/artifacts/{artifactId}/approval` | `status`: `current_approved` / `older_approved` / `never_approved` |

Read (b) works whether automation is on or off. The stages are defined in
`backend/app/services/auto_process_service.py::_stage`.

| # | Backend state (source) | Derived view state | Ghost location | Animation | Badge / label | Building feedback | User actions | Error / recovery | Support |
|---|---|---|---|---|---|---|---|---|---|
| 1 | (a) present, (b) `awaiting_consent` | `needs_consent` | Upload Well rim | Gentle bob | "?" / "Waiting for your OK" | Well idle glow | Open card: Allow / Decline | Consent errors via `RevivePanel` | Existing |
| 2 | (b) `not_started` (consent yes, no analysis) | `ready_to_start` | Upload Well rim | Bob | spark / "Ready to understand" | n/a | Continue automatically (when automation is on) or Revive (when off) | n/a | Existing |
| 3 | (b) `analyzing` (classify op pending, or a running pipeline) | `analyzing` | Over the well | Hover and spin | sparkle / "Understanding…" | Well swirls | Open card (progress only) | Bounded polling then "Check again" | Existing |
| 4 | (b) `routing` (in-process `running` registry) | `routing` | Lantern Crossroads | Turn toward the signpost | sparkle / "Choosing a step…" | Signpost arrow glints | n/a | Usually under 100 ms; may be skipped visually | Existing |
| 5 | (b) `preparing` + `preparation.action` | `preparing_calendar` / `preparing_notes` | Inside the Clock Tower / Library (door) | Fade into the door | calendar or book + sparkle | Clock spins / pages flutter | Open card (progress) | Bounded polling | Existing |
| 6 | (b) `ready_for_review` + (c) `never_approved` | `ready_for_review` | Approval Altar queue | Wait, look at the altar | calendar or book / "Ready for review" plus a "Chosen automatically" or "Chosen by you" chip from `preparation.trigger` | One altar candle per ghost | Review, edit, approve | n/a | Existing (the (c) read is per artifact) |
| 7 | (c) `current_approved` | `approved` | Beside the altar (rest ring) | Content sway | green check / "Approved · v N" | n/a | Review history; edit (a new version becomes unapproved) | n/a | Existing |
| 8 | (c) `older_approved` | `approved_older` | Altar queue | Wait | check outline / "Earlier version approved" | n/a | Approve the current version | n/a | Existing |
| 9 | (b) `recommended` | `recommended` | Crossroads | Wait | "?" + action icon / "Recommended: …" | n/a | Prepare (explicit), choose other | n/a | Existing |
| 10 | (b) `needs_choice` | `needs_choice` | Crossroads | Wait | "?" (padlock if sensitive) / "Your choice" | n/a | Choose a step | n/a | Existing |
| 11 | (b) `ready_to_prepare` | `ready_to_prepare` | Crossroads | Wait | action icon / "Next: …" | n/a | Prepare (explicit) | n/a | Existing |
| 12 | (b) `reference` | `reference` | Lawn | Wander | image / "Kept as reference" | n/a | Choose a step anyway | n/a | Existing |
| 13 | (b) `analysis_failed` | `failed_analysis` | Well rim | Sad bob | "!" / "Didn't finish" | n/a | Try again (explicit, may be paid) | Detail text from `analysis.errorDetail` | Existing |
| 14 | (b) `preparation_failed` (including "Superseded: …") | `failed_preparation` | Crossroads | Sad bob | "!" / "Draft didn't finish" or "Stopped: things changed" | Building "!" flag | Try preparing again / choose other | Detail text | Existing |
| 15 | (a) `state='archived'` / (b) `archived` | `archived` | Crypt (hidden) | Float into the Crypt once | n/a | Crypt plaque count | Resurrection (Crypt overlay) | Lifecycle unknown flow | Existing |
| 16 | Client: POST outcome lost or timed out, no server answer yet | `unknown` | Stays put | Faint pulse | dot / "Checking…" | n/a | Check status (a read) | Never re-POST automatically | Existing pattern (`AutoPilot`, `LiveWorkspace.reconcile`) |
| 17 | Client: read failed or polling bound reached | `stale` | Stays put | Freeze | dot / "Status not confirmed" | n/a | Check again | n/a | New frontend logic only |
| 18 | Uploaded but (b) not fetched yet | `loading` | Well rim | Bob | none / "Checking…" | n/a | Open card | n/a | New frontend logic only |
| 19 | Delivery operation `pending` (Phase D) | `delivering` | Portal | Card flies in (loops) | portal icon / "Sending…" | Portal swirls | None (wait) | Bounded polling, then "Checking…" | **Requires Phase D backend** |
| 20 | Delivery `successful` with verified external id (Phase D) | `delivered` | Beside the altar, with a receipt seal | Content sway | seal / "Delivered" + link | Burst once on the transition | Open the external link | n/a | **Requires Phase D backend** |
| 21 | Delivery `failed`, or outcome unknown (Phase D) | `delivery_failed` / `delivery_uncertain` | Portal steps | Sad bob / faint pulse | "!" or dot / "Not sent" or "Checking delivery…" | Portal flicker | Retry (failed) or Check status (uncertain); never a blind resend | Reconcile through the idempotency key (INV-9) | **Requires Phase D backend** |

**Unknown provider outcome.** The system has two real signals:
1. a POST whose answer was lost (client side);
2. a failed operation whose `errorDetail` reports a timeout ("AI provider timed out"),
   meaning the provider may still have processed it.

The 6A dispatch ledger state `interrupted` is internal and is not exposed by read (b).
The world shows these honestly (rows 13, 14 and 16). It never says "failed for sure"
after a timeout.

**Refresh reconstructs the same truth:**
1. `GET /api/workspace`;
2. `GET /api/screenshots`;
3. (b) for each active screenshot (scheduled; see the technical design §9);
4. (c) for each `preparation.artifactId`.

The view state is a pure function of these reads. Positions are recomputed from the
view state and the id. Nothing visual is persisted.

**Animation is never the source of truth.** Location changes happen only after a server
read changes the derived state. An animation's completion never sends a request or
changes the view state, and skipping or interrupting animations has no effect on data.

---

## G. Existing-to-new integration matrix

Legend: **as-is** = mounted unchanged; **wrap** = hosted inside a new container;
**refactor** = logic extracted into a shared hook with no behavior change, covered by the
existing tests.

| Pixel-world feature | Existing component / service / API | What to reuse | New frontend responsibility | Backend change? |
|---|---|---|---|---|
| Upload Well | `UploadDropZone` (`shell/Workspace.tsx`), `uploadScreenshots` (`api/client.ts`), `POST /api/screenshots` | Validation hints, the result-notice logic in `LiveWorkspace.upload` | A well click target, scene-wide drop target, rising-ghost animation | No |
| Screenshot Ghosts | `listScreenshots`, `getAutoProcess`, `getApprovalStatus` (`api/ai.ts`) | Types `Screenshot`, `AutoProcessState`, `ApprovalStatus` | `deriveGhostView()`, ghost sprites, slots, the centralized status scheduler | No, at first. B1 (a batch status read) is added **only if** the scheduler load measurement fails (decision D1; technical design §9) |
| Lumi Inspect | none | none | Movement, proximity, `select()` intent | No |
| Auto-Routing animation | `AutoPilot` stages, `AUTO_IN_PROGRESS`, `action_router` reasons | The stage strings, `route.reason` | Location transitions | No |
| Clock Tower | `CalendarDraft`, `getEventDraftPreparation` | as-is inside the Drafts overlay | Building states, Drafts overlay list (Calendar tab) | No |
| Library | `MakeNotesDraft`, `getMakeNotesPreparation` | as-is | Building states, Notes tab | No |
| Approval Altar | `ApprovalSection` (inside both draft components), `POST /api/artifacts/{id}/approvals` | as-is through the draft components | Altar candles, stamp animation after the (c) read confirms. *Optional small adaptation:* an `onApprovalConfirmed` callback on `ApprovalSection` to avoid an extra read | No |
| Crypt | `ScreenshotGallery` for archived items, `ArchivedDrafts`, `CRYPT_GALLERY_NOTE` | wrap | Crypt overlay, plaque count | No |
| Resurrection / Burial | `LiveWorkspace.runLifecycle`, `reconcile`, `postLifecycle`, `judge` | **refactor** into `useLifecycle()` shared by both views | Ghost float-in and rise animations | No |
| Portal | none today | none | The six Portal states (§B-15), the Portal panel, "Send" in the Action Card | **Yes: Phase D** (Delivery_Service, OAuth account binding, delivery state reads). The world needs only read endpoints and one explicit send POST from Phase D |
| Quick Queue | Data from (a), (b), (c); the row pattern from `ScreenshotCard` | Labels from `epitaphProvenanceLabel`, `LIVE_ACTIONS` (`shell/nextAction.ts`) | A new accessible list overlay with priority sort and filters | No |
| AI Action Card | `RevivePanel` (consent, disclosure, saved result), `AutoPilot` (progress, recovery), `CalendarDraft`, `MakeNotesDraft`, `imageUrl()`, `epitaphProvenanceLabel` | as-is inside the card, with the same props as in the `LiveWorkspace` drawer (`autoMode`, `onConsentGranted`, `startSignal`, `onState`) | Card frame (M-Card), header (id, filename, stage chip), Bury footer | No |
| Draft History | `draftHistory.ts`, `DraftReviewParts.tsx` via the draft components | as-is | none | No |
| Consent | `RevivePanel`, `useDisclosure`, `useConsent`, `PrivacyNotice.useProviderStatus` | as-is | none | No |
| Automation setting | `useAutomation`, `AutomationToggle` | as-is in the Settings overlay | none | No |
| Gallery and refresh sequencing | `LiveWorkspace.refreshGallery`, ticket logic, `bounded()` | **refactor** into `useGallery()` | none | No |
| Fallback | `LiveWorkspace` (default view) | as-is | A "List view" toolbar link and a banner on small screens | No |

**Do not duplicate:** consent, approval, lifecycle reconciliation or preparation logic.
The world only hosts the existing components and reads the same APIs.

---

## H. Frontend architecture

**Technology comparison.**

| Option | Fit | Verdict |
|---|---|---|
| **React DOM + CSS** (pre-rendered pixel PNG layers, sprites as absolutely positioned elements moved with `transform`, one `requestAnimationFrame` loop) | About 30 moving sprites, simple tweens, no physics. Each ghost can be a real `<button>` (accessibility). Testable with the existing Vitest and jsdom. Zero new dependencies; bundle unchanged apart from assets | **Selected** |
| Canvas 2D | Better above about 200 sprites, but loses DOM accessibility and needs a parallel hit-test and focus layer | Fallback only if profiling shows DOM jank (unlikely at 24 ghosts) |
| PixiJS | WebGL, about 450 KB; overkill for 30 sprites; accessibility and testing friction | Rejected |
| Phaser | A full engine with its own scene, input and loop that fights React state and focus; about 1 MB | Rejected |

**Scene hierarchy.**
```
PixelWorld (route ?view=world, lazy; error boundary → Visual Workspace)
├─ WorldDataProvider     shared hooks: useGallery, useLifecycle, useAutomation,
│                        useProviderStatus, useWorldStatus (scheduler), analysisAuthority
├─ SceneViewport         integer-scaled 640×360 stage; keyboard and pointer input
│  ├─ BackgroundLayers   sky, far hills, ground and paths (static PNGs)
│  ├─ LocationLayer      Well, Crossroads, ClockTower, Library, Altar, Crypt, Portal
│  ├─ ActorLayer         GhostButton × ≤24, CrowdMarker × n, Lumi; y-sorted
│  └─ ForegroundLayers   fence, flowers, framing trees
├─ Hud                   Lumi portrait (Quick Queue count), Toolbar
└─ Overlays              ActionCard | QuickQueue | DraftsOverlay | CryptOverlay |
                         SettingsOverlay | PortalInfo | Toasts
```

**Renderer boundary.**
- The scene modules (`frontend/src/world/scene/**`) receive read-only `GhostView[]` and
  `LocationView[]`, and emit intents only:
  - `select(screenshotId)`;
  - `open(locationId)`;
  - `moveLumi(x, y)`.
- An ESLint `no-restricted-imports` rule forbids importing `api/*` in scene modules.
  Only overlays and the data provider call the API.
- Consent, approval and authorization decisions stay in the existing components and on
  the server.

**Ghost view model.** `deriveGhostView(screenshot, autoState?, approval?, clientFlags)`
is a pure, unit-tested function. It returns `{id, label, viewState, location, badge,
statusIcon, priority, tint, accessory}` (technical design §5 and §6).

**Overlays.** Ordinary React panels over the scene, using the existing theme
(`ui/theme.css`, `ui/components.css`). Pixel framing comes from a CSS 9-slice border
image; the content stays modern and readable (Inter / Cormorant). Only one overlay is
open at a time, except toasts.

**Assets.** Imported through Vite (`import tower from './assets/clock-tower.png'`), so
they are hashed into `frontend/dist/assets`. That directory is already served by FastAPI
(`backend/app/main.py::_mount_spa`), so no new hosting is needed. Assets are preloaded
before the first scene paint, with a loading state.

**Route integration.** `App.tsx` gains `view=world`, lazy-loaded so the default bundle
is unaffected. The Visual Workspace remains the default until §N passes.

**Error boundaries.** A scene renderer error swaps the scene for a static notice plus
the Visual Workspace link, and overlays keep working. An overlay error affects only that
overlay.

**Performance.**
- 60 fps target; one rAF loop.
- Transforms only: no layout properties, no React re-render per frame. Positions are
  written to element styles through refs.
- At most 24 ghost elements.
- The loop pauses when `document.hidden`.
- Asset budget: 1.5 MB or less in total.

**Reduced motion.** `prefers-reduced-motion: reduce`, or an in-app toggle in Settings,
turns off wandering, travel tweens and particles. Ghosts appear directly at their
location slots and state changes become instant swaps.

**Tests.** See the technical design §11: pure view-model tables, scheduler tests with
fake timers, an "intents never call paid APIs" test, overlay integration with mocked
APIs, and a Playwright walkthrough against the mock-OpenAI isolated stack (the 6B
pattern).

---

## I. Visual design specification

- **Camera:** a raised frontal three-quarter view (oblique "storybook diorama"), as in
  M-World. It is not isometric:
  - buildings show their front faces and some roof;
  - paths recede toward the top center;
  - characters are drawn front-facing with 3/4 turns.
- **16:9 layout:** logical stage 640×360, scaled by an integer (×2 = 1280×720,
  ×3 = 1920×1080) and letterboxed. A fractional scale is allowed only between 1.5 and 2,
  using `image-rendering: pixelated`.
- **Composition (from M-World):**
  - Clock Tower upper left of center, Library upper right, Approval Altar at center
    behind the plaza;
  - Crypt at the left edge, Portal at the right edge, Upload Well lower left (from
    M-Card);
  - pond lower right, framing trees and wisteria top left and top right;
  - gravestones and the fence in the foreground at the bottom;
  - the right third must stay readable under the Action Card (M-Card), so key
    buildings sit in the left two-thirds or are still recognizable when partly covered.
- **Palette:** night indigo `#1b1433`, deep violet `#2a1f4d`, grass shadow `#3c3466`,
  stone `#6e6890` / `#9a93b8`, wisteria `#a77be0`, moonlight `#f3ecff`, lantern amber
  `#ffc764` / `#f59b3c`, candle `#ffe4a3`, portal magenta `#b04fe0`. Mapped to the
  existing UI tokens: `--sg-violet #9b6bf0`, `--sg-peach #ffb066`, `--sg-green #62d394`,
  `--sg-amber #f5b73d`, `--sg-text #f0e9fb`.
- **Tiles and sprites:** a 16 px grid. Lumi has a 32×40 frame. Ghosts have a 24×28
  frame. Badge bubbles are 16×16 with 12×12 icons. Building sizes are in the asset spec.
- **Proportions:**
  - Lumi is about 1.4× a ghost's height, wears a wizard hat and carries a lantern
    (M-World, M-Card);
  - ghosts are chubby, two-tone and wide-eyed, and carry a card icon (M-World);
  - buildings are 4 to 7× Lumi's height.
- **Animation principles:** sprite animation at 8 to 10 fps on whole logical pixels.
  Movement is interpolated but snapped to integer logical pixels. Idle loops have small
  amplitude. No animation lasts over 1.5 s unless it is ambient.
- **Lighting:** baked into the sprites:
  - warm lantern and candle pools;
  - cool moonlight rim light;
  - additive glow sprites (soft-edged, but on the pixel grid) for the well, portal,
    altar and selected ghost.
- **Typography:**
  - world signs are baked into the building sprites ("Calendar", "Notes", "Crypt",
    "Portal", per M-Card), with an accessible DOM label for each;
  - overlays use the existing `--sg-font-ui` (Inter) and `--sg-font-display` (Cormorant
    Garamond);
  - no pixel font for long text.
- **Pixel UI versus readable UI:**
  - pixel style for frames, icons, the HUD buttons and the scene;
  - modern React UI for the disclosure, Epitaph, draft fields, editors, errors and the
    approval dialog.
- **Responsive:**
  - ≥1280 px wide: ×2, Action Card docked right at 380 px;
  - 960–1279 px: ×1.5, the card overlays;
  - <960 px or portrait: the scene shrinks above the Quick Queue, and a banner suggests
    the Visual Workspace;
  - <600 px: the list view first, scene optional.
- **Accessibility:**
  - contrast of 4.5:1 or more for all overlay text;
  - status is never shown by color alone (an icon plus a text label);
  - focus rings on ghost buttons;
  - reduced motion as above;
  - all actions reachable from the keyboard without Lumi.
- **Concept art versus production:** the mockups are flattened 1672×941 renders with
  soft lighting. Production needs separate layered PNGs, sprite sheets and an
  arrangement on the 16 px grid. The mockups must not be used as a background.

---

## J. Interaction and animation contracts

| Interaction | Trigger | Preconditions | API call | Loading | Success | Failure | Animation | Skippable | Paid AI? |
|---|---|---|---|---|---|---|---|---|---|
| Upload | Toolbar, well click or drop | Gallery ready, no upload in flight | `POST /api/screenshots` | "Uploading…" toast; well bubbles | Per-file results; refresh the list | Per-file errors | Ghost rises from the well (600 ms) | Yes | No |
| Inspect | Click a ghost, Enter on a ghost button, E near Lumi | none | Reads (b) and the overlay's own reads | Card skeleton | Card shows state | Card read error + Check again | Lumi lantern raise (300 ms) | Yes | No |
| Consent | Allow in `RevivePanel` | Disclosure loaded and matching the provider | `POST /api/screenshots/{id}/consent` | Button busy | "?" becomes a spark | Existing messages | Spark (300 ms) after the 200 | Yes | No |
| AI analysis | Consent granted with automation on, or Continue / Revive | Consent, active screenshot | `POST …/auto-process` (or `POST …/classify` when automation is off) | `AutoPilot` stages | Saved analysis | `analysis_failed` / unknown | Ghost over the well (loops while (b) says analyzing) | Yes | **Yes: one call, server-deduplicated** |
| Auto-routing | Server pipeline | Saved analysis, automation on | none (server) | n/a | (b) shows `preparing` or another stage | n/a | Crossroads glint (may be skipped) | Yes | No |
| Draft preparation | Server pipeline, or an explicit Prepare | Route `auto` or a user choice | `POST …/preparations` (explicit) / none (automatic) | Building active state | `ready_for_review` | `preparation_failed` | Ghost enters the building | Yes | **Yes: one call** |
| Edit | Save in the draft editor | Draft loaded | `POST /api/event-drafts/{id}/edits` / `POST /api/study-notes/{id}/edits` | Saving | "Saved as version N" | Conflict / unknown (existing) | none | n/a | No |
| Approve | Confirm in the `ApprovalSection` dialog | Eligible version, acknowledgements given | `POST /api/artifacts/{id}/approvals` | Dialog busy | 201, then (c) shows `current_approved` | Ineligible / conflict | Lumi stamp (700 ms), check badge | Yes | No |
| Bury | Card footer | Active, no lifecycle in flight or unknown | `POST …/archive` | "Burying…" | Confirmed state | Failed / unknown, then reconcile | Float into the Crypt (800 ms) after confirmation | Yes | No |
| Resurrect | Crypt overlay | Archived | `POST …/restore` | "Resurrecting…" | Confirmed | Integrity failure / unknown | Rise from the Crypt | Yes | No |
| Redo | Existing Redo controls in the card's saved result / drafts | Saved analysis or note | `POST …/analysis/redo`, `POST /api/study-notes/{id}/redo` | Existing | New version | Existing | none | n/a | **Yes (explicit)** |
| Connect app | "Connect Google Calendar" in the Portal panel | Delivery enabled on the server | Phase D OAuth start (a redirect) | "Waiting for Google…" | Server-verified binding, so the Portal moves to "Ready for delivery" | Denied or expired: back to "Connection required" | Key rune lights after the server confirms | Yes | No AI. An account binding |
| Deliver | "Send version N to Google Calendar" | Connected; that version is approved (ledger); not already delivered | Phase D delivery POST (idempotency key = artifact + version + destination) | "Sending…" | `successful` with a verified external id | `failed` / unknown, then reconcile; never a blind resend | Card flies into the portal while pending; the burst only after the verified success read | Yes | No AI. **A real external write**, never automatic |

Invariant: no animation start, end or interruption calls an API. Delivery is sent only
from its explicit "Send" button. The only paid calls are
the six existing explicit POSTs (classify, auto-process, preparations, analysis redo,
study-note generate and redo), and the world sends them only from overlay click handlers
that already exist.

---

## K. Security and truthfulness

| Requirement | How it holds | Existing guarantee it relies on |
|---|---|---|
| Per-screenshot consent | The world only hosts `RevivePanel`; there is no "consent all" | Provider- and disclosure-bound consent; the server re-checks at dispatch (`AIDispatchService.authorize`) and on persistence |
| No AI from movement | The scene has no API imports (lint rule). Intents are select, open and move only. Test: a movement or inspect sweep records zero POSTs | Server idempotency: the keyed classify and prepare operations reuse (6B F3) |
| No automatic external delivery | Delivery needs a connected account, an approved version and an explicit Send per version. Approval never sends; the Portal never sends on arrival or animation | Approval never delivers (5B); Phase D enforces INV-8/INV-9 |
| No misleading completion | Location and badge change only after a server read. The approval stamp waits for a 201 plus the (c) read. "Delivered" is rendered only for a delivery operation the server reports `successful` with a verified external id | Approval ledger; `trigger` provenance (6B F5); INV-8 |
| Delivery account binding | OAuth tokens are stored server-side only, encrypted, bound to one workspace, revocable ("Disconnect"). The frontend never sees a token | New in Phase D; follows the existing secret handling (server environment, log redaction) |
| Workspace isolation | Same-origin cookie; the client never sends a workspace id | `WorkspaceMiddleware`; 404 for foreign ids |
| Untrusted screenshot content | The scene never renders screenshot text except as React-escaped text in overlays. Ghost labels use the filename and stage only | Router instruction tripwire, closed action set (6B P1-A) |
| No API keys in the frontend | Unchanged: keys exist only in the server environment | README key handling, log redaction (6A) |
| Accurate errors and unknowns | Reuse the `AutoPilot` and lifecycle copy, view states `unknown` and `stale` (§F 16–17) | Bounded fetch, keyed operations, no automatic retries |
| Approval and version binding | Approval only through `ApprovalSection` with `versionId` | Ledger SHA-256 binding; a superseded automatic result is never saved (6B P1-C) |
| Accessibility and reduced motion | §D, §H, §I | n/a |

### K-2. Public provider, spending and abuse protection (decision D2)

The public deployment uses real OpenAI Vision. The key lives only in the server
environment (unchanged 6A handling); it is never in the frontend, the repo or logs.

| Layer | Existing (confirmed) | Required for public launch |
|---|---|---|
| Rate limiting | Two token buckets on every `/api/*` request (per IP and per workspace), 60 burst / 1 per s (`backend/app/middleware/limits.py`) | Keep; tune via `RATE_LIMIT_*` only after the D1 load test |
| Upload quotas | 15 MB per file, 20 files per batch, 500 screenshots per workspace (`backend/app/config.py`) | Lower the public value of `MAX_SCREENSHOTS_PER_WORKSPACE` (for example 30) |
| AI-call quota | `MAX_AI_CALLS_PER_WORKSPACE` (default 1000), counted per workspace | Lower the public value (for example 20). **Gap:** a visitor can mint new workspaces, so a per-workspace quota alone does not bound spending |
| Global daily AI request quota | none | **New, small backend change:** a global daily AI request quota (`MAX_AI_CALLS_PER_DAY`, a count of accepted AI operations, not a financial cap), checked under the same lock where operations are created. When it is reached, AI endpoints return a clear "AI limit reached for today" error and the UI offers Demo Mode. It needs a deliberately global counter, an explicit exception to the "every query is workspace-scoped" rule, documented as such |
| Per-request cost bound | Max output tokens per call, image byte caps, zero SDK retries, keyed idempotency (no duplicate paid calls) | Keep |
| Provider-side backstop | Prepaid credits with auto-reload disabled (current account setup); a dedicated project key | Use a project-scoped key with a monthly hard limit in the provider dashboard |
| Workspace minting abuse | Per-IP limit runs before minting | Keep; monitor |
| Demo Mode | `?demo=1` (`frontend/src/demo/DemoApp.tsx`) labels its content "Demo AI mode", "Demo data", "Demo only, nothing is generated by AI" | Link it from the budget-reached and provider-unavailable messages. Never mix demo fixtures into the real workspace or the world's ghosts |

The world sends no image bytes to the AI by itself. The screenshot thumbnail appears
only in the Action Card, through `GET /api/screenshots/{id}/image`, and never in the
scene.

---

## L. Hackathon MVP scope

Two coordinated workstreams ship for the hackathon: **W1 Pixel World** (this PRD) and
**W2 External delivery** (§M Phase D). W1 must not wait for W2. W1 renders W2's states
as soon as its read endpoints exist.

**Must-have (W1, Pixel World)**
1. One original pixel-world main scene (layered assets, not a flattened mockup).
2. Lumi keyboard and pointer movement, idle and turning, plus inspect (playability
   criteria in §N-2).
3. A ghost per real screenshot (24 or fewer rendered, the rest in crowds), states from
   §F rows 1–18, with natural wandering.
4. Upload through the well or toolbar, using the existing pipeline.
5. Correct state locations and badges through the centralized, bounded status scheduler.
6. Action Card hosting `RevivePanel`, `AutoPilot`, `CalendarDraft` and `MakeNotesDraft`
   (review, edit, approve).
7. Crypt overlay with Burial and Resurrection.
8. Quick Queue (the accessible primary path).
9. Settings: the automation toggle, the provider badge and a "List view" link.
10. A Portal that renders its true state (at minimum "Not connected") with honest copy.
11. Reduced motion, keyboard access, and the Visual Workspace fallback.

**Must-have (W2, delivery; hackathon target)**
1. Google Calendar: OAuth account binding per workspace, delivery of an approved
   calendar draft version, verified evidence (the returned event id), idempotent retry
   and reconciliation of uncertain outcomes (INV-8/INV-9).
2. The six Portal states (§B-15) wired to real reads.

**Second priority (W2)**
- Notion delivery of an approved notes draft. It starts only if Google Calendar
  delivery passes its acceptance criteria and Notion OAuth, account binding and
  deployment are feasible in time.

**Must-have (public launch, Phase 0)**
- The spending and abuse protections in §K-2, including the global daily AI request quota. Provider-side financial limits (monthly project budget, prepaid credits with auto-reload off) are a separate launch requirement that the app cannot enforce.

**Nice-to-have**
- richer wandering and idle emotes;
- an elaborate stamp animation with particles;
- moon and fog parallax, fireflies;
- Lumi expressions;
- the cat easter egg;
- sound (off by default).

**Post-hackathon**
- multiple rooms;
- RPG mechanics;
- NPC dialogue;
- customization;
- inventory;
- large maps;
- additional delivery destinations beyond Google Calendar and Notion.

**Spec amendment recorded (AMD-1).** The earlier specs named OneNote (Google Docs
fallback) as the single P1 destination and forbade multiple integrations. AMD-1 amends
`requirements.md` (assumption A6, the glossary, Requirements 16.3, 17.2, 17.6, 17.9), the
task list (4.9), the design note on `Delivery_Service` and `.kiro/steering/product.md`. It
adds **Requirement 25** (`prd-v2-additions.md`): Google Calendar primary, Notion
conditional, explicit approval and Send for every write, OAuth with PKCE and workspace
binding, idempotency and receipts. INV-8/INV-9 are unchanged.

---

## M. Implementation phases

Complexity: S (≤ 0.5 day), M (1 day), L (2 days). Dates assume the baseline of Nov 26.

| Phase | Deliverables | Code areas | Depends on | Acceptance | Main risks | Size |
|---|---|---|---|---|---|---|
| **0 Deployment track (parallel, starts now)** | The existing Visual Workspace publicly deployed (same-origin FastAPI + dist, PostgreSQL, persistent volume) with real OpenAI Vision and the §K-2 protections (lowered quotas, global daily AI request quota, and separately a provider-side financial limit), plus Demo Mode linked | Deployment config; `backend/app/config.py` values; a small global request-quota check in operation creation (new) | Hosting account; OpenAI project key | A public URL passes the 6B walkthrough with mocked AI first, then one minimal live check; the request quota returns the `ai_budget_reached` error in a test | Persistent storage and Postgres setup; spending | M |
| **1 Assets + scene skeleton** | Minimum asset set (asset spec §8); `world/` folder; `SceneViewport`; static layers; integer scaling | `frontend/src/world/**`, `App.tsx` (`view=world`) | Mockups copied into `docs/design/pixel-world/` | The scene renders at ×2 and ×3 crisp; Lighthouse accessibility ≥ 90 for the HUD | Art throughput; style drift | L |
| **2 Playable prototype (fixtures)** | Lumi movement, collision rectangles, inspect, ghosts from fixture `GhostView`s, reduced motion | `world/scene/**`, `world/lumi/**` | Phase 1 | No API imports in the scene (lint); keyboard and pointer pass; 60 fps with 24 ghosts | Focus conflicts | M |
| **3 Real data + state mapping** | Refactor `useGallery` / `useLifecycle` out of `LiveWorkspace` (no behavior change); the centralized `useWorldStatus` scheduler; `deriveGhostView`; Quick Queue; **the D1 load measurement** (technical design §9) | `shell/LiveWorkspace.tsx` (refactor), `world/data/**` | Phase 2 | Existing frontend suite unchanged (654); §N 1–3, 9–11, 15. B1 is added only if §N-15 fails | Refactor regressions; rate limit | L |
| **4 Overlays: Action Card, Drafts, Crypt, approval** | Card hosting existing components; altar and crypt animations gated on server reads | `world/overlays/**` | Phase 3 | §N 4–8, 12 | Duplicate polling between `AutoPilot` and the scheduler | M |
| **5 Accessibility, performance, fallback, polish** | Error boundary, responsive breakpoints, reduced-motion audit, nice-to-haves if time | `world/**` | Phase 4 | §N all; axe clean; Playwright mock-stack walkthrough | Time | M |
| **6 Production switch + submission** | Deploy the world build; switch the default view only once §N (including §N-2) passes; demo video | Deployment | Phases 0 and 5 | Public URL; judges' path works in both views | Late regressions; keep the Visual Workspace default if any §N fails | S |
| **D Delivery workstream (W2, parallel from Phase 1)** | D0 spec amendment (§L; done as AMD-1). D1 Google OAuth app and per-workspace account binding (server-side encrypted tokens, Disconnect). D2 Delivery_Service: `operation` kind "delivery", idempotency key, verified evidence (event id), reconciliation of unknown outcomes. D3 read endpoints for the connection state and delivery state per artifact version, plus one explicit send POST. D4 Notion (conditional) | `backend/app/services/` (new delivery service), new router, a migration for the account binding (and, if needed, the delivery record); the frontend Portal panel | Public HTTPS deployment (OAuth redirect URI); Google Cloud project and consent screen; the spec amendment | INV-8/INV-9 tests (Requirement 14.6); a fake-provider contract test; one manual live delivery to a test calendar; Portal states §B-15 shown from real reads | OAuth verification and consent-screen review time; token security; deployment timing | L (Google Calendar); M (Notion) |

Rule: Phase 0 and Phase D do not wait for the world. If the world's acceptance (§N) has
not passed when the submission is prepared, the submission uses the Visual Workspace as
the default, with the world behind `?view=world` as a preview. There is no forced date
for the switch.

---

## N. Acceptance criteria

1. **Given** a workspace with N active screenshots, **when** the world loads, **then**
   exactly N ghost identities exist (individual ghosts plus crowd counts), each with a
   distinct `screenshotId`, and none for archived screenshots.
2. **Given** a screenshot whose (b) stage changes from `analyzing` to `preparing` to
   `ready_for_review`, **when** each read arrives, **then** the ghost's location moves
   from Well to Clock Tower (or Library) to Altar queue, and its label matches §F.
3. **Given** a completed draft, **when** the page reloads at any point, **then** the
   ghost reappears at the Altar queue with the same badge. Nothing completed is lost,
   and no stage appears that the server does not report.
4. **Given** a selected ghost, **when** the Action Card opens, **then** the header shows
   that ghost's `screenshotId` and filename, the preview is `imageUrl(id)`, and all
   panels are mounted with that same screenshot.
5. **Given** a calendar draft, **when** shown in the card, **then** its artifact comes
   from `GET /api/screenshots/{id}/preparations/add_calendar` for that id.
6. **Given** a notes draft, **when** shown, **then** its artifact comes from
   `.../preparations/make_notes` for that id.
7. **Given** version 2 is approved, **when** version 3 is saved, **then** the ghost shows
   "Earlier version approved", the ledger keeps version 2, and the stamp animation does
   not replay.
8. **Given** Bury on ghost A, **when** the server confirms, **then** only A moves into
   the Crypt. An unknown outcome leaves A in place with "Checking…".
9. **Given** the scene is focused, **when** Lumi moves and inspects for 60 seconds,
   **then** the mocked API records zero calls to any of the six paid endpoints.
10. **Given** animations play, restart and are interrupted (and the reduced-motion
    toggle is flipped), **then** no extra POST is issued. Rerenders issue no POST
    (verified with React StrictMode).
11. **Given** no delivery operation exists for a draft version, **then** "Delivered"
    and "Delivering" are never rendered for it. **Given** the server has no delivery
    capability, **then** the Portal shows "Not connected". **Given** a delivery operation
    is `successful`, **then** "Delivered" is shown only if the read includes the verified
    external id. **Given** an unknown outcome, **then** the UI says "Checking delivery…"
    and offers only a status check (no resend).
12. **Given** a keyboard-only user, **when** using Tab, Enter, the toolbar and Quick
    Queue, **then** they can upload, allow, review, edit, approve, bury and resurrect
    without the movement keys.
13. **Given** `/` (default), **then** the Visual Workspace behaves as before (its tests
    pass unchanged).
14. **Given** the backend suite (1386 at baseline, plus any added) and the frontend
    suite (654 at baseline, plus world tests), **then** all pass, including the
    6A/6B regressions.
15. **Given** the D1 measurement scenario (technical design §9: 10 and 25 active
    screenshots, 5 in progress, the Action Card open half the time, a 5-minute session at
    the default 60 burst / 1 per s limits), **then** world status reads stay at or below
    1 request per 1.5 s sustained, there are zero 429 responses, and every in-progress
    ghost is refreshed at least every 10 s. If any of these fails, B1 is implemented.

### N-2. Playability acceptance ("genuine game feel")

Assessed in a recorded session at ×2 and ×3 by the developer plus one independent
reviewer, against M-World and M-Card. Every item must pass before the world can become
the default (D4).

16. **Movement response:** **given** the scene is focused, **when** a movement key is
    pressed, **then** Lumi starts moving within one frame (≤ 17 ms of input), reaches
    full speed within 100 ms, and stops within 100 ms of release, with no overshoot
    through collision rectangles. Pointer clicks on the ground move Lumi to the point.
17. **Facing and idle:** **given** Lumi moves left, right, up or down, **then** the
    matching facing frames play, and the sprite flips without a visible jump. **When**
    idle for 2 s, **then** the idle bob and lantern flicker play, and Lumi turns toward
    the selected ghost.
18. **Natural ghost wandering:** **given** settled ghosts, **when** observed for 30 s,
    **then** each moves at least once inside its wander radius, at a varied pace (2 to
    5 s pauses, eased starts and stops). No two ghosts at one location move in sync.
    Ghosts never overlap their badges.
19. **Spatial depth:** **given** Lumi or a ghost walks behind or in front of a building,
    prop or another ghost, **then** draw order follows the feet's y-position
    (y-sorting). Lumi passes behind the altar and in front of foreground gravestones.
20. **Building interaction:** **given** Lumi is within the proximity radius of a
    building, **then** an "E" hint appears within 100 ms. Pressing E plays the inspect
    animation and opens the same overlay a click would. Buildings show their active
    state while relevant work runs (clock spin, pages, well swirl).
21. **Visual fidelity:** **given** side-by-side screenshots with M-World at the same
    aspect ratio, **then** composition (building placement), palette (§I), camera angle,
    character proportions and lighting mood are judged consistent by the reviewer.
    There is no blurry scaling, and pixels stay crisp at ×2 and ×3.
22. **State synchronization:** **given** a backend state change (mock-OpenAI stack),
    **then** the affected ghost starts moving to its new location within 2 s of the
    scheduler read that reports it, and reaches it within 3 s. No ghost moves without a
    corresponding read.
23. **Direct controls:** **given** a user who never moves Lumi, **then** all core tasks
    (§N-12) complete with the same number of clicks as in the Visual Workspace, or fewer.
24. **Game feel, not decoration:** **given** a 3-minute free-play session, **then** the
    reviewer confirms Lumi feels controllable (input is responsive, movement has weight
    and easing), the world reacts to Lumi (proximity hints, ghosts turning toward a
    nearby Lumi, an inspect emote), and at least one state change is visibly animated end
    to end. A static scene with clickable hotspots does not pass.

---

## O. Risks and open decisions

| Risk | Concrete mitigation |
|---|---|
| Asset consistency (several art sources, style drift) | One palette file (asset spec §2). A single artist or pipeline per asset class. A side-by-side check with M-World at ×1 before Phase 2 ends. The minimum asset set first |
| Pixel scaling blur | Integer scaling and `image-rendering: pixelated`; positions snapped to whole logical pixels; no CSS `scale()` on sprites, only on the stage |
| Engine dependency | None (DOM/CSS). Canvas only if profiling exceeds 8 ms/frame at 24 ghosts |
| State synchronization and the rate limit | Centralized scheduler: 1 read per 1.5 s, in-progress ghosts first, pausing while the tab is hidden and for the card's own `AutoPilot` screenshot. Decision D1: measure first (§N-15); add B1 `GET /api/auto-process?ids=` (read-only, 50 ids or fewer; about half a day) only if the measurement fails |
| Accessibility | Ghosts as buttons; Quick Queue first-class; axe in CI tests; reduced motion |
| Performance with many screenshots | Cap of 24 plus crowds; transform-only rendering; rAF paused when hidden; lazy route |
| Integration complexity (`LiveWorkspace` is 767 lines) | Refactor only `useGallery` and `useLifecycle`, with the existing 650+ tests as a safety net; host the other components unchanged |
| Hackathon deadline | Phase 0 and Phase D run in parallel with the world. The default-view switch happens only when §N passes (D4); otherwise the world ships as a preview behind `?view=world` and the Visual Workspace stays the default |
| External delivery (W2) | Start the spec amendment and the Google Cloud project on day 1 of Phase D. Use OAuth test users for judging if verification is slow. Build against a fake delivery provider first (contract tests for INV-8/INV-9), then one live test calendar. Notion only after Google Calendar passes |
| AI spending on a public app | Global daily AI request quota (new), lowered per-workspace quotas, a provider-side financial limit (separate launch requirement), keyed idempotency, zero retries; Demo Mode when the quota is reached |
| Production deployment | Phase 0 now: Postgres plus a persistent volume (`.kiro/steering/architecture.md`), `COOKIE_SECURE=1`, `TRUSTED_ORIGINS`, the OpenAI key only in the server environment, and the §K-2 protections before the URL is shared |
| Asset provenance and licensing | Decision D3: original AI-assisted art with human refinement, recorded in the asset manifest (`frontend/src/world/assets/manifest.json`); Kiroween rules checked before release |

## Decision log (product decisions, approved)

- **D1, batch status endpoint: approved conditionally.** Build the centralized frontend
  scheduler first and measure it against the existing rate limiter (§N-15; technical
  design §9). Implement the small read-only batch endpoint only if the measurement fails.
  No per-ghost uncontrolled polling.
- **D2, public AI provider: real OpenAI Vision**, with the clearly labeled Demo Mode
  fallback and the §K-2 protections. The API key is never exposed. Demo data is never
  presented as real inference.
- **D3, asset sourcing: original AI-assisted pixel art, with human selection and
  refinement.** The mockups are references only. A manifest records each asset's origin,
  license, intended use and production readiness (asset spec §6). The Kiroween rules on
  AI-generated assets are checked before final release.
- **D4, default view: acceptance-gated.** The world becomes the default only after §N,
  including §N-2, passes. There is no date-based switch, and the Visual Workspace remains
  as a fallback.
- **Delivery scope correction:** Google Calendar delivery is a hackathon target;
  Notion is second priority under the stated conditions. Both are workstream W2, in
  parallel with the world. The Portal shows six real states, with no fake success.

**Remaining open decisions:**
- **T1:** the hosting platform and its OAuth redirect domain (blocks Phase D's Google
  consent-screen setup).
- **T2:** Google OAuth scope. The narrowest workable scope (`calendar.events`) needs a
  verified consent screen or a test-user list. For judging, decide between test users
  and verification.
- **T3:** the account-binding storage design: a token encryption key in the server
  environment; Disconnect and token revocation behavior.
- **T4:** the public quota values (screenshots and AI calls per workspace, the global
  daily AI request quota).
- **T5:** whether the delivery record reuses `operation` plus the existing
  `idempotency_key` alone, or adds a small delivery table for the external id and
  evidence (decided in Phase D2 design).
