import { describe, it, expect, beforeAll } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { testModePaymentProvider, type TestModePaymentProvider } from '../../packages/orders/src/payment-verification';
import { sellOnline, onlineReady } from '../support/sell-online';
import { TARGETS, againstBudget, type Sample } from './harness';

/**
 * §32 "Customer checkout API — p95 ≤2 s excluding payment provider — APM/load test" (QG-05; OB-288 gates lane).
 *
 * The customer's checkout is `POST /v1/storefront/orders/:orderId`: the basket is priced from the shop's own price list,
 * stock is reserved in the same breath, and the payment answer is checked with the provider. Measured here through the
 * REAL authenticated API surface, one customer after another, against a shop that keeps taking orders — 300 checkouts of
 * a 5-line basket. The payment provider is the in-process test-mode one (the target EXCLUDES the provider, and a stand-in
 * that answers at once is exactly that exclusion).
 *
 * Asserted: p95 ≤ 2,000 ms on this machine, and the last hundred checkouts are not drastically slower than the first
 * hundred — a checkout whose cost grows with every order the shop has taken is the regression that arrives months in.
 * Not a certification: §32 says "APM/load test" on the production environment, which does not exist yet (QG-10).
 */

const T = 'ab000000-0000-4000-8000-0000000c0de5';
const OWNER = 'u-owner';
const CUSTOMERS = Array.from({ length: 10 }, (_, i) => `cust-${i}`);
const PRODUCTS = Array.from({ length: 20 }, (_, i) => `SKU${i}`);
const ORDERS = 300;
const PRICE = 5_000;

const report = (s: Sample): string => `${s.label}: p50 ${s.p50Ms.toFixed(1)} ms · p95 ${s.p95Ms.toFixed(1)} ms · max ${s.maxMs.toFixed(1)} ms over ${s.runs} checkouts`;
const sampleOf = (label: string, t: readonly number[]): Sample => {
  const s = [...t].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))]!;
  return { label, runs: s.length, p50Ms: at(50), p95Ms: at(95), p99Ms: at(99), maxMs: at(100), meanMs: s.reduce((a, b) => a + b, 0) / s.length };
};

describe(`customer checkout API — p95 ≤ ${TARGETS.customerCheckoutMs} ms excluding the payment provider (§32)`, () => {
  let h: ApiHarness;
  let provider: TestModePaymentProvider;
  const post = (path: string, userId: string, key: string, body: unknown) => h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });

  beforeAll(async () => {
    provider = testModePaymentProvider();
    h = apiHarness({ paymentVerifier: provider });
    await h.seedOwner(T, OWNER);
    await h.enableFeature(T, 'customer_app');
    for (const c of CUSTOMERS) await h.provisionRole(T, c, 'customer');
    const today = new Date().toISOString().slice(0, 10);
    const ok = async (path: string, body: unknown, key: string) => { const r = await post(path, OWNER, key, body); expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300); };
    await ok('/v1/catalogue/tax-classes/0401/rates/2017-07-01', { rateBps: 0 }, 'tax');
    for (const p of PRODUCTS) {
      await ok(`/v1/catalogue/products/${p}/publish`, { product: { sku: `${p}-1`, name: `Synthetic ${p}`, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '0401', lifecycle: 'active', ...onlineReady(PRICE) }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }, `pub-${p}`);
      await ok(`/v1/prices/list/${p}/entries/e1`, { scope: 'store', scopeRef: 'L1', priceMinor: PRICE, mrpMinor: PRICE, costMinor: 1_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }, `price-${p}`);
      // Enough stock that every checkout is fully promised — the measured path is the whole one, not a short-cut refusal.
      await ok('/v1/inventory/movements', { movementId: `in-${p}`, productId: p, locationId: 'L1', kind: 'received', quantityMinor: 10_000, uom: 'each', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: OWNER }, `mv-${p}`);
    }
    await ok('/v1/catalogue/pack', { storeId: 'L1', asOf: today }, 'pack');
    await ok('/v1/serviceability/periods/2026-01-01', { radiusMetres: 10_000, deliveryFeeMinor: 0 }, 'fee');
    await sellOnline((path, body) => post(path, OWNER, `online-${path}`, body), PRODUCTS);
  }, 600_000);

  it(`${ORDERS} checkouts of a 5-line basket, one after another, each priced, reserved and paid`, async () => {
    const timings: number[] = [];
    for (let i = 0; i < ORDERS + 5; i += 1) {
      const lines = Array.from({ length: 5 }, (_, k) => ({ productId: PRODUCTS[(i + k * 3) % PRODUCTS.length]!, quantityMinor: 1 + (k % 2) }));
      const amountMinor = lines.reduce((t, l) => t + l.quantityMinor * PRICE, 0);
      const token = `tok-${i}`;
      provider.capture(token, amountMinor); // the provider's answer exists before the call — the provider is excluded
      const started = process.hrtime.bigint();
      const res = await post(`/v1/storefront/orders/so-${i}`, CUSTOMERS[i % CUSTOMERS.length]!, `checkout-${i}`, { lines, locationId: 'L1', payment: { providerRef: token, amountMinor, result: 'authorised' } });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ state: 'placed', payment: { state: 'authorised', paidMinor: amountMinor }, promise: { outcome: 'promised' } });
      if (i >= 5) timings.push(ms); // the first five warm the code up and are not counted
    }
    const all = sampleOf('POST /v1/storefront/orders/:orderId', timings);
    const first = sampleOf('first 100 checkouts', timings.slice(0, 100));
    const last = sampleOf('last 100 checkouts', timings.slice(-100));
    for (const s of [all, first, last]) console.log(report(s));
    const budget = againstBudget({ label: all.label, targetMs: TARGETS.customerCheckoutMs, sample: all, headroom: 1 });
    expect(budget.certifiesTheTarget).toBe(false);
    expect(all.p95Ms, budget.detail).toBeLessThanOrEqual(TARGETS.customerCheckoutMs);
    // A checkout must not cost much more because the shop has taken 300 orders. Loose on purpose (5×): it catches a
    // per-order fold over the whole order history, which grows with every order, not the noise of a shared machine.
    expect(last.p50Ms, `the last 100 checkouts (p50 ${last.p50Ms.toFixed(1)} ms) against the first 100 (p50 ${first.p50Ms.toFixed(1)} ms)`).toBeLessThanOrEqual(Math.max(first.p50Ms * 5, 5));
  }, 600_000);
});
