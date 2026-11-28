# Screenshot Graveyard release image: one container serving the built SPA and
# the API from the same origin (backend/app/main.py `_mount_spa`). Exactly one
# process with one worker (docs/deployment-readiness.md R1).
# Build inputs are an explicit allowlist (.dockerignore + the COPY lines below).

FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/index.html frontend/vite.config.ts frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json ./
COPY frontend/src ./src
COPY frontend/public ./public
# Fail the image build if any Pixel World runtime asset is missing (P1-4b).
COPY deploy/verify-world-assets.mjs /app/deploy/verify-world-assets.mjs
RUN node /app/deploy/verify-world-assets.mjs src && npm run build

FROM python:3.13-slim AS app
# The release image is production by default (P1-5); preflight refuses anything else.
ENV APP_ENV=production PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 APP_HOME=/app
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/alembic.ini backend/alembic.ini
COPY backend/alembic backend/alembic
COPY backend/app backend/app
COPY --from=frontend /app/frontend/dist frontend/dist
COPY deploy/start.sh deploy/start.sh
RUN chmod 0755 deploy/start.sh && useradd --create-home --uid 10001 app
# The persistent volume for STORAGE_ROOT must be mounted and writable by uid 10001;
# preflight verifies both before anything else runs.
USER app
EXPOSE 8000
CMD ["/app/deploy/start.sh"]
