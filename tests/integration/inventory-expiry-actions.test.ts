import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M10-FR-01: the FEFO daily expiry action list on the live API. Every on-hand batch that is EXPIRED
// (→ dispose) or within nearExpiryDays of expiry (→ markdown) is returned earliest-expiry first, so the
// floor pulls what is past date and marks down what is close. Recall-blocked, non-on_hand and zero-qty
// batches are never listed — they are not sellable stock to mark down. Stateless (the caller supplies the
// on-hand batches with their expiry; the cloud availability ledger holds no batch expiry): a read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const check = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/inventory/expiry-actions', userId, tenantId: A, idempotencyKey: key, body });

interface ActionItem { batchId: string; action: string; status: string; daysToExpiry: number; qty: number }
interface ActionList { items: ActionItem[]; disposeCount: number; markdownCount: number; totalQtyAtRisk: number }

describe('FEFO expiry action list (M10-FR-01)', () => {
  it('lists expired (dispose) and near-expiry (markdown) batches, earliest-expiry first, with counts', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const batches = [
      { batchId: 'b-near', productId: 'p1', qty: 8, expiry: '2026-08-20' },   // 2 days ahead → markdown
      { batchId: 'b-expired', productId: 'p1', qty: 5, expiry: '2026-08-16' }, // 2 days past → dispose
      { batchId: 'b-today', productId: 'p2', qty: 10, expiry: '2026-08-18' },  // 0 days → markdown
      { batchId: 'b-far', productId: 'p2', qty: 99, expiry: '2026-08-30' },    // 12 days → not listed
    ];
    const body = (await check(h, 'u-owner', { batches, asOf: '2026-08-18', nearExpiryDays: 3 }, 'exp-1')).body as ActionList;
    // Earliest expiry first: 08-16 (dispose), 08-18 (markdown), 08-20 (markdown); the far batch is absent.
    expect(body.items.map((i) => i.batchId)).toEqual(['b-expired', 'b-today', 'b-near']);
    expect(body.items[0]).toMatchObject({ action: 'dispose', status: 'expired', daysToExpiry: -2 });
    expect(body.items[1]).toMatchObject({ action: 'markdown', status: 'near_expiry', daysToExpiry: 0 });
    expect(body.items[2]).toMatchObject({ action: 'markdown', status: 'near_expiry', daysToExpiry: 2 });
    expect(body.disposeCount).toBe(1);
    expect(body.markdownCount).toBe(2);
    expect(body.totalQtyAtRisk).toBe(23); // 5 + 10 + 8; the far batch's 99 is not at risk
  });

  it('never lists a recall-blocked, non-on_hand or zero-qty batch — only sellable stock to mark down', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const batches = [
      { batchId: 'ok', productId: 'p1', qty: 4, expiry: '2026-08-16' },                              // expired, sellable → listed
      { batchId: 'recalled', productId: 'p1', qty: 4, expiry: '2026-08-16', recallBlocked: true },   // recalled → never
      { batchId: 'quarantined', productId: 'p1', qty: 4, expiry: '2026-08-16', state: 'quarantine' },// held → never
      { batchId: 'empty', productId: 'p1', qty: 0, expiry: '2026-08-16' },                           // no stock → never
    ];
    const body = (await check(h, 'u-owner', { batches, asOf: '2026-08-18', nearExpiryDays: 3 }, 'exp-2')).body as ActionList;
    expect(body.items.map((i) => i.batchId)).toEqual(['ok']);
    expect(body.disposeCount).toBe(1);
    expect(body.markdownCount).toBe(0);
  });

  it('refuses a malformed request and an unparseable date, and gates on inventory.availability.read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    const ok = { batchId: 'b', productId: 'p', qty: 1, expiry: '2026-08-16' };
    // Missing batches[].
    expect((await check(h, 'u-owner', { asOf: '2026-08-18', nearExpiryDays: 3 }, 'exp-nobatch')).status).toBe(400);
    // Negative nearExpiryDays.
    expect((await check(h, 'u-owner', { batches: [ok], asOf: '2026-08-18', nearExpiryDays: -1 }, 'exp-neg')).status).toBe(400);
    // An unparseable expiry date reaches the engine → 400 invalid_expiry_request (not a silent skip).
    const bad = await check(h, 'u-owner', { batches: [{ ...ok, expiry: 'not-a-date' }], asOf: '2026-08-18', nearExpiryDays: 3 }, 'exp-baddate');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('invalid_expiry_request');
    // A cashier does not hold inventory.availability.read.
    expect((await check(h, 'u-cash', { batches: [ok], asOf: '2026-08-18', nearExpiryDays: 3 }, 'exp-rbac')).status).toBe(403);
  });
});
