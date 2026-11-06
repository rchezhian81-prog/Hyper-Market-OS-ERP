import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { aBranch } from '../support/a-branch';
import { buildRouter } from '../../services/kernel/src/index';
import { buildSurface } from '../../services/api/src/main';
import { DIRECT_MOVEMENT_KINDS, RELAYED_MOVEMENT_KINDS, MOVE_WORD, NARROWED_MOVEMENT_ROLES } from '../../services/api/src/w2-movement-jobs';

/**
 * **OB-623 (owner, 1 Nov 2026, in writing: "narrow it before the pilot"): the Receiver/QC and the Warehouse user each post
 * only their own kinds of stock movement** — judged on head office's server on every route the stock-movement word opens
 * (services/api/src/w2-movement-jobs.ts). Refused in plain words, before anything is written; the owner and the store
 * manager keep what they have. Through the real API.
 */

const ROUTES = (() => {
  const built = buildRouter(buildSurface({ signingKey: 'x'.repeat(32), migrationTargetKind: 'rehearsal' }));
  if (!built.ok) throw new Error('surface malformed');
  return built.router!.list();
})();

describe('every route the stock-movement word opens is classified', () => {
  it('the table names exactly the routes that ask for the word, and every relayed record it judges exists', () => {
    const asking = ROUTES.filter((r) => r.permission === MOVE_WORD).map((r) => `${r.method} ${r.path}`).sort();
    expect(Object.keys(DIRECT_MOVEMENT_KINDS).sort()).toEqual(asking);
    const all = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const key of Object.keys(RELAYED_MOVEMENT_KINDS)) expect(all.has(key), key).toBe(true);
    expect(NARROWED_MOVEMENT_ROLES).toEqual({ receiver_qc: ['count', 'receive'], warehouse_user: ['count', 'move_in_store', 'transfer'] });
  });
});

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const NARROWED = 'not_your_kind_of_stock_movement';

async function shop() {
  const h = apiHarness();
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await aBranch(h, T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager', ['store-1']);
  await h.provisionRole(T, 'u-recv', 'receiver_qc', ['store-1']);
  await h.provisionRole(T, 'u-wh', 'warehouse_user', ['store-1']);
  // A person who is BOTH a warehouse user and a store manager keeps the manager's reach.
  await h.provisionRole(T, 'u-both', 'warehouse_user', ['store-1']);
  await h.provisionRole(T, 'u-both', 'store_manager', ['store-1']);
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, branchId: 'store-1', ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  return { call };
}

const at = '2026-11-01T05:00:00.000Z';
const move = (kind: string) => ({ movementId: `m-${randomUUID()}`, productId: 'rice', locationId: 'store-1', kind, quantityMinor: 5, uom: 'each', occurredAt: at, enteredBy: 'x', reason: 'r' });

/** Each request, and which of the two narrowed roles may make it. */
const CASES: readonly { readonly name: string; readonly method: 'GET' | 'POST'; readonly path: string; readonly body?: unknown; readonly receiver: boolean; readonly warehouse: boolean }[] = [
  { name: 'a count typed on the movements form', method: 'POST', path: '/v1/inventory/movements', body: move('counted'), receiver: true, warehouse: true },
  { name: 'a typed receipt (received)', method: 'POST', path: '/v1/inventory/movements', body: move('received'), receiver: false, warehouse: false },
  { name: 'a typed transfer out', method: 'POST', path: '/v1/inventory/movements', body: move('transferred_out'), receiver: false, warehouse: false },
  { name: 'a typed upward correction', method: 'POST', path: '/v1/inventory/movements', body: move('adjusted'), receiver: false, warehouse: false },
  { name: 'a count', method: 'POST', path: '/v1/inventory/counts/c-1', body: {}, receiver: true, warehouse: true },
  { name: 'a count on a count sheet', method: 'POST', path: '/v1/inventory/count-plans/p-1/counts/c-1', body: {}, receiver: true, warehouse: true },
  { name: 'opening a count sheet', method: 'GET', path: '/v1/inventory/count-plans/p-1/sheet', receiver: true, warehouse: true },
  { name: 'a goods receipt', method: 'POST', path: '/v1/inventory/goods-receipt/g-1', body: {}, receiver: true, warehouse: false },
  { name: 'completing a goods receipt', method: 'POST', path: '/v1/inventory/goods-receipt/g-1/assemble', body: {}, receiver: true, warehouse: false },
  { name: 'booking the receiving door', method: 'POST', path: '/v1/inventory/dock-diary/s-1', body: {}, receiver: true, warehouse: false },
  { name: 'marking a delivery at the door', method: 'POST', path: '/v1/inventory/dock-diary/s-1/status', body: {}, receiver: true, warehouse: false },
  { name: 'booking a dock slot', method: 'POST', path: '/v1/inventory/dock-slots/book', body: {}, receiver: true, warehouse: false },
  { name: 'sending goods back to the supplier', method: 'POST', path: '/v1/inventory/goods-receipt/g-1/excess/returned', body: {}, receiver: false, warehouse: false },
  { name: 'a put-away', method: 'POST', path: '/v1/warehouse/movements/w-1', body: { kind: 'put_away' }, receiver: false, warehouse: true },
  { name: 'a bin-to-bin move', method: 'POST', path: '/v1/warehouse/movements/w-2', body: { kind: 'bin_to_bin' }, receiver: false, warehouse: true },
  { name: 'a pick', method: 'POST', path: '/v1/warehouse/movements/w-3', body: { kind: 'pick' }, receiver: false, warehouse: true },
  { name: 'a put-back', method: 'POST', path: '/v1/warehouse/movements/w-4', body: { kind: 'return_to_bin' }, receiver: false, warehouse: true },
  { name: 'a warehouse dispatch move', method: 'POST', path: '/v1/warehouse/movements/w-5', body: { kind: 'dispatch' }, receiver: false, warehouse: false },
  { name: 'a warehouse pack move', method: 'POST', path: '/v1/warehouse/movements/w-6', body: { kind: 'pack' }, receiver: false, warehouse: false },
  { name: 'a transfer', method: 'POST', path: '/v1/warehouse/transfers/t-1', body: {}, receiver: false, warehouse: true },
  { name: 'sending a transfer', method: 'POST', path: '/v1/warehouse/transfers/t-1/dispatch', body: {}, receiver: false, warehouse: true },
  { name: 'receiving a transfer', method: 'POST', path: '/v1/warehouse/transfers/t-1/receive', body: {}, receiver: false, warehouse: true },
  { name: 'cancelling a transfer', method: 'POST', path: '/v1/warehouse/transfers/t-1/cancel', body: {}, receiver: false, warehouse: false },
  { name: 'issuing to the floor', method: 'POST', path: '/v1/floor/indents/i-1/issues/s-1', body: {}, receiver: false, warehouse: true },
  { name: 'counting in a floor issue', method: 'POST', path: '/v1/floor/indents/i-1/issues/s-1/receipt', body: {}, receiver: false, warehouse: true },
  { name: 'taking the floor\'s return back', method: 'POST', path: '/v1/floor/indents/i-1/returns/r-1/accepted', body: {}, receiver: false, warehouse: true },
  { name: 'setting up a bin', method: 'POST', path: '/v1/warehouse/bins/b-1', body: {}, receiver: false, warehouse: false },
  { name: 'a write-off', method: 'POST', path: '/v1/inventory/write-off/wo-1', body: {}, receiver: false, warehouse: false },
  { name: 'valuing a write-off', method: 'GET', path: '/v1/inventory/write-off-value', receiver: false, warehouse: false },
  { name: 'a waste record', method: 'POST', path: '/v1/waste/records/ws-1', body: {}, receiver: false, warehouse: false },
  { name: 'a free sample', method: 'POST', path: '/v1/inventory/free-samples/f-1', body: {}, receiver: false, warehouse: false },
  { name: 'a packaging item', method: 'POST', path: '/v1/packaging/items/pk-1', body: {}, receiver: false, warehouse: false },
  { name: 'the expiry sweep', method: 'POST', path: '/v1/inventory/expiry-sweep', body: {}, receiver: false, warehouse: false },
];

describe('on the real API: each narrowed role is held to its own kinds; the manager is not', () => {
  it('every allowed kind passes the judgement and every other kind is refused by name, in plain words', async () => {
    const { call } = await shop();
    for (const c of CASES) {
      for (const [user, allowed] of [['u-recv', c.receiver], ['u-wh', c.warehouse]] as const) {
        const r = await call(c.method, c.path, user, c.body);
        if (allowed) {
          // Passed OB-623; whatever the route itself then says (a missing field, an unknown record) is the route's own.
          expect(codeOf(r), `${user} ${c.name}: ${JSON.stringify(r.body)}`).not.toBe(NARROWED);
        } else {
          expect(r.status, `${user} ${c.name}`).toBe(403);
          expect(codeOf(r), `${user} ${c.name}`).toBe(NARROWED);
          const err = (r.body as { error: { whatHappened: string; wasItSaved: string; nextSafeAction: string } }).error;
          expect(err.whatHappened).toMatch(/OB-623/);
          expect(err.whatHappened).toMatch(user === 'u-recv' ? /Receiver \/ QC role, which may only enter a count; book a delivery/ : /Warehouse user role, which may only enter a count; put away/);
          expect(err.wasItSaved).toBe('not_saved');
          expect(err.nextSafeAction).toMatch(/store manager/);
        }
      }
      // The store manager, and a person who is a warehouse user AND a manager, keep what they had.
      for (const user of ['u-mgr', 'u-both', 'u-owner']) {
        expect(codeOf(await call(c.method, c.path, user, c.body)), `${user} ${c.name}`).not.toBe(NARROWED);
      }
    }
  });

  it('an allowed count is really recorded for the receiver; a refused typed receipt writes nothing', async () => {
    const { call } = await shop();
    const counted = await call('POST', '/v1/inventory/movements', 'u-recv', { ...move('counted'), movementId: 'm-count-1', enteredBy: 'u-recv' });
    expect(counted.status, JSON.stringify(counted.body)).toBeLessThan(300);
    const refused = await call('POST', '/v1/inventory/movements', 'u-recv', { ...move('received'), movementId: 'm-recv-1', enteredBy: 'u-recv' });
    expect(codeOf(refused)).toBe(NARROWED);
    // The manager may then post that same id: nothing was written under it by the refused call.
    const mgr = await call('POST', '/v1/inventory/movements', 'u-mgr', { ...move('received'), movementId: 'm-recv-1', enteredBy: 'u-mgr', unitCostMinor: 100 });
    expect(mgr.status, JSON.stringify(mgr.body)).toBeLessThan(300);
    expect((mgr.body as { duplicate?: boolean }).duplicate ?? false).toBe(false);
  });
});
