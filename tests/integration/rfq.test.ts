import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M06-FR-02: requisition → RFQ → quotation comparison on the live API. A buyer raises a requisition,
// captures the quotes suppliers send, and reads a like-for-like comparison (cheapest + fastest per line
// and overall). A quote missing a line is shown but never ranked as if complete; a re-quote supersedes.
// Recording gated purchase.order.propose; comparison + worklist purchase.commitment.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INR = 'INR';
const cost = (minor: number) => ({ minor, currency: INR });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type Ref = { supplierId: string; quoteId: string } | undefined;
type Comparison = { cheapestOverall?: Ref; fastestOverall?: Ref; totals: { quoteId: string }[]; incompleteQuotes: string[]; summary: string };
const cmp = (res: { body: unknown }): Comparison => (res.body as { comparison: Comparison }).comparison;

const reqBody = () => ({ currency: INR, lines: [{ productId: 'p1', quantity: 10 }, { productId: 'p2', quantity: 4 }] });
const quoteBody = (supplierId: string, p1: { c: number; l: number }, p2?: { c: number; l: number }) => ({
  supplierId,
  lines: [
    { productId: 'p1', unitCost: cost(p1.c), leadTimeDays: p1.l },
    ...(p2 ? [{ productId: 'p2', unitCost: cost(p2.c), leadTimeDays: p2.l }] : []),
  ],
});

const raiseReq = (h: ApiHarness, u: string, id: string, b: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/requisitions/${id}`, userId: u, tenantId: A, idempotencyKey: key, body: b });
const putQuote = (h: ApiHarness, u: string, reqId: string, quoteId: string, b: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/requisitions/${reqId}/quotes/${quoteId}`, userId: u, tenantId: A, idempotencyKey: key, body: b });
const comparison = (h: ApiHarness, u: string, reqId: string) =>
  h.request({ method: 'GET', path: `/v1/purchase/requisitions/${reqId}/comparison`, userId: u, tenantId: A });
const listReqs = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/purchase/requisitions', userId: u, tenantId: A });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // propose + commitment.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('requisition / RFQ / quotation comparison (M06-FR-02)', () => {
  it('compares quotes like-for-like: cheapest and fastest overall are named', async () => {
    const h = await cast();
    await raiseReq(h, 'u-mgr', 'rq-1', reqBody(), 'k1');
    // A: cheaper (60000) but slow (10d); B: dearer (62400) but fast (3d).
    await putQuote(h, 'u-mgr', 'rq-1', 'qA', quoteBody('supA', { c: 5000, l: 10 }, { c: 2500, l: 8 }), 'k2');
    await putQuote(h, 'u-mgr', 'rq-1', 'qB', quoteBody('supB', { c: 5200, l: 3 }, { c: 2600, l: 2 }), 'k3');

    const c = cmp(await comparison(h, 'u-owner', 'rq-1'));
    expect(c.cheapestOverall).toEqual({ supplierId: 'supA', quoteId: 'qA' });
    expect(c.fastestOverall).toEqual({ supplierId: 'supB', quoteId: 'qB' });
    expect(c.totals.map((t) => t.quoteId).sort()).toEqual(['qA', 'qB']);
    expect(c.summary).toContain('cheapest overall: supA');
  });

  it('never totals a quote missing a line — it is flagged, not ranked cheap', async () => {
    const h = await cast();
    await raiseReq(h, 'u-mgr', 'rq-2', reqBody(), 'k1');
    await putQuote(h, 'u-mgr', 'rq-2', 'qA', quoteBody('supA', { c: 5000, l: 10 }, { c: 2500, l: 8 }), 'k2');
    // qC quotes only p1, and cheap — must not win the basket.
    await putQuote(h, 'u-mgr', 'rq-2', 'qC', quoteBody('supC', { c: 4000, l: 5 }), 'k3');

    const c = cmp(await comparison(h, 'u-owner', 'rq-2'));
    expect(c.incompleteQuotes).toEqual(['qC']);
    expect(c.totals.map((t) => t.quoteId)).toEqual(['qA']);
    expect(c.cheapestOverall).toEqual({ supplierId: 'supA', quoteId: 'qA' });
  });

  it('a re-quote supersedes: the newest price wins the comparison', async () => {
    const h = await cast();
    await raiseReq(h, 'u-mgr', 'rq-3', reqBody(), 'k1');
    await putQuote(h, 'u-mgr', 'rq-3', 'qA', quoteBody('supA', { c: 5000, l: 10 }, { c: 2500, l: 8 }), 'k2');
    await putQuote(h, 'u-mgr', 'rq-3', 'qB', quoteBody('supB', { c: 5200, l: 3 }, { c: 2600, l: 2 }), 'k3'); // dearer
    // supB re-quotes lower — now cheapest.
    await putQuote(h, 'u-mgr', 'rq-3', 'qB', quoteBody('supB', { c: 4000, l: 3 }, { c: 2000, l: 2 }), 'k4');
    const c = cmp(await comparison(h, 'u-owner', 'rq-3'));
    expect(c.cheapestOverall).toEqual({ supplierId: 'supB', quoteId: 'qB' });
    expect(c.totals.length).toBe(2); // still two quotes, not three — qB superseded
  });

  it('gates recording and reading, and refuses a quote against an unknown requisition', async () => {
    const h = await cast();
    // A cashier can neither raise a requisition nor read the comparison.
    expect((await raiseReq(h, 'u-cash', 'rq-x', reqBody(), 'k1')).status).toBe(403);
    await raiseReq(h, 'u-mgr', 'rq-4', reqBody(), 'k2');
    expect((await comparison(h, 'u-cash', 'rq-4')).status).toBe(403);
    // A quote against a requisition that was never raised is a 404.
    expect((await putQuote(h, 'u-mgr', 'nope', 'qA', quoteBody('supA', { c: 5000, l: 10 }, { c: 2500, l: 8 }), 'k3')).status).toBe(404);
    // A requisition with no lines is refused.
    expect(codeOf(await raiseReq(h, 'u-mgr', 'rq-5', { currency: INR, lines: [] }, 'k4'))).toBe('not_readable_as_a_requisition');
  });

  it('survives a restart: the requisition, quotes and comparison rebuild from the event store', async () => {
    const h = await cast();
    await raiseReq(h, 'u-mgr', 'rq-6', reqBody(), 'k1');
    await putQuote(h, 'u-mgr', 'rq-6', 'qA', quoteBody('supA', { c: 5000, l: 10 }, { c: 2500, l: 8 }), 'k2');

    const restarted = apiHarness({ store: h.store });
    expect((await listReqs(restarted, 'u-owner')).body as { count: number }).toMatchObject({ count: 1 });
    expect(cmp(await comparison(restarted, 'u-owner', 'rq-6')).cheapestOverall).toEqual({ supplierId: 'supA', quoteId: 'qA' });
  });
});
