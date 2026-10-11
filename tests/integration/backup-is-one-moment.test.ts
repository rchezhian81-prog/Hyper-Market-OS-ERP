import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
// @ts-expect-error — a plain ES module script with no type declarations; exercised exactly as the CLI runs it.
import { takeBackup } from '../../scripts/lib/backup-snapshot.mjs';

/**
 * **A backup's dump and its manifest come from ONE database moment (audit GT-07 · QG-08 · MG-02 · M35-FR-01).**
 *
 * The audit found the dump and the reconciliation manifest taken at different moments: `pg_dump` first, the row counts
 * and money totals afterwards on another connection. Sales committed in between were in one and not the other.
 *
 * Proven here on real PostgreSQL, in throw-away databases made for this run (synthetic data, hard rule #7):
 *   • sales are recorded; the backup starts; WHILE it runs (after its snapshot, before the totals and the dump) more
 *     sales commit — the old window;
 *   • the manifest's counts and money equal exactly what the snapshot held, and the dump holds exactly that too;
 *   • the manifest names the snapshot and the latest durable boundary (the newest event sequence it contains);
 *   • restored into an EMPTY, isolated database with `scripts/restore.mjs` (checksum checked, totals re-counted), it
 *     reconciles exactly — and the sales that committed during the backup are, correctly, in neither.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

const RUN = Date.now().toString(36);
const SOURCE_DB = `gt07_src_${RUN}`;
const TARGET_DB = `gt07_dst_${RUN}`;
const TENANT = randomUUID();
const urlFor = (db: string): string => { const u = new URL(DATABASE_URL!); u.pathname = `/${db}`; return u.toString(); };

describeOrSkip('a backup is one database moment, and restores exactly into an empty database (GT-07)', () => {
  let admin: Pool;
  let source: Pool;
  let target: Pool | undefined;
  const out = mkdtempSync(join(tmpdir(), 'gt07-'));

  const sale = (n: number, totalMinor: number) => makeEvent({
    id: `sale-${RUN}-${n}`, type: 'SaleCommitted', occurredAt: new Date(Date.now() - 60_000 + n).toISOString(),
    idempotencyKey: `sale-${TENANT}-${RUN}-${n}`, source: 'api/pos', payload: { saleId: `S-${n}`, totalMinor },
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: urlFor('postgres'), max: 1 });
    admin.on('error', () => { /* a scratch database is dropped WITH (FORCE); its idle connections are cut */ });
    await admin.query(`CREATE DATABASE ${SOURCE_DB}`);
    source = new Pool({ connectionString: urlFor(SOURCE_DB), max: 2, options: '-c app.tenant_id=*' });
    source.on('error', () => { /* a scratch database is dropped WITH (FORCE); its idle connections are cut */ });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(source), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    const store = new SqlEventStore(pgPoolClient(source));
    await store.registerTenant(TENANT, 'tests/gt07');
    for (let n = 1; n <= 5; n += 1) await store.append(TENANT, 'sales', sale(n, n * 10_000)); // ₹1,500.00 in all
  }, 60_000);

  afterAll(async () => {
    await source?.end();
    await target?.end();
    // Scratch databases made for this run only — synthetic, never a shop's data.
    await admin?.query(`DROP DATABASE IF EXISTS ${SOURCE_DB} WITH (FORCE)`);
    await admin?.query(`DROP DATABASE IF EXISTS ${TARGET_DB} WITH (FORCE)`);
    await admin?.end();
    rmSync(out, { recursive: true, force: true });
  });

  it('writes that commit during the backup are in neither the dump nor the manifest; the restore reconciles exactly', async () => {
    const store = new SqlEventStore(pgPoolClient(source));
    const before = Number((await source.query('SELECT count(*)::int AS n FROM event_ledger')).rows[0].n);
    let duringSnapshot = '';

    const { manifest, manifestPath } = await takeBackup({
      databaseUrl: urlFor(SOURCE_DB), outDir: out, env: process.env,
      // The window the old backup straddled: three more sales commit after the snapshot, before the totals and dump.
      onSnapshot: async ({ snapshotId }: { snapshotId: string }) => {
        duringSnapshot = snapshotId;
        for (let n = 6; n <= 8; n += 1) await store.append(TENANT, 'sales', sale(n, 99_000));
      },
    });

    const live = Number((await source.query('SELECT count(*)::int AS n FROM event_ledger')).rows[0].n);
    expect(live).toBe(before + 3); // the three really committed…
    expect(manifest.controlTotals.rowCounts.event_ledger).toBe(before); // …and the manifest is the snapshot's, not the live table's
    expect(manifest.controlTotals.valueTotals.SaleCommitted).toBe(150_000);
    expect(manifest.consistency).toMatchObject({ method: 'exported_snapshot', isolation: 'repeatable_read', snapshotId: duringSnapshot });
    const maxSeqInSnapshot = Number((await source.query(`SELECT max(seq)::int AS s FROM event_ledger WHERE idempotency_key NOT LIKE '%-${RUN}-6' AND idempotency_key NOT LIKE '%-${RUN}-7' AND idempotency_key NOT LIKE '%-${RUN}-8'`)).rows[0].s);
    expect(manifest.consistency.latestEventSeq).toBe(maxSeqInSnapshot);
    expect(manifest.checksum).toMatch(/^[0-9a-f]{64}$/);

    // Restore into an EMPTY, isolated database — the production restore tool, as the operator runs it.
    await admin.query(`CREATE DATABASE ${TARGET_DB}`);
    const said = execFileSync('node', ['scripts/restore.mjs', '--manifest', manifestPath, '--target', urlFor(TARGET_DB)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(said).toMatch(/checksum verified/);
    expect(said).toMatch(/Restore reconciles exactly against the manifest/);
    expect(said).toMatch(new RegExp(`snapshot ${duringSnapshot}`));

    target = new Pool({ connectionString: urlFor(TARGET_DB), max: 1, options: '-c app.tenant_id=*' });
    target.on('error', () => { /* a scratch database is dropped WITH (FORCE); its idle connections are cut */ });
    expect(Number((await target.query('SELECT count(*)::int AS n FROM event_ledger')).rows[0].n)).toBe(before);
    expect(Number((await target.query(`SELECT coalesce(sum((payload->>'totalMinor')::bigint),0)::bigint AS t FROM event_ledger WHERE type='SaleCommitted'`)).rows[0].t)).toBe(150_000);
    // The sales that committed during the backup are, correctly, not in it — the next backup takes them.
    expect(Number((await target.query(`SELECT count(*)::int AS n FROM event_ledger WHERE (payload->>'totalMinor')::bigint = 99000`)).rows[0].n)).toBe(0);
  }, 120_000);

  it('a restore into a database that already holds tables is refused — never a silent overwrite', () => {
    const manifest = readdirSync(out).find((f) => f.endsWith('.manifest.json'))!;
    let refused = '';
    try {
      execFileSync('node', ['scripts/restore.mjs', '--manifest', join(out, manifest), '--target', urlFor(TARGET_DB)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      refused = String((e as { stderr?: string }).stderr ?? '');
    }
    expect(refused).toMatch(/REFUSED: the target already has/);
  }, 60_000);
});
