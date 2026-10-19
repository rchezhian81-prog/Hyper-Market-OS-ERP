import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { backings, openDatabase, closeDatabase } from '../support/r4-lane1';
import { seedOnlineShop, callsFor, codeOf, saidOf, CUSTOMER, STORE } from '../support/online-shop';
import { sellOnline } from '../support/sell-online';

/**
 * **R4 · OB-234 — the storefront order route refuses a product the shop has not published online (the real API, in
 * memory and on real PostgreSQL, with a cold restart).** Lane 2 built the online listing register (B23 · A26); the order
 * route (`POST /v1/storefront/orders/:id`) now asks it, through the same answer the customer's listing gives: a product
 * is sold online only while it is published there AND still carries every display duty. Else the order is refused
 * before any delivery slot is bound or any stock is held, in Lane 2's words: "online listing incomplete: <field>"
 * (`online_listing_incomplete`), or "not sold online" (`not_sold_online`) — not published yet, another seller's goods,
 * or not in the catalogue. Synthetic data only.
 */

beforeAll(openDatabase);
afterAll(closeDatabase);

describe.each(backings())('an online order refuses a product not sold online — on $name (OB-234)', ({ harness, restart }) => {
  it('incomplete → refused by field; complete but unpublished → not sold online; published → placed; withdrawn → refused again', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    const order = (orderId: string, products: readonly string[]) =>
      req('POST', `/v1/storefront/orders/${orderId}`, { lines: products.map((productId) => ({ productId, quantityMinor: 1 })), locationId: STORE }, CUSTOMER);
    const mine = async () => ((await ok(req('GET', '/v1/storefront/orders', undefined, CUSTOMER), 'my orders')).body as { orders: { orderId: string }[] }).orders.map((o) => o.orderId);
    const refused = async (orderId: string, products: readonly string[], code: string, words: string) => {
      const r = await order(orderId, products);
      expect([r.status, codeOf(r), saidOf(r)], JSON.stringify(r.body)).toEqual([409, code, words]);
    };

    // ── The shop's details are not set: every product is incomplete, named by its first missing field ──────────────
    await refused('O-1', ['MILK'], 'online_listing_incomplete', 'MILK: online listing incomplete: shop legal name.');
    // ── The details set: BROOM still lacks its country of origin; MILK is complete but not published ───────────────
    await sellOnline((path, body) => req('POST', path, body), []);
    await refused('O-2', ['BROOM'], 'online_listing_incomplete', 'BROOM: online listing incomplete: country of origin.');
    await refused('O-3', ['MILK'], 'not_sold_online', 'MILK: not sold online: not published online yet.');
    // Another seller's goods (a concession tenant's saree) and a product the catalogue does not carry.
    await refused('O-4', ['SAREE'], 'not_sold_online', "SAREE: other seller's goods: not sold online.");
    await refused('O-5', ['NO-SUCH'], 'not_sold_online', 'NO-SUCH: not sold online: not in the published catalogue.');
    // Nothing was recorded or held for any of them.
    expect(await mine()).toEqual([]);

    // ── MILK is published online; a COLD RESTART reads the listing back from the store ─────────────────────────────
    await ok(req('POST', '/v1/online-store/listings/MILK', { action: 'publish' }), 'publish MILK');
    h = restart(h);
    const placed = await ok(order('O-6', ['MILK']), 'order MILK');
    expect(placed.status).toBe(201);
    // One unpublished product in the basket refuses the whole order — the listed MILK is not held either.
    await refused('O-7', ['MILK', 'SAREE'], 'not_sold_online', "SAREE: other seller's goods: not sold online.");
    expect(await mine()).toEqual(['O-6']);

    // ── Withdrawn: refused again ────────────────────────────────────────────────────────────────────────────────────
    await ok(req('POST', '/v1/online-store/listings/MILK', { action: 'withdraw', reason: 'test: off the app for a day (synthetic)' }), 'withdraw MILK');
    await refused('O-8', ['MILK'], 'not_sold_online', 'MILK: not sold online: not published online yet.');
    expect(await mine()).toEqual(['O-6']);
  });
});
