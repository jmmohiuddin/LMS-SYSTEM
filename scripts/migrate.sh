#!/usr/bin/env bash
#
# Applies db/migrations/*.sql in order, then optionally the db/tests/ suites.
# This is the loop documented in docs/06-DEPLOYMENT.md §4, with a preflight
# guard added.
#
# Connect with the OWNER role on the DIRECT (non-pooled) endpoint —
# DATABASE_MIGRATION_URL, not DATABASE_URL. The runtime role deliberately
# lacks DDL rights, and the pooler's transaction pooling breaks the
# session-scoped DDL these files rely on.
#
#   DATABASE_MIGRATION_URL='postgresql://neondb_owner:...@ep-...neon.tech/shikhon_lms?sslmode=require' \
#     ./scripts/migrate.sh [--with-tests] [--force]
#
# The migrations are NOT idempotent: every CREATE TABLE/TYPE is unguarded, and
# nothing records what has already run. Re-applying them to a populated
# database fails partway and leaves it half-migrated. So this refuses to start
# unless the public schema is empty; --force is the deliberate override.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${DATABASE_MIGRATION_URL:-}" ]]; then
  echo "error: DATABASE_MIGRATION_URL is not set." >&2
  echo "       Use the owner role on the direct endpoint (see docs/06-DEPLOYMENT.md §3)." >&2
  exit 1
fi

WITH_TESTS=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --with-tests) WITH_TESTS=1 ;;
    --force)      FORCE=1 ;;
    *) echo "error: unknown argument '$arg'" >&2; exit 1 ;;
  esac
done

psql_run() { psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -q -f "$1"; }

existing=$(psql "$DATABASE_MIGRATION_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")

echo "target has ${existing} table(s) in public schema"

if [[ "$existing" -ne 0 && "$FORCE" -ne 1 ]]; then
  echo "error: refusing to run — the public schema is not empty." >&2
  echo "       These migrations assume a fresh database. Re-run with --force only if" >&2
  echo "       you are certain the pending files have never been applied here." >&2
  exit 1
fi

for f in db/migrations/*.sql; do
  echo "==> $f"
  psql_run "$f"
done

if [[ "$WITH_TESTS" -eq 1 ]]; then
  for f in db/tests/schema_lint.sql db/tests/invariants.sql db/tests/e2e_academic_cycle.sql; do
    echo "==> $f"
    psql_run "$f"
  done
fi

applied=$(psql "$DATABASE_MIGRATION_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
echo "done — ${applied} table(s) now in public schema"
