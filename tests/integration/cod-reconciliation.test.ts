import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// COD reconciliation at shift end, end to end (M19-FR-04, API-08). Cash-on-delivery is collected to the
// paisa and reconciled per order against what was expected. Every mismatch is an OWNED, VALUED exception —
// short / over / uncollected / unexpected — never a silent loss (P-08), and it feeds finance reconciliation
// (M23). COD is cash/UPI ONLY: a card method is refused, because the shop never holds card data (hard rule
// #3). Gated delivery.run.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const reconcile = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'cod') =>
  h.request({ method: 'POST', path: '/v1/fulfilment/cod/reconcile', userId: u, tenantId: A, idempotencyKey: key, body });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type Recon = {
  matched: { orderId: string; amountMinor: number }[];
  exceptions: { orderId: string; kind: string; expectedMinor?: number; collectedMinor?: number; varianceMinor?: number }[];
  matchedCount: number; exceptionCount: number;
};

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // delivery.run.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // not
  return h;
}

describe('COD reconciliation: cash to the paisa, every mismatch an owned exception, no card data (M19-FR-04)', () => {
  it('matches what balances and values every mismatch — short, uncollected and unexpected', async () => {
    const h = await cast();
    const body = (await reconcile(h, 'u-mgr', {
      expectations: [
        { orderId: 'o1', expectedMinor: 50000 },
        { orderId: 'o2', expectedMinor: 30000 },
        { orderId: 'o3', expectedMinor: 20000 },
      ],
      collections: [
        { orderId: 'o1', collectedMinor: 50000, method: 'cash' }, // matches to the paisa
        { orderId: 'o2', collectedMinor: 25000, method: 'cash' }, // short by 50
        { orderId: 'o4', collectedMinor: 10000, method: 'upi' },  // nobody expected this
        // o3 was expected but nothing was collected → uncollected
      ],
    })).body as Recon;

    expect(body.matchedCount).toBe(1);
    expect(body.matched[0]).toMatchObject({ orderId: 'o1', amountMinor: 50000 });
    expect(body.exceptionCount).toBe(3);
    const byOrder = Object.fromEntries(body.exceptions.map((e) => [e.orderId, e]));
    expect(byOrder['o2']).toMatchObject({ kind: 'short', expectedMinor: 30000, collectedMinor: 25000, varianceMinor: -5000 });
    expect(byOrder['o3']).toMatchObject({ kind: 'uncollected', expectedMinor: 20000 });
    expect(byOrder['o4']).toMatchObject({ kind: 'unexpected', collectedMinor: 10000 });
  });

  it('flags an over-collection with its positive variance', async () => {
    const h = await cast();
    const body = (await reconcile(h, 'u-owner', {
      expectations: [{ orderId: 'o5', expectedMinor: 40000 }],
      collections: [{ orderId: 'o5', collectedMinor: 45000, method: 'cash' }],
    })).body as Recon;
    expect(body.matchedCount).toBe(0);
    expect(body.exceptions[0]).toMatchObject({ orderId: 'o5', kind: 'over', varianceMinor: 5000 });
  });

  it('refuses a card method — the shop never holds card data (hard rule #3)', async () => {
    const h = await cast();
    const res = await reconcile(h, 'u-mgr', {
      expectations: [{ orderId: 'o6', expectedMinor: 10000 }],
      collections: [{ orderId: 'o6', collectedMinor: 10000, method: 'card' }],
    });
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('card_data_not_allowed');
  });

  it('is gated to fulfilment staff and refuses a malformed reconciliation', async () => {
    const h = await cast();
    const good = { expectations: [{ orderId: 'o7', expectedMinor: 1000 }], collections: [] };
    expect((await reconcile(h, 'u-cash', good, 'cod-cash')).status).toBe(403);
    expect(codeOf(await reconcile(h, 'u-mgr', { expectations: 'nope', collections: [] }, 'cod-bad'))).toBe('not_readable_as_a_cod_reconciliation');
  });
});
