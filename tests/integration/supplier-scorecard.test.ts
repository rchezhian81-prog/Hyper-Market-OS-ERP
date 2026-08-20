import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M06-FR-03: supplier scorecards + contract alerts on the live API. Buyers judge suppliers on the
// relationship; the numbers usually say something different, and the gap is expensive. Delivery
// OUTCOMES are recorded per PO (never an opinion) and the tested scoreSupplier turns them into fill
// rate, on-time (vs the contracted lead time), lead-time RELIABILITY (the spread), price adherence,
// quality, and a weighted overall — with a plain-English worst-signal-first summary, and `not_rated`
// where there is no evidence. reviewContracts surfaces expiring/expired/UNAPPROVED contracts worst-first.
// Recording is gated purchase.performance.record / purchase.contract.manage; reads purchase.commitment.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INR = 'INR';
const money = (minor: number) => ({ minor, currency: INR });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type Rating = { kind: string; bp?: number };
interface CardShape {
  deliveries?: number;
  summary?: string;
  fillRate: Rating;
  onTime: Rating;
  leadTimeReliability: Rating;
  priceAdherence: Rating;
  quality: Rating;
  overall: Rating;
}
const cardOf = (res: { body: unknown }): CardShape =>
  ((res.body as { scorecard?: unknown }).scorecard ?? {}) as CardShape;

const receiptBody = (over: Record<string, unknown> = {}) => ({
  orderedOn: '2026-07-01', receivedOn: '2026-07-08',
  orderedQtyMinor: 100, receivedQtyMinor: 100,
  agreedValue: money(100_000), invoicedValue: money(100_000), ...over,
});

const recordReceipt = (h: ApiHarness, u: string, sup: string, po: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/suppliers/${sup}/receipts/${po}`, userId: u, tenantId: A, idempotencyKey: key, body });
const recordContract = (h: ApiHarness, u: string, cid: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/contracts/${cid}`, userId: u, tenantId: A, idempotencyKey: key, body });
const scorecard = (h: ApiHarness, u: string, sup: string) =>
  h.request({ method: 'GET', path: `/v1/purchase/suppliers/${sup}/scorecard`, userId: u, tenantId: A });
const contractAlerts = (h: ApiHarness, u: string, onDate: string) =>
  h.request({ method: 'GET', path: '/v1/purchase/contracts/alerts', userId: u, tenantId: A, query: { onDate } });

const contract = (over: Record<string, unknown> = {}) =>
  ({ supplierId: 'sup-1', startsOn: '2026-01-01', endsOn: '2026-12-31', agreedLeadTimeDays: 7, approvedBy: 'u-owner', ...over });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // record + read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('supplier scorecards + contract alerts (M06-FR-03)', () => {
  it('scores a supplier who does everything right, from the recorded facts', async () => {
    const h = await cast();
    await recordContract(h, 'u-owner', 'c-1', contract(), 'kc');
    await recordReceipt(h, 'u-mgr', 'sup-1', 'po-1', receiptBody(), 'k1');
    await recordReceipt(h, 'u-mgr', 'sup-1', 'po-2', receiptBody({ orderedOn: '2026-07-10', receivedOn: '2026-07-17' }), 'k2');

    const card = cardOf(await scorecard(h, 'u-owner', 'sup-1'));
    expect(card.deliveries).toBe(2);
    expect(card.fillRate).toEqual({ kind: 'rated', bp: 10_000 });
    expect(card.onTime).toEqual({ kind: 'rated', bp: 10_000 }); // 7 days vs an agreed 7
    expect(card.overall.kind).toBe('rated');
    expect(card.summary).toBe('no concerns in the period');
  });

  it('names the short deliverer for what it costs, and catches invoice drift', async () => {
    const h = await cast();
    await recordContract(h, 'u-owner', 'c-1', contract(), 'kc');
    await recordReceipt(h, 'u-mgr', 'sup-1', 'po-1', receiptBody({ receivedQtyMinor: 82, invoicedValue: money(102_000) }), 'k1');

    const card = cardOf(await scorecard(h, 'u-owner', 'sup-1'));
    expect(card.fillRate).toEqual({ kind: 'rated', bp: 8_200 });
    expect(card.priceAdherence).toEqual({ kind: 'rated', bp: 9_800 });
    expect(card.summary).toContain('the lost sale dwarfs any price advantage');
    expect(card.summary).toContain('invoices run above the agreed value by 2.0%');
  });

  it('re-recording a delivery supersedes it — the score counts it once, not twice', async () => {
    const h = await cast();
    await recordContract(h, 'u-owner', 'c-1', contract(), 'kc');
    await recordReceipt(h, 'u-mgr', 'sup-1', 'po-1', receiptBody({ receivedQtyMinor: 50 }), 'k1'); // first, wrong
    await recordReceipt(h, 'u-mgr', 'sup-1', 'po-1', receiptBody({ receivedQtyMinor: 100 }), 'k2'); // corrected
    const card = cardOf(await scorecard(h, 'u-owner', 'sup-1'));
    expect(card.deliveries).toBe(1);
    expect(card.fillRate).toEqual({ kind: 'rated', bp: 10_000 }); // the correction won, not the average
  });

  it('says "not rated" rather than flattering a supplier with no evidence', async () => {
    const h = await cast();
    const empty = cardOf(await scorecard(h, 'u-owner', 'sup-9'));
    expect(empty.overall.kind).toBe('not_rated');
    expect(empty.summary).toContain('not the same as good');
    // With deliveries but no contract, on-time cannot be judged.
    await recordReceipt(h, 'u-mgr', 'sup-2', 'po-1', receiptBody(), 'k1');
    const noContract = cardOf(await scorecard(h, 'u-owner', 'sup-2'));
    expect(noContract.onTime).toEqual({ kind: 'not_rated', because: 'no contracted lead time to measure against' });
  });

  it('surfaces expiring/expired/unapproved contracts worst-first', async () => {
    const h = await cast();
    await recordContract(h, 'u-owner', 'far', contract({ endsOn: '2026-12-31' }), 'k1');
    await recordContract(h, 'u-owner', 'soon', contract({ endsOn: '2026-09-01' }), 'k2');
    await recordContract(h, 'u-owner', 'unappr', contract({ endsOn: '2026-10-01', approvedBy: undefined }), 'k3');

    const res = await contractAlerts(h, 'u-owner', '2026-08-04');
    const body = res.body as { alerts: { contractId: string; finding: string }[]; actionNeededCount: number };
    expect(body.alerts.map((a) => a.contractId)).toEqual(['soon', 'unappr', 'far']);
    expect(body.alerts.find((a) => a.contractId === 'soon')?.finding).toBe('expiring_soon');
    expect(body.alerts.find((a) => a.contractId === 'unappr')?.finding).toBe('unapproved');
    expect(body.actionNeededCount).toBe(2);
  });

  it('gates recording and reading, and refuses a malformed body', async () => {
    const h = await cast();
    // A cashier can neither record a delivery outcome nor a contract, nor read a scorecard.
    expect((await recordReceipt(h, 'u-cash', 'sup-1', 'po-1', receiptBody(), 'k1')).status).toBe(403);
    expect((await recordContract(h, 'u-cash', 'c-1', contract(), 'k2')).status).toBe(403);
    expect((await scorecard(h, 'u-cash', 'sup-1')).status).toBe(403);
    // A delivery dated before it was ordered is refused.
    expect(codeOf(await recordReceipt(h, 'u-mgr', 'sup-1', 'po-2', receiptBody({ orderedOn: '2026-07-08', receivedOn: '2026-07-01' }), 'k3'))).toBe('received_before_ordered');
    // A body with no dates is not readable.
    expect(codeOf(await recordReceipt(h, 'u-mgr', 'sup-1', 'po-3', { orderedQtyMinor: 1 }, 'k4'))).toBe('not_readable_as_a_delivery_outcome');
  });

  it('survives a restart: the recorded facts and the scorecard are rebuilt from the event store', async () => {
    const h = await cast();
    await recordContract(h, 'u-owner', 'c-1', contract(), 'kc');
    await recordReceipt(h, 'u-mgr', 'sup-1', 'po-1', receiptBody(), 'k1');

    const restarted = apiHarness({ store: h.store });
    const card = cardOf(await scorecard(restarted, 'u-owner', 'sup-1'));
    expect(card.deliveries).toBe(1);
    expect(card.fillRate).toEqual({ kind: 'rated', bp: 10_000 });
  });
});
