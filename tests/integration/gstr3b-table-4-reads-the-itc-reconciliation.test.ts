import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { seedItcShop, october2b, ITC_PERIOD, ACCOUNTANT } from '../support/itc-shop';

/**
 * **R3 seam — GSTR-3B Table 4 reads the A17 GSTR-2B / IMS reconciliation, on the real API, in memory AND on real
 * PostgreSQL, with a cold restart.** The GST returns lane asks for October 2026 as 102026; the input-credit lane keys it
 * 2026-10; the bridge (`services/api/src/r3-itc-bridge.ts`) joins them.
 *
 * No 2B uploaded → Table 4(A)(5) is "not reconciled", an exception, never zero. The 2B uploaded with its lines still
 * awaiting a person → still not reconciled, and it says how many lines wait. Every line accepted → Table 4 shows exactly
 * the accepted figures. A reversal is reported on its own as 4(B) — never netted off the 4(A) figure, never hidden.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const sqlHarness = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: sqlHarness, restart: sqlHarness });
}

type Res = { status: number; body: unknown };
interface Table4Itc { status: string; detail: string; igstMinor?: number; cgstMinor?: number; sgstMinor?: number; cessMinor?: number }
interface G3b { table4: { a5AllOther: Table4Itc }; exceptions: { code: string; detail: string }[] }

/** October's 2B with only the two lines the books hold exactly (A/101 and B-77) — so every line can be accepted. */
function matchedOnly2b(): unknown {
  const s = october2b() as { data: { docdata: { b2b: { inv: { inum: string }[] }[] } } };
  for (const sup of s.data.docdata.b2b) sup.inv = sup.inv.filter((i) => i.inum === 'A/101' || i.inum === 'B-77');
  return s;
}

describe.each(backings)('GSTR-3B Table 4 reads the GSTR-2B / IMS reconciliation — on $name (A15 ↔ A17)', ({ harness, restart }) => {
  it('no 2B → not reconciled · lines awaiting → not reconciled · all accepted → the accepted figures · reversal → 4(B), not netted', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, idempotencyKey?: string): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: idempotencyKey ?? `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    await seedItcShop({ call, owner: 'u-owner', grant: (u, r) => h.provisionRole(T, u, r), store: 'st-itc3b', createStore: true });
    const g3b = async (): Promise<G3b> => {
      const r = await call('GET', '/v1/finance/gstr3b/102026', 'u-owner');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as G3b;
    };
    const itcException = (g: G3b) => g.exceptions.find((e) => e.code === 'itc_not_yet_reconciled');

    // ── no 2B uploaded: not reconciled, said why — no figure at all, so it can never read as zero ──
    let g = await g3b();
    expect(g.table4.a5AllOther.status).toBe('not_reconciled');
    expect(g.table4.a5AllOther).not.toHaveProperty('igstMinor');
    expect(g.table4.a5AllOther.detail).toMatch(/ITC not reconciled for 102026 — no GSTR-2B has been uploaded for 2026-10/);
    expect(itcException(g)?.detail).toBe(g.table4.a5AllOther.detail);

    // ── the 2B uploaded, both lines awaiting a person: still not reconciled ──
    expect((await call('POST', `/v1/finance/itc/${ITC_PERIOD}/statement`, ACCOUNTANT, { statement: matchedOnly2b() })).status).toBe(201);
    g = await g3b();
    expect(g.table4.a5AllOther).toMatchObject({ status: 'not_reconciled', detail: expect.stringMatching(/2 line\(s\) of the 2026-10 GSTR-2B are awaiting/) });
    expect(itcException(g)).toBeDefined();

    const review = (await call('GET', `/v1/finance/itc/${ITC_PERIOD}`, ACCOUNTANT)).body as { lines: { lineId: string; invoiceNo: string }[] };
    const lineId = (no: string): string => review.lines.find((l) => l.invoiceNo === no)!.lineId;
    expect((await call('POST', `/v1/finance/itc/${ITC_PERIOD}/lines/${lineId('A/101')}/action`, ACCOUNTANT, { action: 'accept' })).status).toBe(201);
    // One of two: still not reconciled — never a part-figure.
    g = await g3b();
    expect(g.table4.a5AllOther).toMatchObject({ status: 'not_reconciled', detail: expect.stringMatching(/1 line\(s\)/) });
    expect(g.table4.a5AllOther).not.toHaveProperty('cgstMinor');
    expect((await call('POST', `/v1/finance/itc/${ITC_PERIOD}/lines/${lineId('B-77')}/action`, ACCOUNTANT, { action: 'accept' })).status).toBe(201);

    // ── a cold restart: Table 4 is folded from what is stored ──
    h = restart(h);
    g = await g3b();
    // Every line accepted: Table 4(A)(5) is the accepted figures — CGST ₹900 + SGST ₹900 (A/101), IGST ₹240 (B-77).
    expect(g.table4.a5AllOther).toMatchObject({ status: 'reconciled', igstMinor: 24_000, cgstMinor: 90_000, sgstMinor: 90_000, cessMinor: 0 });
    expect(g.table4.a5AllOther.detail).toMatch(/reconciliation of 2026-10: ₹2040\.00 accepted from 2 accepted line\(s\)/);
    expect(g.table4.a5AllOther.detail).toMatch(/Table 4\(B\) ITC reversed: none recorded/);
    expect(itcException(g)).toBeUndefined();

    // ── a reversal (free samples): reported as 4(B), the 4(A) figure is not netted ──
    expect((await call('POST', `/v1/finance/itc/${ITC_PERIOD}/reversals/rv-3b`, ACCOUNTANT, { rule: 'free_samples', sourceRef: 'A12 free sample FS-SYN-3', reason: 'samples given away', cgstMinor: 4_500, sgstMinor: 4_500 })).status).toBe(201);
    g = await g3b();
    expect(g.table4.a5AllOther).toMatchObject({ status: 'reconciled', igstMinor: 24_000, cgstMinor: 90_000, sgstMinor: 90_000 });
    expect(g.table4.a5AllOther.detail).toMatch(/Table 4\(B\) ITC reversed: CGST ₹45\.00, SGST ₹45\.00 \(₹90\.00 in 1 reversal\(s\)\) — reported on its own, NOT netted off 4\(A\)/);

    // ── another month with no 2B is still not reconciled ──
    const nov = (await call('GET', '/v1/finance/gstr3b/112026', 'u-owner')).body as G3b;
    expect(nov.table4.a5AllOther).toMatchObject({ status: 'not_reconciled', detail: expect.stringMatching(/no GSTR-2B has been uploaded for 2026-11/) });
  }, 120_000);
});
