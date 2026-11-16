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
import { ownerApprovedSetting } from '../support/owner-approved-setting';

/**
 * **D-056 (OB-800 THE PLAN, daily-work walkthrough): the morning brief said "Sales: not available · Margin: not available"
 * while the owner's Today page showed both.** The brief now reads the SAME governed margin report the owner's dashboard
 * reads (net of GST, at the average buying cost): with a costed day it says the sales and the margin, to the paisa the
 * report says; with an uncosted product it still says "not available" (never a made-up figure). In memory and on real
 * PostgreSQL.
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

const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };
type Report = { figures: { name: string; valueMinor?: number; notAvailableBecause?: string }[] };
const rupees = (minor: number): string => `₹${Math.trunc(minor / 100).toLocaleString('en-IN')}.${String(minor % 100).padStart(2, '0')}`;

describe.each(backings)('D-056 — the morning brief says the dashboard\'s sales and margin — on $name', ({ harness }) => {
  it('a costed day: the brief\'s Sales and Margin are the margin report\'s figures; an uncosted product: "not available"', async () => {
    const h = harness();
    const T = randomUUID();
    if (h.store instanceof SqlEventStore) await h.store.registerTenant(T, 'test/provision');
    await h.seedOwner(T, 'u-owner');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId: 'u-owner', tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    await ok(ownerApprovedSetting(h, T, 'locale.time_zone', { value: 'UTC' }), 'tz');
    const today = new Date().toISOString().slice(0, 10);
    // Rice received at ₹400.00 (the average buying cost), sold at ₹480.00 with 5% GST frozen on the line.
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'mv-r1', productId: 'P-RICE', locationId: 'S1', kind: 'received', quantityMinor: 10, uom: 'ea', occurredAt: `${today}T00:01:00.000Z`, enteredBy: 'u-owner', unitCostMinor: 40_000 }), 'receipt');
    const sell = (id: string, productId: string, price: number) => ok(req('POST', '/v1/sales', {
      saleId: id, receiptNumber: `R-${id}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: today,
      committedAt: new Date().toISOString(), totalMinor: price, currency: 'INR', packVersion: 1,
      lines: [{ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: price, lineTotalMinor: price, taxRateBps: 500 }], tenders: [{ kind: 'cash', amountMinor: price }],
    }), `sale ${id}`);
    await sell('S-1', 'P-RICE', 48_000);

    const margin = (await ok(req('GET', '/v1/reports/margin', undefined, { day: today }), 'margin report')).body as Report;
    const net = margin.figures.find((f) => f.name === 'Taken net of GST')!.valueMinor!;
    const kept = margin.figures.find((f) => f.name === 'Margin')!.valueMinor!;
    expect(net).toBe(45_714); // ₹480.00 incl. 5% GST
    expect(kept).toBe(45_714 - 40_000);

    const brief = (await ok(req('GET', '/v1/reporting/brief-today'), 'brief')).body as { lines: string[] };
    const text = brief.lines.join('\n');
    expect(text).toContain(`Sales: ${rupees(net)}`);
    expect(text).toMatch(new RegExp(`Margin: ${rupees(kept).replace(/[.$]/g, '\\$&')} \\(`));
    expect(text).not.toMatch(/Sales: not available|Margin: not available/);
    expect(text).toMatch(/Cash banked: not available/); // head office holds no banked cash for the day — said so, not invented

    // A product with no buying cost: the report cannot say the margin, and neither does the brief.
    await sell('S-2', 'P-GIFT', 10_000);
    const after = (await ok(req('GET', '/v1/reporting/brief-today'), 'brief 2')).body as { lines: string[] };
    expect(after.lines.join('\n')).toMatch(/Margin: not available/);
  }, 120_000);
});
