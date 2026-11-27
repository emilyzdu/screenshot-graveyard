# Pixel World: Technical Integration Design

Planning document for [`pixel-world-prd.md`](pixel-world-prd.md). Baseline commit
`beab558`. Nothing here is implemented. Revised for decisions D1–D4 and the delivery
workstream (W2).

## 1. Current frontend component map (confirmed)

| Area | File | Notes |
|---|---|---|
| Entry | `frontend/src/main.tsx`, `frontend/src/App.tsx` | No router library. `?demo=1` → lazy `demo/DemoApp`; `?view=classic` → `Graveyard`; default → `shell/LiveWorkspace` |
| Visual Workspace | `shell/LiveWorkspace.tsx` (767 lines) | Owns the gallery list and ticket sequencing, upload, archive/restore with reconcile, drawer, selection, choices, automation, auto states |
| Gallery and cards | `shell/Workspace.tsx` | `UploadDropZone`, `ScreenshotGallery`, `ScreenshotCard`, `WorkspaceHeading` |
| Drawer | `shell/DetailDrawer.tsx` | `Drawer` (focus handling) |
| Consent, Revive, result | `shell/RevivePanel.tsx` | Props include `autoMode` and `onConsentGranted` (6B) |
| Auto flow | `shell/AutoPilot.tsx`, `shell/AutomationToggle.tsx`, `shell/useAutomation.ts` | `AutoPilot` props: `screenshot`, `providerMode`, `startSignal`, `onState`, `onSettled`, `onReview` |
| Assistant | `shell/LiveAssistant.tsx` | Hosts `MakeNotesDraft` and `CalendarDraft` |
| Drafts | `shell/CalendarDraft.tsx`, `shell/MakeNotesDraft.tsx`, `EventDraftEditor.tsx`, `NotesDraftEditor.tsx`, `DraftReviewParts.tsx`, `draftHistory.ts`, `usePreparation.ts` | Self-contained per screenshot (props: `screenshot`, `providerMode`, `canStart`, `readOnly?`, `onPresence?`) |
| Approval | `shell/ApprovalSection.tsx`, `approvalAttempts.ts` | No "approval confirmed" callback today |
| Archived drafts | `shell/ArchivedDrafts.tsx` | Read-only drafts for archived screenshots |
| Next step vocabulary | `shell/nextAction.ts` | `LIVE_ACTIONS`, `epitaphProvenanceLabel` |
| Analysis authority | `shell/sharedAnalysis.ts`, `useValidatedAnalysis.ts` | Newest-read-wins analysis cache |
| AI hooks | `ai/useDisclosure.ts`, `ai/useConsent.ts`, `ai/PrivacyNotice.tsx` (`useProviderStatus`), `ai/reviveCoordinator.ts` | Shared registries |
| API | `api/client.ts` (screenshots, lifecycle), `api/ai.ts` (all AI, drafts, approval, auto), `api/boundedFetch.ts` (`boundedFetch`, `withDeadline`) | |
| UI kit | `ui/primitives.tsx`, `ui/Ghost.tsx` (SVG ghost), `ui/Icon.tsx`, `ui/theme.css`, `ui/components.css` | |
| Assets | `frontend/public/vite.svg` only | No raster art yet |
| State management | React state plus custom hooks; no Redux or React Query | Polling: `ai/useOperationPolling.ts` (1 s, 60 polls), `AutoPilot` (1 s, 120 polls) |
| Tests | Vitest + RTL (38 files, 654 tests); Playwright scripts outside the repo (`/tmp/sg5/pw`) | |
| Build | `npm run build` = `tsc -b && vite build` → `frontend/dist`, served by FastAPI `_mount_spa` at the same origin | |

## 2. Backend API inventory (confirmed, `backend/app/main.py` and `backend/app/routers/*`)

| Method | Path | Use in the world | Paid AI |
|---|---|---|---|
| GET | `/api/health` | none | – |
| GET | `/api/workspace` | Mint or resolve the workspace (first call) | – |
| GET | `/api/ai/provider-mode` | Provider badge | – |
| GET | `/api/ai/disclosure` | Consent (through `RevivePanel`) | – |
| GET / POST | `/api/workspace/automation` | Settings | – |
| GET | `/api/screenshots` | Ghost identities | – |
| POST | `/api/screenshots` | Upload | – |
| GET | `/api/screenshots/{id}/image` | Card preview only | – |
| POST | `/api/screenshots/{id}/archive` / `restore` | Crypt | – |
| GET / POST | `/api/screenshots/{id}/consent` | Consent | – |
| POST | `/api/screenshots/{id}/classify` | Revive (automation off) | **yes** |
| GET / POST | `/api/screenshots/{id}/auto-process` | Ghost state / continue automatically | POST **yes** |
| GET | `/api/screenshots/{id}/analysis` | Card result | – |
| POST | `/api/screenshots/{id}/analysis/edits` | Category / Epitaph edit | – |
| POST | `/api/screenshots/{id}/analysis/redo` | Explicit Redo | **yes** |
| GET / POST | `/api/screenshots/{id}/preparations[/{action}]` | Drafts | POST **yes** |
| GET | `/api/event-drafts/{aid}`, `/versions`; POST `/edits` | Calendar draft | – |
| GET | `/api/study-notes`, `/{aid}`, `/versions`, `/sources`, `/export`; POST `/edits` | Notes draft | – |
| POST | `/api/study-notes`, `/api/study-notes/{aid}/redo` | Multi-screenshot notes (classic) | **yes** |
| POST | `/api/study-notes/selection` | Selection validation | – |
| GET | `/api/artifacts/{aid}/approval`; POST `/approvals` | Approval | – |
| GET | `/api/artifacts/{aid}/compare` | Version compare | – |
| GET / POST | `/api/operations[/{id}]` | Operation polling | – |

**Not present today:** any delivery, OAuth, Google or Notion endpoint; any batch
status endpoint; any event stream (SSE or WebSocket); a global (cross-workspace) AI request
quota at the time of writing (since added by the deployment foundation, §10.6). Delivery endpoints are planned in Phase D (§13); they are proposals, not
existing contracts.

**Rate limits** (`backend/app/middleware/limits.py`): every `/api/*` request, GETs
included, passes through two token buckets, one per client IP and one per workspace.
Both default to capacity 60 and a refill of 1 per second (`RATE_LIMIT_CAPACITY`,
`RATE_LIMIT_REFILL_PER_SEC`).

## 3. Proposed component hierarchy

```
App.tsx ── view=world ──► lazy(PixelWorld)
PixelWorld                         world/PixelWorld.tsx (error boundary + preload)
└─ WorldDataProvider               world/data/WorldDataProvider.tsx
   │  useGallery()                 ← extracted from LiveWorkspace (refresh tickets, bounded reads)
   │  useLifecycle()               ← extracted from LiveWorkspace (runLifecycle/reconcile/judge)
   │  useAutomation(), useProviderStatus(), createAnalysisAuthority()
   │  useWorldStatus(ids)          ← NEW scheduler over getAutoProcess/getApprovalStatus
   │  ghosts = deriveGhostViews(...)  ← NEW pure functions
   ├─ SceneViewport                world/scene/SceneViewport.tsx   (no api/* imports)
   │  ├─ Background / Locations / Actors (GhostButton, CrowdMarker, Lumi) / Foreground
   │  └─ useSceneLoop()            one rAF; refs only; pauses when document.hidden
   ├─ Hud (LumiPortrait, Toolbar)  world/hud/*
   └─ Overlays                     world/overlays/*
      ActionCard  → RevivePanel + AutoPilot + CalendarDraft + MakeNotesDraft (as-is)
      QuickQueue, DraftsOverlay, CryptOverlay (ScreenshotGallery + ArchivedDrafts),
      SettingsOverlay (AutomationToggle), PortalInfo, Toasts
```

## 4. Data flow

```
GET /api/screenshots ─┐
GET …/auto-process ───┼─► useWorldStatus cache ─► deriveGhostViews() ─► Scene (props)
GET …/approval ───────┘          ▲                                       │ intents
                                 │ onState (AutoPilot), onSettled        ▼
Overlay actions (POST) ──────────┴──────── Overlays ◄── select(id) / open(location)
```

Writes happen only in overlays, through existing components. After a confirmed write,
the overlay calls `invalidate(id)`, which schedules a read. The scene never writes.

## 5. Screenshot ID → GhostView

```ts
interface GhostView {
  id: number;                 // screenshotId (stable identity)
  label: string;              // originalFilename || `Screenshot #${id}`
  viewState: ViewState;       // PRD §F derived states
  location: LocationId;       // 'well' | 'crossroads' | 'clock' | 'library' | 'altar' | 'altarRest' | 'lawn' | 'crypt'
  badge: 'calendar' | 'book' | 'image' | 'question' | 'lock' | null;
  status: 'consent' | 'choice' | 'progress' | 'approved' | 'failed' | 'unknown' | null;
  trigger: 'auto' | 'manual' | null;  // from preparation.trigger, never inferred
  priority: number;           // queue and render order
  tint: 0|1|2|3|4; accessory: 0|1|2|3; // hash(id)
}
```

## 6. Status → scene derivation (pure)

```
deriveViewState(shot, auto?, approval?, client):
  if shot.state === 'archived'                 → archived
  if client.lifecycleUnknown(id) or client.postUnknown(id) → unknown
  if !auto                                     → client.readFailed ? stale : loading
  switch auto.stage:
    awaiting_consent → needs_consent        not_started → ready_to_start
    analyzing → analyzing                    routing → routing
    preparing → preparing_<preparation.action>
    ready_for_review → approval?.status === 'current_approved' ? approved
                     : approval?.status === 'older_approved' ? approved_older : ready_for_review
    recommended → recommended   needs_choice → needs_choice   ready_to_prepare → ready_to_prepare
    reference → reference   analysis_failed → failed_analysis   preparation_failed → failed_preparation
    archived → archived
```

The location and badge are table lookups (PRD §F). Unit-test the whole table. Unknown
stage strings map to `stale`, never to success.

## 7. Reuse and refactor plan

1. **Refactor, no behavior change:**
   - extract `useGallery()` (`refreshGallery`, the `isCurrent` tickets, `applyConfirmed`,
     `bounded()`);
   - extract `useLifecycle()` (`runLifecycle`, `reconcile`, `judge`, `postLifecycle`,
     the uncertain registry) from `LiveWorkspace.tsx`;
   - `LiveWorkspace` keeps identical behavior. Gate: `LiveRevive`, `App`,
     `AnalysisAuthority`, `StaleClosure` and the full frontend suite pass unchanged.
2. **As-is in overlays:** `RevivePanel`, `AutoPilot`, `CalendarDraft`, `MakeNotesDraft`
   (which include `ApprovalSection` and the editors), `ArchivedDrafts`,
   `AutomationToggle`, `UploadDropZone`.
3. **Optional, small:** an `onApprovalConfirmed?(artifactId, versionId)` prop on
   `ApprovalSection`, threaded through the draft components. It saves one read. Without
   it, re-read (c) when the card reports `onPresence` or when it closes.
4. **New:** everything in `frontend/src/world/**`.

## 8. Route and overlay integration

- `App.tsx` gets `view=world` → `lazy(() => import('./world/PixelWorld'))`. The
  Visual Workspace stays the default.
- The toolbar "List view" link goes to `/`; the Visual Workspace gets a "World view"
  link (a small change).
- One active overlay at a time, in a `useState<Overlay | null>`. Escape closes it and
  focus returns to the opener (the same pattern as `Drawer`).
- The Action Card is keyed by `screenshotId` plus an epoch, the same as the 6B remount
  pattern (`autoEpochs`).

## 9. Browser lifecycle and polling

- **Initial load:**
  1. `GET /api/workspace`, then `GET /api/screenshots`;
  2. (b) reads for active screenshots, highest priority first, at most 8 in the
     initial burst;
  3. the rest at the scheduler rate;
  4. (c) reads only for ghosts whose (b) has `preparation.artifactId`.
- **Scheduler (`useWorldStatus`):**
  - one global queue and at most 1 request in flight;
  - minimum gap 1.5 s;
  - in-progress ghosts (`AUTO_IN_PROGRESS`) are polled first, at most 120 times each
    (same as `AutoPilot`), then they show `stale` with Check again;
  - settled ghosts are not polled;
  - a ghost is re-read after a confirmed write, or when its overlay reports
    `onSettled`.
- **Deduplication with `AutoPilot`:** while the Action Card is open for screenshot X,
  the scheduler skips X and takes its state from `AutoPilot.onState`. This avoids
  polling X twice.
- **Visibility:** on `visibilitychange` to hidden, pause the queue and the rAF loop. On
  visible, run one refresh of the list plus in-progress items.
- **Budget check:**
  - a sustained 0.67 read/s from the world, plus ≤1/s from `AutoPilot`, stays near the
    1/s refill only while a card is open;
  - so the scheduler halves its rate while a card is open (gap 3 s);
  - a 60-token burst covers the initial load for 50 or fewer active screenshots.
- **D1 measurement (decision: measure first, build B1 only if needed).** Run in
  Phase 3 against the isolated mock-OpenAI stack, at the default limits (60 burst,
  1 per s, per IP and per workspace). The browser test harness records every
  `/api/*` request with its timestamp and status.
  - Scenarios: (a) 10 active screenshots, 5 in progress; (b) 25 active, 5 in progress;
    (c) scenario (b) with the Action Card open for half of the 5-minute session; (d) a
    cold reload during (b).
  - Pass criteria (PRD §N-15): zero 429 responses; sustained world reads at or below 1
    per 1.5 s; every in-progress ghost refreshed at least every 10 s; settled ghosts not
    polled; the initial load completes within 60 tokens.
  - Fail means implementing B1. Tuning the scheduler rate is not a substitute if (b)
    cannot meet the 10 s freshness bound.
- **B1 (conditional, small and read-only):** `GET /api/auto-process?ids=1,2,…` (50 or
  fewer). It returns `{items: [state…]}` using `AutoProcessService.state()` per id in
  one session, with 404 semantics per item (omitted). It replaces N requests with one.
  There is no write and no AI. Built only if the D1 measurement fails.

## 10. No-duplicate-AI-call safeguards

1. Scene modules cannot import `api/*` (ESLint `no-restricted-imports` on
   `src/world/scene/**`, `src/world/lumi/**`, `src/world/hud/**`).
2. Paid POSTs exist only in existing components' click handlers. `AutoPilot` starts only
   on `startSignal` changes, a confirmed consent grant, or a button (6B tests).
3. Server-side backstops:
   - keyed classify, which reuses a running or successful compatible analysis and
     returns 409 `already_analyzed` when an analysis already stands;
   - keyed preparation reuse;
   - the in-process pipeline claim;
   - dispatch-time and persistence-time policy checks.
4. StrictMode double effects do not issue POSTs (mount effects only read; existing 6B
   tests).
5. Animations hold no callbacks into data code. Completion handlers only update visual
   refs.
6. **Request backstop (D2, public launch):** a global daily AI request quota check
   (`MAX_AI_CALLS_PER_DAY`; a request count, not a financial cap) is added
   where AI operations are created (`OperationService.create_pending` and
   `create_or_reuse_keyed`, under the existing workspace lock), alongside the existing
   per-workspace `ensure_ai_quota`. It needs a deliberately global count (a documented
   exception to the workspace-scoped repository rule). It returns a distinct
   `ai_budget_reached` error that the UI maps to "Try Demo Mode". Reused (deduplicated)
   operations do not count, exactly like the existing quota. Financial limits live
   only on the provider side (monthly project budget, prepaid credits with auto-reload
   off) and are a separate launch requirement.
7. **Delivery is never automatic:** the send POST exists only in the Portal panel and
   the Action Card's Send button. No approval, animation or Portal state change calls
   it.

## 11. Testing strategy

- **Unit:**
  - the `deriveViewState` and location/badge tables (every §F row and unknown stages);
  - `hash(id)` stability;
  - slot assignment determinism;
  - scheduler ordering, gap, caps and pause, with fake timers.
- **Component (RTL, mocked `api/ai` and `api/client`, as in `LiveAuto.test.tsx`):**
  - ghosts as labelled buttons;
  - selecting opens the card with the right id;
  - movement and inspect sweeps make zero paid calls;
  - the approval stamp only after `current_approved`;
  - no "Delivered" text;
  - reduced-motion swaps;
  - keyboard-only flows.
- **Regression:** the full existing frontend suite (654) and backend suite (1386) pass
  unchanged after the `useGallery` / `useLifecycle` refactor.
- **Playability (PRD §N-2):** a frame-timing harness (Playwright `page.clock` plus
  `requestAnimationFrame` timestamps) measures input-to-movement latency, stop distance,
  facing changes and y-sort order. Wandering desynchronization is checked by sampling
  ghost transforms for 30 s. Visual fidelity is a reviewer check against M-World and
  M-Card at ×2 and ×3.
- **Delivery (Phase D):** contract tests against a fake delivery provider for INV-8
  (no success without the external id) and INV-9 (an uncertain retry reconciles by
  idempotency key and never creates a second event), plus one manual live delivery to a
  test calendar.
- **E2E:** the Playwright walkthrough against the isolated mock-OpenAI stack (6B
  pattern: separate port, database and cookie name). Upload event, study and reference
  screenshots; check ghost locations and exactly 2 or 1 provider requests each; approve
  v2; Crypt round trip; zero requests to non-local origins.
- **Visual:** screenshot at ×2 and ×3 for manual comparison with M-World. No pixel-diff
  CI (it would be too brittle for the deadline).

## 12. Minimal migration path

1. Add `world/` behind `?view=world`. Leave the default untouched.
2. Refactor the two hooks out of `LiveWorkspace` (tests are the gate).
3. Make the world feature-complete per the PRD §L must-haves.
4. Add a cross-link between the two views.
5. Make the world the default only when PRD §N, including the §N-2 playability
   criteria, passes (decision D4). There is no date-based switch. The Visual Workspace
   stays reachable as the fallback ("List view") permanently.

The world itself needs no backend migration. B1 is conditional and additive. The
global daily AI request quota (§10.6) and Phase D delivery (§13) are separate backend changes with
their own reviews.

First implementation slice: [`pixel-world-milestone-1.md`](pixel-world-milestone-1.md).
Public launch checklist: [`deployment-readiness.md`](deployment-readiness.md).

## 13. Delivery workstream (W2) integration contract (proposed)

Status: **proposed**, to be finalized in Phase D design. The governing requirement is
Requirement 25 (`.kiro/specs/screenshot-graveyard/prd-v2-additions.md`, amendment
AMD-1). Nothing below exists. The world depends only on the read shapes, so W1 and W2 can
proceed in parallel against a fixture.

- **Backend building blocks (existing):**
  - the `operation` model with `kind` "delivery" (anticipated in `models.py`) and
    `idempotency_key` (reserved "for external writes");
  - the approval ledger (an approved version and its content SHA-256);
  - the workspace lock;
  - INV-8 and INV-9 in `requirements.md` Requirement 8.4/8.5.
- **New backend (Phase D):**
  - per-workspace account binding (encrypted OAuth tokens, server-side only);
  - a Delivery_Service;
  - a migration for the binding (and possibly a small delivery-evidence table; PRD
    open decision T5).
- **Proposed reads the world consumes:**
  - connection state per destination: `not_connected` (capability off) |
    `connection_required` | `connected`;
  - delivery state per artifact version: `none` | `pending` | `successful` (with the
    external id and link) | `failed` (with a reason) | `unknown`.
- **Proposed writes (explicit buttons only):** start OAuth (a redirect); send one
  approved version to one destination; disconnect.
- **Portal state derivation (world, pure):**
  - capability off → *Not connected*;
  - no binding → *Connection required*;
  - connected with an approved, undelivered version → *Ready for delivery*;
  - `pending` → *Delivering*;
  - `successful` with an external id → *Delivered*;
  - `failed` or `unknown` → *Failed / uncertain*.
  - `successful` without an external id is treated as *uncertain* (INV-8).
- **Polling:** delivery reads join the same centralized scheduler. A pending delivery
  counts as in-progress (same caps).
- **Fixture-first:** until Phase D3 lands, the world renders *Not connected* from a
  constant capability flag, which is the true state of the deployed backend.
