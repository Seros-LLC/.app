#!/usr/bin/env bash
# tools/pg-test.sh — run the suite against a real Postgres, the way production runs.
#
# The default `npm test` lane is SQLite. Every dialect-conditional branch in
# src/ (`dialect() === 'pg' ? ... : ...`) is therefore UNTESTED by it, and that
# gap has already shipped three separate production-only defects: a result shape
# that does not exist on postgres-js, a row-count field that is named `count`
# there, and raw column keys that arrive camelCased. A green SQLite suite is not
# evidence that production works.
#
# Usage:  ./tools/pg-test.sh              # whole suite on Postgres
#         ./tools/pg-test.sh tests/pg-dialect.test.ts   # one file
#
# Starts a disposable container, waits for readiness, runs the tests, and removes
# the container on the way out whether the tests passed or not.
set -euo pipefail

CONTAINER="${SEROS_PG_TEST_CONTAINER:-seros-pgtest}"
PORT="${SEROS_PG_TEST_PORT:-55433}"
PASSWORD="serostest"
DB="seros_test"
IMAGE="${SEROS_PG_TEST_IMAGE:-docker.io/library/postgres:16-alpine}"
ENGINE="${SEROS_CONTAINER_ENGINE:-}"

if [ -z "$ENGINE" ]; then
  if command -v podman >/dev/null 2>&1; then ENGINE=podman
  elif command -v docker >/dev/null 2>&1; then ENGINE=docker
  else
    echo "pg-test: needs podman or docker to start a disposable Postgres" >&2
    exit 127
  fi
fi

cleanup() { "$ENGINE" rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
# Remove any leftover from an interrupted run before starting a new one.
cleanup
trap cleanup EXIT

echo "pg-test: starting $IMAGE as $CONTAINER on port $PORT ($ENGINE)"
"$ENGINE" run -d --rm --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB="$DB" \
  -p "$PORT:5432" "$IMAGE" >/dev/null

# Readiness, carefully. The postgres image runs a TEMPORARY server during
# initdb that listens on the unix socket ONLY, so `pg_isready` (which defaults to
# that socket) reports "accepting connections" seconds before the real server
# exists — the temp one is then shut down and restarted, and a run that trusted
# it fails with "Postgres never became ready" or a dropped connection mid-suite.
# Observed here: socket said accepting at t=4s, TCP not until t=5s.
#
# So probe what the tests actually use: a real query, over TCP, against the real
# database. That is false only when the server genuinely cannot serve us.
ready=0
for _ in $(seq 1 60); do
  if "$ENGINE" exec "$CONTAINER" \
      psql -h 127.0.0.1 -U postgres -d "$DB" -c 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "pg-test: Postgres never became ready; last 20 log lines:" >&2
  "$ENGINE" logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 1
fi

export SEROS_PG_TEST_URL="postgresql://postgres:$PASSWORD@127.0.0.1:$PORT/$DB"
export DATABASE_URL="$SEROS_PG_TEST_URL"
export SEROS_PROVIDER=fake
export SEROS_TRACKER=fake

TARGET=("$@")
if [ ${#TARGET[@]} -eq 0 ]; then TARGET=(tests/pg-*.test.ts); fi

echo "pg-test: running ${TARGET[*]}"
npx tsx --test "${TARGET[@]}"
