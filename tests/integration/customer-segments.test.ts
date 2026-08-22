import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Customer segmentation & value ranking, end to end (M16-FR-02 · PRV/DPDP, API-06). Two truths this
// proves through the live API: consent is TWO permissions — analysing a customer (profiling) is not
// messaging them (marketing), a marketing audience needs BOTH, and the excluded-for-consent count is
// always in the answer (never a silently smaller list); and VALUE is margin, not revenue. Gated
// customer.segment.read; a pure compute over the facts supplied — it writes nothing.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AS_OF = '2026-08-22T00:00:00Z';

const audience = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'aud1') =>
  h.request({ method: 'POST', path: '/v1/customer/segments/audience', userId: u, tenantId: A, idempotencyKey: key, body });
const ranking = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'rank1') =>
  h.request({ method: 'POST', path: '/v1/customer/segments/value-ranking', userId: u, tenantId: A, idempotencyKey: key, body });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// Three recent orders → a 'regular' customer (≥2 and <10, not lapsed).
const orders = (cust: string, net = 1000, margin = 300) =>
  [1, 2, 3].map((n) => ({ orderId: `${cust}-o${n}`, customerRef: cust, at: '2026-08-20T00:00:00Z', netMinor: net, marginMinor: margin, channel: 'store' }));

type Audience = { segment: string; purpose: string; customerRefs: string[]; excludedForConsent: number; detail: string };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // customer.segment.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // not
  return h;
}

describe('customer segmentation: consent is two permissions, value is margin (M16-FR-02)', () => {
  it('a marketing audience needs profiling AND marketing consent, and reports who was excluded', async () => {
    const h = await cast();
    const body = {
      segment: 'regular', purpose: 'marketing', asOf: AS_OF,
      orders: [...orders('c1'), ...orders('c2'), ...orders('c3'), ...orders('c4')],
      consents: [
        { customerRef: 'c1', granted: ['profiling', 'marketing'] }, // contactable
        { customerRef: 'c2', granted: ['profiling'] },              // analysed, but not messageable
        { customerRef: 'c3', granted: ['marketing'] },              // no profiling → not even segmented
        { customerRef: 'c4', granted: [] },                          // nothing
      ],
    };
    const a = (await audience(h, 'u-owner', body)).body as Audience;
    // Only c1 can be messaged; c2 matched the segment but has no marketing consent → excluded (and counted).
    expect(a).toMatchObject({ segment: 'regular', purpose: 'marketing', customerRefs: ['c1'], excludedForConsent: 1 });
    expect(a.detail).toContain('not consented');
  });

  it('a service purpose is performance of the contract — built regardless of marketing consent', async () => {
    const h = await cast();
    const body = {
      segment: 'regular', purpose: 'service', asOf: AS_OF,
      orders: [...orders('c1'), ...orders('c2'), ...orders('c3')],
      consents: [{ customerRef: 'c1', granted: [] }], // no consent at all
    };
    const a = (await audience(h, 'u-owner', body)).body as Audience;
    // Service needs no marketing consent — everyone in the segment is reachable, nobody excluded.
    expect(a.customerRefs.sort()).toEqual(['c1', 'c2', 'c3']);
    expect(a.excludedForConsent).toBe(0);
  });

  it('ranks by margin not revenue, and leaves a non-profiled customer out of the rank', async () => {
    const h = await cast();
    const body = {
      asOf: AS_OF,
      // c1: big spender, thin margin (₹50,000 @ 4%). c2: smaller, fat margin (₹20,000 @ 30%). c3: no consent.
      orders: [
        { orderId: 'c1-o', customerRef: 'c1', at: '2026-08-20T00:00:00Z', netMinor: 5_000_000, marginMinor: 200_000, channel: 'store' },
        { orderId: 'c2-o', customerRef: 'c2', at: '2026-08-20T00:00:00Z', netMinor: 2_000_000, marginMinor: 600_000, channel: 'store' },
        { orderId: 'c3-o', customerRef: 'c3', at: '2026-08-20T00:00:00Z', netMinor: 1_000_000, marginMinor: 300_000, channel: 'store' },
      ],
      consents: [
        { customerRef: 'c1', granted: ['profiling'] },
        { customerRef: 'c2', granted: ['profiling'] },
        { customerRef: 'c3', granted: [] }, // not profiled → excluded from the rank
      ],
    };
    const r = (await ranking(h, 'u-owner', body)).body as { ranking: { customerRef: string; lifetimeMarginMinor: number }[]; count: number };
    expect(r.count).toBe(2); // c3 is not ranked
    // The fat-margin customer outranks the big spender.
    expect(r.ranking.map((x) => x.customerRef)).toEqual(['c2', 'c1']);
    expect(r.ranking[0]?.lifetimeMarginMinor).toBe(600_000);
  });

  it('is gated to segment readers, and refuses a malformed request', async () => {
    const h = await cast();
    expect((await audience(h, 'u-cash', { segment: 'regular', purpose: 'marketing', orders: [], consents: [] })).status).toBe(403);
    // An unknown segment, and a malformed order fact, are both 400s.
    expect(codeOf(await audience(h, 'u-owner', { segment: 'nonsense', purpose: 'marketing', orders: [], consents: [] }, 'aud-b'))).toBe('not_readable_as_an_audience_request');
    expect(codeOf(await audience(h, 'u-owner', { segment: 'regular', purpose: 'marketing', consents: [], orders: [{ orderId: 'x', customerRef: 'c1', at: '2026-08-20T00:00:00Z', netMinor: 100, channel: 'store' }] }, 'aud-c'))).toBe('not_readable_as_an_audience_request');
  });
});
