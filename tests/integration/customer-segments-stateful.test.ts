import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M16-FR-02 — the STATEFUL segmentation surface. The audience/value-ranking engines were what-ifs over
// facts supplied in the body; this runs them over the tenant's STORED order/complaint facts + STORED
// policy + the STORED consent ledger. The consent ledger is per-(purpose,channel); segmentation folds it
// to a purpose-level view per the owner-chosen rule: `?channel=` → that contact channel exactly (the count
// you see is the count you can send to), omit → reachable on any channel. The binding per-channel check
// still runs at send time, so this is a targeting pre-filter, never the final permission.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const setPolicy = (h: ApiHarness, body: unknown) =>
  h.request({ method: 'POST', path: '/v1/customer/segments/policy', userId: 'u-owner', tenantId: A, idempotencyKey: 'pol', body });
const recordOrder = (h: ApiHarness, u: string, orderId: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/customer/facts/orders/${orderId}`, userId: u, tenantId: A, idempotencyKey: `o-${orderId}`, body });
const recordConsent = (h: ApiHarness, cust: string, purpose: string, channel: string, given: boolean) =>
  h.request({ method: 'POST', path: `/v1/customers/${cust}/consent`, userId: 'u-owner', tenantId: A, idempotencyKey: `c-${cust}-${purpose}-${channel}-${given}`, body: { purpose, channel, given, evidence: 'test seed consent' } });
const audience = (h: ApiHarness, query: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/customer/segments/audience', userId: 'u-owner', tenantId: A, query });
const ranking = (h: ApiHarness, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/customer/segments/value-ranking', userId: 'u-owner', tenantId: A, query });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code ?? (res.body as { code?: string }).code;

// Three recent orders → "loyal" once the tenant sets loyalAtOrders:3.
async function threeRecentOrders(h: ApiHarness, ref: string): Promise<void> {
  for (const [i, day] of ['05', '09', '14'].entries()) {
    await recordOrder(h, 'u-owner', `${ref}-${i}`, { customerRef: ref, at: `2026-09-${day}T10:00:00.000Z`, netMinor: 20000, marginMinor: 6000, channel: 'store' });
  }
}

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                    // customer.segment.manage + read + consent.write
  await h.provisionRole(A, 'u-cash', 'cashier');      // holds none of those
  await setPolicy(h, { loyalAtOrders: 3 });
  // Two loyal customers who consented on DIFFERENT channels.
  await threeRecentOrders(h, 'C1');
  await threeRecentOrders(h, 'C2');
  await recordConsent(h, 'C1', 'marketing', 'sms', true);
  await recordConsent(h, 'C1', 'profiling', 'sms', true);
  // C2 can be PROFILED on SMS (so it lands in the "loyal" segment under a ?channel=sms read) but has
  // only consented to MARKETING on email — so under ?channel=sms it matches the segment yet is not
  // SMS-contactable, which is exactly the "excluded for consent" case (surfaced, never silently dropped).
  await recordConsent(h, 'C2', 'profiling', 'sms', true);
  await recordConsent(h, 'C2', 'profiling', 'email', true);
  await recordConsent(h, 'C2', 'marketing', 'email', true);
  return h;
}

describe('stateful customer segmentation over stored facts + consent (M16-FR-02)', () => {
  it('a marketing audience with NO channel reads "reachable on any channel" — both loyal, consented customers', async () => {
    const h = await cast();
    const res = (await audience(h, { segment: 'loyal', purpose: 'marketing' })).body as { customerRefs: string[]; excludedForConsent: number };
    expect(res.customerRefs).toEqual(['C1', 'C2']);
    expect(res.excludedForConsent).toBe(0);
  });

  it('the SAME audience narrowed to ?channel=sms is exactly who can be reached on SMS — the count you see is the count you can send', async () => {
    const h = await cast();
    const res = (await audience(h, { segment: 'loyal', purpose: 'marketing', channel: 'sms' })).body as { customerRefs: string[]; excludedForConsent: number };
    expect(res.customerRefs).toEqual(['C1']);      // C2 consented on email, not SMS
    expect(res.excludedForConsent).toBe(1);        // C2 matches "loyal" but is not SMS-contactable — surfaced, not dropped
  });

  it('the value ranking runs over stored facts by margin — both profiled customers appear', async () => {
    const h = await cast();
    const res = (await ranking(h)).body as { ranking: { customerRef: string }[]; count: number };
    expect(res.count).toBe(2);
    expect(res.ranking.map((r) => r.customerRef).sort()).toEqual(['C1', 'C2']);
  });

  it('recording facts is manager-gated, and a malformed fact is refused', async () => {
    const h = await cast();
    expect((await recordOrder(h, 'u-cash', 'X-1', { customerRef: 'X', at: '2026-09-14T10:00:00.000Z', netMinor: 100, marginMinor: 10, channel: 'store' })).status).toBe(403);
    expect(codeOf(await recordOrder(h, 'u-owner', 'X-2', { customerRef: 'X', at: 'not-a-date', netMinor: 100, marginMinor: 10, channel: 'store' }))).toBe('not_readable_as_an_order_fact');
  });
});
