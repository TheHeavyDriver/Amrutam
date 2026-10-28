#!/usr/bin/env bash
set -euo pipefail

# Logical backup for staging/local environments. Production relies primarily on
# RDS automated backups and point-in-time recovery; this is a secondary export.
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${BACKUP_DIR}/amrutam-${STAMP}.dump"

umask 077
mkdir -p "$BACKUP_DIR"

${PG_DUMP_BIN:-pg_dump} "$DATABASE_URL" --format=custom --compress=9 --no-owner --no-privileges --file="$FILE"
sha256sum "$FILE" > "${FILE}.sha256"
echo "Wrote $FILE and ${FILE}.sha256"

if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  aws s3 cp "$FILE" "${BACKUP_S3_URI%/}/$(basename "$FILE")" --sse aws:kms
  aws s3 cp "${FILE}.sha256" "${BACKUP_S3_URI%/}/$(basename "$FILE").sha256" --sse aws:kms
fi
