import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Scrap & recycling, end to end through the real API (M28-FR-02, API-09). This is the store's one
// revenue stream with no natural paperwork — cardboard, crates, used oil sold to a man with a van.
// The control is making the number EXIST: proceeds are recorded and must reach the books; an
// unevidenced sale is FLAGGED, never refused; a rate below the category's own running average is the
// question worth asking (of the RATE, not the person). Proves the wired scrap surface against the real
// pipeline and real per-tenant RBAC — another engine nothing fed.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const scrap = (over: Record<string, unknown> = {}) => ({
  scrapId: 's1', branchId: 'BR1', category: 'cardboard', disposal: 'sold',
  grams: 1_000, proceedsMinor: 5_000, handledBy: 'u-owner', at: '2026-08-05T10:00:00.000Z', ...over,
});

const record = (h: ApiHarness, tenantId: string, userId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/scrap/sales', userId, tenantId, idempotencyKey: `sc-${body['scrapId']}`, body });

const markPosted = (h: ApiHarness, tenantId: string, userId: string, scrapId: string) =>
  h.request({ method: 'POST', path: `/v1/scrap/sales/${scrapId}/posted`, userId, tenantId, idempotencyKey: `scp-${scrapId}`, body: {} });

const review = (h: ApiHarness, tenantId: string, userId: string, branchId = 'BR1') =>
  h.request({ method: 'GET', path: '/v1/scrap/review', userId, tenantId, query: { branchId, from: '2026-08-01', to: '2026-08-31' } });

interface Review { sales: number; unpostedMinor: number; findings: { scrapId: string; flag: string }[] }
const flagsFor = (r: Review, id: string) => r.findings.filter((f) => f.scrapId === id).map((f) => f.flag);

describe('scrap proceeds are made to exist, flagged not refused (M28-FR-02, API-09)', () => {
  it('records an unevidenced off-books disposal and flags it rather than refusing it', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await record(h, A, 'u-owner', scrap())).status).toBe(201); // recorded, not refused

    const r = (await review(h, A, 'u-owner')).body as Review;
    expect(r).toMatchObject({ sales: 1, unpostedMinor: 5_000 });
    const flags = flagsFor(r, 's1');
    expect(flags).toContain('no_evidence');
    expect(flags).toContain('no_buyer_named');
    expect(flags).toContain('not_posted_to_finance');
  });

  it('clears the off-books flag once the proceeds are posted to finance', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await record(h, A, 'u-owner', scrap({ buyerName: 'City Recyclers', evidenceRefs: ['weighbridge-slip-42'] }));
    expect(flagsFor((await review(h, A, 'u-owner')).body as Review, 's1')).toContain('not_posted_to_finance');

    expect((await markPosted(h, A, 'u-owner', 's1')).status).toBe(200);
    const after = (await review(h, A, 'u-owner')).body as Review;
    expect(flagsFor(after, 's1')).not.toContain('not_posted_to_finance');
    expect(after.unpostedMinor).toBe(0);
  });

  it('flags e-waste sent to a handler with no recycler registration', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await record(h, A, 'u-owner', scrap({ scrapId: 'e1', category: 'e_waste', buyerName: 'X', evidenceRefs: ['cert'] }));
    expect(flagsFor((await review(h, A, 'u-owner')).body as Review, 'e1')).toContain('unauthorised_recycler');
  });

  it('flags a rate well below the category running average', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const clean = (id: string, proceeds: number) => scrap({ scrapId: id, grams: 1_000, proceedsMinor: proceeds, buyerName: 'City Recyclers', evidenceRefs: ['slip'] });
    // Three cardboard sales at ~5,000/1,000g, then one at 500 — far below the running average.
    await record(h, A, 'u-owner', clean('c1', 5_000));
    await record(h, A, 'u-owner', clean('c2', 5_000));
    await record(h, A, 'u-owner', clean('c3', 5_000));
    await record(h, A, 'u-owner', clean('c4', 500));

    expect(flagsFor((await review(h, A, 'u-owner')).body as Review, 'c4')).toContain('rate_below_average');
    // The at-rate ones are not flagged for rate.
    expect(flagsFor((await review(h, A, 'u-owner')).body as Review, 'c1')).not.toContain('rate_below_average');
  });

  it('is authorized and per-tenant, and refuses a malformed disposal', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not handle scrap accounting
    await record(h, A, 'u-owner', scrap());

    expect((await record(h, A, 'u-cash', scrap({ scrapId: 'sx' }))).status).toBe(403);
    expect((await review(h, A, 'u-cash')).status).toBe(403);
    expect((await record(h, A, 'u-owner', { scrapId: 'sy', branchId: 'BR1', category: 'nonsense' })).status).toBe(400);
    expect((await markPosted(h, A, 'u-owner', 'GHOST')).status).toBe(404);

    // Tenant B has no scrap of its own.
    await h.seedOwner(B, 'u-owner-b');
    expect(((await review(h, B, 'u-owner-b')).body as Review).sales).toBe(0);
  });
});
