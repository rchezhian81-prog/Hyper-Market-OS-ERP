import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { ApiError, type Route, type RequestContext } from '../../services/kernel/src/index';
import { movementJobsSurface, movementReachOf, movementKindRefusal, RELAYED_MOVEMENT_KINDS } from '../../services/api/src/w2-movement-jobs';

/**
 * OB-623 (owner, 1 Nov 2026): the rule on its own, and on the records a store computer RELAYS naming the person who moved
 * the stock — a receiver's warehouse move or a warehouse user's stock loss relayed from the box is refused by name (a 403
 * the box keeps as a visible dead letter), never booked in their name.
 */

const g = (userId: string, roleId: string, branchScope: readonly string[] | 'all' = ['store-1']) => ({ userId, roleId, branchScope });

describe('how a person holds the stock-movement word', () => {
  it('none, any (through a role that is not narrowed) or narrowed to the union of the narrowed roles\' kinds', () => {
    expect(movementReachOf([g('a', 'cashier')], 'a', 'store-1')).toEqual({ kind: 'none' });
    expect(movementReachOf([g('a', 'store_manager')], 'a', 'store-1')).toEqual({ kind: 'any' });
    expect(movementReachOf([g('a', 'receiver_qc')], 'a', 'store-1')).toEqual({ kind: 'narrowed', roles: ['receiver_qc'], jobs: ['count', 'receive'] });
    expect(movementReachOf([g('a', 'receiver_qc'), g('a', 'warehouse_user')], 'a', 'store-1')).toEqual({ kind: 'narrowed', roles: ['receiver_qc', 'warehouse_user'], jobs: ['count', 'receive', 'move_in_store', 'transfer'] });
    expect(movementReachOf([g('a', 'warehouse_user'), g('a', 'owner', 'all')], 'a', 'store-1')).toEqual({ kind: 'any' });
    // A manager at another store does not widen a warehouse user here.
    expect(movementReachOf([g('a', 'warehouse_user'), g('a', 'store_manager', ['store-2'])], 'a', 'store-1')).toMatchObject({ kind: 'narrowed' });
  });

  it('the refusal says who, what their role may do and what this was; a kind they may do is not refused', () => {
    const reach = movementReachOf([g('u-r', 'receiver_qc')], 'u-r', null);
    expect(movementKindRefusal(reach, 'u-r', { job: 'receive', what: 'a goods receipt' }, false)).toBeUndefined();
    const e = movementKindRefusal(reach, 'u-r', { job: null, what: 'a stock write-off' }, true) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(403);
    expect(e.body.code).toBe('not_your_kind_of_stock_movement');
    expect(e.body.whatHappened).toBe('u-r holds stock work through the Receiver / QC role, which may only enter a count; book a delivery at the receiving door and record or complete a goods receipt. A stock write-off is not one of those (owner decision OB-623).');
    expect(e.body.nextSafeAction).toMatch(/^Do not discard it at the store/);
    expect(movementKindRefusal({ kind: 'any' }, 'u-m', { job: null, what: 'x' }, false)).toBeUndefined();
  });
});

describe('records the store computer relays are judged on the person they name', () => {
  async function relayed() {
    const h = apiHarness();
    const T = randomUUID();
    await h.provisionRole(T, 'u-recv', 'receiver_qc', ['store-1']);
    await h.provisionRole(T, 'u-wh', 'warehouse_user', ['store-1']);
    await h.provisionRole(T, 'u-mgr', 'store_manager', ['store-1']);
    const reached: string[] = [];
    const surface: Route[] = Object.keys(RELAYED_MOVEMENT_KINDS).map((key) => {
      const [method, path] = key.split(' ') as [Route['method'], string];
      return { api: 'API-04', method, path, permission: 'inventory.movement.sync', idempotent: true, handler: () => { reached.push(key); return { status: 201, body: {} }; } } as Route;
    });
    movementJobsSurface(surface, { store: h.store });
    const send = async (key: string, body: Record<string, unknown>) => {
      const route = surface.find((r) => `${r.method} ${r.path}` === key)!;
      try {
        return (await route.handler({ tenantId: T, userId: 'u-box', branchId: 'store-1', scope: ['store-1'], params: {}, query: {}, body, idempotencyKey: 'k', traceId: 't' } as RequestContext)).status;
      } catch (e) { if (e instanceof ApiError) return `${e.status} ${e.body.code}`; throw e; }
    };
    return { send, reached };
  }

  it('a warehouse user\'s put-away, issue and transfer pass; a receiver\'s put-away and a warehouse user\'s stock loss are refused', async () => {
    const { send, reached } = await relayed();
    expect(await send('POST /v1/warehouse/movements/:commandId/synced', { movedBy: 'u-wh', kind: 'put_away' })).toBe(201);
    expect(await send('POST /v1/floor/indents/:indentId/issues/:issueId/synced', { issuedBy: 'u-wh' })).toBe(201);
    expect(await send('POST /v1/warehouse/transfers/:transferId/dispatch/synced', { dispatchedBy: 'u-wh' })).toBe(201);
    expect(await send('POST /v1/inventory/counts/:countId/synced', { counterId: 'u-wh' })).toBe(201);
    expect(await send('POST /v1/inventory/receiving-scans/:commandId/synced', { receivedBy: 'u-recv' })).toBe(201);
    expect(await send('POST /v1/inventory/goods-receipt/:grnId/assembled', { completedBy: 'u-recv' })).toBe(201);
    expect(await send('POST /v1/warehouse/movements/:commandId/synced', { movedBy: 'u-recv', kind: 'put_away' })).toBe('403 not_your_kind_of_stock_movement');
    expect(await send('POST /v1/warehouse/movements/:commandId/synced', { movedBy: 'u-wh', kind: 'dispatch' })).toBe('403 not_your_kind_of_stock_movement');
    expect(await send('POST /v1/inventory/receiving-scans/:commandId/synced', { receivedBy: 'u-wh' })).toBe('403 not_your_kind_of_stock_movement');
    expect(await send('POST /v1/inventory/write-off/:writeOffId/synced', { raisedBy: 'u-wh' })).toBe('403 not_your_kind_of_stock_movement');
    expect(await send('POST /v1/inventory/write-off/:writeOffId/synced', { raisedBy: 'u-recv' })).toBe('403 not_your_kind_of_stock_movement');
    // The manager keeps everything; a record naming nobody is left to the route's own checks.
    expect(await send('POST /v1/inventory/write-off/:writeOffId/synced', { raisedBy: 'u-mgr' })).toBe(201);
    expect(await send('POST /v1/warehouse/movements/:commandId/synced', { kind: 'put_away' })).toBe(201);
    expect(reached.filter((k) => k.includes('write-off'))).toHaveLength(1);
  });
});
