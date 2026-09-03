import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Quotations, end to end (M12-FR-02 / M22, API-05). A price PROMISED, not a sale: it moves no stock, the
// quoted price is honoured only inside its validity window (an expired quote is refused, never silently
// re-priced), a below-floor price needs a separate approver (§28), converting is idempotent (one quote →
// one sale), and a withdrawn/expired quote is KEPT as a lost-sale signal (hard rule #6). Writes gated
// pos.quotation.write; the list and follow-up read pos.quotation.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const line = (over: Record<string, unknown> = {}) =>
  ({ lineId: 'l1', productId: 'p1', description: 'Rice 25kg', unitPriceMinor: 420000, quantityMinor: 1, uom: 'bag', taxBps: 0, ...over });

const issue = (h: ApiHarness, u: string, id: string, body: Record<string, unknown> = {}, key = `i-${id}`) =>
  h.request({ method: 'POST', path: `/v1/pos/quotations/${id}`, userId: u, tenantId: A, idempotencyKey: key,
    body: { storeId: 's1', customerRef: 'cust-1', currency: 'INR', validUntil: '2027-12-31', lines: [line()], ...body } });
const convert = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key = `c-${id}`) =>
  h.request({ method: 'POST', path: `/v1/pos/quotations/${id}/convert`, userId: u, tenantId: A, idempotencyKey: key, body });
const withdraw = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key = `w-${id}`) =>
  h.request({ method: 'POST', path: `/v1/pos/quotations/${id}/withdraw`, userId: u, tenantId: A, idempotencyKey: key, body });
const list = (h: ApiHarness, u: string, query?: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/pos/quotations', userId: u, tenantId: A, ...(query ? { query } : {}) });
const followUp = (h: ApiHarness, u: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/pos/quotations/follow-up', userId: u, tenantId: A, query });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                    // pos.quotation.write + read
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // pos.quotation.write + read
  await h.provisionRole(A, 'u-cash', 'cashier');      // neither
  return h;
}

describe('quotations: a price promised, converted once, held only while valid (M12-FR-02)', () => {
  it('issues a quotation, converts it at the quoted prices once (idempotently), and survives a restart', async () => {
    const h = await cast();
    expect((await issue(h, 'u-mgr', 'q1')).status).toBe(201);
    expect((await list(h, 'u-owner', { state: 'issued' })).body).toMatchObject({ count: 1 });

    const conv = await convert(h, 'u-mgr', 'q1', { saleId: 'sale-1' });
    expect(conv.status).toBe(200);
    const body = conv.body as { converted: boolean; saleId: string; saleLines: { unitPriceMinor: number }[] };
    expect(body).toMatchObject({ converted: true, saleId: 'sale-1' });
    expect(body.saleLines[0]!.unitPriceMinor).toBe(420000); // the promised price

    // A second convert returns the sale that already exists — one quote becomes one sale, not two.
    const again = await convert(h, 'u-mgr', 'q1', { saleId: 'sale-2' }, 'c-q1-again');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ converted: false, alreadyConverted: true, saleId: 'sale-1' });

    // Durable across a restart.
    const h2 = apiHarness({ store: h.store });
    expect((await list(h2, 'u-owner', { state: 'converted' })).body).toMatchObject({ count: 1 });
  });

  it('refuses a below-floor price without a separate approver, and a self-approval (§28)', async () => {
    const h = await cast();
    const belowFloor = { marginFloorBps: 1000, lines: [line({ unitPriceMinor: 10000, unitCostMinor: 9500 })] }; // 5% vs 10% floor

    const unapproved = await issue(h, 'u-mgr', 'q-lo', belowFloor);
    expect(unapproved.status).toBe(422);
    expect(codeOf(unapproved)).toBe('quotation_below_floor_unapproved');

    const selfApproved = await issue(h, 'u-mgr', 'q-self', { ...belowFloor, approval: { subjectRef: 'q-self', status: 'approved', decidedBy: 'u-mgr', reason: 'x' } }, 'i-q-self');
    expect(selfApproved.status).toBe(422);
    expect(codeOf(selfApproved)).toBe('quotation_self_approved');

    // A different person's approval lets it through.
    const approved = await issue(h, 'u-mgr', 'q-ok', { ...belowFloor, approval: { subjectRef: 'q-ok', status: 'approved', decidedBy: 'u-owner', reason: 'strategic account' } }, 'i-q-ok');
    expect(approved.status).toBe(201);
  });

  it('honours the price only inside the validity window — an expired quote is refused, not re-priced', async () => {
    const h = await cast();
    await issue(h, 'u-mgr', 'q-exp', { validUntil: '2027-06-30' });
    const expired = await convert(h, 'u-mgr', 'q-exp', { saleId: 'sale-x', at: '2027-07-01T09:00:00Z' });
    expect(expired.status).toBe(422);
    expect(codeOf(expired)).toBe('quotation_expired');
  });

  it('withdraws with a reason (kept), refuses converting a withdrawn quote, and refuses a reasonless withdraw', async () => {
    const h = await cast();
    await issue(h, 'u-mgr', 'q-wd');
    expect((await withdraw(h, 'u-mgr', 'q-wd', { reason: 'customer went elsewhere' })).status).toBe(200);
    expect((await list(h, 'u-owner', { state: 'withdrawn' })).body).toMatchObject({ count: 1 }); // kept, not deleted

    const conv = await convert(h, 'u-mgr', 'q-wd', { saleId: 'sale-y' });
    expect(conv.status).toBe(422);
    expect(codeOf(conv)).toBe('quotation_withdrawn');

    await issue(h, 'u-mgr', 'q-wd2');
    expect((await withdraw(h, 'u-mgr', 'q-wd2', { reason: '' })).status).toBe(400);
  });

  it('surfaces quotations expiring soon on the follow-up list (soonest first)', async () => {
    const h = await cast();
    await issue(h, 'u-mgr', 'q-soon', { validUntil: '2027-12-31' });
    const res = await followUp(h, 'u-owner', { today: '2027-12-29', withinDays: '3' });
    expect(res.status).toBe(200);
    const body = res.body as { quotations: { quotationId: string; daysLeft: number }[] };
    expect(body.quotations.find((q) => q.quotationId === 'q-soon')).toMatchObject({ daysLeft: 2 });
  });

  it('refuses a re-issue of a known id (409), an unknown convert (404), and gates on the permissions', async () => {
    const h = await cast();
    await issue(h, 'u-mgr', 'q1');
    const dup = await issue(h, 'u-mgr', 'q1', {}, 'i-q1-dup');
    expect(dup.status).toBe(409);
    expect(codeOf(dup)).toBe('quotation_already_exists');

    expect((await convert(h, 'u-mgr', 'nope', { saleId: 's' })).status).toBe(404);

    // A cashier holds neither permission → refused on write and read.
    expect((await issue(h, 'u-cash', 'q-cash')).status).toBe(403);
    expect((await list(h, 'u-cash')).status).toBe(403);
  });
});
