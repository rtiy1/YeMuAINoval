#!/usr/bin/env bash
set -euo pipefail
umask 077

backup_target=${1:-"backups/story-studio-$(date -u +%Y%m%dT%H%M%SZ).dump"}
postgres_user=${POSTGRES_USER:-story}
postgres_db=${POSTGRES_DB:-story_studio}

mkdir -p "$(dirname "$backup_target")"
docker compose exec -T postgres pg_dump --username "$postgres_user" --dbname "$postgres_db" --format=custom > "$backup_target"
test -s "$backup_target"
echo "PostgreSQL backup written to $backup_target"
