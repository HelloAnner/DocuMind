#!/usr/bin/env bash
set -euo pipefail

SCHEMA="${DOCUMIND_SCHEMA:-documind}"
PG_CONTAINER="${PG_CONTAINER:-corevo-platform-postgres-1}"
PG_USER="${PG_USER:-moss}"
PG_DATABASE="${PG_DATABASE:-northline_dev}"
DATABASE_URL="${DATABASE_URL:-}"

quote_ident() {
  printf '"%s"' "${1//\"/\"\"}"
}

psql_stdin() {
  if command -v psql >/dev/null 2>&1 && [[ -n "$DATABASE_URL" ]]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
    return
  fi
  if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DATABASE" "$@"
    return
  fi
  echo "No psql command and no running PostgreSQL container named $PG_CONTAINER."
  exit 1
}

psql_query() {
  local sql="$1"
  if command -v psql >/dev/null 2>&1 && [[ -n "$DATABASE_URL" ]]; then
    psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "$sql"
    return
  fi
  docker exec "$PG_CONTAINER" psql -At -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DATABASE" -c "$sql"
}

schema_ident="$(quote_ident "$SCHEMA")"

printf '%s\n' \
  "CREATE SCHEMA IF NOT EXISTS $schema_ident AUTHORIZATION $PG_USER;" \
  'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";' \
  "CREATE TABLE IF NOT EXISTS $schema_ident._dev_migrations (" \
  '    id TEXT PRIMARY KEY,' \
  '    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()' \
  ');' \
  | psql_stdin >/dev/null

for migration in apps/api-rs/migrations/*.up.sql; do
  migration_id="$(basename "$migration")"
  applied="$(psql_query "SELECT 1 FROM $schema_ident._dev_migrations WHERE id = '$migration_id'" || true)"
  if [[ "$applied" == "1" ]]; then
    continue
  fi
  {
    echo "SET search_path TO $schema_ident, public;"
    cat "$migration"
    echo "INSERT INTO $schema_ident._dev_migrations(id) VALUES ('$migration_id');"
  } | psql_stdin >/dev/null
  echo "Applied DocuMind migration: $migration_id"
done
