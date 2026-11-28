# External tools via Composio (AMD-2)

Status: **engineering checkpoint, not a production release.** Implemented and
covered by automated tests with a deterministic fake transport. An independent
review passed it for *controlled local live verification with dedicated test
accounts*. That live verification has **not** been run yet: no real Composio
call, real account write or real-OpenAI planning run has happened from this
repository. `COMPOSIO_ALLOW_LIVE_WRITES` and `COMPOSIO_PUBLIC_CONNECT` stay off.

Requirement: `.kiro/specs/screenshot-graveyard/prd-v2-additions.md`,
Requirement 25 as amended by AMD-2. Design summary:
`.kiro/specs/screenshot-graveyard/design.md`, "External tools via Composio".

## What it does

1. The AI (the existing consent-gated adapter) looks at ONE screenshot and
   proposes an action plan: `act` (1 to 3 actions), `no_action`, or
   `needs_clarification` (one question). Each action names a tool from a
   bounded server catalog, a short rationale, a confidence and its arguments.
2. The plan is an append-only versioned artifact (`action_plan`). The user
   reviews and edits it (each save is a new `manual_edit` version) and approves
   one exact version through the existing approval ledger.
3. Each approved action has its own **Run** with an explicit confirmation. Run
   reserves the write; a background worker re-authorizes it at the dispatch
   boundary, sends it once, and records a receipt or an honest unknown outcome.

Planning never mutates anything externally (it only reads tool schemas).

## Tool catalog (bounded, server-controlled)

| Tool slug | App | What it may do |
| --- | --- | --- |
| `GOOGLECALENDAR_CREATE_EVENT` | Google Calendar | One event on `primary`; `send_updates="none"`, `create_meeting_room=false`, no attendees |
| `NOTION_CREATE_NOTION_PAGE` | Notion | One page (title + Markdown) under a parent page the user chooses |
| `GMAIL_CREATE_EMAIL_DRAFT` | Gmail | One unsent draft (`user_id="me"`, `is_html=false`); never sends |

Slugs and argument names come from Composio's toolkit reference and are
re-checked at runtime against `GET /api/v3.1/tools/{slug}`. A tool is withheld
if its toolkit is not configured, its live schema is unavailable, deprecated,
tagged `destructiveHint`, lacks an argument we send, requires an argument we do
not always send, or its version does not match the pin / `available_versions`.
Both the documented flat `input_parameters` map and the JSON Schema form are
parsed. No Composio meta-tools (search, multi-execute, workbench, bash,
connection management), proxy/HTTP execution, read, update, delete or send
tools are ever offered to the model or executed.

## Architecture

* **Transport:** Composio REST v3.1 over `httpx` (`app/tools/composio_http.py`),
  not the `composio` Python SDK: every SDK release since 0.20 requires
  `openai>=2.48`, and this backend pins `openai==1.109.1` for its reviewed
  vision adapter. Endpoints used: `POST /connected_accounts/link`,
  `GET|DELETE /connected_accounts/{id}`, `GET /tools/{slug}`,
  `POST /tools/execute/{slug}` (direct execution with an explicit `user_id`,
  `connected_account_id` and pinned `version`). Sessions are not used because
  they always select the newest toolkit version and the most recent account.
* **Fake transport** (`EXTERNAL_TOOLS_MODE=fake`): network-free, deterministic;
  every connection, plan and receipt is labelled simulated.
* **Planner:** `plan_actions` on the existing adapters. The OpenAI adapter uses
  the Responses API with a Structured Outputs schema, the existing safety rules
  (screenshot text is untrusted data) and the existing calendar evidence checks.
  The model never chooses an account or a Notion parent page.
* **Services:** `tool_connection_service`, `action_plan_service`,
  `tool_execution_service`; routers `integrations`, `action_plans`.
* **UI:** Pixel World Settings (connected apps), Portal (server-reported
  status) and the ghost's Action Card (plan, rationale, exact arguments,
  edit, approve, Run, receipt). The Pixel World renderer is unchanged.

## Identity and connections

* Each workspace has one random Composio user id (`external_identity`), never
  derived from the workspace token; workspaces never share a connected account.
* A connected account id is recorded only from Composio's response to a link
  request this server made. Before use, Composio is asked again: the account
  must belong to this workspace's user, match the toolkit and be `ACTIVE`.
* **Hosted Connect Link completion** follows Composio's guidance ("verify its
  connected_account_id against the connection attempt stored on your server
  and the signed-in application user ... Callback query parameters alone
  aren't proof of ownership"). Each connect creates a single-use attempt token
  (only its SHA-256 is stored) that expires after 10 minutes and travels only
  in the callback URL. A pending connection becomes active ONLY through
  `POST /api/integrations/callback` from the same workspace, before expiry,
  with a matching account id and a provider confirmation. Refresh never
  activates a connection.
* Disconnect is local first (never used again from that commit), cancels
  unsent reservations in the same transaction, then deletes the account at
  Composio and reports honestly if that delete failed.

## Execution safety

* **Authorize (Run):** current plan version; an approval of exactly that
  version whose content SHA-256 matches the stored bytes and the hash the
  request names; enabled, complete action; bound, re-confirmed connection;
  arguments rebuilt server-side; no conflicting execution. Creates a
  `reserved` row (provably not sent).
* **Dispatch boundary:** provider re-check of the account (no lock held), then
  one locked transaction re-reads the reservation, screenshot state, current
  version, approval and hash, binding, connection and the rebuilt argument
  hash. A stop that won becomes `cancelled`. Otherwise the conditional update
  `reserved -> executing` commits: **the linearization point**. From then on
  the write is treated as possibly sent and cannot be cancelled.
* **Stop operations** (disconnect, connection failure, plan edit, Safe Burial)
  cancel unsent reservations in their own locked transaction. `cancelled` is
  terminal; restoring a screenshot never revives it.
* **Outcomes** (conditional updates, never overwriting a settled row):
  `succeeded` (Calendar: the event carries our private delivery marker;
  Notion/Gmail: an item id, stored as an UNVERIFIED receipt); `unknown`
  (every failure after the request may have reached Composio, including
  `successful: false` and every non-2xx status); `failed` only when no
  connection was ever opened. Overdue `executing` -> `unknown`; overdue
  `reserved` -> `cancelled`. Nothing is retried automatically.
* **Delivery identity**, independent of plan artifacts and versions:
  `scope_key` = (workspace, screenshot, tool, destination app);
  `delivery_key` = scope + normalized intended action. Enforced under the lock
  and by partial unique indexes: at most one unresolved
  (`reserved`/`executing`/`unknown`/`rejected`) execution per scope, at most one
  held execution per delivery identity. Replans, revisions, equivalent edits
  and reconnects cannot bypass an unresolved write.
* Only the reviewed minimum arguments are sent: no image, filename,
  screenshot id or other workspace data.

## Configuration (names only)

`EXTERNAL_TOOLS_MODE` (`off` default | `fake` | `composio`), `COMPOSIO_API_KEY`
(secret, backend only), `COMPOSIO_BASE_URL`, `COMPOSIO_CALLBACK_URL` (required
in composio mode), `COMPOSIO_AUTH_CONFIG_GOOGLECALENDAR`,
`COMPOSIO_AUTH_CONFIG_NOTION`, `COMPOSIO_AUTH_CONFIG_GMAIL`, optional
`COMPOSIO_TOOLKIT_VERSION_<APP>`, `COMPOSIO_TIMEOUT_SECONDS`,
`TOOL_EXECUTION_STALE_SECONDS`, `AI_ACTION_PLAN_MAX_OUTPUT_TOKENS`, and the two
switches that stay **off**: `COMPOSIO_ALLOW_LIVE_WRITES` (no external write is
dispatched without it) and `COMPOSIO_PUBLIC_CONNECT` (production refuses new
connections and callback completion without it). `COMPOSIO_LIVE_VERIFIED_TOOLS`
is informational: the UI calls nothing "live" unless it is listed.

Composio setup: one auth config per toolkit in the dashboard, with the narrowest
scopes (Calendar event creation, Gmail compose, Notion page creation).

## Verification status

| Area | Verified by | Not verified |
| --- | --- | --- |
| Connections, isolation, attempt binding | Automated tests (fake transport) | Real Connect Link; that Composio preserves the `sg_attempt` callback parameter (documented, not observed) |
| Planning | Tests with a scripted planner and a mocked OpenAI client | Real model tool-selection quality |
| Execution safety | Deterministic race tests; file-backed SQLite concurrency test | PostgreSQL behaviour (DDL/SQL compiled only) |
| HTTP contract | Tests against `httpx.MockTransport` and fixtures from the docs | Real Composio responses |
| Receipts | Tests | That Composio's create-event response includes `extendedProperties` |

## Accepted limitations

* Provider state can change between the dispatch-boundary check and the send.
* A write past the linearization point cannot be cancelled.
* An `unknown` (or `rejected`) outcome blocks its whole scope (screenshot +
  tool + app); there is no user flow to resolve it yet.
* Two different events at the same times from one screenshot share a
  delivery identity.
* The destination scope excludes the account id (reconnecting the same real
  account must not reopen an unresolved write), so switching to a different
  real account is also blocked by an unresolved write.
* Notion and Gmail receipts are unverified (an item id is not matched to the
  request).
* Background work is in-process (no durable queue); an interrupted write ends
  `unknown`.
* The Notion parent page is entered as an ID (no picker).
* Connections that were already active before the production gate was enabled
  keep working.
* Only the Pixel World UI exposes the flow; the Visual Workspace list view,
  AutoPilot and the Approval Altar are not integrated.

## Public-production blockers

1. **Provider identity:** the hosted flow binds completion to the initiating
   workspace but cannot prove WHICH Google/Notion/Gmail identity was
   authorized. Until resolved (for example by showing and confirming the
   provider identity), `COMPOSIO_PUBLIC_CONNECT` stays off.
2. **Live verification not run:** each tool needs at least one recorded,
   authorized write to a dedicated test account (Requirement 25.9) before it
   may be listed in `COMPOSIO_LIVE_VERIFIED_TOOLS`.
3. **Calendar receipt shape:** confirm the marker comes back in the real
   response; otherwise add a read-back correlation before enabling writes.
4. **Real response shapes** for Notion/Gmail receipts and flat
   `input_parameters` (`required` placement) must be confirmed.
5. **PostgreSQL:** run the migration and the race tests against a disposable
   PostgreSQL database.
6. **Token custody:** Composio holds OAuth tokens (a deviation from the
   original Requirement 25.4 text, accepted in AMD-2); review Composio's data
   handling before public use.

## Controlled local live verification (not yet run)

Only with dedicated test accounts, on a developer machine, never in production:
set `EXTERNAL_TOOLS_MODE=composio`, a test-project `COMPOSIO_API_KEY`, the three
auth configs and `COMPOSIO_CALLBACK_URL=http://localhost:<port>/?view=world`.
Connecting and planning work with live writes off. Writing to the test account
additionally needs `COMPOSIO_ALLOW_LIVE_WRITES=1` for that local session only,
and an explicit authorization from the product owner. Record each result
(tool, account, execution id, receipt) before listing a tool as verified.
