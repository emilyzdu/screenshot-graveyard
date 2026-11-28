#!/bin/sh
# Synthetic-sentinel verification of the Docker build context AND the final
# release image (P1-4). REQUIRES a Docker daemon; it has not been run in the
# development environment that produced it. The static exit-logic tests use a
# fake `docker` and prove only that this script fails closed.
#
# It works on a throwaway copy of the repository (without .git, node_modules,
# virtualenvs, build output, local databases or the local screenshot store), so
# no sentinel is ever created in, and no real data is ever read from, the real
# working tree.
#
# Fail-closed: every docker command's exit status is checked; a probe must print
# the exact lines STATUS=CLEAN and INCLUDED=OK; "VERIFIED" is printed only after
# every check passed. Any other outcome exits non-zero.
#
# Usage: deploy/verify-build-context.sh [repo-root]
set -eu

fail() { echo "FAIL: $*" >&2; exit 1; }

SRC="$(cd "${1:-$(dirname "$0")/..}" && pwd)" || fail "repository not found"
WORK="$(mktemp -d)" || fail "mktemp failed"
trap 'rm -rf "$WORK"' EXIT
MARK="SG_SENTINEL_DO_NOT_SHIP_$$_$(date +%s)"

# 1. Throwaway copy of the build inputs' tree.
( cd "$SRC" && tar --exclude=./.git --exclude='*/node_modules' --exclude='*/.venv' --exclude='*/dist' \
    --exclude=./backend/var --exclude='*.db' --exclude='*.sqlite*' -cf - . ) | ( cd "$WORK" && tar -xf - ) \
  || fail "could not copy the repository"

# 2. Plant sentinels, including the exact paths reproduced in review.
SHA64="$(printf 'b%.0s' $(seq 64))"
for f in \
  .env frontend/.env.local frontend/src/.env.development backend/.env backend/app/.env \
  backend/app/.env.production backend/alembic/versions/.env \
  backend/app/server.key backend/app/cert.pem frontend/public/secret.pem frontend/src/service-secret.json \
  backend/app/db_credentials.txt backend/local.db backend/local.db-wal backend/local.db-shm \
  backend/app/cache.sqlite3 backend/app/cache.sqlite3-wal backend/app/cache.sqlite3-shm \
  backend/app/cache.sqlite3-journal backend/app/app.db-journal frontend/src/assets/local.db \
  "backend/app/dev.local-storage/1/ab/cd/$SHA64" backend/app/storage-dev/blob.bin backend/app/uploads/x.png \
  "backend/var/storage/1/ab/cd/$SHA64"; do
  mkdir -p "$WORK/$(dirname "$f")" || fail "could not create $f"
  printf '%s\n' "$MARK" > "$WORK/$f" || fail "could not create $f"
done
# Pixel World source art and browser captures must never ship either. Planted
# only where the world exists, so a tree without it is not changed.
mkdir -p "$WORK/frontend/.shots/probe" && printf '%s\n' "$MARK" > "$WORK/frontend/.shots/probe/world.png" \
  || fail "could not create the capture sentinel"
if [ -d "$WORK/frontend/src/world/assets" ]; then
  mkdir -p "$WORK/frontend/src/world/assets/_source" \
    && printf '%s\n' "$MARK" > "$WORK/frontend/src/world/assets/_source/sentinel-source.png" \
    || fail "could not create the source-art sentinel"
fi

# Runs INSIDE a container: search for the sentinel, then check required files.
PROBE='mark=$1; root=$2; shift 2
if grep -rqF "$mark" "$root"; then echo STATUS=FOUND
else rc=$?; if [ "$rc" -eq 1 ]; then echo STATUS=CLEAN; else echo "STATUS=ERROR$rc"; fi; fi
ok=1; for f in "$@"; do [ -f "$root/$f" ] || { echo "MISSING=$f"; ok=0; }; done
[ "$ok" -eq 1 ] && echo INCLUDED=OK
exit 0'

probe() {  # probe <image> <label> <root> <required files...>
  image=$1; label=$2; root=$3; shift 3
  out="$(docker run --rm --entrypoint sh "$image" -c "$PROBE" probe "$MARK" "$root" "$@" 2>&1)" \
    || fail "$label: docker run failed (exit $?): $out"
  printf '%s\n' "$out" | grep -qx 'STATUS=CLEAN' || fail "$label: sentinel present or search incomplete: $out"
  printf '%s\n' "$out" | grep -qx 'INCLUDED=OK' || fail "$label: expected build inputs missing: $out"
}

# 3. Exactly what Docker sends: copy the whole context into a scratch image.
printf 'FROM busybox\nCOPY . /ctx\n' | docker build -q -t sg-context-probe -f - "$WORK" >/dev/null \
  || fail "context probe build failed"
probe sg-context-probe "build context" /ctx \
  backend/app/main.py backend/app/storage/file_store.py backend/app/preflight.py backend/alembic/env.py \
  backend/alembic.ini backend/requirements.txt deploy/start.sh frontend/package.json frontend/src/main.tsx \
  frontend/public/vite.svg

# 4. The real release image. Its frontend stage runs deploy/verify-world-assets.mjs,
#    so a missing Pixel World runtime asset fails this build (fail closed).
docker build -q -t sg-release-probe "$WORK" >/dev/null || fail "release image build failed"
probe sg-release-probe "release image" /app \
  backend/app/main.py backend/app/storage/file_store.py backend/app/preflight.py frontend/dist/index.html \
  deploy/start.sh

docker image rm -f sg-context-probe sg-release-probe >/dev/null 2>&1 || true
echo "VERIFIED: no sentinel in the build context or the release image; required inputs present"
