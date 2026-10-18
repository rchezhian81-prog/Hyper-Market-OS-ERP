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
import { localDateOf } from '../../services/api/src/r3-gst-adapters';

/**
 * **R3 A21 — the 30-day e-invoice reporting guard (signed OB-188; OB-149 "A": a small guard, SWITCHED OFF), in memory AND
 * on real PostgreSQL, with a cold restart.**
 *
 * While switched off, a B2B invoice dated 60 days ago enters the e-invoice lifecycle — nothing is blocked — and the GST
 * page's read says the guard is off. Only the owner may switch it on (with a reason). Then a credit note dated 60 days
 * ago is REFUSED at submit by name and listed as an exception; one dated today goes through; the invoice submitted
 * while off and still not registered at the portal is listed as past the window. Switching it off again blocks nothing,
 * and the refusal already listed stays on the list (never deleted).
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
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const GSTIN = '33ABCDE1234F1Z5';
const TODAY = localDateOf(new Date().toISOString(), 'Asia/Kolkata');
const daysAgo = (n: number): string => new Date(Date.parse(`${TODAY}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
const fyCompact = (d: string): string => { const y = Number(d.slice(0, 4)); const s = Number(d.slice(5, 7)) >= 4 ? y : y - 1; return `${String(s).slice(2)}${String(s + 1).slice(2)}`; };
const doc = (number: string, date: string, documentType: 'INV' | 'CRN') => ({
  // The Rule 46 field check names every e-invoiced document a "Tax Invoice"; the IRP document type (INV / CRN) says which.
  invoice: { documentType: 'Tax Invoice', supplierGstin: GSTIN, invoiceNumber: number, invoiceDate: date, hsnCode: '040610', taxableMinor: 100_000, rateBps: 500, placeOfSupply: 'intra_state', taxComponents: ['CGST', 'SGST'] },
  annualTurnoverMinor: 6_000_000_000, supplyType: 'b2b', recipientGstin: GSTIN, documentType,
});

describe.each(backings)('the 30-day e-invoice guard blocks nothing until switched on — on $name (A21)', ({ harness, restart }) => {
  it('off: an old invoice goes through and the page says off → owner switches on → an old credit note is refused and listed', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method !== 'GET' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const old = daysAgo(60);
    const guard = async () => (await ok(req('GET', '/v1/finance/e-invoice/reporting-guard'), 'guard')).body as { switchedOn: boolean; said: string; exceptions: { blockedAtSubmit: { invoiceId: string }[]; notRegisteredInWindow: { invoiceId: string }[] } };

    // ── switched off: nothing blocked, and said ────────────────────────────────────────────────────────────────────
    expect((await guard()).switchedOn).toBe(false);
    expect((await guard()).said).toMatch(/SWITCHED OFF/);
    await ok(req('POST', '/v1/finance/e-invoice/invoices/inv-old/submit', doc(`INV/${fyCompact(old)}/000001`, old, 'INV')), 'old invoice while off');
    expect((await guard()).exceptions).toEqual({ blockedAtSubmit: [], notRegisteredInWindow: [] });

    // ── only the owner switches it on ──────────────────────────────────────────────────────────────────────────────
    expect((await req('PUT', '/v1/finance/gst/controls/einvoice-30-day-guard', { switchedOn: true, reason: 'x' }, 'u-mgr')).status).toBe(403);
    await ok(req('PUT', '/v1/finance/gst/controls/einvoice-30-day-guard', { switchedOn: true, reason: 'turnover reached ₹10 crore (synthetic)' }), 'switch on');
    h = restart(h);
    const refused = await req('POST', '/v1/finance/e-invoice/invoices/crn-old/submit', doc(`CRN/${fyCompact(old)}/000001`, old, 'CRN'));
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('einvoice_reporting_window_passed');
    expect((await req('GET', '/v1/finance/e-invoice/invoices/crn-old')).status).toBe(404); // never entered the lifecycle
    await ok(req('POST', '/v1/finance/e-invoice/invoices/inv-new/submit', doc(`INV/${fyCompact(TODAY)}/000002`, TODAY, 'INV')), 'today\'s invoice');
    let g = await guard();
    expect(g.switchedOn).toBe(true);
    expect(g.exceptions.blockedAtSubmit.map((b) => b.invoiceId)).toEqual(['crn-old']);
    expect(g.exceptions.notRegisteredInWindow.map((b) => b.invoiceId)).toEqual(['inv-old']);

    // ── off again: nothing blocked; the refusal already listed stays ───────────────────────────────────────────────
    await ok(req('PUT', '/v1/finance/gst/controls/einvoice-30-day-guard', { switchedOn: false, reason: 'synthetic' }), 'switch off');
    await ok(req('POST', '/v1/finance/e-invoice/invoices/crn-old/submit', doc(`CRN/${fyCompact(old)}/000001`, old, 'CRN')), 'old credit note while off');
    g = await guard();
    expect(g.switchedOn).toBe(false);
    expect(g.exceptions.blockedAtSubmit.map((b) => b.invoiceId)).toEqual(['crn-old']);
  }, 60_000);
});
