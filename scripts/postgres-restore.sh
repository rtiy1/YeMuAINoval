#!/usr/bin/env bash
set -euo pipefail

backup_source=${1:-}
postgres_user=${POSTGRES_USER:-story}
postgres_db=${POSTGRES_DB:-story_studio}

if [[ -z "$backup_source" || ! -s "$backup_source" ]]; then
  echo "Usage: RESTORE_CONFIRM=1 npm run db:restore -- <non-empty-dump-file>" >&2
  exit 1
fi
if [[ ${RESTORE_CONFIRM:-} != 1 ]]; then
  echo "Restore replaces the current database. Set RESTORE_CONFIRM=1 to continue." >&2
  exit 1
fi

services_stopped=false
restart_services() {
  if [[ "$services_stopped" == true ]]; then
    docker compose start app worker >/dev/null 2>&1 || true
  fi
}
trap restart_services EXIT

docker compose stop app worker >/dev/null 2>&1 || true
services_stopped=true
docker compose exec -T postgres pg_restore --username "$postgres_user" --dbname "$postgres_db" --clean --if-exists --no-owner < "$backup_source"
restart_services
services_stopped=false
trap - EXIT
echo "PostgreSQL restored from $backup_source"
