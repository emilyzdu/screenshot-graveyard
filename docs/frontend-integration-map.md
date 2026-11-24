# Visual UI redesign: component to backend map

The Gothic Workspace is the default. It uses the existing same-origin clients for workspace bootstrap, screenshot upload and listing, and owner-authorized previews. The Crypt is read-only in the new shell. The **Open classic workspace** link (`/?view=classic`) keeps consent, Revive, Epitaph editing, archive/restore, and Study Notes available with the same workspace cookie. FastAPI endpoints are unchanged.

The frontend-only **demo mode** (`/?demo=1` or `npm run dev:demo`) still uses synthetic fixtures and makes no backend requests.

Layers:
- `src/ui/`: design tokens, primitives (Button, Card, Badge, Checkbox, SelectField, MenuButton, Stepper), ghost and graveyard art, synthetic screenshot art.
- `src/shell/`: presentational components that take view models from `shell/types.ts`. No data access.
- `src/demo/`: `DemoApp` (state and interactions) and `fixtures.ts` (invented sample data, labeled "Demo data" / "Sample" in the UI).
- `src/shell/LiveWorkspace.tsx`: live entry point and mapping from server screenshots to shell view models.

| Component | Demo source | Real source to wire later |
|---|---|---|
| `UploadDropZone` | Local object URLs, never uploaded | Connected to `uploadScreenshots` (`POST /api/screenshots`); the server validates file bytes |
| `ScreenshotGallery` / `ScreenshotCard` | `DEMO_SHOTS` | Connected to `listScreenshots` and `imageUrl`; Workspace shows active screenshots and The Crypt shows archived screenshots |
| `FilterBar` | Client-side filter/sort | Client-side on `Screenshot` + `analysis.category`; no endpoint needed |
| Card suggestion label | `ShotVM.suggestedAction` fixture | `deriveSuggestions` (`assistant/suggestions.ts`), rules and AI-sourced, after consent |
| `SelectionBar` | Local selection | Existing selection state in `Graveyard.tsx` (`MAX_STUDY_NOTE_SELECTION` applies) |
| Detail `Drawer` | Fixture details | Authorized image and real metadata are connected; consent, analysis and edits still use the classic `ScreenshotDetail` |
| `AssistantPanel` suggestion, stepper | `buildArtifact` fixtures | `QuietAssistant` logic and `deriveSuggestions`; Prepare = `generateStudyNote` operation, Review = `getStudyNote` / versions, Approve = future export/write step |
| Assistant "Approve" | Always disabled | Not available: no external write endpoint exists. `studyNoteExportUrl` is the only export |
| Recent Activity | `DEMO_ACTIVITY` | Operation polling (`getOperation`, `ai/useOperationPolling.ts`) |
| Safe Burial / Resurrection, The Crypt | Local state | `archiveScreenshot`, `restoreScreenshot` |
| Creations | `DEMO_CREATIONS` | `listStudyNotes`, `getStudyNote` |
| Connections | Static "Not connected" / "Coming later" | None yet (OneNote/Calendar OAuth out of scope) |
| Header "Demo AI mode" | Constant | `getProviderMode`, `HealthStatus` |

## Remaining integration tasks
1. Add Safe Burial and restore in the live drawer using the classic lifecycle clients and server-confirmed state.
2. Move the existing consent and AI workflow UI into the live shell in a later batch.
3. **Safety blocker, unchanged:** the backend consent-dispatch race (see `docs/` proposal) must be fixed before real AI provider acceptance.
4. Approve step and external connections need backend work.
5. Header bell and account buttons are inert placeholders.

## Safe Burial / Resurrection: outcome limits of the current API

`POST /api/screenshots/{id}/archive` and `/restore` return no operation id, and there is no lifecycle status endpoint. The only evidence the client can get about a request it lost track of (timeout, dropped connection, 5xx, unreadable or mismatched body) is the screenshot's current `state` from `GET /api/screenshots`.

What the Gothic Workspace does with that:
- A matching, explicit reply is the only thing treated as success or failure. A 4xx, or a reply for the right screenshot with `status: failed`, is a definite failure. Anything else is **unresolved**.
- An unresolved action is never reported as failed and is never replayed. The screenshot's Safe Burial / Resurrection control stays blocked.
- "Check status" re-reads the list (bounded to 10 s). Only a read that is still authoritative (not superseded by a newer read or a confirmed change) and shows the expected state resolves it, as success.
- An unchanged state does **not** resolve it. The earlier request may still commit after the read, and the client cannot tell "failed" from "not finished yet". No wait period is treated as proof.
- Recovery: check again, or reload the page, which starts from the server's current state. Both actions are idempotent on the server today, so a late commit cannot corrupt data, but the UI does not rely on that.

Definitive resolution needs backend support: an idempotency key or operation id returned by (or sent with) the lifecycle POST plus a status read, or a state precondition on the transition. That is a separate backend task.

## Batch 3A: consent + Revive + classification (Gothic Live Workspace)

Component: `frontend/src/shell/RevivePanel.tsx`, rendered in the Gothic screenshot drawer. It reuses the existing clients in `api/ai.ts`, `ai/useConsent.ts`, `ai/pollOperation.ts`, `ai/reviveCoordinator.ts` and the copy in `ai/messages.ts`. No backend changes and no new endpoints.

| UI action | API method | Backend route | Response | Resulting UI state |
|---|---|---|---|---|
| Open drawer | `getProviderMode` (once per page) | `GET /api/ai/provider-mode` | `{mode: "fake"\|"openai"}` | Fake AI copy and badge; Revive offered only in `fake` mode |
| Open drawer | `getConsent` | `GET /api/screenshots/{id}/consent` | `{screenshotId, granted}` | "granted" / "not granted" / "could not be read" |
| Open drawer | `getAnalysis` | `GET /api/screenshots/{id}/analysis` | 200 analysis, or 404 | Result shown, or Revive offered |
| Allow AI processing | `setConsent(id, true)` | `POST /api/screenshots/{id}/consent` (CSRF) | `{granted: true}` | Revive enabled (fake mode, active screenshot, no analysis yet) |
| Decline / Withdraw | `setConsent(id, false)` | same | `{granted: false}` | Revive disabled; no classify request |
| Revive | `classifyScreenshot` | `POST /api/screenshots/{id}/classify` (CSRF) | 202 `{operationId, kind, status}` | "Revive is running on the server…" |
| (polling) | `getOperation` | `GET /api/operations/{opId}` | `pending\|successful\|failed\|uncertain` | Terminal message from `describeOperationOutcome` |
| (on `successful`) | `getAnalysis`, `listScreenshots` | as above | analysis; list with `analysis` summary | Result card labelled "Simulated result"; card status "Revived" |

Outcome rules:
- `classify` 4xx (403 `consent_required`, 404, 429) and 503 `service_unavailable`/`identity_unavailable` are returned before any operation is created, so they are treated as "not started" and Revive can be retried.
- Any other classify failure (network error, 15 s timeout, other 5xx, malformed 2xx body) is an **unknown** outcome. The screenshot is blocked from a second Revive (`markReviveOutcomeUnknown`). "Check status" resolves it only when `GET /analysis` shows a persisted result. There is no endpoint to look up an operation by screenshot, so an accepted-but-still-running operation whose id was lost cannot be found. The copy says reloading allows a retry that may start a second analysis.
- Poll timeouts or outages keep the operation id (unresolved). "Check status" and reopening the drawer resume polling the same id; nothing is resubmitted.
- Closing the drawer stops polling (the pending wait and in-flight read are aborted) and keeps the id. A classify POST in flight is not aborted (that would not cancel the server's work); its id is recorded for the next open.

Consent-dispatch race (task 7.1): still present. `classification_service.py` re-checks consent after reading the bytes and then calls the adapter with no lock or consent version, so a withdrawal committed between that check and the adapter call does not stop the call. Revive is therefore disabled in the UI whenever the server reports a real provider, and the UI copy says withdrawing cannot stop an analysis already started. This is a frontend guard only; the server would still accept classify in `openai` mode.

## Batch 3B: saved analysis on cards, Live Quiet Assistant, choose a next step

Components: `shell/LiveAssistant.tsx`, `shell/nextAction.ts` (rule + vocabulary), card fields in `shell/Workspace.tsx`, wiring in `shell/LiveWorkspace.tsx`. No backend changes and no new endpoints.

The backend has **no intent, suggestion, action-plan or draft contract**. Everything below is either a backend field shown as-is, or an explicit frontend rule labelled "rule-based".

| Backend field (source) | Frontend representation | Recommended user action |
|---|---|---|
| `analysis.category` (list summary and `GET /analysis` `classification.category`) | Card and assistant show the category verbatim | Only matching, validated detail authorizes the rule below |
| `analysis.uncertain` / `classification.uncertain` | "uncertain" on the card, "Marked uncertain" badge | Never suggests anything |
| `analysis.epitaph` / `epitaph.text` | Short Epitaph on the card (2-line clamp), full in the assistant | Display only |
| `epitaph.visibleFacts` | "Visible facts" in the assistant | Display only |
| `epitaph.inferredIntent` (nullable) | "Possible reason … (a guess, not a fact)" only when non-null | Display only; never used for suggestions |
| `classification.origin`, `epitaph.origin`, `analysis.epitaphOrigin` | Recognized origins are shown per field. Facts and inferred intent inherit an AI-version origin when written with that Epitaph. After a manual Epitaph edit their source is unavailable. | Display only |
| `classification.confidence` | Not shown on cards or in the assistant. Only shown in the 3A result panel for an explicitly AI-origin category with a confirmed OpenAI provider | Never used |
| `GET /api/ai/provider-mode` | Fake AI labels | Display only |

Category rule (`suggestFromCategory`, category only, never Epitaph text):

| Category | Suggested (rule-based) |
|---|---|
| Study/Knowledge | Make Notes |
| Shopping/Inspiration | Add to Wishlist |
| Memory/Entertainment | Save as Memory |
| Reference/Document | none ("does not point to one next step") |
| Unknown/Needs Review | none |
| Potentially Sensitive | none (with a caution) |
| any, when uncertain | none |

Cards and Assistant share the same eligibility for the single selected screenshot. While the detail is loading, unavailable, mismatched, or disagrees with the list, neither offers an automatic suggestion. The card keeps the fresher detail for display when the list is stale. Explicit choices remain separate.

Add to Calendar is never suggested (no category identifies an event); it can only be chosen.

Choice lifecycle (transient by design): the user accepts the suggestion ("Chosen by you … you accepted the suggestion") or picks "Something else" ("Chosen by you"). The choice lives in `LiveWorkspace` state keyed by screenshot id, is never sent to the server, survives drawer close/reopen, selection changes and Safe Burial/Resurrection, and is lost on reload. It ends at **Ready to prepare**; "Prepare draft" is disabled.

Requests: displaying cards sends nothing beyond the list and authorized image reads; selecting one analyzed screenshot sends one bounded `GET /api/screenshots/{id}/analysis` (aborted on change/unmount); choosing, overriding and clearing send nothing.

### Batch 4 handoff requirements
- **Prepare contract:** a backend endpoint that accepts `{screenshotId, action}` and creates a draft as an operation (202 + operationId, polled like classify), consent-gated and idempotent per (screenshot, action). Make Notes can likely reuse `POST /api/study-notes` (single-screenshot selection); Add to Calendar, Save as Memory and Add to Wishlist have no backend at all.
- **Persist the choice** server-side if it must survive reload, or keep it transient and say so (current behaviour).
- **Replace the disabled "Prepare draft"** with a real call, keep the "Chosen by you" vs "Suggested" distinction, and add Review → Approve → Deliver states with no external writes until explicit approval.
- **Multi-select** stays constrained to one screenshot until a batch contract exists.
- The consent-dispatch race (task 7.1) must be fixed before any real-provider Prepare.

## Batch 4A: Make Notes draft (Prepare → Persist → Reopen)

Reused unchanged: the `study_note` pipeline (`StudyNoteService.run_generation`: re-checks ownership and consent, reads bytes, ONE adapter call, strict validation, atomic artifact + version 1 + source reference + operation status), `GET /api/operations/{id}` polling, `GET /api/study-notes/{artifactId}` for reading, the per-workspace write lock, the AI quota and the stale-pending sweep. The draft IS a `study_note` artifact (own id, append-only versions with `origin`, source reference to the screenshot); it also appears in `GET /api/study-notes` and the classic workspace.

New, smallest extension (no migration, no new table; uses the existing unused `operation.idempotency_key` column):

| Route | Purpose | Responses |
|---|---|---|
| `POST /api/screenshots/{id}/preparations` body `{"action":"make_notes"}` (CSRF) | Explicitly start, or reuse, the Make Notes draft for one screenshot | 202 new (`reused:false`), 200 existing (`reused:true`), 403 `consent_required`, 404 missing/foreign, 409 `screenshot_archived` / `provider_not_permitted`, 422 any other body, 429 quota, 503 |
| `GET /api/screenshots/{id}/preparations/make_notes` | Latest preparation, for reopening after a reload | 200 `{operationId, status, artifactId, errorDetail, provider}`, 404 `no_preparation`, 404 missing/foreign |

Server rules (`services/preparation_service.py`, `routers/preparations.py`):
- Order: action → provider guard (`AI_PROVIDER` must be `fake`) → ownership (workspace-scoped, foreign = 404) → active (archived = 409) → under the workspace lock: reuse, or consent → quota → create.
- Idempotency key `prepare:make_notes:screenshot:{id}:provider:{provider}`; the newest operation with prefix `prepare:make_notes:screenshot:{id}:` is reused while it is `pending` or produced an artifact. Only a failure without a draft allows a new attempt. Find-then-create runs under the lock, so concurrent requests create one operation.
- Consent and quota are checked only when a new operation is created; returning an existing draft processes nothing.
- The worker re-checks provider and active state, then runs the unchanged Study Note worker (which re-checks consent).
- Provenance: version `origin` (`ai_generate` / `manual_edit`) plus the provider recorded in the key; the UI labels Fake drafts "Simulated" from that record, not from the current mode.

Frontend: `shell/MakeNotesDraft.tsx` in the Live Quiet Assistant. States: checking, ready to prepare, preparing, draft ready, failed (Retry), refused (with reason), unresolved (Check status), lookup error (Check again). Lost POST responses are reconciled with the GET, never re-sent. Read-only draft view; no approve, export or delivery.

Release blocker (unchanged): the consent check-to-dispatch race (tasks.md 7.1) and provider-scoped consent must be fixed before any real provider; until then the prepare route and worker fail closed for any provider other than `fake`.
