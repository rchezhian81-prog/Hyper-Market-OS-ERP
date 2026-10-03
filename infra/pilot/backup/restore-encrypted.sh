#!/usr/bin/env bash
# Restore an ENCRYPTED demo backup into a target database (see encrypted-backup.sh).
#   RESTORE_TARGET_URL=postgres://… infra/pilot/backup/restore-encrypted.sh <backup-id> <private-key-file> [--force]
# The private key is the owner's, brought to the box only for the restore. The backup is unlocked into
# RAM next to its manifest, then the normal scripts/restore.mjs runs: checksum verified, target must be
# empty unless --force, control totals must reconcile exactly. The RAM copy is shredded afterwards.
set -euo pipefail
REPO=/opt/sre/app
BACKUPS=/var/lib/sre-pilot/backups
id=${1:?backup id, e.g. bk-2026-09-28T07-23-00-932Z}
key=${2:?path to the owner private key file}
shift 2
[ -n "${RESTORE_TARGET_URL:-}" ] || { echo "Set RESTORE_TARGET_URL (never on the command line)." >&2; exit 2; }
WORK=$(mktemp -d /dev/shm/sre-restore.XXXXXX)
cleanup() { find "$WORK" -type f -exec shred -u {} + 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
age -d -i "$key" -o "$WORK/$id.dump" "$BACKUPS/$id.dump.age"
cp "$BACKUPS/$id.manifest.json" "$WORK/$id.manifest.json"
node "$REPO/scripts/restore.mjs" --manifest "$WORK/$id.manifest.json" "$@"
