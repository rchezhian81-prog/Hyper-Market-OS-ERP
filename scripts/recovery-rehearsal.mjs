// Rehearse an off-site recovery (audit PA-12 · M35-FR-01/02/03). See scripts/lib/recovery-rehearsal.mjs.
//
// Usage:
//   DATABASE_URL=… RESTORE_TARGET_URL=… node scripts/recovery-rehearsal.mjs --work DIR --offsite DIR
//
// DATABASE_URL is the database to back up; RESTORE_TARGET_URL an EMPTY database on the spare machine (the restore
// refuses one that already holds tables). Both come from the environment, never the command line, so no credential
// lands in shell history. --offsite is the off-site folder (in a real rehearsal, the mounted off-site store the owner
// chose). Writes rehearsal-<backupId>.json beside the backup: the outcome, the boundary restored, and the timings.

import { rehearseRecovery } from './lib/recovery-rehearsal.mjs';

const sourceUrl = process.env['DATABASE_URL'];
const targetUrl = process.env['RESTORE_TARGET_URL'];
const workDir = argValue('--work');
const offsiteDir = argValue('--offsite');
if (!sourceUrl || !targetUrl || !workDir || !offsiteDir) {
  console.error('Usage: DATABASE_URL=… RESTORE_TARGET_URL=… node scripts/recovery-rehearsal.mjs --work DIR --offsite DIR');
  process.exit(2);
}

const record = await rehearseRecovery({ sourceUrl, targetUrl, workDir, offsiteDir, log: (l) => console.log(l) });
console.log(`  outcome  ${record.outcome}`);
if (record.boundary) console.log(`  boundary event seq ${record.boundary.latestEventSeq ?? 'none'} (${record.boundary.latestEventAt ?? 'none'})`);
if (record.timingsMs) console.log(`  timings  ${JSON.stringify(record.timingsMs)}`);
console.log(`  record   ${workDir}/${record.rehearsalId}.json`);
process.exit(record.outcome === 'restored_and_reconciled' ? 0 : 1);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
