import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import type { MatchLine, MatchResult } from '../../packages/purchasing/src/three-way-match';

// The three-way match, end to end through the real API (M06/M07, API-03, D03). A supplier invoice's
// lines are CAPTURED (ordered/received/invoiced per line) and only then MATCHED: what may be paid is
// the LOWEST of the three, and where they disagree the difference is WITHHELD until a person settles
// it (M07-FR-04, hard rule "conflicts become visible exceptions"). This proves the wired
// `services/purchase` capture+match against the real pipeline and real per-tenant RBAC — an invoice
// nobody captured is refused as *not checked*, which is a different answer from *checked and clean*.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const line = (over: Partial<MatchLine> = {}): MatchLine => ({
  productId: 'P1', orderedQty: 10, receivedQty: 10, invoicedQty: 10,
  orderedUnitMinor: 500, invoicedUnitMinor: 500, ...over,
});

const capture = (h: ApiHarness, tenantId: string, userId: string, invoiceId: string, lines: readonly MatchLine[], key?: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/invoices/${invoiceId}/capture`, userId, tenantId, idempotencyKey: key ?? `cap-${invoiceId}`, body: { lines } });

const match = async (h: ApiHarness, tenantId: string, userId: string, invoiceId: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/invoices/${invoiceId}/match`, userId, tenantId, idempotencyKey: `mat-${invoiceId}` });

describe('supplier invoices are captured then three-way matched (M06/M07, API-03)', () => {
  it('pays a clean invoice in full: order, delivery and invoice agree', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect((await capture(h, A, 'u-owner', 'inv-clean', [line()])).status).toBe(201);

    const res = await match(h, A, 'u-owner', 'inv-clean');
    expect(res.status).toBe(200);
    const r = res.body as MatchResult;
    expect(r).toMatchObject({ blocked: false, payableMinor: 5000, invoicedMinor: 5000, withheldMinor: 0 });
  });

  it('withholds the overage on an out-of-tolerance invoice, paying only what all three agree on', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // Ordered and received 10; invoiced 20. Pay the lowest (10 × ₹5) and hold back the rest.
    expect((await capture(h, A, 'u-owner', 'inv-over', [line({ invoicedQty: 20 })])).status).toBe(201);

    const r = (await match(h, A, 'u-owner', 'inv-over')).body as MatchResult;
    expect(r).toMatchObject({ blocked: true, payableMinor: 5000, invoicedMinor: 10000, withheldMinor: 5000 });
  });

  it('refuses an invoice nobody captured as NOT CHECKED, not as clean', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // No capture for this invoice — the match holds no lines to compare.
    const r = (await match(h, A, 'u-owner', 'inv-ghost')).body as MatchResult;
    expect(r.blocked).toBe(true);
    expect(r.payableMinor).toBe(0);
    expect(r.detail).toContain('no lines were found');
  });

  it('collapses a re-sent capture rather than doubling the lines the match compares', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // Same invoice captured twice under DIFFERENT request keys — both reach the adapter, whose event
    // idempotency key carries no timestamp, so the second append collapses onto the first.
    await capture(h, A, 'u-owner', 'inv-dup', [line()], 'cap-dup-1');
    await capture(h, A, 'u-owner', 'inv-dup', [line()], 'cap-dup-2');

    const r = (await match(h, A, 'u-owner', 'inv-dup')).body as MatchResult;
    expect(r.payableMinor).toBe(5000); // not 10000 — the lines were not doubled
  });

  it('is authorized and per-tenant: a cashier cannot capture (403), and one tenant\'s capture never reaches another', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await capture(h, A, 'u-owner', 'inv-iso', [line()]);

    // A cashier holds neither capture nor match on the purchase surface.
    expect((await capture(h, A, 'u-cash', 'inv-cash', [line()])).status).toBe(403);
    expect((await match(h, A, 'u-cash', 'inv-iso')).status).toBe(403);

    // Tenant B never captured that invoice, so its match finds nothing — A's lines did not leak.
    await h.seedOwner(B, 'u-owner-b');
    const rb = (await match(h, B, 'u-owner-b', 'inv-iso')).body as MatchResult;
    expect(rb.blocked).toBe(true);
    expect(rb.payableMinor).toBe(0);
  });

  it('refuses an empty or malformed capture without saving anything', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect((await capture(h, A, 'u-owner', 'inv-empty', [])).status).toBe(400);
    // A line with a negative quantity is not readable.
    expect((await capture(h, A, 'u-owner', 'inv-bad', [line({ invoicedQty: -1 })])).status).toBe(422);
    // Neither was saved: the match still finds nothing to compare.
    expect(((await match(h, A, 'u-owner', 'inv-bad')).body as MatchResult).payableMinor).toBe(0);
  });
});
