#!/usr/bin/env bash
# Hosted demo — ENCRYPTED on-box backup (owner decision 28 Sep 2026, option C: off-site deferred until
# before real data). Wraps the verified `scripts/backup.mjs` (checksummed manifest + control totals):
#   • the plain dump is written ONLY to RAM (/dev/shm), never to disk;
#   • it is encrypted with `age` to the PUBLIC recipient key in /etc/sre-pilot/backup-recipient.txt —
#     the box can lock a backup but can NOT unlock it: the private key is held by the owner, off the box;
#   • the RAM copy is shredded; only <id>.dump.age + <id>.manifest.json land in /var/lib/sre-pilot/backups.
# Nothing is ever deleted from the backup folder (retention is a later owner decision).
# Restore: infra/pilot/backup/restore-encrypted.sh (needs the owner's private key, brought back briefly).
#
# PA-12 round 6 — the job REPORTS ITS OWN OUTCOME to head office on every exit, success and failure
# (scripts/report-backup.mjs → POST /v1/platform/backups/:id/taken), with what it measured: start and end, the
# encrypted file's size and sha256, whether it is really encrypted, and whether the operator's off-site copy step
# (SRE_BACKUP_OFFSITE_CMD, given the file's path; exit 0 = copy confirmed) confirmed the copy. It signs in as its own
# machine identity: SRE_BACKUP_REPORT_API_URL and SRE_BACKUP_REPORT_TOKEN come from the operator's EnvironmentFile
# (sre-pilot-backup.service), never from this repo. If the report cannot be made the job FAILS loudly — and head
# office, hearing nothing, raises the backup as MISSED by itself when it falls due.
#
# The paths below are the demo box's; SRE_BACKUP_* overrides exist so the rehearsal test runs this very script.
set -euo pipefail
REPO=${SRE_BACKUP_REPO:-/opt/sre/app}
ENV_FILE=${SRE_BACKUP_ENV_FILE:-"$REPO/infra/compose/.env.pilot"}
OUT=${SRE_BACKUP_OUT:-/var/lib/sre-pilot/backups}
RECIPIENT=${SRE_BACKUP_RECIPIENT:-/etc/sre-pilot/backup-recipient.txt}

STARTED=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
RUN_ID="bk-run-$(date -u +%Y-%m-%dT%H-%M-%S)"
STEP="starting"
REPORTED=0
WORK=""

cleanup() {
  [ -n "$WORK" ] && { find "$WORK" -type f -exec shred -u {} + 2>/dev/null || true; rm -rf "$WORK"; }
}
on_exit() {
  status=$?
  cleanup
  if [ "$REPORTED" = 0 ] && [ "$status" != 0 ]; then
    # A failure is reported as a failure, naming the step — never left for someone to notice.
    node "$REPO/scripts/report-backup.mjs" --failed --id "$RUN_ID" --started "$STARTED" \
      --reason "exited $status while $STEP" || true
  fi
  exit "$status"
}
trap on_exit EXIT

STEP="checking the recipient key"
[ -s "$RECIPIENT" ] || { echo "REFUSED — no backup recipient key at $RECIPIENT" >&2; exit 2; }
grep -q '^age1' "$RECIPIENT" || { echo "REFUSED — $RECIPIENT is not an age public key" >&2; exit 2; }
install -d -m 700 "$OUT"

WORK=$(mktemp -d /dev/shm/sre-backup.XXXXXX)   # shredded by on_exit → cleanup, on every exit path

# The connection carries NO password: libpq (pg_dump / psql) reads it from PGPASSWORD, so it never
# appears in a URL, a process listing or any output.
val() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-; }
PGPASSWORD=$(val POSTGRES_PASSWORD)
DATABASE_URL="postgresql://$(val POSTGRES_USER)@127.0.0.1:$(val POSTGRES_PORT || true)/$(val POSTGRES_DB)"
DATABASE_URL=${DATABASE_URL/127.0.0.1:\//127.0.0.1:5432/}
export PGPASSWORD
export DATABASE_URL BACKUP_ENCRYPTED=true

STEP="taking the database dump"
node "$REPO/scripts/backup.mjs" --out "$WORK" | grep -E 'sha256|rows|complete'

REPORT_FAILED=0
for dump in "$WORK"/*.dump; do
  id=$(basename "$dump" .dump)
  RUN_ID="$id"
  STEP="encrypting $id"
  age -R "$RECIPIENT" -o "$OUT/$id.dump.age" "$dump"
  install -m 600 "$WORK/$id.manifest.json" "$OUT/$id.manifest.json"
  chmod 600 "$OUT/$id.dump.age"
  head -c 22 "$OUT/$id.dump.age" | grep -q 'age-encryption.org/v1' || { echo "RED — $id did not encrypt" >&2; exit 1; }
  echo "encrypted  $OUT/$id.dump.age  ($(stat -c %s "$OUT/$id.dump.age") bytes; plain copy only ever in RAM, shredded)"

  # The off-site copy: confirmed only when the operator's copy step ran and said so (exit 0).
  STEP="copying $id off-site"
  OFFSITE=(--offsite-detail "no off-site copy step is configured (SRE_BACKUP_OFFSITE_CMD)")
  if [ -n "${SRE_BACKUP_OFFSITE_CMD:-}" ]; then
    if "$SRE_BACKUP_OFFSITE_CMD" "$OUT/$id.dump.age"; then OFFSITE=(--offsite-confirmed)
    else OFFSITE=(--offsite-detail "the off-site copy step failed"); fi
  fi

  STEP="reporting $id to head office"
  REPORTED=1
  node "$REPO/scripts/report-backup.mjs" --ok --id "$id" --started "$STARTED" --artefact "$OUT/$id.dump.age" "${OFFSITE[@]}" \
    || REPORT_FAILED=1
done
[ "$REPORT_FAILED" = 0 ] || { echo "RED — the backup was taken but head office was NOT told" >&2; exit 3; }
