import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The effective-dated, scoped price list (M05-FR-01, API-02) end to end through the real API. "One price
// truth" resolved by precedence customer > channel > zone > store; a future price does NOT activate early;
// entries are append-only with a version so a sale can lock the one it referenced; above MRP is refused at
// any scope (a legal ceiling); and back-dating is refused (it would rewrite what past sales should have
// charged). The rules are the pure resolvePrice/priceHistory engine — this proves they are wired.
//
// Dates are computed relative to the real clock the surface runs on, so the "today"/"future" boundaries
// line up between the test and the server.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const iso = (offsetDays: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
};

const publish = (h: ApiHarness, t: string, u: string, productId: string, entryId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/prices/list/${productId}/entries/${entryId}`, userId: u, tenantId: t, idempotencyKey: `pe-${entryId}`, body });
const resolve = (h: ApiHarness, t: string, u: string, productId: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: `/v1/prices/list/${productId}/resolve`, userId: u, tenantId: t, query });
const history = (h: ApiHarness, t: string, u: string, productId: string) =>
  h.request({ method: 'GET', path: `/v1/prices/list/${productId}/history`, userId: u, tenantId: t });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Resolved { entryId: string; version: number; scope: string; priceMinor: number }

describe('price list: effective-dated, scoped, one price truth by precedence (M05-FR-01)', () => {
  it('publishes scoped entries and resolves by precedence, returning the entry to lock the sale to', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect((await publish(h, A, 'u-owner', 'P1', 'e-store', { scope: 'store', scopeRef: 'store-1', priceMinor: 10_000, mrpMinor: 20_000, currency: 'INR', effectiveFrom: iso(0) })).status).toBe(201);
    expect((await publish(h, A, 'u-owner', 'P1', 'e-cust', { scope: 'customer', scopeRef: 'CUST1', priceMinor: 9_000, mrpMinor: 20_000, currency: 'INR', effectiveFrom: iso(0) })).status).toBe(201);

    // No customer in context → the store base applies.
    const base = (await resolve(h, A, 'u-owner', 'P1', { at: iso(1), storeId: 'store-1' })).body as Resolved;
    expect(base.scope).toBe('store');
    expect(base.priceMinor).toBe(10_000);

    // With the customer → the customer price wins (higher precedence), and the entry id/version come back.
    const forCust = (await resolve(h, A, 'u-owner', 'P1', { at: iso(1), storeId: 'store-1', customerId: 'CUST1' })).body as Resolved;
    expect(forCust.scope).toBe('customer');
    expect(forCust.priceMinor).toBe(9_000);
    expect(forCust.entryId).toBe('e-cust');
    expect(forCust.version).toBe(1);
  });

  it('a future price does not activate early, and activates on its effective date', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    await publish(h, A, 'u-owner', 'P1', 'e-now', { scope: 'store', scopeRef: 'store-1', priceMinor: 10_000, mrpMinor: 20_000, currency: 'INR', effectiveFrom: iso(0) });
    await publish(h, A, 'u-owner', 'P1', 'e-future', { scope: 'store', scopeRef: 'store-1', priceMinor: 8_000, mrpMinor: 20_000, currency: 'INR', effectiveFrom: iso(30) });

    // Before the future date, today's price still applies.
    expect(((await resolve(h, A, 'u-owner', 'P1', { at: iso(1), storeId: 'store-1' })).body as Resolved).priceMinor).toBe(10_000);
    // On/after the future date, the newer effective price wins.
    expect(((await resolve(h, A, 'u-owner', 'P1', { at: iso(31), storeId: 'store-1' })).body as Resolved).priceMinor).toBe(8_000);
  });

  it('refuses a price above MRP and refuses back-dating — and records nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect(codeOf(await publish(h, A, 'u-owner', 'P1', 'e-mrp', { scope: 'store', scopeRef: 'store-1', priceMinor: 25_000, mrpMinor: 20_000, currency: 'INR', effectiveFrom: iso(0) }))).toBe('price_above_mrp');
    expect(codeOf(await publish(h, A, 'u-owner', 'P1', 'e-back', { scope: 'store', scopeRef: 'store-1', priceMinor: 10_000, mrpMinor: 20_000, currency: 'INR', effectiveFrom: iso(-5) }))).toBe('price_back_dated');

    // Neither refusal recorded anything — there is no price list for the product.
    expect((await history(h, A, 'u-owner', 'P1')).status).toBe(404);
  });

  it('keeps an append-only history with a version per (scope, ref)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    await publish(h, A, 'u-owner', 'P1', 'e1', { scope: 'store', scopeRef: 'store-1', priceMinor: 10_000, mrpMinor: 20_000, currency: 'INR', effectiveFrom: iso(0) });
    const second = await publish(h, A, 'u-owner', 'P1', 'e2', { scope: 'store', scopeRef: 'store-1', priceMinor: 9_500, mrpMinor: 20_000, currency: 'INR', effectiveFrom: iso(10) });
    expect((second.body as { version: number }).version).toBe(2);   // monotonic per (scope, ref)

    const h1 = await history(h, A, 'u-owner', 'P1');
    expect(h1.status).toBe(200);
    expect((h1.body as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('is authorized (publish vs read) and per-tenant', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');   // publishes AND reads
    await h.provisionRole(A, 'u-cash', 'cashier');        // reads prices, does NOT publish
    await h.provisionRole(A, 'u-acct', 'accountant');     // neither (no catalogue.pack.read, no price.change.propose)

    // A manager may publish; a cashier and an accountant may not.
    expect((await publish(h, A, 'u-mgr', 'P1', 'e1', { scope: 'store', scopeRef: 'store-1', priceMinor: 10_000, mrpMinor: 20_000, currency: 'INR', effectiveFrom: iso(0) })).status).toBe(201);
    expect((await publish(h, A, 'u-cash', 'P1', 'e2', { scope: 'store', scopeRef: 'store-1', priceMinor: 10_000, mrpMinor: 20_000, currency: 'INR', effectiveFrom: iso(0) })).status).toBe(403);

    // A cashier may resolve a price (the till reads prices); an accountant may not.
    expect((await resolve(h, A, 'u-cash', 'P1', { at: iso(1), storeId: 'store-1' })).status).toBe(200);
    expect((await resolve(h, A, 'u-acct', 'P1', { at: iso(1), storeId: 'store-1' })).status).toBe(403);

    // Unknown product and malformed input are refused cleanly.
    expect((await resolve(h, A, 'u-owner', 'GHOST', { at: iso(1), storeId: 'store-1' })).status).toBe(404);
    expect((await publish(h, A, 'u-owner', 'P1', 'e-bad', { scope: 'nonsense', scopeRef: 'x', priceMinor: 1, mrpMinor: 2, currency: 'INR', effectiveFrom: iso(0) })).status).toBe(400);

    // Another tenant sees nothing of A's price list.
    await h.seedOwner(B, 'u-owner-b');
    expect((await resolve(h, B, 'u-owner-b', 'P1', { at: iso(1), storeId: 'store-1' })).status).toBe(404);
  });
});
