// The backup job reports its OWN outcome to head office (PA-12 round 6 · M35-FR-01/03 · P-08 no silent failure).
//
// Before, backup health rested on a record somebody posted by hand; the real job (infra/pilot/backup/encrypted-backup.sh)
// never said anything, so a night it failed — or never ran — looked exactly like a night nobody asked. Now the job
// posts `POST /v1/platform/backups/:backupId/taken` itself, on success AND on failure, with only what it MEASURED:
//   • when it started and ended;
//   • the kept (encrypted) file's size in bytes and its sha256, computed from the bytes on disk here;
//   • whether that file really is encrypted (it starts with the `age` header) — not whether someone said so;
//   • whether the operator's off-site copy step confirmed the copy (it exited 0) — false when there is none.
//
// Credentials (hard rule #4): the job signs in as its OWN machine identity (role `backup_job`, one permission), with a
// token the OPERATOR provisions into its environment — `SRE_BACKUP_REPORT_API_URL` and `SRE_BACKUP_REPORT_TOKEN`, from
// an EnvironmentFile only root can read. Nothing here mints, prints, logs or writes the token. Missing either: the job
// says "NOT REPORTED" and fails loudly — and head office, hearing nothing, raises the backup as MISSED by itself.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/** The header every `age`-encrypted file begins with. */
export const AGE_HEADER = 'age-encryption.org/v1';

/** Where to report and as whom — from the job's environment only. Never from argv (shell history, process listings). */
export function reporterFromEnv(env = process.env) {
  const apiUrl = (env['SRE_BACKUP_REPORT_API_URL'] ?? '').trim();
  const token = (env['SRE_BACKUP_REPORT_TOKEN'] ?? '').trim();
  const missing = [...(apiUrl === '' ? ['SRE_BACKUP_REPORT_API_URL'] : []), ...(token === '' ? ['SRE_BACKUP_REPORT_TOKEN'] : [])];
  if (missing.length > 0) return { configured: false, missing };
  if (!/^https?:\/\//.test(apiUrl)) return { configured: false, missing: ['SRE_BACKUP_REPORT_API_URL (not an http(s) URL)'] };
  return { configured: true, apiUrl: apiUrl.replace(/\/+$/, ''), token };
}

/** Measure the kept file: size, sha256 and whether it is really encrypted — from its bytes, nothing taken on trust. */
export function measureArtefact(path) {
  const bytes = readFileSync(path);
  return {
    sizeBytes: statSync(path).size,
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    encrypted: bytes.subarray(0, AGE_HEADER.length).toString('latin1') === AGE_HEADER,
  };
}

/**
 * The record head office keeps. A SUCCESS carries the measured facts; a FAILURE says it did not complete and why. A
 * success whose file is not encrypted, or whose off-site copy was not confirmed, is still reported as it is — head
 * office decides it does not count (and says why), never this script.
 */
export function backupReportBody(outcome) {
  const base = { at: outcome.startedAt, endedAt: outcome.endedAt };
  if (outcome.ok) {
    return {
      ...base, ok: true, encrypted: outcome.measured.encrypted, offsite: outcome.offsiteConfirmed === true,
      sizeBytes: outcome.measured.sizeBytes, checksum: outcome.measured.checksum,
      detail: outcome.offsiteConfirmed === true ? 'reported by the backup job; off-site copy confirmed by the operator\'s copy step'
        : `reported by the backup job; off-site copy NOT confirmed${outcome.offsiteDetail ? ` (${outcome.offsiteDetail})` : ''}`,
    };
  }
  return {
    ...base, ok: false, encrypted: false, offsite: false,
    detail: `the backup job failed: ${String(outcome.reason ?? 'no reason given').slice(0, 500)}`,
  };
}

/**
 * Post the outcome. Idempotent on the backup id: a retry after a lost answer is the same record, and head office's
 * "already recorded" (409) means it already has it. Returns { reported, status, body }.
 */
export async function reportBackupOutcome({ reporter, backupId, body, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${reporter.apiUrl}/v1/platform/backups/${encodeURIComponent(backupId)}/taken`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${reporter.token}`,
      'idempotency-key': `backup-job-${backupId}`,
    },
    body: JSON.stringify(body),
  });
  let parsed;
  try { parsed = await res.json(); } catch { parsed = undefined; }
  const already = res.status === 409 && parsed?.error?.code === 'backup_already_recorded';
  return { reported: res.status === 201 || res.status === 200 || already, status: res.status, body: parsed };
}
