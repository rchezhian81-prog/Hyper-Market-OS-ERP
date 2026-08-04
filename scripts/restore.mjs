// Restore a backup and PROVE it (M35-FR-01 / QG-07 / QG-08).
//
// The restore is not finished when pg_restore exits zero. It is finished when the
// restored database reproduces the manifest's control totals exactly — same rows,
// same money, to the paisa. A restore that exits zero and loses 300 sales also
// exits zero.
//
// Usage: node scripts/restore.mjs --manifest PATH --target POSTGRES_URL [--force]
// The target must be EMPTY unless --force is given: restoring over live data is a
// destructive act and is never the default.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const manifestPath = argValue('--manifest');
const target = argValue('--target') ?? process.env['RESTORE_TARGET_URL'];
const force = process.argv.includes('--force');

if (!manifestPath || !target) {
  console.error('Usage: node scripts/restore.mjs --manifest PATH --target POSTGRES_URL [--force]');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const artefact = manifestPath.replace(/\.manifest\.json$/, '.dump');

// 1. The file must still be the file that was taken.
const actual = {
  sizeBytes: statSync(artefact).size,
  checksum: createHash('sha256').update(readFileSync(artefact)).digest('hex'),
};
if (actual.checksum !== manifest.checksum) {
  console.error('REFUSED: the artefact no longer matches its recorded checksum.');
  console.error(`  expected ${manifest.checksum}`);
  console.error(`  actual   ${actual.checksum}`);
  console.error('It is truncated, corrupted or was altered. Do not rely on this backup.');
  process.exit(1);
}
console.log(`  checksum verified (${actual.sizeBytes} bytes)`);

// 2. Never silently overwrite a database that has something in it.
const existing = Number(
  psql(target, "SELECT count(*) FROM pg_tables WHERE schemaname='public'"),
);
if (existing > 0 && !force) {
  console.error(`REFUSED: the target already has ${existing} table(s).`);
  console.error('Restoring over live data is destructive. Re-run with --force if that is intended.');
  process.exit(1);
}

// 3. Restore.
console.log(`  restoring into the target database`);
execFileSync('pg_restore', ['--dbname', target, '--no-owner', '--no-privileges', artefact], {
  stdio: 'inherit',
});

// 4. Prove it — the step that makes this a restore rather than a hope.
const restored = readControlTotals(target);
const differences = [];
for (const [table, expected] of Object.entries(manifest.controlTotals.rowCounts)) {
  const got = restored.rowCounts[table] ?? 0;
  if (got !== expected) differences.push(`${table}: expected ${expected} rows, got ${got}`);
}
for (const [stream, expected] of Object.entries(manifest.controlTotals.valueTotals ?? {})) {
  const got = restored.valueTotals[stream] ?? 0;
  if (got !== expected) differences.push(`${stream}: expected ${expected} minor units, got ${got}`);
}
if ((manifest.controlTotals.maxEventSeq ?? 0) !== (restored.maxEventSeq ?? 0)) {
  differences.push(
    `event_ledger reached seq ${restored.maxEventSeq}, backup reached ${manifest.controlTotals.maxEventSeq}`,
  );
}

if (differences.length > 0) {
  console.error('\nRESTORE NOT ACCEPTED — the data does not reconcile:');
  for (const d of differences) console.error(`  ${d}`);
  process.exit(1);
}

console.log('\n✅  Restore reconciles exactly against the manifest.');
console.log(`   tables ${Object.keys(manifest.controlTotals.rowCounts).length}`);
console.log(`   rows   ${JSON.stringify(manifest.controlTotals.rowCounts)}`);
console.log(`   money  ${JSON.stringify(manifest.controlTotals.valueTotals ?? {})}`);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function psql(connection, sql) {
  return execFileSync('psql', [connection, '-t', '-A', '-F', '\t', '-c', sql], {
    encoding: 'utf8',
  }).trim();
}

function readControlTotals(connection) {
  const rowCounts = {};
  const tables = psql(connection, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    .split('\n')
    .filter(Boolean);
  for (const table of tables) {
    rowCounts[table] = Number(psql(connection, `SELECT count(*) FROM "${table}"`));
  }
  const valueTotals = {};
  if (tables.includes('event_ledger')) {
    const rows = psql(
      connection,
      `SELECT type, coalesce(sum((payload->>'totalMinor')::bigint), 0)
       FROM event_ledger WHERE payload ? 'totalMinor' GROUP BY type ORDER BY type`,
    );
    for (const line of rows.split('\n').filter(Boolean)) {
      const [type, total] = line.split('\t');
      valueTotals[type] = Number(total);
    }
  }
  const maxEventSeq = tables.includes('event_ledger')
    ? Number(psql(connection, 'SELECT coalesce(max(seq), 0) FROM event_ledger'))
    : 0;
  return { rowCounts, valueTotals, maxEventSeq };
}
