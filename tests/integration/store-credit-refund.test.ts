import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// A refund issued as store credit becomes a real, spendable balance end to end (M13-FR-03 / M17,
// API-05/06). Store credit is the shop taking on a liability, so it is capped by the owner, issued to a
// named customer, recorded ATOMICALLY with the return, and idempotent on the return id. This proves the
// wired path against the real API + RBAC + the stored-value read side.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const sale = () => ({
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-08-07', committedAt: '2026-08-07T10:00:00.000Z', totalMinor: 15000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amountMinor: 15000 }],
});

const bank = (h: ApiHarness, userId: string) =>
  h.request({ method: 'POST', path: '/v1/sales', userId, tenantId: A, idempotencyKey: 'bank-S1', body: sale() });

// A store-credit refund of 1 unit of P1 (₹50), resold, approved by u-mgr (the default 0 threshold makes
// every refund material), issued to customer c-asha.
const scReq = (over: Record<string, unknown> = {}) => ({
  returnId: 'RT-SC', number: 'RN-SC', reasonCode: 'customer_changed_mind',
  lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' as const }],
  refundMinor: 5000, refundTender: 'store_credit', approvedBy: 'u-mgr', customerRef: 'c-asha', ...over,
});
const ret = (h: ApiHarness, userId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/sales/S1/returns', userId, tenantId: A, idempotencyKey: `ret-${body['returnId']}`, body });

const setCap = (h: ApiHarness, userId: string, capMinor: number, key: string) =>
  h.request({ method: 'POST', path: '/v1/pos/store-credit-cap', userId, tenantId: A, idempotencyKey: key, body: { capMinor } });
const getInstrument = (h: ApiHarness, userId: string, instrumentId: string) =>
  h.request({ method: 'GET', path: `/v1/stored-value/instruments/${instrumentId}`, userId, tenantId: A });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds pos.return.approve
  return h;
}

describe('a store-credit refund issues a real spendable balance (M13-FR-03 / M17)', () => {
  it('is refused until the owner sets a store-credit cap (fail-safe)', async () => {
    const h = await cast();
    await bank(h, 'u-owner');
    const res = await ret(h, 'u-owner', scReq({ returnId: 'RT-NOCAP' }));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('store_credit_unavailable');
  });

  it('is refused without a customer to issue the credit to', async () => {
    const h = await cast();
    await bank(h, 'u-owner');
    expect((await setCap(h, 'u-owner', 100000, 'cap1')).status).toBe(200);
    const res = await ret(h, 'u-owner', scReq({ returnId: 'RT-NOCUST', customerRef: undefined }));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('store_credit_needs_a_customer');
  });

  it('issues a spendable instrument whose balance equals the refund, once the cap is set', async () => {
    const h = await cast();
    await bank(h, 'u-owner');
    expect((await setCap(h, 'u-owner', 100000, 'cap1')).status).toBe(200);

    const res = await ret(h, 'u-owner', scReq());
    expect(res.status).toBe(201);
    const body = res.body as { refundStatus: string; storeCredit?: { instrumentId: string; balanceMinor: number } };
    expect(body.refundStatus).toBe('settled');
    expect(body.storeCredit?.balanceMinor).toBe(5000);
    const instrumentId = body.storeCredit!.instrumentId;

    // The balance is real and spendable — the stored-value read confirms it.
    const inst = await getInstrument(h, 'u-owner', instrumentId);
    expect(inst.status).toBe(200);
    expect(inst.body).toMatchObject({ kind: 'store_credit', ownerRef: 'c-asha', balanceMinor: 5000 });
  });

  it('refuses a refund above the cap without issuing anything', async () => {
    const h = await cast();
    await bank(h, 'u-owner');
    expect((await setCap(h, 'u-owner', 4000, 'cap-low')).status).toBe(200); // ₹40 cap, refund is ₹50
    const res = await ret(h, 'u-owner', scReq({ returnId: 'RT-OVER' }));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('store_credit_over_cap');
    // Nothing was issued.
    expect((await getInstrument(h, 'u-owner', 'store-credit:RT-OVER')).status).toBe(404);
  });

  it('is idempotent on the return id — a retry does not double the credit', async () => {
    const h = await cast();
    await bank(h, 'u-owner');
    expect((await setCap(h, 'u-owner', 100000, 'cap1')).status).toBe(200);
    expect((await ret(h, 'u-owner', scReq())).status).toBe(201);
    expect((await ret(h, 'u-owner', scReq())).status).toBe(201); // same returnId, resent
    const inst = await getInstrument(h, 'u-owner', 'store-credit:RT-SC');
    expect((inst.body as { balanceMinor: number }).balanceMinor).toBe(5000); // not 10,000
  });
});
