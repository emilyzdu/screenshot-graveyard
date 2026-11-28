#!/bin/sh
# Container entrypoint. Order matters (P1-5):
#   1. preflight: environment + persistent storage checks; no database access;
#   2. migrations;
#   3. storage counter reconciliation (no uploads can be running yet);
#   4. ONE uvicorn worker. --no-proxy-headers: uvicorn must not rewrite the
#      client address itself; the app trusts X-Forwarded-For only from
#      TRUSTED_PROXY_CIDRS (app/middleware/limits.py).
# `set -e` stops at the first failing step, so a failed preflight never migrates.
set -eu
cd "${APP_HOME:-/app}/backend"
python -m app.preflight
python -m alembic upgrade head
python -m app.storage_reconcile
exec python -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1 --no-proxy-headers
