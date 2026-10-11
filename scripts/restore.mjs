// Restore a backup and PROVE it (M35-FR-01 / QG-07 / QG-08).
//
// The restore is not finished when pg_restore exits zero. It is finished when the
// restored database reproduces the manifest's control totals exactly — same rows,
// same money, to the paisa. A restore that exits zero and loses 300 sales also
// exits zero.
//
// Usage: node scripts/restore.mjs --manifest PATH --target POSTGRES_URL [--force] [--shred-list-from SOURCE …]
//
// FUL-12 · ADR-0025: after the restore reconciles, the shredded-key list is RE-APPLIED — from this backup's own manifest
// and from every `--shred-list-from` SOURCE (the live database's URL, or a NEWER backup's manifest path) — so a key an
// erasure destroyed after this backup was taken is destroyed again in the restored database. The newest list wins.
// The target must be EMPTY unless --force is given: restoring over live data is a
// destructive act and is never the default.

import { execFileSync } from 'node:child_process';

// Row-level security (migration 0012): restoring and re-counting is the PLATFORM's view — every tenant — under the
// explicit operator scope `app.tenant_id=*`, so the copied rows pass the policies and the control totals see them.
// Declared first: every psql/pg_restore call below runs under it, including the "is the target empty?" check.
const PLATFORM_SCOPE = { ...process.env, PGOPTIONS: '-c app.tenant_id=*' };
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { readShredList, reapplyShredList, unionOf } from './lib/shred-list.mjs';

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
// GT-07: the one moment the dump and its control totals were taken from, and the latest durable boundary in it.
if (manifest.consistency?.method === 'exported_snapshot') {
  console.log(`  snapshot ${manifest.consistency.snapshotId} taken ${manifest.consistency.takenAt} — contains every event up to seq ${manifest.consistency.latestEventSeq ?? 'none'} (newest ${manifest.consistency.latestEventAt ?? 'none'})`);
} else {
  console.log('  WARNING: this backup predates one-snapshot backups (GT-07) — its control totals may have been read at a different moment from the dump; a mismatch below may be that, not data loss.');
}

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
  env: PLATFORM_SCOPE,
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

// 5. The shredded-key list wins (FUL-12 · ADR-0025) — re-applied AFTER the reconciliation, which proves the backup as taken.
const shredSources = process.argv.flatMap((a, i) => (a === '--shred-list-from' ? [process.argv[i + 1]] : [])).filter(Boolean);
const lists = [Array.isArray(manifest.shredList) ? manifest.shredList : []];
for (const source of shredSources) lists.push(await readShredList(source));
const shredEntries = unionOf(...lists);
const reapplied = await reapplyShredList({ targetUrl: target, entries: shredEntries });
console.log(`  shredded-key list re-applied: ${shredEntries.length} entr${shredEntries.length === 1 ? 'y' : 'ies'} from ${1 + shredSources.length} source(s); ${reapplied.added} added back, ${reapplied.destroyed} restored key(s) destroyed again`);
if (shredSources.length === 0) {
  console.log('  WARNING: no newer shredded-key list was given (--shred-list-from). An erasure carried out AFTER this backup');
  console.log('  is not re-applied yet — run this again with the live database URL or the newest backup manifest (ADR-0025).');
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
    encoding: 'utf8', env: PLATFORM_SCOPE,
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
