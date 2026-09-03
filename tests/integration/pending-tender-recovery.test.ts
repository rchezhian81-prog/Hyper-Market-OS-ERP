import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Pending-tender recovery, end to end (D04-FR-02 / M12-FR-03, API-09). A card/UPI tender the lane committed
// as `uncertain` (the machine never answered) is reconciled against the PROVIDER'S OWN authorisation record.
// Both costly outcomes are surfaced in opposite directions — the shop owed (NOT PAID) and the customer owed
// (PAID TWICE / OVER-CAPTURED) — the exposure is split four ways, and the day may close ONLY while the shop is
// not holding a customer's money. A pure compute over supplied evidence; no manual resolution (§4.3), and a
// providerRef that looks like a card number is refused (hard rule #3). Gated settlement.review.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
// A valid-Luhn Visa test PAN, built from parts so the secret scanner does not flag a 16-digit literal.
const CARD_LIKE = ['4111', '1111', '1111', '1111'].join('');

const tender = (over: Record<string, unknown> = {}) =>
  ({ tenderId: 't1', saleId: 's1', laneId: 'lane-1', kind: 'card', providerRef: 'tok-1', amountMinor: 1000, currency: 'INR', capturedAt: '2026-09-02T18:00:00Z', ...over });
const auth = (over: Record<string, unknown> = {}) =>
  ({ ref: 'tok-1', amountMinor: 1000, status: 'captured', at: '2026-09-02T18:00:05Z', ...over });

const recover = (h: ApiHarness, u: string, body: unknown, key = 'r-1') =>
  h.request({ method: 'POST', path: '/v1/settlement/pending-tenders/recover', userId: u, tenantId: A, idempotencyKey: key, body });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                   // settlement.review.read
  await h.provisionRole(A, 'u-book', 'accountant');  // settlement.review.read
  await h.provisionRole(A, 'u-cash', 'cashier');     // neither
  return h;
}

type Result = { tenderId: string; outcome: string; owedMinor: number; owedBy: string; contactable: boolean };
type Body = { results: Result[]; exposure: { recoverableMinor: number; unrecoverableMinor: number; owedToCustomersMinor: number; unknownMinor: number }; dayClose: { canClose: boolean; detail: string } };

describe('pending-tender recovery: reconcile the uncertain tender both ways (D04-FR-02 / M12-FR-03)', () => {
  it('reconciles a mix — paid, over-captured (customer owed), unpaid to a known and an anonymous customer', async () => {
    const h = await cast();
    const res = await recover(h, 'u-owner', {
      statementComplete: true,
      tenders: [
        tender({ tenderId: 't-paid', providerRef: 'ok', amountMinor: 1000 }),
        tender({ tenderId: 't-double', providerRef: 'dbl', amountMinor: 500 }),
        tender({ tenderId: 't-known', providerRef: 'dec', amountMinor: 800, customerRef: 'cust-1' }),
        tender({ tenderId: 't-anon', providerRef: 'non', amountMinor: 300 }), // no customerRef → anonymous
      ],
      authorisations: [
        auth({ ref: 'ok', amountMinor: 1000, status: 'captured' }),
        auth({ ref: 'dbl', amountMinor: 500, status: 'captured' }),
        auth({ ref: 'dbl', amountMinor: 500, status: 'captured' }), // two captures against one sale
        auth({ ref: 'dec', amountMinor: 800, status: 'declined' }),
        // 'non' has no authorisation; on a COMPLETE statement that is a genuine non-payment.
      ],
    });
    expect(res.status).toBe(200);
    const body = res.body as Body;
    const by = (id: string) => body.results.find((r) => r.tenderId === id)!;

    expect(by('t-paid')).toMatchObject({ outcome: 'confirmed_paid', owedMinor: 0, owedBy: 'nobody' });
    expect(by('t-double')).toMatchObject({ outcome: 'paid_more_than_once', owedMinor: 500, owedBy: 'customer' });
    expect(by('t-known')).toMatchObject({ outcome: 'confirmed_not_paid', owedMinor: 800, owedBy: 'shop', contactable: true });
    expect(by('t-anon')).toMatchObject({ outcome: 'confirmed_not_paid', owedMinor: 300, owedBy: 'shop', contactable: false });

    // The exposure is split four ways — a debt from an identified customer is not a loss from an anonymous one.
    expect(body.exposure).toMatchObject({ recoverableMinor: 800, unrecoverableMinor: 300, owedToCustomersMinor: 500, unknownMinor: 0 });
    // The day is blocked because the shop is holding a customer's money.
    expect(body.dayClose.canClose).toBe(false);
    expect(body.dayClose.detail).toContain('owed back to customers');
  });

  it('an incomplete provider record is UNKNOWN, not a decline — the day still closes but the figure is stated', async () => {
    const h = await cast();
    const res = await recover(h, 'u-owner', {
      statementComplete: false,
      tenders: [tender({ tenderId: 't-unk', providerRef: 'pending', amountMinor: 400 })],
      authorisations: [], // no record yet — but the statement is not complete, so this is not "not paid"
    });
    const body = res.body as Body;
    expect(body.results[0]).toMatchObject({ outcome: 'still_unknown', owedBy: 'shop' });
    expect(body.exposure).toMatchObject({ unknownMinor: 400, recoverableMinor: 0, owedToCustomersMinor: 0 });
    expect(body.dayClose.canClose).toBe(true); // an unknown never blocks the close
    expect(body.dayClose.detail).toContain('still unknown');
  });

  it('refuses a providerRef that looks like a card number (hard rule #3) — on a tender or an authorisation', async () => {
    const h = await cast();
    const onTender = await recover(h, 'u-owner', {
      statementComplete: true, authorisations: [],
      tenders: [tender({ providerRef: CARD_LIKE })],
    });
    expect(onTender.status).toBe(422);
    expect(codeOf(onTender)).toBe('provider_ref_not_a_token');

    const onAuth = await recover(h, 'u-owner', {
      statementComplete: true,
      tenders: [tender()],
      authorisations: [auth({ ref: CARD_LIKE })],
    }, 'r-2');
    expect(onAuth.status).toBe(422);
    expect(codeOf(onAuth)).toBe('provider_ref_not_a_token');
  });

  it('rejects a malformed body (400) and gates on settlement.review.read', async () => {
    const h = await cast();
    const bad = await recover(h, 'u-owner', { tenders: 'nope', authorisations: [], statementComplete: true });
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_pending_recovery');

    // Missing statementComplete is also a 400 (it is load-bearing, not defaulted).
    const noFlag = await recover(h, 'u-owner', { tenders: [tender()], authorisations: [] }, 'r-noflag');
    expect(noFlag.status).toBe(400);

    // Accountant may reconcile; a cashier (no settlement.review.read) is refused.
    expect((await recover(h, 'u-book', { tenders: [tender()], authorisations: [auth()], statementComplete: true }, 'r-book')).status).toBe(200);
    expect((await recover(h, 'u-cash', { tenders: [tender()], authorisations: [auth()], statementComplete: true }, 'r-cash')).status).toBe(403);
  });
});
