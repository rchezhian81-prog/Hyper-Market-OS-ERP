import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
// @ts-expect-error — a plain ES module script with no type declarations; exercised exactly as the CLI runs it.
import { rehearseRecovery } from '../../scripts/lib/recovery-rehearsal.mjs';

/**
 * **The off-site recovery is rehearsed: restored FROM the off-site copy onto an empty "spare machine" database, and
 * reconciled (audit PA-12 · M35-FR-01/02/03 · QG-08) — the software half.**
 *
 * The off-site destination and its custodians are the owner's choice (an external dependency). What the software must
 * prove first, on real PostgreSQL in throw-away databases (synthetic data, hard rule #7):
 *   • the backup is copied off-site, the copies are made read-only, and the COPY is re-checked against the checksum;
 *   • the restore runs from the off-site copy into an empty database and reconciles exactly (rows and money);
 *   • the rehearsal leaves a record: the outcome, the boundary restored (newest event), and the measured timings;
 *   • an off-site copy that differs from what was taken is REFUSED and never restored.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;
const RUN = Date.now().toString(36);
const SOURCE = `pa12_src_${RUN}`;
const SPARE = `pa12_spare_${RUN}`;
const SPARE2 = `pa12_spare2_${RUN}`;
const TENANT = randomUUID();
const urlFor = (db: string): string => { const u = new URL(DATABASE_URL!); u.pathname = `/${db}`; return u.toString(); };

describeOrSkip('off-site recovery rehearsal onto a spare database (PA-12)', () => {
  let admin: Pool;
  const work = mkdtempSync(join(tmpdir(), 'pa12-work-'));
  const offsite = mkdtempSync(join(tmpdir(), 'pa12-offsite-'));

  beforeAll(async () => {
    admin = new Pool({ connectionString: urlFor('postgres'), max: 1 });
    admin.on('error', () => { /* a scratch database is dropped WITH (FORCE); its idle connections are cut */ });
    for (const db of [SOURCE, SPARE, SPARE2]) await admin.query(`CREATE DATABASE ${db}`);
    const source = new Pool({ connectionString: urlFor(SOURCE), max: 2, options: '-c app.tenant_id=*' });
    source.on('error', () => { /* a scratch database is dropped WITH (FORCE); its idle connections are cut */ });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(source), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    const store = new SqlEventStore(pgPoolClient(source));
    await store.registerTenant(TENANT, 'tests/pa12');
    for (let n = 1; n <= 4; n += 1) {
      await store.append(TENANT, 'sales', makeEvent({ id: `s-${RUN}-${n}`, type: 'SaleCommitted', occurredAt: new Date(Date.now() - 60_000 + n).toISOString(), idempotencyKey: `s-${TENANT}-${n}`, source: 'api/pos', payload: { saleId: `S-${n}`, totalMinor: 25_000 } }));
    }
    await source.end();
  }, 60_000);

  afterAll(async () => {
    // Scratch databases and folders made for this run only — synthetic, never a shop's data.
    for (const db of [SOURCE, SPARE, SPARE2]) await admin?.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin?.end();
    rmSync(work, { recursive: true, force: true });
    rmSync(offsite, { recursive: true, force: true, maxRetries: 1 });
  });

  it('restores from the off-site copy into an empty spare database, reconciles exactly, and records the rehearsal', async () => {
    const record = await rehearseRecovery({ sourceUrl: urlFor(SOURCE), targetUrl: urlFor(SPARE), workDir: work, offsiteDir: offsite });
    expect(record.outcome).toBe('restored_and_reconciled');
    expect(record.restoredFrom).toBe('offsite_copy');
    expect(record.controlTotals.valueTotals.SaleCommitted).toBe(100_000);
    expect(record.boundary).toMatchObject({ method: 'exported_snapshot' });
    expect(record.timingsMs.total).toBeGreaterThan(0);
    // The off-site copies are read-only.
    for (const f of readdirSync(offsite)) expect(statSync(join(offsite, f)).mode & 0o222).toBe(0);
    // The spare database holds what was taken.
    const spare = new Pool({ connectionString: urlFor(SPARE), max: 1, options: '-c app.tenant_id=*' });
    spare.on('error', () => { /* a scratch database is dropped WITH (FORCE); its idle connections are cut */ });
    expect(Number((await spare.query(`SELECT coalesce(sum((payload->>'totalMinor')::bigint),0)::bigint AS t FROM event_ledger WHERE type='SaleCommitted'`)).rows[0].t)).toBe(100_000);
    await spare.end();
    // The rehearsal record is on disk beside the backup.
    expect(JSON.parse(readFileSync(join(work, `${record.rehearsalId}.json`), 'utf8'))).toMatchObject({ outcome: 'restored_and_reconciled' });
  }, 120_000);

  it('an off-site copy that differs from what was taken is refused, and never restored', async () => {
    const off2 = mkdtempSync(join(tmpdir(), 'pa12-offsite2-'));
    try {
      const record = await rehearseRecovery({
        sourceUrl: urlFor(SOURCE), targetUrl: urlFor(SPARE2), workDir: work, offsiteDir: off2,
        tamper: (path: string) => { appendFileSync(path, 'bit rot'); },
      });
      expect(record.outcome).toBe('refused_offsite_copy_damaged');
      const spare2 = new Pool({ connectionString: urlFor(SPARE2), max: 1 });
      spare2.on('error', () => { /* a scratch database is dropped WITH (FORCE); its idle connections are cut */ });
      expect(Number((await spare2.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n)).toBe(0);
      await spare2.end();
    } finally {
      rmSync(off2, { recursive: true, force: true });
    }
  }, 120_000);
});
