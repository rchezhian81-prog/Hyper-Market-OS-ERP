// One backup, ONE database moment (audit GT-07 · QG-08 · MG-02 · M35-FR-01).
//
// The backup used to run `pg_dump` and then, afterwards and on another connection, count the rows and sum the money
// for the manifest. Anything committed between the two landed in one and not the other: the dump held a sale the
// manifest never counted (or the reverse), so a perfectly good restore "failed" to reconcile — or, worse, a restore
// missing a sale reconciled against a manifest that had also missed it.
//
// Now both come from the same snapshot:
//   1. one connection opens a REPEATABLE READ, READ ONLY transaction and exports its snapshot (`pg_export_snapshot`);
//   2. the control totals are read INSIDE that transaction — they see exactly that moment;
//   3. `pg_dump --snapshot=<id>` dumps exactly that moment too, while the exporting transaction is still open;
//   4. the transaction ends only after the dump has finished.
// The manifest records the snapshot id, the transaction snapshot (`pg_current_snapshot()` — the latest durable
// boundary: every transaction committed before it is in, none after), the newest event sequence and time, and the
// dump's sha256. Writes that commit while the backup runs are in NEITHER the dump nor the totals — the next backup
// takes them — and the manifest says where the line was drawn.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/** The operator's view of every tenant (row-level security, migration 0012): set explicitly, never by the API. */
export const PLATFORM_OPTIONS = '-c app.tenant_id=*';

/**
 * Take a backup of `databaseUrl` into `outDir`. `onSnapshot` (tests only) runs after the snapshot is exported and
 * before the totals are read and the dump is taken — the window in which the old backup could disagree with itself.
 * Returns the manifest and where it and the artefact were written.
 */
export async function takeBackup({ databaseUrl, outDir, env = process.env, onSnapshot, log = () => {} }) {
  const startedAt = new Date().toISOString();
  const backupId = `bk-${startedAt.replace(/[:.]/g, '-')}`;
  mkdirSync(outDir, { recursive: true });
  const artefact = join(outDir, `${backupId}.dump`);

  const client = new pg.Client({ connectionString: databaseUrl, options: PLATFORM_OPTIONS });
  await client.connect();
  let manifest;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snap = (await client.query(
      'SELECT pg_export_snapshot() AS snapshot_id, pg_current_snapshot()::text AS txid_snapshot, now() AS taken_at',
    )).rows[0];
    if (onSnapshot !== undefined) await onSnapshot({ snapshotId: snap.snapshot_id });

    // The control totals, read inside the SAME transaction the dump imports — one moment, two views of it.
    const controlTotals = await readControlTotals(client);

    log(`  taking  ${artefact} (snapshot ${snap.snapshot_id})`);
    // Custom format: compressed, restorable table-by-table. `--snapshot` makes pg_dump see exactly the exported
    // moment; `--enable-row-security` + the platform scope let it read every tenant's rows under the policies.
    execFileSync('pg_dump', ['--format=custom', '--enable-row-security', `--snapshot=${snap.snapshot_id}`, '--file', artefact, databaseUrl], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...env, PGOPTIONS: PLATFORM_OPTIONS },
    });

    const bytes = readFileSync(artefact);
    const { schemaVersion, ...totals } = controlTotals;
    manifest = {
      backupId,
      tenantScope: 'all',
      startedAt,
      completedAt: new Date().toISOString(),
      sizeBytes: statSync(artefact).size,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      checksumAlgorithm: 'sha256',
      // GT-07: the one moment both the dump and the totals were taken from, and where the durable line was drawn.
      consistency: {
        method: 'exported_snapshot',
        isolation: 'repeatable_read',
        snapshotId: snap.snapshot_id,
        txidSnapshot: snap.txid_snapshot,
        takenAt: new Date(snap.taken_at).toISOString(),
        latestEventSeq: totals.maxEventSeq ?? null,
        latestEventAt: totals.latestEventAt ?? null,
      },
      // Encryption at rest is the storage layer's in a deployment; locally the artefact is unencrypted and the
      // manifest says so rather than pretending.
      encrypted: env['BACKUP_ENCRYPTED'] === 'true',
      ...(env['BACKUP_OFFSITE'] ? { offsiteLocation: env['BACKUP_OFFSITE'] } : {}),
      controlTotals: totals,
      schemaVersion,
    };
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }

  const manifestPath = join(outDir, `${backupId}.manifest.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath, artefact };
}

/** The numbers a restore must reproduce exactly, read on `client` (inside whatever transaction it holds). */
export async function readControlTotals(client) {
  const q = async (sql) => (await client.query(sql)).rows;
  const tables = (await q("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map((r) => r.tablename);
  const rowCounts = {};
  for (const table of tables) {
    rowCounts[table] = Number((await q(`SELECT count(*)::bigint AS n FROM "${table}"`))[0].n);
  }
  const valueTotals = {};
  let maxEventSeq;
  let latestEventAt;
  if (tables.includes('event_ledger')) {
    // Summing the money inside the events catches a restore that has every row and still lost data to a truncated
    // column or a coerced type.
    for (const r of await q(`SELECT type, coalesce(sum((payload->>'totalMinor')::bigint), 0)::bigint AS total
                             FROM event_ledger WHERE payload ? 'totalMinor' GROUP BY type ORDER BY type`)) {
      valueTotals[r.type] = Number(r.total);
    }
    maxEventSeq = Number((await q('SELECT coalesce(max(seq), 0)::bigint AS s FROM event_ledger'))[0].s);
    const latest = (await q('SELECT max(occurred_at) AS at FROM event_ledger'))[0].at;
    latestEventAt = latest === null ? undefined : new Date(latest).toISOString();
  }
  const schemaVersion = tables.includes('schema_migrations')
    ? ((await q("SELECT coalesce(max(name), '') AS v FROM schema_migrations"))[0].v)
    : 'unknown';
  return { rowCounts, valueTotals, maxEventSeq, latestEventAt, schemaVersion };
}
