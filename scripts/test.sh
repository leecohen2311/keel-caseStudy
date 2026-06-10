#!/usr/bin/env bash
# One-command test run: fresh throwaway Postgres, then vitest (which applies
# migrations in its global setup).
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose -f docker-compose.test.yml down -v --remove-orphans >/dev/null 2>&1 || true
docker compose -f docker-compose.test.yml up -d --wait

npx vitest run "$@"
