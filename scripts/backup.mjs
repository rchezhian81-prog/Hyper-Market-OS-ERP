// Take a verified backup (M35-FR-01). Produces the artefact AND a manifest carrying
// its checksum and the control totals of the data inside it — because a backup you
// cannot prove is a file, not a backup.
//
// Usage: node scripts/backup.mjs [--out DIR]
// Reads DATABASE_URL from the environment. Never takes a credential on the command
// line, where it would land in shell history and process listings.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set. Refusing to guess where your data lives.');
  process.exit(2);
}

const outDir = argValue('--out') ?? 'backups';
const startedAt = new Date().toISOString();
const backupId = `bk-${startedAt.replace(/[:.]/g, '-')}`;
mkdirSync(outDir, { recursive: true });
const artefact = join(outDir, `${backupId}.dump`);

console.log(`  taking  ${artefact}`);
// Custom format: compressed, and restorable table-by-table if a recovery needs it.
execFileSync('pg_dump', ['--format=custom', '--file', artefact, url], { stdio: 'inherit' });

const controlTotals = readControlTotals(url);
const bytes = readFileSync(artefact);
const manifest = {
  backupId,
  tenantScope: 'all',
  startedAt,
  completedAt: new Date().toISOString(),
  sizeBytes: statSync(artefact).size,
  checksum: createHash('sha256').update(bytes).digest('hex'),
  checksumAlgorithm: 'sha256',
  // Encryption at rest is provided by the storage layer in a deployment; locally the
  // artefact is unencrypted and the manifest says so rather than pretending.
  encrypted: process.env['BACKUP_ENCRYPTED'] === 'true',
  ...(process.env['BACKUP_OFFSITE'] ? { offsiteLocation: process.env['BACKUP_OFFSITE'] } : {}),
  controlTotals,
  schemaVersion: controlTotals.schemaVersion,
};
delete manifest.controlTotals.schemaVersion;

const manifestPath = join(outDir, `${backupId}.manifest.json`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`  manifest ${manifestPath}`);
console.log(`  sha256   ${manifest.checksum}`);
console.log(`  rows     ${JSON.stringify(manifest.controlTotals.rowCounts)}`);
console.log(`Backup ${backupId} complete.`);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Read the numbers a restore will have to reproduce exactly. */
function readControlTotals(connection) {
  const q = (sql) =>
    execFileSync('psql', [connection, '-t', '-A', '-F', '\t', '-c', sql], { encoding: 'utf8' }).trim();

  const rowCounts = {};
  const tables = q(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  )
    .split('\n')
    .filter(Boolean);
  for (const table of tables) {
    rowCounts[table] = Number(q(`SELECT count(*) FROM "${table}"`));
  }

  const valueTotals = {};
  if (tables.includes('event_ledger')) {
    // Summing the money inside the events catches a restore that has every row and
    // still lost data to a truncated column or a coerced type.
    const rows = q(
      `SELECT type, coalesce(sum((payload->>'totalMinor')::bigint), 0)
       FROM event_ledger WHERE payload ? 'totalMinor' GROUP BY type ORDER BY type`,
    );
    for (const line of rows.split('\n').filter(Boolean)) {
      const [type, total] = line.split('\t');
      valueTotals[type] = Number(total);
    }
  }

  const maxEventSeq = tables.includes('event_ledger')
    ? Number(q('SELECT coalesce(max(seq), 0) FROM event_ledger'))
    : undefined;
  const latestEventAt = tables.includes('event_ledger')
    ? q("SELECT coalesce(max(occurred_at)::text, '') FROM event_ledger") || undefined
    : undefined;
  const schemaVersion = tables.includes('schema_migrations')
    ? q("SELECT coalesce(max(name), '')  FROM schema_migrations")
    : 'unknown';

  return { rowCounts, valueTotals, maxEventSeq, latestEventAt, schemaVersion };
}
