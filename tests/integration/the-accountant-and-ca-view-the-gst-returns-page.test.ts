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
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

/**
 * **OB-192 "A" (owner, 18 Oct 2026, in writing): the accountant and the chartered accountant may OPEN the GST returns
 * page — view only.** In memory AND on real PostgreSQL.
 *
 * Each can read everything the page shows — GSTR-3B for a month, the GST controls, the 30-day e-invoice guard, the filing
 * calendar and the annual return — and is refused (403) on every act the page or the API offers: locking GSTR-3B,
 * recording an amendment, recording a return filed, the GSTR-1 submission's prepare / approve / file, raising the owner
 * exceptions, and every switch (reverse charge, the 30-day guard, the time-bar window).
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
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });
}

type Res = { status: number; body: unknown };
const VIEWERS = ['accountant', 'chartered_accountant'] as const;
/** Every code that locks, amends, files, approves or switches anything on the GST returns page. */
const ACTS = ['finance.gstr.generate', 'finance.gstr.approve', 'finance.gstr.submit', 'finance.rcm.switch', 'finance.einvoice.guard.switch', 'finance.gst.timebar.set'];

describe('OB-192: the accountant and the CA hold read access to the GST returns page and nothing that acts', () => {
  it('the role catalogue: finance.gstr.read, and none of the acting codes', () => {
    for (const id of VIEWERS) {
      const perms = ROLE_CATALOGUE.find((r) => r.id === id)!.permissions;
      expect(perms, id).toContain('finance.gstr.read');
      for (const act of ACTS) expect(perms, `${id} must not hold ${act}`).not.toContain(act);
    }
    // The menu offers the page to whoever holds the read code — so both now see "GST returns".
    expect(ERP_NAVIGATION.find((n) => n.id === 'gst-returns')?.requires).toBe('finance.gstr.read');
  });
});

describe.each(backings)('OB-192: the accountant and the CA view the GST returns page — on $name', ({ harness }) => {
  it.each(VIEWERS)('the %s reads GSTR-3B, the controls, the calendar and the annual return, and is refused every act', async (roleId) => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const who = `u-${roleId}`;
    await h.provisionRole(T, who, roleId);
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, body: unknown = {}): Promise<Res> =>
      h.request({ method, path, userId: who, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}`, body }) });

    // ── reads: every GET the page makes ──
    for (const path of ['/v1/finance/gstr3b/052026', '/v1/finance/gst/controls', '/v1/finance/e-invoice/reporting-guard', '/v1/finance/filing-calendar', '/v1/finance/gstr9/2026-27', '/v1/finance/gstr9c/2026-27']) {
      const r = await req('GET', path);
      expect(r.status, `${roleId} GET ${path}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    const g3b = (await req('GET', '/v1/finance/gstr3b/052026')).body as { period: string; table4: { a5AllOther: { status: string } } };
    expect(g3b).toMatchObject({ period: '052026', table4: { a5AllOther: { status: 'not_reconciled' } } });
    const cal = (await req('GET', '/v1/finance/filing-calendar')).body as { nearBarDays: number };
    expect(cal.nearBarDays).toBe(180);

    // ── acts: every one refused, nothing recorded ──
    const refused: [method: 'POST' | 'PUT', path: string, body: unknown][] = [
      ['POST', '/v1/finance/gstr3b/052026/lock', {}],
      ['POST', '/v1/finance/gstr3b/052026/amendments/AM-1', { reason: 'not mine to record' }],
      ['POST', '/v1/finance/returns/GSTR3B/052026/filed', { arn: 'AA33X', filedOn: '2026-06-19' }],
      ['POST', '/v1/finance/gstr1/submission/052026/preview', { returnDigest: 'x' }],
      ['POST', '/v1/finance/gstr1/submission/052026/approve', {}],
      ['POST', '/v1/finance/gstr1/submission/052026/submit', { gstin: '33ABCDE1234F1Z5', digest: 'x' }],
      ['POST', '/v1/finance/filing-calendar/raise-owner-exceptions', {}],
      ['PUT', '/v1/finance/gst/controls/reverse-charge', { switchedOn: true, reason: 'x' }],
      ['PUT', '/v1/finance/gst/controls/einvoice-30-day-guard', { switchedOn: true, reason: 'x' }],
      ['PUT', '/v1/finance/gst/controls/time-bar-warning-days', { days: 90, reason: 'x' }],
    ];
    for (const [method, path, body] of refused) {
      const r = await req(method, path, body);
      expect(r.status, `${roleId} ${method} ${path}: ${JSON.stringify(r.body)}`).toBe(403);
    }
    // Nothing changed: the switches are still off and the window still the owner's 180 days.
    const controls = (await req('GET', '/v1/finance/gst/controls')).body as { controls: { reverseCharge: { value: boolean }; einvoice30DayGuard: { value: boolean }; timeBarWarningDays: { value: number; decision?: string } } };
    expect(controls.controls.reverseCharge.value).toBe(false);
    expect(controls.controls.einvoice30DayGuard.value).toBe(false);
    expect(controls.controls.timeBarWarningDays).toEqual({ value: 180, decision: 'OB-191' });
    expect(((await req('GET', '/v1/finance/gstr3b/052026')).body as { basis: string; lock?: unknown }).lock).toBeUndefined();
  }, 60_000);
});
