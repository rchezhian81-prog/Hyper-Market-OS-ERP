// The recovery rehearsal (audit PA-12 · M35-FR-01/02/03 · QG-08) — the software half of "off-site recovery rehearsed
// on a spare machine". The off-site destination and its custodians are the owner's to choose (an external dependency);
// this is everything the software can prove before that choice is made:
//
//   1. take a backup — one database snapshot (GT-07), checksummed, with its control totals;
//   2. copy it to the off-site folder and make the copies read-only there; re-read the copy and check its checksum
//      (a copy that differs from what was taken is refused, never trusted);
//   3. restore FROM THE OFF-SITE COPY into an empty, separate database — what a spare machine does on the bad day;
//   4. reconcile the restored database against the manifest (scripts/restore.mjs — rows and money to the paisa);
//   5. write the rehearsal record: what was restored, from where, the boundary it holds (the newest event), and how
//      long each step took — the measured recovery time, against the §32 target.
//
// Nothing is deleted anywhere (hard rule #6): backups and off-site copies are kept; the rehearsal record is a new file.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { takeBackup } from './backup-snapshot.mjs';

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Rehearse a recovery. `sourceUrl` is the database backed up; `targetUrl` an EMPTY database standing in for the spare
 * machine; `offsiteDir` the off-site folder (in a real rehearsal, the mounted off-site store). `tamper` (tests only)
 * runs on the off-site copy before it is checked, to prove a damaged copy is refused.
 */
export async function rehearseRecovery({ sourceUrl, targetUrl, workDir, offsiteDir, env = process.env, tamper, log = () => {} }) {
  const t0 = Date.now();
  const { manifest, manifestPath, artefact } = await takeBackup({ databaseUrl: sourceUrl, outDir: workDir, env, log });
  const tBackup = Date.now();

  // 2. Off-site: copy both files, make them read-only, then re-read the COPY and check it.
  mkdirSync(offsiteDir, { recursive: true });
  const offsiteDump = join(offsiteDir, basename(artefact));
  const offsiteManifest = join(offsiteDir, basename(manifestPath));
  copyFileSync(artefact, offsiteDump);
  copyFileSync(manifestPath, offsiteManifest);
  if (tamper !== undefined) tamper(offsiteDump);
  chmodSync(offsiteDump, 0o444);
  chmodSync(offsiteManifest, 0o444);
  const offsiteChecksum = sha256(offsiteDump);
  const tCopy = Date.now();
  if (offsiteChecksum !== manifest.checksum) {
    const record = {
      rehearsalId: `rehearsal-${manifest.backupId}`, outcome: 'refused_offsite_copy_damaged', backupId: manifest.backupId,
      expectedChecksum: manifest.checksum, offsiteChecksum, offsiteDir,
      detail: 'the off-site copy does not match what was taken — it was not restored, and it must not be relied on',
    };
    writeFileSync(join(workDir, `${record.rehearsalId}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  // 3 + 4. Restore FROM THE OFF-SITE COPY into the empty spare database, and reconcile (the production restore tool).
  let restoreSaid = '';
  let restored = false;
  try {
    restoreSaid = execFileSync('node', ['scripts/restore.mjs', '--manifest', offsiteManifest, '--target', targetUrl], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
    restored = /Restore reconciles exactly against the manifest/.test(restoreSaid);
  } catch (e) {
    restoreSaid = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const tRestore = Date.now();

  const record = {
    rehearsalId: `rehearsal-${manifest.backupId}`,
    outcome: restored ? 'restored_and_reconciled' : 'restore_not_accepted',
    backupId: manifest.backupId,
    restoredFrom: 'offsite_copy',
    offsiteDir,
    checksum: manifest.checksum,
    offsiteCopyReadOnly: true,
    // The boundary the restored service holds: every event up to this one; anything later is the recovery-point loss.
    boundary: manifest.consistency,
    controlTotals: { rowCounts: manifest.controlTotals.rowCounts, valueTotals: manifest.controlTotals.valueTotals },
    timingsMs: { backup: tBackup - t0, offsiteCopyAndCheck: tCopy - tBackup, restoreAndReconcile: tRestore - tCopy, total: tRestore - t0 },
    restoreOutput: restoreSaid.trim().split('\n').filter((l) => !/^\s+(rows|money)\s/.test(l)),
    detail: restored
      ? 'restored from the off-site copy into an empty database and reconciled exactly — rows and money match the manifest'
      : 'the restore from the off-site copy did NOT reconcile — do not rely on this backup; see restoreOutput',
  };
  writeFileSync(join(workDir, `${record.rehearsalId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  log(`  rehearsal ${record.outcome} in ${record.timingsMs.total} ms`);
  return record;
}
