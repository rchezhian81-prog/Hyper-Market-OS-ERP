#!/usr/bin/env bash
# Hosted demo — ENCRYPTED on-box backup (owner decision 28 Sep 2026, option C: off-site deferred until
# before real data). Wraps the verified `scripts/backup.mjs` (checksummed manifest + control totals):
#   • the plain dump is written ONLY to RAM (/dev/shm), never to disk;
#   • it is encrypted with `age` to the PUBLIC recipient key in /etc/sre-pilot/backup-recipient.txt —
#     the box can lock a backup but can NOT unlock it: the private key is held by the owner, off the box;
#   • the RAM copy is shredded; only <id>.dump.age + <id>.manifest.json land in /var/lib/sre-pilot/backups.
# Nothing is ever deleted from the backup folder (retention is a later owner decision).
# Restore: infra/pilot/backup/restore-encrypted.sh (needs the owner's private key, brought back briefly).
set -euo pipefail
REPO=/opt/sre/app
ENV_FILE="$REPO/infra/compose/.env.pilot"
OUT=/var/lib/sre-pilot/backups
RECIPIENT=/etc/sre-pilot/backup-recipient.txt

[ -s "$RECIPIENT" ] || { echo "REFUSED — no backup recipient key at $RECIPIENT" >&2; exit 2; }
grep -q '^age1' "$RECIPIENT" || { echo "REFUSED — $RECIPIENT is not an age public key" >&2; exit 2; }
install -d -m 700 "$OUT"

WORK=$(mktemp -d /dev/shm/sre-backup.XXXXXX)
cleanup() { find "$WORK" -type f -exec shred -u {} + 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# The connection carries NO password: libpq (pg_dump / psql) reads it from PGPASSWORD, so it never
# appears in a URL, a process listing or any output.
val() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-; }
PGPASSWORD=$(val POSTGRES_PASSWORD)
DATABASE_URL="postgresql://$(val POSTGRES_USER)@127.0.0.1:$(val POSTGRES_PORT || true)/$(val POSTGRES_DB)"
DATABASE_URL=${DATABASE_URL/127.0.0.1:\//127.0.0.1:5432/}
export PGPASSWORD
export DATABASE_URL BACKUP_ENCRYPTED=true

node "$REPO/scripts/backup.mjs" --out "$WORK" | grep -E 'sha256|rows|complete'

for dump in "$WORK"/*.dump; do
  id=$(basename "$dump" .dump)
  age -R "$RECIPIENT" -o "$OUT/$id.dump.age" "$dump"
  install -m 600 "$WORK/$id.manifest.json" "$OUT/$id.manifest.json"
  chmod 600 "$OUT/$id.dump.age"
  head -c 22 "$OUT/$id.dump.age" | grep -q 'age-encryption.org/v1' || { echo "RED — $id did not encrypt" >&2; exit 1; }
  echo "encrypted  $OUT/$id.dump.age  ($(stat -c %s "$OUT/$id.dump.age") bytes; plain copy only ever in RAM, shredded)"
done
