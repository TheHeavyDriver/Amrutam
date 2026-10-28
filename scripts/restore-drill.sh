#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"

if [[ "$SOURCE_DATABASE_URL" == "$TARGET_DATABASE_URL" ]]; then
  echo "Refusing to restore over the source database." >&2
  exit 1
fi

if [[ ! "$TARGET_DATABASE_URL" =~ (_restore|_test) ]]; then
  echo "TARGET_DATABASE_URL must point to a _restore or _test database." >&2
  exit 1
fi

WORK_DIR="${TMPDIR:-/tmp}/amrutam-restore-drill"
mkdir -p "$WORK_DIR"
DUMP="$WORK_DIR/source.dump"
START="$(date +%s)"

echo "Dumping source..."
${PG_DUMP_BIN:-pg_dump} "$SOURCE_DATABASE_URL" --format=custom --compress=9 --no-owner --no-privileges --file="$DUMP"
sha256sum "$DUMP" > "${DUMP}.sha256"
sha256sum -c "${DUMP}.sha256"

echo "Restoring into isolated target..."
${PG_RESTORE_BIN:-pg_restore} --clean --if-exists --no-owner --no-privileges --dbname="$TARGET_DATABASE_URL" "$DUMP"

echo "Running integrity checks..."
${PSQL_BIN:-psql} "$TARGET_DATABASE_URL" --no-psqlrc --set=ON_ERROR_STOP=1 --file=scripts/verify-restore.sql

ELAPSED=$(( $(date +%s) - START ))
printf 'Restore drill completed in %ss. Record this value against the RTO target.\n' "$ELAPSED"
