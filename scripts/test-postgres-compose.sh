#!/usr/bin/env bash
set -euo pipefail

export COMPOSE_PROJECT_NAME="story-integration-${$}"
export AUTH_SECRET="integration-secret-with-enough-entropy"
export POSTGRES_PASSWORD="integration-postgres-password"
export POSTGRES_DB="story_integration"
export POSTGRES_USER="story"
export AI_SERVICE_TOKEN="integration-ai-token"
export AI_TASK_QUEUE_ENABLED="true"

cleanup() {
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$integration_tmp"
}

integration_tmp=$(mktemp -d)
trap cleanup EXIT

docker compose up -d --wait postgres redis
docker compose build app
docker compose run --rm --no-deps app node server/postgres-integration-test.mjs
docker compose run --rm --no-deps app node server/task-queue-integration-test.mjs

backup_file="$integration_tmp/story-studio.dump"
docker compose exec -T postgres pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom > "$backup_file"
test -s "$backup_file"
docker compose exec -T postgres psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "DELETE FROM ideas" >/dev/null
test "$(docker compose exec -T postgres psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command 'SELECT COUNT(*) FROM ideas')" = "0"
docker compose exec -T postgres pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --clean --if-exists --no-owner < "$backup_file"
test "$(docker compose exec -T postgres psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command 'SELECT COUNT(*) FROM ideas')" = "1"
test "$(docker compose exec -T postgres psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command 'SELECT COUNT(*) FROM users')" = "1"
echo "PostgreSQL Compose backup/restore drill passed"
