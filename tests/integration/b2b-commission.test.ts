import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { b2bCommissionAdapter, STREAM, streamName } from '../../services/api/src/adapters';
import type { CommissionAccrual } from '../../services/finance/src/b2b-commission';

// M22-FR-03 (W4) — B2B salesperson commission is only ever DERIVED: the rate is a rule a second person approved and the
// base is the taxable value of the tax invoice head office issued for an attributed order (proved end to end in
// tests/integration/a-b2b-order-holds-and-moves-ordinary-stock.test.ts and the Sales commission browser test). The OLD
// manual accrual route took a typed `baseMinor` and `rateBps`; it is RETIRED — it refuses by name, naming the invoice-derived
// path, and records nothing. Accruals recorded before it was retired stay readable as a projected running total (hard rule
// #2: append-only, never rewritten). Reading stays split: a manager reads, a cashier neither. Through the real API + RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const accrue = (h: ApiHarness, tenantId: string, userId: string, salespersonId: string, accrualId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/b2b/commissions/${salespersonId}/accruals/${accrualId}`, userId, tenantId, idempotencyKey: key ?? `acc-${accrualId}`, body });
const owed = (h: ApiHarness, tenantId: string, userId: string, salespersonId: string) =>
  h.request({ method: 'GET', path: `/v1/b2b/commissions/${salespersonId}`, userId, tenantId });

interface Owed { salespersonId: string; currency: string; totalCommissionMinor: number; totalBaseMinor: number; count: number; accruals: { accrualId: string; commissionMinor: number; baseMinor: number }[] }
interface Refusal { error: { code: string; whatHappened: string; wasItSaved: string; nextSafeAction: string } }

/** An accrual recorded before the manual route was retired — laid straight on the salesperson's stream, as it was then. */
const earlier = (salespersonId: string, accrualId: string, baseMinor: number, rateBps: number, commissionMinor: number): CommissionAccrual => ({
  accrualId, salespersonId, baseMinor, rateBps, capMinor: null, commissionMinor, currency: 'INR', ref: 'typed before W4', at: '2026-10-01T09:00:00.000Z',
});

describe('b2b commission: the typed manual accrual is retired; earlier accruals stay readable (M22-FR-03)', () => {
  it('refuses a typed base by name, naming the invoice-derived path, and records nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'b2b'); // this shop's plan includes B2B (M36-FR-01)
    await h.provisionRole(A, 'u-acct', 'accountant');

    for (const who of ['u-owner', 'u-acct']) {
      const r = await accrue(h, A, who, 'SP1', `a-${who}`, { baseMinor: 1_000_000, rateBps: 500 });
      expect(r.status).toBe(410);
      const e = (r.body as Refusal).error;
      expect(e.code).toBe('manual_commission_accrual_retired');
      expect(e.wasItSaved).toBe('not_saved');
      expect(e.whatHappened).toMatch(/only from a tax invoice head office issues for an order attributed to them, at the commission rate a second person approved/);
      expect(e.nextSafeAction).toContain('/v1/b2b/commissions/:salespersonId/rules/:ruleId/approve');
      expect(e.nextSafeAction).toContain('/v1/b2b/documents/:customerId/invoices/:documentId');
    }
    // Whatever the body says — even a well-formed one — nothing is on record.
    expect((await owed(h, A, 'u-owner', 'SP1')).status).toBe(404);
    expect(await h.store.readStream(A, streamName(STREAM.b2b, 'commission', 'SP1'))).toEqual([]);
  });

  it('keeps the accruals recorded before it was retired: projected, never rewritten; a refused re-send changes nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'b2b');
    const books = b2bCommissionAdapter({ store: h.store, now: () => '2026-10-01T09:00:00.000Z' });
    await books.recordAccrual(A, 'SP2', earlier('SP2', 'a1', 500_000, 400, 20_000));
    await books.recordAccrual(A, 'SP2', earlier('SP2', 'a2', 100, 150, 2));

    const before = (await owed(h, A, 'u-owner', 'SP2')).body as Owed;
    expect(before.totalCommissionMinor).toBe(20_002);
    expect(before.totalBaseMinor).toBe(500_100);
    expect(before.count).toBe(2);

    // The old caller sends the same accrual again with another figure: refused, and the history reads exactly as before.
    expect((await accrue(h, A, 'u-owner', 'SP2', 'a1', { baseMinor: 9_000_000, rateBps: 1000 }, 'acc-a1-again')).status).toBe(410);
    const after = (await owed(h, A, 'u-owner', 'SP2')).body as Owed;
    expect(after.accruals).toEqual(before.accruals);
    expect(after.totalCommissionMinor).toBe(20_002);
  });

  it('keeps reading least-privilege and per tenant: a manager reads, a cashier neither; another shop sees nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'b2b');
    await h.provisionRole(A, 'u-mgr', 'store_manager');     // reads, does NOT record
    await h.provisionRole(A, 'u-cash', 'cashier');          // neither
    await b2bCommissionAdapter({ store: h.store, now: () => '2026-10-01T09:00:00.000Z' }).recordAccrual(A, 'SP3', earlier('SP3', 'a1', 100_000, 500, 5_000));

    expect((await accrue(h, A, 'u-mgr', 'SP3', 'a2', { baseMinor: 1, rateBps: 500 })).status).toBe(403); // no record right at all
    expect((await accrue(h, A, 'u-cash', 'SP3', 'a3', { baseMinor: 1, rateBps: 500 })).status).toBe(403);
    expect((await owed(h, A, 'u-mgr', 'SP3')).status).toBe(200);   // a manager may read
    expect((await owed(h, A, 'u-cash', 'SP3')).status).toBe(403);
    expect((await owed(h, A, 'u-owner', 'GHOST')).status).toBe(404);

    await h.seedOwner(B, 'u-owner-b');
    await h.enableFeature(B, 'b2b');
    expect((await owed(h, B, 'u-owner-b', 'SP3')).status).toBe(404);
  });
});
