import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';

// M15-FR-02 (audit-2 P4): "stateful fraud signals over stored coupons, points, COD and supplier invoices", acceptance
// "cross-domain signals reconcile to their source". Through the real API, in memory and — with DATABASE_URL — on real
// PostgreSQL, with a cold restart between the records and the read. Synthetic data.
//
// The coupons are issued and redeemed on the coupon register, the points moved by hand on a member's points ledger; the
// report then reads THOSE records (not a dataset the caller posts), runs the shop's own thresholds, names the person who
// issued points with no sale behind them, says how many records each register gave, and traces every signal back to
// them. A cashier reads nothing (403). Nothing is blocked.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };

describe.each(backings)('the fraud signals read the shop\'s own records (M15-FR-02) — on $name', ({ harness }) => {
  it('coupons concentrated on one account and points from nowhere are found in the stored registers, reconciled, after a restart', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.enableFeature(T, 'loyalty');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    // The shop's own thresholds: a share means something from four uses up, and half of them is odd.
    await ok(call('POST', '/v1/fraud-signals/thresholds', 'u-owner', { couponConcentrationMinimumTotal: 4, couponConcentrationPercent: 50 }), 'thresholds');
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    for (const [code, valueMinor] of [['FEST-1', 5_000], ['FEST-2', 5_000], ['FEST-3', 5_000], ['FEST-4', 5_000]] as const) {
      await ok(call('POST', `/v1/loyalty/coupons/${code}`, 'u-mgr', { kind: 'amount_off', valueMinor, validUntil: until, maxRedemptions: 1, maxPerCustomer: 1 }), `issue ${code}`);
    }
    // Three of the four went to the same member, the fourth to another.
    for (const [code, who, saleId] of [['FEST-1', 'M-9', 'S1'], ['FEST-2', 'M-9', 'S2'], ['FEST-3', 'M-9', 'S3'], ['FEST-4', 'M-5', 'S4']] as const) {
      await ok(call('POST', `/v1/loyalty/coupons/${code}/redemptions/r-${code}`, 'u-cash', { saleId, basketMinor: 50_000, customerRef: who }), `redeem ${code}`);
    }
    // 500 points earned by hand with no sale behind them — by the manager; and 40 points with their sale named.
    await ok(call('POST', '/v1/customers/M-7/points', 'u-mgr', { movementId: 'mv-free', kind: 'earn', points: 500 }), 'points from nowhere');
    await ok(call('POST', '/v1/customers/M-7/points', 'u-cash', { movementId: 'mv-sale', kind: 'earn', points: 40, sourceRef: 'S5' }), 'points for a sale');

    h = harness(h); // ── COLD RESTART: the report reads what is stored ──

    expect((await call('GET', '/v1/fraud-signals/stored', 'u-cash')).status).toBe(403);
    const r = (await ok(call('GET', '/v1/fraud-signals/stored', 'u-mgr'), 'stored signals')).body as {
      signals: { kind: string; domain: string; subjectRef: string; confidence: string; valueMinor: number; evidenceRefs: string[]; reconciles: boolean; actionTaken: boolean }[];
      sources: { domain: string; known: boolean; read: number }[]; allReconcile: boolean; actionTaken: boolean;
    };
    expect(r.signals.map((s) => [s.domain, s.kind, s.subjectRef, s.confidence, s.valueMinor, [...s.evidenceRefs].sort(), s.reconciles])).toEqual([
      ['loyalty', 'loyalty_earn_without_sale', 'u-mgr', 'strong', 0, ['mv-free'], true],
      ['coupon', 'coupon_concentrated_on_one_account', 'M-9', 'probable', 15_000, ['S1', 'S2', 'S3'], true],
    ]);
    expect(r.signals.every((s) => s.actionTaken === false)).toBe(true);
    expect(r.sources.map((s) => [s.domain, s.known, s.read])).toEqual([['coupon', true, 4], ['loyalty', true, 2], ['delivery', true, 0], ['supplier', true, 0]]);
    expect([r.allReconcile, r.actionTaken]).toEqual([true, false]);

    // A window before any of it reads nothing — and says it read nothing.
    const before = (await ok(call('GET', '/v1/fraud-signals/stored', 'u-mgr', undefined, { from: '2020-01-01', to: '2020-01-31' }), 'old window')).body as { signals: unknown[]; sources: { read: number }[] };
    expect([before.signals, before.sources.map((s) => s.read)]).toEqual([[], [0, 0, 0, 0]]);
    expect((await call('GET', '/v1/fraud-signals/stored', 'u-mgr', undefined, { from: '2026-02-01', to: '2026-01-01' })).status).toBe(400);
  }, 120_000);
});
