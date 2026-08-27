import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Customer duplicate detection, end to end (M16-FR-01 · P-02 · P-08 · §28, API-06). The same person enrolls
// twice — at the till on Tuesday, on the app on Friday — and their spend, loyalty and consent split across two
// records. Duplicates are FOUND, but nothing is ever AUTO-MERGED: a shared VERIFIED phone/email is a
// high-confidence merge CANDIDATE, a shared unverified contact or matching name is low-confidence REVIEW, and
// the merge itself is a governed, reversible, audited act by a person. Gated customer.segment.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const detect = (h: ApiHarness, u: string, customers: unknown[], key = 'dup') =>
  h.request({ method: 'POST', path: '/v1/customer/duplicates', userId: u, tenantId: A, idempotencyKey: key, body: { customers } });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type Body = { matches: { customerIds: [string, string]; matchedOn: string; confidence: string; disposition: string }[]; count: number; mergeCandidates: number; forReview: number };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner'); // customer.segment.read
  await h.provisionRole(A, 'u-cash', 'cashier'); // not
  return h;
}

describe('customer duplicates: found and proposed, never auto-merged (M16-FR-01)', () => {
  it('flags a shared VERIFIED phone or email as a high-confidence merge candidate', async () => {
    const h = await cast();
    const b = (await detect(h, 'u-owner', [
      { customerId: 'c1', phone: '9876543210', phoneVerified: true },
      { customerId: 'c2', phone: '98765-43210', phoneVerified: true }, // same number, normalised
      { customerId: 'c3', email: 'a@x.com', emailVerified: true },
      { customerId: 'c4', email: 'A@X.com ', emailVerified: true },     // same email, normalised
    ])).body as Body;
    expect(b.mergeCandidates).toBe(2);
    expect(b.forReview).toBe(0);
    const phone = b.matches.find((m) => m.matchedOn === 'verified_phone');
    expect(phone).toMatchObject({ customerIds: ['c1', 'c2'], confidence: 'high', disposition: 'merge_candidate' });
    expect(b.matches.some((m) => m.matchedOn === 'verified_email' && m.disposition === 'merge_candidate')).toBe(true);
  });

  it('sends a shared UNVERIFIED contact or a matching name to review — low confidence, never merged', async () => {
    const h = await cast();
    const b = (await detect(h, 'u-owner', [
      { customerId: 'c5', phone: '5551234', phoneVerified: false },
      { customerId: 'c6', phone: '555 1234', phoneVerified: false }, // same number, but unverified
      { customerId: 'c7', name: 'Ravi Menon' },
      { customerId: 'c8', name: 'ravi  menon' },                     // same name, normalised
    ])).body as Body;
    expect(b.mergeCandidates).toBe(0);
    expect(b.forReview).toBe(2);
    expect(b.matches.every((m) => m.confidence === 'low' && m.disposition === 'review')).toBe(true);
    expect(b.matches.some((m) => m.matchedOn === 'unverified_contact')).toBe(true);
    expect(b.matches.some((m) => m.matchedOn === 'name')).toBe(true);
  });

  it('orders high-confidence first and finds nothing among genuinely distinct people', async () => {
    const h = await cast();
    const mixed = (await detect(h, 'u-owner', [
      { customerId: 'c1', phone: '9876543210', phoneVerified: true },
      { customerId: 'c2', phone: '9876543210', phoneVerified: true }, // high
      { customerId: 'c7', name: 'Ravi Menon' },
      { customerId: 'c8', name: 'ravi menon' },                       // low
    ], 'mix')).body as Body;
    expect(mixed.matches[0]?.confidence).toBe('high'); // high-confidence first

    const none = (await detect(h, 'u-owner', [
      { customerId: 'd1', phone: '1111111', name: 'Asha' },
      { customerId: 'd2', phone: '2222222', name: 'Bala' },
    ], 'none')).body as Body;
    expect(none.count).toBe(0);
  });

  it('is gated and refuses a malformed customer set', async () => {
    const h = await cast();
    expect((await detect(h, 'u-cash', [{ customerId: 'c1' }], 'gate')).status).toBe(403);
    expect(codeOf(await detect(h, 'u-owner', [{ phone: '123' }], 'bad'))).toBe('not_readable_as_a_customer_set'); // no customerId
  });
});
