// Take a verified backup (M35-FR-01). Produces the artefact AND a manifest carrying
// its checksum and the control totals of the data inside it — because a backup you
// cannot prove is a file, not a backup.
//
// The dump and the control totals come from ONE database snapshot (audit GT-07): a
// REPEATABLE READ transaction exports its snapshot, the totals are read inside it,
// and pg_dump --snapshot dumps exactly that moment. The manifest records the
// snapshot and the latest durable boundary. See scripts/lib/backup-snapshot.mjs.
//
// Usage: node scripts/backup.mjs [--out DIR]
// Reads DATABASE_URL from the environment. Never takes a credential on the command
// line, where it would land in shell history and process listings.

import { takeBackup } from './lib/backup-snapshot.mjs';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set. Refusing to guess where your data lives.');
  process.exit(2);
}

const outDir = argValue('--out') ?? 'backups';
const { manifest, manifestPath } = await takeBackup({ databaseUrl: url, outDir, log: (line) => console.log(line) });

console.log(`  manifest ${manifestPath}`);
console.log(`  snapshot ${manifest.consistency.snapshotId} (txids ${manifest.consistency.txidSnapshot}, taken ${manifest.consistency.takenAt})`);
console.log(`  boundary event seq ${manifest.consistency.latestEventSeq ?? 'none'}, newest event ${manifest.consistency.latestEventAt ?? 'none'}`);
console.log(`  sha256   ${manifest.checksum}`);
console.log(`  rows     ${JSON.stringify(manifest.controlTotals.rowCounts)}`);
console.log(`Backup ${manifest.backupId} complete.`);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
