import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The promotion catalogue and best-price basket evaluation (M05-FR-03, API-02) end to end through the
// real API. A promotion is DEFINED as a draft, deliberately ACTIVATED, and can be STOPPED — an offer
// never goes live by being typed. Evaluation is the deterministic `bestPrice`: only active, in-window,
// eligible promotions apply; within an exclusive group only the single best applies and everything else
// stacks; gates (member/coupon) are honoured; the same basket gives the same price online and offline.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const iso = (offsetDays: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
};

const define = (h: ApiHarness, t: string, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/promotions/${id}/definition`, userId: u, tenantId: t, idempotencyKey: key ?? `def-${id}`, body });
const activate = (h: ApiHarness, t: string, u: string, id: string, key?: string) =>
  h.request({ method: 'POST', path: `/v1/promotions/${id}/activate`, userId: u, tenantId: t, idempotencyKey: key ?? `act-${id}`, body: {} });
const stop = (h: ApiHarness, t: string, u: string, id: string) =>
  h.request({ method: 'POST', path: `/v1/promotions/${id}/stop`, userId: u, tenantId: t, idempotencyKey: `stop-${id}`, body: {} });
const getDef = (h: ApiHarness, t: string, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/promotions/${id}/definition`, userId: u, tenantId: t });
const evaluate = (h: ApiHarness, t: string, u: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/promotions/evaluate`, userId: u, tenantId: t, idempotencyKey: `ev-${Math.round(body.qtyKey as number ?? 0)}-${u}-${String(body.tag ?? '')}`, body });

// A basket of 10 × ₹100 of product P1 → gross ₹1,000.00 (1,00,000 minor).
const basket = (extra: Record<string, unknown> = {}) => ({
  lines: [{ lineId: 'l1', productId: 'P1', unitPrice: { minor: 10_000, currency: 'INR' }, qty: 10 }],
  at: iso(1), currency: 'INR', ...extra,
});
const WINDOW = { startsAt: iso(0), endsAt: iso(30) };

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Result { grossTotal: { minor: number }; discount: { minor: number }; netTotal: { minor: number }; applied: { promotionId: string }[] }

describe('promotion catalogue: define → activate → stop, and the deterministic best price (M05-FR-03)', () => {
  it('a draft promotion never applies until it is activated', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect((await define(h, A, 'u-owner', 'p1', { kind: 'percent_off', percentBps: 1000, ...WINDOW })).status).toBe(201);
    // Draft → no discount.
    expect(((await evaluate(h, A, 'u-owner', basket({ tag: 'draft' }))).body as Result).discount.minor).toBe(0);

    expect((await activate(h, A, 'u-owner', 'p1')).status).toBe(200);
    // Active, in window → 10% of 1,00,000 = 10,000.
    const r = (await evaluate(h, A, 'u-owner', basket({ tag: 'active' }))).body as Result;
    expect(r.discount.minor).toBe(10_000);
    expect(r.netTotal.minor).toBe(90_000);
  });

  it('a stopped promotion no longer applies and cannot be reactivated', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await define(h, A, 'u-owner', 'p1', { kind: 'percent_off', percentBps: 1000, ...WINDOW });
    await activate(h, A, 'u-owner', 'p1');
    expect(((await evaluate(h, A, 'u-owner', basket({ tag: 'on' }))).body as Result).discount.minor).toBe(10_000);

    expect((await stop(h, A, 'u-owner', 'p1')).status).toBe(200);
    expect(((await evaluate(h, A, 'u-owner', basket({ tag: 'off' }))).body as Result).discount.minor).toBe(0);

    // A stopped promotion is ended, not paused (a fresh transport key so it reaches the handler).
    expect(codeOf(await activate(h, A, 'u-owner', 'p1', 'act-p1-again'))).toBe('promotion_stopped');
  });

  it('best price is deterministic: within an exclusive group only the best applies, others stack', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // Two offers compete in group g1; only the larger applies.
    await define(h, A, 'u-owner', 'promo-a', { kind: 'percent_off', percentBps: 1000, exclusiveGroup: 'g1', ...WINDOW }); // 10,000
    await define(h, A, 'u-owner', 'promo-b', { kind: 'amount_off', amountOffMinor: 5_000, exclusiveGroup: 'g1', ...WINDOW }); // 5,000
    // A non-exclusive offer stacks.
    await define(h, A, 'u-owner', 'promo-c', { kind: 'percent_off', percentBps: 500, ...WINDOW }); // 5,000
    for (const id of ['promo-a', 'promo-b', 'promo-c']) await activate(h, A, 'u-owner', id);

    const r = (await evaluate(h, A, 'u-owner', basket({ tag: 'excl' }))).body as Result;
    expect(r.discount.minor).toBe(15_000);              // best-of-g1 (10,000) + stacking c (5,000)
    expect(r.applied.map((a) => a.promotionId)).toEqual(['promo-a', 'promo-c']);  // b excluded, sorted by id
  });

  it('honours a member-only gate — it applies only when the shopper is a member', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await define(h, A, 'u-owner', 'p1', { kind: 'percent_off', percentBps: 1000, requiresMember: true, ...WINDOW });
    await activate(h, A, 'u-owner', 'p1');

    expect(((await evaluate(h, A, 'u-owner', basket({ tag: 'guest' }))).body as Result).discount.minor).toBe(0);
    expect(((await evaluate(h, A, 'u-owner', basket({ tag: 'member', isMember: true }))).body as Result).discount.minor).toBe(10_000);
  });

  it('is authorized (define/activate vs read/evaluate), create-once, per-tenant, and refuses malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');   // defines and evaluates
    await h.provisionRole(A, 'u-cash', 'cashier');         // neither (no promotion.launch / read)

    expect((await define(h, A, 'u-mgr', 'p1', { kind: 'percent_off', percentBps: 1000, ...WINDOW })).status).toBe(201);
    expect((await define(h, A, 'u-cash', 'p2', { kind: 'percent_off', percentBps: 1000, ...WINDOW })).status).toBe(403);
    expect((await evaluate(h, A, 'u-mgr', basket({ tag: 'mgr' }))).status).toBe(200);
    expect((await evaluate(h, A, 'u-cash', basket({ tag: 'cash' }))).status).toBe(403);

    // Create-once: redefining a live id is refused (a fresh transport key so it reaches the handler).
    expect(codeOf(await define(h, A, 'u-owner', 'p1', { kind: 'amount_off', amountOffMinor: 1, ...WINDOW }, 'def-p1-again'))).toBe('promotion_already_defined');
    // Unknown definition, malformed kind.
    expect((await getDef(h, A, 'u-owner', 'ghost')).status).toBe(404);
    expect((await define(h, A, 'u-owner', 'p-bad', { kind: 'nonsense', ...WINDOW })).status).toBe(400);

    // Another tenant has no promotions — the basket evaluates with no discount.
    await h.seedOwner(B, 'u-owner-b');
    expect(((await evaluate(h, B, 'u-owner-b', basket({ tag: 'tenantB' }))).body as Result).discount.minor).toBe(0);
  });
});
