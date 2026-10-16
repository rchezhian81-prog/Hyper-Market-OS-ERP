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

/**
 * **C10 (v2.1 addendum · MG-04 · hard rule #3) — the legacy-card-purge check passes.** On the real API, in memory and (with
 * DATABASE_URL) on real PostgreSQL: a clean legacy extract passes; one carrying a card number in a remarks column, a
 * security-code column and a card-expiry column fails, naming source, record and column — and the card number appears
 * nowhere in the reply, nor anywhere in the shop's ledger (the check stores nothing). A cashier may not run it.
 */

const OWNER = 'u-owner'; const CASHIER = 'u-cash';
const TEST_VISA = ['4111', '1111', '1111', '1111'].join('');

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness; ledgerText?: (tenantId: string) => Promise<string> }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) {
  backings.push({
    name: 'real PostgreSQL',
    harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); },
    ledgerText: async (tenantId) => {
      const a = await pool!.query('SELECT payload::text AS t FROM event_ledger WHERE tenant_id = $1', [tenantId]);
      const b = await pool!.query('SELECT body::text AS t FROM idempotency_keys WHERE tenant_id = $1', [tenantId]);
      return [...a.rows, ...b.rows].map((r: { t: string }) => r.t).join('\n');
    },
  });
}

describe.each(backings)('C10 — the legacy-card-purge check reads an extract — on $name', ({ harness, ledgerText }) => {
  it('passes a clean extract, fails one with card data by source/record/column, and keeps no card number anywhere', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, CASHIER, 'cashier');
    const check = (user: string, records: unknown) => h.request({ method: 'POST', path: '/v1/migration/legacy-card-purge/check', userId: user, tenantId: T, idempotencyKey: `purge-${randomUUID()}`, body: { records } });

    const clean = await check(OWNER, [
      { source: 'old-pos.sales', rowRef: '1', fields: { billNo: 'B-1', barcode: '8901030865278', tender: 'CARD', expiry: '2026-12-31' } },
    ]);
    expect(clean.status, JSON.stringify(clean.body)).toBe(200);
    expect(clean.body).toMatchObject({ passed: true, findings: [] });

    const dirty = await check(OWNER, [
      { source: 'old-pos.sales', rowRef: '2', fields: { billNo: 'B-2', remarks: `paid ${TEST_VISA}`, expiry: '12/29' } },
      { source: 'old-erp.receipts', rowRef: '9', fields: { CVV: '000', 'Card Exp': '0130' } },
    ]);
    expect(dirty.status).toBe(200);
    const body = dirty.body as { passed: boolean; findings: { source: string; rowRef: string; column: string; kind: string }[]; columnsToDrop: string[] };
    expect(body.passed).toBe(false);
    expect(body.findings.map((f) => [f.source, f.rowRef, f.column, f.kind])).toEqual([
      ['old-pos.sales', '2', 'expiry', 'card_expiry_column'],
      ['old-pos.sales', '2', 'remarks', 'card_number_value'],
      ['old-erp.receipts', '9', 'CVV', 'card_security_code_column'],
      ['old-erp.receipts', '9', 'Card Exp', 'card_expiry_column'],
    ]);
    expect(body.columnsToDrop).toEqual(['old-erp.receipts:CVV', 'old-erp.receipts:Card Exp', 'old-pos.sales:expiry']);
    expect(JSON.stringify(dirty.body)).not.toContain(TEST_VISA);
    if (ledgerText !== undefined) expect(await ledgerText(T)).not.toContain(TEST_VISA);

    expect((await check(CASHIER, [{ source: 's', rowRef: '1', fields: {} }])).status).toBe(403);
    expect((await check(OWNER, [])).status).toBe(400);
  });
});
