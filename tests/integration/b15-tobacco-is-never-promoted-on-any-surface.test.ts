import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { seedOnlineShop, listShopOnline, callsFor, codeOf, saidOf, OWNER, MANAGER, CASHIER, CUSTOMER, OTHER_CUSTOMER } from '../support/online-shop';
import { productMasterAdapter, STREAM, streamName } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **B15 (COTPA 2003 s.5 · OWNER_DECISIONS D3): tobacco may not be advertised or promoted — on EVERY surface, not only
 * offers.** The one guard (`tobaccoAdvertisingRefusal`) asked by each, through the real routes, in memory and (with
 * DATABASE_URL) on real PostgreSQL, with a cold restart:
 *   • RECOMMENDATIONS — "bought together" never names a tobacco product; how many were withheld, and why, is said;
 *   • ONLINE LISTING — a tobacco product is refused by name (`tobacco_may_not_be_promoted`), the attempt kept;
 *   • CAMPAIGNS — an abandoned-cart reminder (a campaign message) never counts tobacco: a basket of only tobacco is no
 *     reminder; a basket with tobacco in it is valued without it;
 *   • BUNDLES — a bundle that holds tobacco, or IS tobacco, is refused in the guard's words;
 *   • SUBSTITUTES — tobacco is never given as a substitute, in the guard's words.
 * The till's offers were already guarded; the customer display and the storefront listing are proved in the unit test of
 * the same name.
 */

const backings = useRestartableBackings();
const hoursAgo = (n: number): string => new Date(Date.now() - n * 3_600_000).toISOString();
const DAY = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
const bill = (saleId: string, productIds: readonly string[]) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: CASHIER, tradingDay: DAY, committedAt: `${DAY}T06:30:00.000Z`, totalMinor: productIds.length * 10_00, currency: 'INR', packVersion: 1,
  lines: productIds.map((productId) => ({ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: 10_00, lineTotalMinor: 10_00 })), tenders: [{ kind: 'cash', amountMinor: productIds.length * 10_00 }],
});

describe.each(backings)('B15 — tobacco is never promoted, on any surface — on $name', ({ harness }) => {
  it('recommendations, the online listing, a cart reminder, a bundle and a substitute list each refuse or leave out tobacco, and say so', async () => {
    let h = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    await listShopOnline(c);
    // A cigarette pack on the master (tobacco), as the till sells it — behind the counter, to adults.
    await productMasterAdapter({ store: h.store, now: () => new Date().toISOString() }).publish(T, {
      productId: 'CIG', tenantId: T, sku: 'CIG-10', name: 'Synthetic cigarettes 10s', baseUom: 'ea', primaryCategoryId: 'household', taxClass: '2402', lifecycle: 'active',
      safety: { tobacco: true, minimumAge: 18, packMinimumMinor: 1 },
    }, 'test');

    // ── RECOMMENDATIONS ──
    for (const [id, items] of [['S1', ['MILK', 'CIG']], ['S2', ['MILK', 'CIG']], ['S3', ['MILK', 'BROOM']]] as const) {
      const r = await h.request({ method: 'POST', path: '/v1/sales', userId: CASHIER, tenantId: T, idempotencyKey: `bank-${id}`, body: bill(id, items) });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
    }
    const suggest = async () => (await ok(req('GET', '/v1/storefront/recommendations', undefined, CUSTOMER, { productId: 'MILK' }), 'suggest')).body as { recommendations: { productId: string }[]; withheld?: { count: number; code: string; why: string } };
    const s = await suggest();
    expect(s.recommendations.map((r) => r.productId)).toEqual(['BROOM']);
    expect(s.withheld).toMatchObject({ count: 1, code: 'tobacco_may_not_be_promoted', why: expect.stringMatching(/COTPA 2003 s\.5/) });

    // ── ONLINE LISTING ──
    expect((await req('POST', '/v1/online-store/listings/CIG', { action: 'publish' }, CASHIER)).status).toBe(403);
    const listed = await req('POST', '/v1/online-store/listings/CIG', { action: 'publish' });
    expect([listed.status, codeOf(listed)]).toEqual([422, 'tobacco_may_not_be_promoted']);
    expect(saidOf(listed)).toMatch(/^The online store cannot name a tobacco product \(CIG\)/);

    // ── CAMPAIGNS: the abandoned-cart reminder ──
    const journeys = streamName(STREAM.customer, 'journeys');
    const cart = (who: string, lines: { productId: string; quantityMinor: number }[], valueMinor: number) => h.store.append(T, journeys, makeEvent({
      id: `cart-${who}-${T}`, type: 'CartHeld', occurredAt: hoursAgo(3), idempotencyKey: `cart-${who}-${T}`, source: 'test/seed',
      payload: { customerRef: who, lines, valueMinor, updatedAt: hoursAgo(3) },
    }));
    await cart(OTHER_CUSTOMER, [{ productId: 'CIG', quantityMinor: 2 }], 400_00);           // only tobacco
    await cart(CUSTOMER, [{ productId: 'MILK', quantityMinor: 2 }, { productId: 'CIG', quantityMinor: 1 }], 320_00);

    // ── BUNDLES and SUBSTITUTES ──
    const holds = await req('POST', '/v1/catalogue/bundles/BROOM', { components: [{ productId: 'MILK', quantityMinor: 1 }, { productId: 'CIG', quantityMinor: 1 }], reason: 'festival box' });
    expect([holds.status, codeOf(holds)]).toEqual([422, 'bundle_component_tobacco']);
    expect(saidOf(holds)).toMatch(/A bundle cannot name a tobacco product \(CIG\)/);
    const is = await req('POST', '/v1/catalogue/bundles/CIG', { components: [{ productId: 'MILK', quantityMinor: 1 }, { productId: 'BROOM', quantityMinor: 1 }], reason: 'smoker box' });
    expect([is.status, codeOf(is)]).toEqual([422, 'bundle_product_tobacco']);
    const sub = await req('POST', '/v1/catalogue/products/BROOM/substitutes', { substitutes: ['CIG'], reason: 'out of stock' });
    expect([sub.status, codeOf(sub)]).toEqual([422, 'substitute_controlled']);
    expect(saidOf(sub)).toMatch(/A suggested substitute cannot name a tobacco product \(CIG\)/);

    h = harness(h); // ── COLD RESTART ──
    expect((await suggest()).recommendations.map((r) => r.productId)).toEqual(['BROOM']);
    const read = await h.request({ method: 'GET', path: '/v1/service/journeys', userId: MANAGER, tenantId: T });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const abandoned = (read.body as { journeys: { kind: string; candidates: { customerRef: string; eligible: boolean; detail: string }[] }[] }).journeys.find((j) => j.kind === 'abandoned_cart')!;
    // The tobacco-only basket is no reminder at all; the mixed one is a reminder for the milk alone.
    expect(abandoned.candidates.map((x) => x.customerRef)).toEqual([CUSTOMER]);
    expect(abandoned.candidates[0]!.eligible).toBe(true);
    // The kept refusal of the online listing reads back (who tried to list tobacco).
    const register = (await ok(req('GET', '/v1/online-store/listings', undefined, OWNER), 'listings')).body as { listings: { productId: string; listed: boolean }[] };
    expect(register.listings.find((l) => l.productId === 'CIG')?.listed ?? false).toBe(false);
  }, 180_000);
});
