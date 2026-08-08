import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Cross-domain fraud signals (M15-FR-02, API-05) end to end through the real API. This watches the four
// places value leaves with no cashier touching anything — coupons, loyalty, cash-on-delivery, suppliers.
// Two constraints are proven: a SIGNAL IS NOT A VERDICT (every finding carries `actionTaken: false` and
// links its evidence — nothing is blocked/sanctioned, AI-NFR-12), and THE THRESHOLD IS ALWAYS THE
// TENANT'S (the store's own thresholds are stored and applied, and one store's thresholds never affect
// another's result). The output is the whole fraud layer's: one prioritised list to read (strong first).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-08-08T10:00:00Z';

const setThresholds = (h: ApiHarness, t: string, u: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/fraud-signals/thresholds`, userId: u, tenantId: t, idempotencyKey: key ?? `ft-${t}`, body });
const getThresholds = (h: ApiHarness, t: string, u: string) =>
  h.request({ method: 'GET', path: `/v1/fraud-signals/thresholds`, userId: u, tenantId: t });
const evaluate = (h: ApiHarness, t: string, u: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/fraud-signals/evaluate`, userId: u, tenantId: t, idempotencyKey: key ?? `fe-${t}-${u}-${String(body.tag ?? '')}`, body });

interface Signal { signalId: string; domain: string; kind: string; subjectRef: string; confidence: string; valueMinor: number; evidenceRefs: string[]; actionTaken: boolean }
const sigs = (res: { body: unknown }): Signal[] => (res.body as { signals: Signal[] }).signals;
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const coupons = (n: number) => Array.from({ length: n }, (_, i) => ({ useId: `u${i + 1}`, couponCode: 'C1', accountRef: 'acc1', saleId: `s${i + 1}`, discountMinor: 5_000, at: AT }));
const supplierHistory = (n: number, unitPriceMinor = 100, quantityMinor = 100) =>
  Array.from({ length: n }, (_, i) => ({ invoiceId: `h${i + 1}`, supplierId: 'S1', productId: 'P1', unitPriceMinor, quantityMinor, at: AT }));

describe('fraud signals: cross-domain, tenant thresholds, detect-only, prioritised (M15-FR-02)', () => {
  it('detects a declared-limit coupon breach as STRONG, and the tenant threshold decides it', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // The store tightens the coupon limit to 2 — below the default of 5.
    expect((await setThresholds(h, A, 'u-owner', { couponUsesPerAccount: 2 })).status).toBe(201);

    const out = sigs(await evaluate(h, A, 'u-owner', { coupons: coupons(3), tag: 'c' }));
    const s = out.find((x) => x.kind === 'coupon_beyond_limit');
    expect(s).toMatchObject({ domain: 'coupon', subjectRef: 'acc1', confidence: 'strong', actionTaken: false });
    expect(s?.evidenceRefs).toEqual(['s1', 's2', 's3']);   // links back to the sales
    // Every signal is detect-only.
    expect(out.every((x) => x.actionTaken === false)).toBe(true);
  });

  it('flags loyalty points earned with no sale and COD collected-but-not-banked, both strong, detect-only', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const out = sigs(await evaluate(h, A, 'u-owner', {
      loyalty: [{ movementId: 'm1', accountRef: 'a1', kind: 'earn', points: 500, at: AT, staffId: 'staff-7' }],  // no saleId → from nowhere
      cod: [{ stopId: 'st1', driverRef: 'drv-3', orderId: 'o1', expectedMinor: 100_000, collectedMinor: 100_000, collectedAt: '2026-08-06T10:00:00Z' }], // 48h unbanked
      at: AT, tag: 'lc',
    }));
    expect(out.find((x) => x.kind === 'loyalty_earn_without_sale')).toMatchObject({ subjectRef: 'staff-7', confidence: 'strong', actionTaken: false });
    expect(out.find((x) => x.kind === 'cod_collected_but_not_banked')).toMatchObject({ subjectRef: 'drv-3', confidence: 'strong', actionTaken: false });
  });

  it('needs enough supplier history, and prioritises strong before weak', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // Too little history → no supplier signal (two observations is a coincidence, not a baseline).
    const thin = sigs(await evaluate(h, A, 'u-owner', { supplier: { lines: [{ invoiceId: 'i1', supplierId: 'S1', productId: 'P1', unitPriceMinor: 200, quantityMinor: 100, at: AT }], history: supplierHistory(4) }, tag: 'thin' }));
    expect(thin.filter((x) => x.domain === 'supplier')).toHaveLength(0);

    // Enough history: a price at 2× the supplier's own average is strong; combine with a weak signal and
    // a strong one to prove the ordering (strong first).
    const out = sigs(await evaluate(h, A, 'u-owner', {
      supplier: { lines: [{ invoiceId: 'i2', supplierId: 'S1', productId: 'P1', unitPriceMinor: 200, quantityMinor: 100, at: AT }], history: supplierHistory(5) },
      loyalty: [{ movementId: 'm9', accountRef: 'a9', kind: 'earn', points: 10, at: AT }],   // orphan earn → strong
      tag: 'prio',
    }));
    expect(out.find((x) => x.kind === 'supplier_price_out_of_history')).toMatchObject({ subjectRef: 'S1', confidence: 'strong' });
    expect(out[0]?.confidence).toBe('strong');   // strong is read first
  });

  it('stores thresholds per tenant, authorizes (manage vs read/evaluate), and refuses malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');   // sets thresholds and evaluates
    await h.provisionRole(A, 'u-acct', 'accountant');     // evaluates, does NOT set
    await h.provisionRole(A, 'u-cash', 'cashier');        // neither

    expect((await setThresholds(h, A, 'u-mgr', { couponUsesPerAccount: 2 }, 'ft-a-mgr')).status).toBe(201);
    expect(((await getThresholds(h, A, 'u-owner')).body as { thresholds: { couponUsesPerAccount?: number } }).thresholds.couponUsesPerAccount).toBe(2);
    expect((await setThresholds(h, A, 'u-acct', { couponUsesPerAccount: 1 }, 'ft-a-acct')).status).toBe(403);
    expect((await setThresholds(h, A, 'u-cash', { couponUsesPerAccount: 1 }, 'ft-a-cash')).status).toBe(403);
    expect((await evaluate(h, A, 'u-acct', { coupons: coupons(3), tag: 'acct' })).status).toBe(200);
    expect((await evaluate(h, A, 'u-cash', { coupons: coupons(3), tag: 'cash' })).status).toBe(403);
    // A malformed dataset is refused.
    expect(codeOf(await evaluate(h, A, 'u-owner', { coupons: 'not-a-list', tag: 'bad' }))).toBe('not_readable_as_coupons');

    // Per-tenant thresholds: the SAME 3 coupon uses breach A's tightened limit (2) but not B's default (5).
    await h.seedOwner(B, 'u-owner-b');
    expect(sigs(await evaluate(h, A, 'u-owner', { coupons: coupons(3), tag: 'A' })).some((x) => x.kind === 'coupon_beyond_limit')).toBe(true);
    expect(sigs(await evaluate(h, B, 'u-owner-b', { coupons: coupons(3), tag: 'B' })).some((x) => x.kind === 'coupon_beyond_limit')).toBe(false);
  });
});
