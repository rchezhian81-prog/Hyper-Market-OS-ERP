import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-07 M18-FR-04 — channel reconciliation. A sales channel (marketplace) is reconciled against our own
// ledger IN BOTH DIRECTIONS: an order the channel has and we do not is revenue we never fulfilled; an order we
// have and the channel does not is a phantom; a matched order with a different value or state is surfaced too.
// Stateless: the caller supplies both order lists; nothing is stored.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const recon = (h: ApiHarness, u: string, body: unknown, key = 'rc1') =>
  h.request({ method: 'POST', path: '/v1/orders/channel-reconcile', userId: u, tenantId: A, idempotencyKey: key, body });

interface Recon {
  matched: number; matchedValueMinor: number; reconciles: boolean; atRiskValueMinor: number;
  discrepancies: { kind: string; orderId: string; varianceMinor: number }[];
}

describe('channel reconciliation route (M18-FR-04)', () => {
  it('reconciles exactly when every order matches on id, value and state', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const orders = [{ orderId: 'o-1', valueMinor: 50_000, state: 'confirmed' }, { orderId: 'o-2', valueMinor: 30_000, state: 'delivered' }];
    const res = await recon(h, 'u-owner', { channel: 'bigbasket', channelOrders: orders, ledgerOrders: orders });
    expect(res.status).toBe(200);
    const body = res.body as Recon;
    expect(body.reconciles).toBe(true);
    expect(body.matched).toBe(2);
    expect(body.matchedValueMinor).toBe(80_000);
    expect(body.discrepancies).toHaveLength(0);
    expect(body.atRiskValueMinor).toBe(0);
  });

  it('flags an order the channel has and we do not (revenue never fulfilled)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await recon(h, 'u-owner', {
      channel: 'bigbasket',
      channelOrders: [{ orderId: 'o-1', valueMinor: 50_000, state: 'confirmed' }],
      ledgerOrders: [],
    }, 'rc2');
    const body = res.body as Recon;
    expect(body.reconciles).toBe(false);
    expect(body.discrepancies[0]?.kind).toBe('in_channel_not_in_ledger');
    expect(body.atRiskValueMinor).toBe(50_000);
  });

  it('flags a phantom order we have and the channel does not', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await recon(h, 'u-owner', {
      channel: 'bigbasket',
      channelOrders: [],
      ledgerOrders: [{ orderId: 'o-9', valueMinor: 20_000, state: 'confirmed' }],
    }, 'rc3');
    expect((res.body as Recon).discrepancies[0]?.kind).toBe('in_ledger_not_in_channel');
  });

  it('flags a value mismatch (the variance is ledger − channel) and a state mismatch', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const valueRes = await recon(h, 'u-owner', {
      channel: 'bigbasket',
      channelOrders: [{ orderId: 'o-1', valueMinor: 50_000, state: 'confirmed' }],
      ledgerOrders: [{ orderId: 'o-1', valueMinor: 55_000, state: 'confirmed' }],
    }, 'rc4');
    const v = (valueRes.body as Recon).discrepancies[0];
    expect(v?.kind).toBe('value_mismatch');
    expect(v?.varianceMinor).toBe(5_000); // 55000 ledger − 50000 channel

    const stateRes = await recon(h, 'u-owner', {
      channel: 'bigbasket',
      channelOrders: [{ orderId: 'o-1', valueMinor: 50_000, state: 'delivered' }],
      ledgerOrders: [{ orderId: 'o-1', valueMinor: 50_000, state: 'confirmed' }],
    }, 'rc5');
    const s = (stateRes.body as Recon).discrepancies[0];
    expect(s?.kind).toBe('state_mismatch');
    expect(s?.varianceMinor).toBe(0);
  });

  it('refuses a malformed reconciliation and gates on order.read (a cashier is refused)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    const bad = await recon(h, 'u-owner', { channel: 'x', channelOrders: [{ orderId: 'o-1' }], ledgerOrders: [] }, 'rc6'); // order missing valueMinor/state
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_channel_reconciliation');
    expect((await recon(h, 'u-cash', { channel: 'x', channelOrders: [], ledgerOrders: [] }, 'rc7')).status).toBe(403);
  });
});
