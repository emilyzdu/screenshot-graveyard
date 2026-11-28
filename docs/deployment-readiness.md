# Public Deployment Readiness (audit at `beab558`)

Assessment only; nothing is deployed. The target is the public app with real OpenAI
Vision and a labeled Demo Mode (`docs/pixel-world-prd.md` §K-2, decision D2).

## 0. Deployment foundation status (implemented and remediated; uncommitted; not deployed)

The tables in §1–§2 below are the original audit at `beab558`. This section is the
current state and supersedes any contradicting "Why" text there.

| Item | Status | Where |
|---|---|---|
| R3 driver and lock | **Fixed.** `psycopg` and `psycopg-binary` 3.2.3 pinned; `openai` (previously missing from the lock) pinned. A test keeps `pyproject.toml` and the lock in sync. The lock installs cleanly into a fresh Python 3.13 environment, and the full backend suite passes there | `backend/requirements.txt` |
| R4 proxy IPs | **Fixed in code.** `X-Forwarded-For` is used only when the direct peer is inside `TRUSTED_PROXY_CIDRS`, and then only its right-most non-proxy entry. `none` (alone) disables forwarding explicitly. Comma-only lists, `none` mixed with networks, invalid networks and trust-everything prefixes (`0.0.0.0/0`, `::/0`) are rejected. uvicorn runs with `--no-proxy-headers` | `app/middleware/limits.py`, `app/config.py`, `deploy/start.sh` |
| R5 global AI quota | **Fixed.** `MAX_AI_CALLS_PER_DAY` is reserved in the same locked transaction that creates an AI operation that will execute (sources owned, consent granted). The source-less `POST /api/operations` scaffold is never metered and is disabled in production (404) | `app/services/operation_service.py`, `app/routers/operations.py` |
| R7 public quotas | **Fixed.** Production defaults: 30 screenshots and 25 AI calls per workspace | `app/config.py` |
| R8 storage cap | **Fixed (reserve-before-write).** Physical capacity is reserved before any byte is written: under a process-wide allocation lock (one worker), in its own committed transaction under the counter's row lock. The byte cap and the free-space floor are checked together at that point. Bytes stay counted even when the later metadata transaction fails, because the file is retained (write-once). `deploy/start.sh` reconciles the counter with the physical bytes on disk before serving: it reclaims only this store's own leftover temp files (exact temp/probe name patterns inside `.tmp/`), then counts every remaining regular file once per inode, `.tmp/` included. It runs under an exclusive allocation file lock and refuses to run while any upload holds the shared lock. Content already published without metadata is accepted at the cap because it adds no bytes. Remaining failure modes below | `app/services/vault_service.py`, `app/services/global_usage_service.py`, `app/storage_reconcile.py` |
| R9 environment validation | **Fixed.** At startup (`create_app`), and earlier in `app.preflight` before migrations. Preflight checks the AI provider contract too (provider `fake`/`openai`; for `openai` a non-blank key and model; reasoning effort, timeout and retries) and then asks the runtime itself: a child interpreter imports `app.config` and builds the configured adapter with the same environment, without importing `app.main` and without network or database access. `TRUSTED_ORIGINS` entries must be browser origins (`scheme://host[:port]`, no path, query, fragment, credentials, wildcard or invalid port) in every environment, and public `https://` in production. Messages name settings, never values | `app/production_checks.py`, `app/preflight.py` |
| Database URL safety | **Fixed.** The URL is parsed once and passed to SQLAlchemy and Alembic as a URL object, never through Alembic's ConfigParser, so encoded passwords like `%40` work. Malformed URLs and connection failures never print the password | `app/db/url.py`, `alembic/env.py`, `app/db/session.py` |
| Release preflight | **Added.** The release image defaults to `APP_ENV=production`. `start.sh` runs preflight (environment plus a storage check: not ephemeral, on a mounted filesystem other than `/`, writable by the runtime UID), then migrations, then storage reconciliation, then one worker; `set -e` stops at the first failure | `app/preflight.py`, `deploy/start.sh`, `Dockerfile` |
| Build context | **Allowlist.** `.dockerignore` excludes everything, re-includes only the exact build inputs, then excludes secrets, databases (including WAL/SHM), blobs and generated files again. The Dockerfile copies only those inputs. **Static checks (run here):** a `.dockerignore` emulation over the exact reproduced paths and every tracked or new source file, plus the verifier's exit logic against a fake `docker` (a failed build, `docker run` exit 125, and a sentinel hit each exit non-zero without printing VERIFIED). **Daemon checks (not run; no Docker here):** `deploy/verify-build-context.sh` builds the context probe and the release image and inspects both for planted sentinels and required inputs. No image has been built or inspected, so the actual image is not verified. Run it on staging | `.dockerignore`, `Dockerfile`, `deploy/verify-build-context.sh` |
| Truthful 429 text | **Fixed.** The global daily limit, rate limiting and the workspace quota each have their own text | `frontend/src/ai/messages.ts` |
| R1, R2, R6, R10–R12 | **Open:** they need the hosting account, the volume, the provider dashboard and the domain | §2, §5 |

**Request quota versus financial cap.** `MAX_AI_CALLS_PER_DAY` and the per-workspace
quota are application-side request quotas: they count accepted AI operations (each at
most one provider request) and know nothing about money. Financial limits exist only on
the provider side, and the application can neither read, set nor verify them (§5):
- a project spend limit with **hard-limit enforcement turned on**. A spend alert or
  budget notification alone only sends email and does not stop traffic. When an
  enforced limit is reached, OpenAI rejects requests with 429
  `project_spend_limit_exceeded`. Enforcement is not instantaneous, so recorded spend
  can slightly exceed the configured amount
  ([OpenAI: Spend limits](https://developers.openai.com/api/docs/guides/spend-limits));
- prepaid credits with auto-reload off, which bound the total that can ever be spent
  (exhaustion returns `credit_balance_exhausted`).

The app sends no automatic retries (`AI_PROVIDER_MAX_RETRIES=0`). A provider 429 surfaces
as the adapter's existing rate-limited error (`AIAdapterRateLimitedError`); the request
is not retried and source screenshots stay intact.

**Remaining storage failure modes (documented, tested).** If the process dies after a
reservation commits but before the file is written, the counter over-counts until the
next start. If it dies after the temp file is fsynced but before publication, the temp
bytes stay on disk until the next start. In both cases `app.storage_reconcile` reclaims
the temp file and sets the counter to the bytes actually on disk, so the cap never
under-counts after a restart. Reconciliation runs only at startup. Files in `.tmp/` with
unknown names are never deleted and stay counted. Reconciliation fails closed: if any
directory or file under `STORAGE_ROOT` cannot be inspected, it aborts before reclaiming
anything, keeps the previous counter, and exits non-zero, so `start.sh` never starts the
server on a partial count. Preflight also creates and removes a disposable directory
directly under `STORAGE_ROOT` (where workspace directories are published), not only in
`.tmp/`. The free-space floor is exact only within the single worker. The byte
cap itself holds across processes (it is a database row lock).

### Recommended platform (smallest viable)

One Docker web service, one instance, a persistent disk, a managed PostgreSQL in the
same region, and the platform's managed TLS on a custom domain. **Render** fits this
shape:
- **Confirmed from Render's documentation (fetched 2026-11-27):** persistent disks attach
  only to paid services; a service with a disk cannot scale to multiple instances, which
  matches R1; disks are not available during build or pre-deploy commands, so the start
  script migrates at runtime; deploys with a disk have a few seconds of downtime; the
  rest of the filesystem is ephemeral; disks get daily snapshots kept for 7 days.
- **Assumptions to verify on staging:**
  - the proxy's source network for `TRUSTED_PROXY_CIDRS` (log the peer address of a
    test request);
  - that Render appends the client to `X-Forwarded-For`;
  - that the disk mount is writable by the container's non-root user (uid 10001);
  - that the managed PostgreSQL URL needs rewriting to `postgresql+psycopg://`;
  - current prices.

Fly.io or Railway would work with the same container. Their volume and proxy details
are unverified.

### Environment variables (names only)

`APP_ENV`, `DATABASE_URL`, `STORAGE_ROOT`, `TRUSTED_ORIGINS`, `TRUSTED_PROXY_CIDRS`,
`COOKIE_SECURE` (leave unset; defaults to on), `MAX_AI_CALLS_PER_DAY`,
`MAX_TOTAL_STORAGE_BYTES`, `STORAGE_MIN_FREE_BYTES` (optional),
`MAX_SCREENSHOTS_PER_WORKSPACE` and `MAX_AI_CALLS_PER_WORKSPACE` (optional;
production defaults 30 / 25), `AI_PROVIDER`, `OPENAI_MODEL`, `OPENAI_API_KEY`
(secret), `PORT` (set by the platform). Optional existing settings: `RATE_LIMIT_*`,
`STALE_PENDING_OPERATION_SECONDS`.

## 1. Already implemented (verified in code)

| Area | What exists | Where |
|---|---|---|
| Same-origin serving | FastAPI serves `frontend/dist` and routes `/api/*`. Unknown `/api` paths return JSON 404. Starts without `dist` | `backend/app/main.py` (`_mount_spa`) |
| Workspace identity and isolation | Opaque `secrets.token_urlsafe(32)` token; only its SHA-256 is stored. Cookie `sg_workspace` is HttpOnly, SameSite=Strict and Secure (`COOKIE_SECURE` defaults to 1). Every query is workspace-scoped; foreign ids return 404 | `app/middleware/workspace.py`, `app/db/repository.py` |
| CSRF / Origin | Exact Origin/Referer allowlist plus a required `X-Requested-With` header on state-changing requests. No wildcard. `APP_ENV=production` refuses to start without `TRUSTED_ORIGINS`. No CORS middleware (same origin; none needed) | `app/middleware/csrf.py`, `app/config.py` |
| Upload safety | Content-authoritative validation (signature, Pillow decode, megapixel guard); streaming 15 MB per-file cap; 20 files per batch; 500 screenshots per workspace; per-workspace dedup | `app/routers/screenshots.py`, `app/services/vault_service.py`, `app/config.py` |
| Original bytes | Write-once, content-addressed files, read-only (`0o444`); never served publicly; `Cache-Control: private, no-store` | `app/storage/`, `app/routers/screenshots.py` |
| Rate limiting | Two token buckets on every `/api/*` request (per IP, then per workspace), 60 burst / 1 per s | `app/middleware/limits.py` |
| AI cost bounds (per request and per workspace) | `MAX_AI_CALLS_PER_WORKSPACE`; keyed idempotency (no duplicate paid calls); zero SDK retries (`AI_PROVIDER_MAX_RETRIES` must be 0); max output tokens; image byte caps | `app/config.py`, `app/services/operation_service.py`, `app/services/auto_process_service.py` |
| Consent and dispatch safety | Provider- and disclosure-bound per-screenshot consent; dispatch-time and persistence-time checks | `app/services/ai_dispatch_service.py` |
| Secrets | The OpenAI key comes only from the environment. Real mode fails closed without it. SDK log redaction is installed | `app/config.py`, `app/ai/log_redaction.py` |
| Crash recovery | A startup and periodic sweep marks stale `pending` operations failed or interrupted | `app/main.py` (lifespan), `app/services/operation_recovery_service.py` |
| Migrations | Alembic chain through `d6b1a7e00001`. Workspace locking uses `SELECT … FOR UPDATE` on PostgreSQL | `backend/alembic/versions/`, `repository.lock_workspace` |
| Demo Mode | Frontend-only `?demo=1` (or `VITE_UI_MODE=demo`): synthetic fixtures, never calls the API, labeled "Demo AI mode", "Demo data", "Demo only, nothing is generated by AI" | `frontend/src/uiMode.ts`, `frontend/src/demo/DemoApp.tsx` |

## 2. Required before public launch (priority order)

| # | Item | Why (evidence) | Work |
|---|---|---|---|
| R1 | **Hosting platform: one long-running container, one uvicorn worker, a persistent volume, managed HTTPS** | The rate limiter, the auto-process running registry and BackgroundTasks are all in-process (`limits.py` "not shared across workers"; `auto_process_service.RUNNING`). Serverless or multi-worker setups break these guarantees | Decision T1; run `uvicorn app.main:app --workers 1` |
| R2 | **Persistent screenshot storage** | `STORAGE_ROOT` defaults to `backend/var/storage` inside the image, which is lost on redeploy | Mount a volume and set `STORAGE_ROOT` to it |
| R3 | **Production database: PostgreSQL** | The steering mandates PostgreSQL in production. **`backend/requirements.txt` (the pinned lock) has no PostgreSQL driver**; only `pyproject.toml` lists `psycopg[binary]==3.2.3`. The PostgreSQL schema test (`tests/test_db_postgres.py`) has never run here (it was skipped) | Add `psycopg[binary]` to the lock. Run `tests/test_db_postgres.py` against a disposable PostgreSQL. Run `alembic upgrade head` as the release step. Enable backups |
| R4 | **Real client IPs behind the platform proxy** | The per-IP limiter keys on `request.client.host` and deliberately ignores `X-Forwarded-For` (`limits.py`). Behind a proxy, every visitor would share one 60/1 per s bucket, and workspace-minting protection would collapse | Implemented in the application, not in uvicorn: uvicorn runs with `--no-proxy-headers`, and `X-Forwarded-For` is read only when the direct peer is inside `TRUSTED_PROXY_CIDRS` (`limits.py`). Verify on staging that two clients get separate buckets |
| R5 | **Global daily AI request quota (new code)** | `MAX_AI_CALLS_PER_WORKSPACE` is per workspace only; any visitor can mint new workspaces | A `MAX_AI_CALLS_PER_DAY` check where AI operations are created (technical design §10.6). A distinct `ai_budget_reached` error; the UI links to Demo Mode |
| R6 | **Provider-side spending backstop** | Defense in depth if R5 has a bug | A dedicated OpenAI project key whose project spend limit has hard-limit enforcement turned on (an alert alone does not stop requests; enforcement can lag slightly). Keep prepaid credits with auto-reload off |
| R7 | **Public quota values** | Defaults (500 screenshots × 15 MB, 1000 AI calls per workspace) are for development | Set lower values (decision T4), for example 30 screenshots and 20 AI calls per workspace |
| R8 | **Global storage guard** | No delete path exists (INV-10), and workspaces are unlimited, so disk can fill | A total-bytes or daily-upload cap checked at upload (small new code), or at minimum a volume-usage alarm with a manual pause switch |
| R9 | **Production environment** | `APP_ENV=production`, `TRUSTED_ORIGINS=https://<domain>`, `COOKIE_SECURE=1` (default), `DATABASE_URL`, `STORAGE_ROOT`, `AI_PROVIDER=openai`, `OPENAI_MODEL`, `OPENAI_API_KEY` in the platform's secret store (never in the repo or an image) | Configuration |
| R10 | **HTTPS on the final domain** | Required for the Secure cookie, and later as the OAuth redirect URI for Google and Notion (Requirement 25.4). Changing the domain later means re-registering OAuth | Fix the domain before creating OAuth clients |
| R11 | **Launch verification** | First with `AI_PROVIDER=fake` on the deployed URL (the 6B walkthrough), then one minimal live OpenAI check with synthetic images, then confirm the global daily request quota trips. Provider-side financial limits are checked separately (§5, item 6) | A checklist run, recorded |
| R12 | **Demo Mode reachable and labeled** | Decision D2 | A link from the quota-reached (`ai_budget_reached`) and provider-unavailable messages and from the README. Demo fixtures never enter a real workspace |

## 3. Optional improvements

- **Security headers (low effort, recommended):** `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy` with
  `frame-ancestors 'none'`, and `Referrer-Policy: same-origin`. None are set today.
- **Observability:** structured request logs (never image contents or keys), a daily
  AI-call count, and alerts at 50% and 80% of the global daily request quota.
- **Inactive-workspace retention policy:** a documented policy only. Deletion is out of
  scope by INV-10.
- **A shared rate limiter (for example Redis):** only if more than one instance is ever
  needed.
- **The B1 batch status endpoint:** only if the D1 measurement fails.
- **A CDN for `frontend/dist/assets`:** not needed at hackathon scale.

## 4. Future OAuth prerequisites (Requirement 25)

- The final HTTPS domain (R10) is registered as the redirect URI.
- Google Cloud project, consent screen, and the `calendar.events` scope. Use test users
  for judging if verification is slow (decision T2).
- A token encryption key in the server's secret store (decision T3).
- Notion: a public integration with the same redirect domain. Conditional per
  Requirement 25.1(b).

## 5. Staging verification procedure (not yet run)

Run in order on the staging service. Each step's evidence is recorded before public
launch.

1. **Image confidentiality:** on a machine with Docker, run
   `deploy/verify-build-context.sh`. It plants synthetic sentinels in a throwaway copy,
   then checks both the build context and the release image. It must print two `OK`
   lines.
2. **Preflight negative checks:** start the image without a mounted volume, with
   `STORAGE_ROOT=/tmp/x`, and with `TRUSTED_PROXY_CIDRS=,`. Each must exit before
   "Running upgrade" appears in the log.
3. **PostgreSQL (disposable database only):**
   `TEST_POSTGRES_URL=postgresql+psycopg://… PG_TEST_DB_IS_DISPOSABLE=1 python -m pytest tests/test_db_postgres.py`.
   Then two parallel AI requests from two workspaces at `MAX_AI_CALLS_PER_DAY=1`: exactly
   one is accepted. Use a password containing `@`, `:` and `/` (URL-encoded) to confirm
   P1-3 end to end.
4. **Proxy:** log the peer address of one request to find the proxy network, set
   `TRUSTED_PROXY_CIDRS` to it, and confirm that two different client IPs get separate
   rate-limit buckets and that a forged left-most `X-Forwarded-For` entry has no effect.
5. **Storage:** set a small `MAX_TOTAL_STORAGE_BYTES` on staging and confirm that
   uploads stop at the cap, that a restart reconciles the counter, and that the disk's
   mount owner allows uid 10001.
6. **Provider-side financial limits (separate launch requirement):** the application
   cannot read, set or enforce money. Before launch, confirm in the OpenAI dashboard:
   a project-scoped key; a project spend limit with hard-limit enforcement turned on
   (not only an alert); and prepaid credits with auto-reload off. Size the limit with
   headroom, because enforcement is not instantaneous and spend can slightly exceed it.
   Record the values in the launch checklist.
7. **Application request quota:** run one minimal live check with a synthetic image,
   then confirm that `ai_budget_reached` appears at the configured
   `MAX_AI_CALLS_PER_DAY` (a request count, not a spending cap).
