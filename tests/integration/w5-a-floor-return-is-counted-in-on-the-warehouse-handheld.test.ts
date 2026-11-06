import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { warehousePayload, warehouseSupervisorPayload } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { isRelayable } from '../../packages/sync/src/device-relay';
import { pathFor, EVENT_ROUTES } from '../../edge/sync-agent/src/http-transport';
import { personNamedBy } from '../../edge/store-edge/src/handheld-sign-in';
import { RELAY_RECORD_KEY } from '../../services/platform/src/store-computer-identity';
import { RELAYED_MOVEMENT_KINDS } from '../../services/api/src/w2-movement-jobs';
import { WarehouseSession, FLOOR_INDENT_RETURN_ACCEPTED, FEEDBACK_CODES, SENT_WORK_KINDS, indentReturnKey, type WarehouseAssignment, type HeldIndentReturn } from '../../apps/warehouse-app/src/warehouse-session';
import { readFileSync } from 'node:fs';

/**
 * **W5 · M09-FR-03 — the floor sends stock back on an indent, and the BACK STORE counts it in on the warehouse handheld, with
 * the line down; head office takes it once (§28 · §31 · P-01 · hard rules #1 #2 #6 #10).**
 *
 * The floor asks on the Indents page (`POST /v1/floor/indents/:id/returns/:returnId`); the return waits at the back store. The
 * store computer serves it to the handheld from the indent register it holds (`indentReturns`, each line in its own unit).
 * On the handheld a DIFFERENT person counts each line in (0 is a real count); the person who sent it back is refused there
 * before anything is saved. The count is ONE record on the durable device queue (`FloorIndentReturnAccepted`), in the
 * signed-in worker's name; the box takes it (relayable from the warehouse surface, the person field `acceptedBy`) and relays
 * it to `POST /v1/floor/indents/:id/returns/:returnId/accepted/synced`, where head office re-verifies the acceptor from their
 * own grants, re-runs the indent and transfer engines, moves the stock off the floor and onto the back store ONCE, values a
 * shortfall, and answers the same acceptance again with 200 and no second movement. The returner as acceptor is refused by
 * name (422 — the box keeps it, visible). Synthetic data only.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-11-03T05:00:00.000Z';
const BACK = 'S1-BACK';
const FLOOR = 'S1';
type Body = Record<string, unknown>;
const post = (h: ApiHarness, u: string, path: string, body: Body, key: string) => h.request({ method: 'POST', path, userId: u, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, u: string, path: string, query?: Readonly<Record<string, string>>) => h.request({ method: 'GET', path, userId: u, tenantId: A, ...(query === undefined ? {} : { query }) });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const onHand = async (h: ApiHarness, locationId: string): Promise<number> =>
  ((await get(h, 'u-owner', '/v1/inventory/availability', { productId: 'RICE' })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === locationId).reduce((s, r) => s + r.onHandMinor, 0);

async function aReturnWaiting(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  for (const u of ['u-floor', 'u-mgr', 'u-back', 'u-floor2', 'u-back2']) await h.provisionRole(A, u, 'store_manager');
  await h.provisionRole(A, 'u-box', 'store_computer', [FLOOR]);
  await h.provisionRole(A, 'u-acct', 'accountant');
  const node = (id: string, body: Body) => post(h, 'u-owner', `/v1/org/nodes/${id}`, body, `org-${id}`);
  expect((await node('C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
  expect((await node(FLOOR, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
  expect((await node(BACK, { kind: 'warehouse', name: 'Store 1 back store', parentId: FLOOR, companyId: 'C1' })).status).toBe(201);
  expect((await post(h, 'u-owner', '/v1/inventory/movements', { movementId: 'seed-RICE', productId: 'RICE', locationId: BACK, kind: 'received', quantityMinor: 50, uom: 'EA', occurredAt: '2026-11-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 5_000 }, 'seed')).status).toBeLessThan(300);
  expect((await post(h, 'u-floor', '/v1/floor/indents/ind-1', { fromLocationId: BACK, toLocationId: FLOOR, lines: [{ productId: 'RICE', quantityMinor: 20, uom: 'EA' }] }, 'ask')).status).toBe(201);
  expect((await post(h, 'u-mgr', '/v1/floor/indents/ind-1/approval', {}, 'ap')).status).toBe(200);
  expect((await post(h, 'u-back', '/v1/floor/indents/ind-1/issues/is-1', { lines: [{ productId: 'RICE', quantityMinor: 20 }] }, 'is')).status).toBe(201);
  expect((await post(h, 'u-floor2', '/v1/floor/indents/ind-1/issues/is-1/receipt', { counted: [{ productId: 'RICE', batchId: null, quantityMinor: 20 }] }, 'rc')).status).toBe(201);
  // The floor sends 6 back — what the Indents page's "Send stock back" section sends.
  const ret = await post(h, 'u-floor', '/v1/floor/indents/ind-1/returns/ret-1', { lines: [{ productId: 'RICE', quantityMinor: 6 }], reason: 'overstock' }, 'ret');
  expect(ret.status).toBe(201);
  return h;
}

describe('a floor return counted in on the warehouse handheld (W5 · M09-FR-03)', () => {
  it('the store computer serves the waiting return to the handheld from the register it holds, each line in its own unit', async () => {
    const h = await aReturnWaiting();
    const register = (await get(h, 'u-box', '/v1/floor/indents', { open: 'true' })).body as { asAt: string; indents: unknown[] };
    const pack = readPack({
      version: 1, policies: { tradingDayCutoff: '02:00', storeId: FLOOR, branchId: FLOOR, warehouseId: BACK },
      warehouse: { assignmentId: 'wa-1', workerId: 'u-back2', storeId: FLOOR, bins: [], supervisor: { userId: 'u-mgr', branchScope: [FLOOR] } },
      floorIndents: { asAt: register.asAt ?? AT, indents: register.indents },
    }, AT);
    const payload = warehousePayload({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: AT, tradingDay: '2026-11-03' } as never)!;
    expect(payload['indentReturns']).toEqual([{ indentId: 'ind-1', returnId: 'ret-1', returnedBy: 'u-floor', reason: 'overstock', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 6, uom: 'ea' }] }]);
    // The supervisor's page now says who is looking (filled by the box with the signed-in person's own words).
    const sup = warehouseSupervisorPayload({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: AT, tradingDay: '2026-11-03' } as never)!;
    expect(sup).toMatchObject({ permissions: [], userId: 'u-mgr', storeId: FLOOR });
  });

  it('on the handheld: the returner is refused, every line needs its count, and ONE record is queued in the worker\'s name', () => {
    const waiting: HeldIndentReturn = { indentId: 'ind-1', returnId: 'ret-1', returnedBy: 'u-floor', reason: 'overstock', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 6, uom: 'EA' }] };
    const as = (workerId: string) => { const outbox = new SyncOutbox(); const a: WarehouseAssignment = { assignmentId: 'wa-1', workerId, storeId: FLOOR, bins: [], indentReturns: [waiting] }; return { outbox, s: new WarehouseSession(a, outbox, { now: () => AT }) }; };
    const returner = as('u-floor');
    expect(returner.s.acceptFloorReturn({ indentId: 'ind-1', returnId: 'ret-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 6 }], at: AT }).signal).toMatchObject({ feedback: 'reject', code: 'returner_cannot_accept' });
    expect(returner.outbox.all()).toEqual([]);

    const { outbox, s } = as('u-back2');
    expect(s.floorReturns()).toEqual([{ ...waiting, doneHere: false }]);
    expect(s.acceptFloorReturn({ indentId: 'ind-1', returnId: 'ret-1', counted: [], at: AT }).signal.code).toBe('count_incomplete');
    expect(s.acceptFloorReturn({ indentId: 'ind-1', returnId: 'ret-9', counted: [], at: AT }).signal.code).toBe('not_a_return_here');
    const out = s.acceptFloorReturn({ indentId: 'ind-1', returnId: 'ret-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 5 }], at: AT });
    expect(out).toMatchObject({ accepted: true, signal: { feedback: 'warn', code: 'return_accepted' } });
    expect(out.signal.detail).toMatch(/1 fewer than the floor sent; head office books the shortfall/);
    expect(s.acceptFloorReturn({ indentId: 'ind-1', returnId: 'ret-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 5 }], at: AT }).signal.code).toBe('return_already_done');
    expect(outbox.all().map((i) => i.key)).toEqual([indentReturnKey('ind-1', 'ret-1')]);
    const ev = outbox.all()[0]!.event;
    expect(ev).toMatchObject({ type: FLOOR_INDENT_RETURN_ACCEPTED, idempotencyKey: 'indent-return:ind-1:ret-1' });
    expect(ev.payload).toEqual({ indentId: 'ind-1', returnId: 'ret-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 5 }], acceptedBy: 'u-back2', at: AT, storeId: FLOOR, source: 'warehouse-handheld' });
    expect(s.floorReturns()[0]!.doneHere).toBe(true);
    expect(s.sentWork().map((w) => w.kind)).toEqual(['return_in']);
    // The box takes it from the warehouse handheld only, names the person in it, and knows exactly where it goes.
    expect(isRelayable(FLOOR_INDENT_RETURN_ACCEPTED, 'warehouse')).toBe(true);
    expect(isRelayable(FLOOR_INDENT_RETURN_ACCEPTED, 'picker')).toBe(false);
    expect(personNamedBy(ev)).toEqual({ ok: true, userId: 'u-back2' });
    expect(pathFor(ev)).toBe('/v1/floor/indents/ind-1/returns/ret-1/accepted/synced');
    expect(EVENT_ROUTES[FLOOR_INDENT_RETURN_ACCEPTED]).toBeDefined();
    expect(RELAY_RECORD_KEY['/v1/floor/indents/:indentId/returns/:returnId/accepted/synced']).toEqual({ family: 'floor-indent', param: 'indentId' });
    expect(RELAYED_MOVEMENT_KINDS['POST /v1/floor/indents/:indentId/returns/:returnId/accepted/synced']?.person).toBe('acceptedBy');
    // Every new word on the handheld has English and Tamil.
    expect(FEEDBACK_CODES).toEqual(expect.arrayContaining(['return_accepted', 'returner_cannot_accept', 'not_a_return_here', 'return_already_done']));
    expect(SENT_WORK_KINDS).toContain('return_in');
    const app = readFileSync('apps/warehouse-app/web/app.js', 'utf8');
    for (const k of ['return_accepted', 'returner_cannot_accept', 'not_a_return_here', 'return_already_done', 'returnsHeading']) expect(app.split(`${k}:`).length).toBeGreaterThanOrEqual(3);
  });

  it('head office takes the relayed count ONCE: the acceptor re-verified, stock off the floor and onto the back store, a shortfall valued, the returner refused', async () => {
    const h = await aReturnWaiting();
    expect([await onHand(h, BACK), await onHand(h, FLOOR)]).toEqual([30, 20]);
    const path = '/v1/floor/indents/ind-1/returns/ret-1/accepted/synced';
    const payload = (over: Body = {}): Body => ({ indentId: 'ind-1', returnId: 'ret-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 5 }], acceptedBy: 'u-back2', at: AT, storeId: FLOOR, source: 'warehouse-handheld', ...over });
    // Only the store's sync identity relays.
    expect(codeOf(await post(h, 'u-back2', path, payload(), 'k0'))).toBe('forbidden');
    // The person who sent it back cannot accept it (§28) — refused by name, nothing moved; the box keeps it for a person.
    const self = await post(h, 'u-box', path, payload({ acceptedBy: 'u-floor' }), 'k1');
    expect([self.status, codeOf(self)]).toEqual([422, 'returner_cannot_accept']);
    expect([await onHand(h, BACK), await onHand(h, FLOOR)]).toEqual([30, 20]);
    // A payload that does not name its own return is 400 — kept at the store, not dropped.
    expect(codeOf(await post(h, 'u-box', path, payload({ returnId: 'ret-x' }), 'k2'))).toBe('not_readable_as_a_relayed_return_acceptance');

    const r = await post(h, 'u-box', path, payload(), 'k3');
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ recorded: true, alreadyAccepted: false, flags: [], return: { state: 'accepted', acceptedBy: 'u-back2', relayed: { relayedBy: 'u-box', source: 'warehouse-handheld', storeId: FLOOR }, governanceFlags: [] } });
    expect((r.body as { discrepancies: unknown[] }).discrepancies.length).toBeGreaterThan(0); // 1 of the 6 did not arrive — valued
    // The floor's 6 left it; the 5 counted reached the back store (the 1 short is the valued exception, not stock).
    expect([await onHand(h, BACK), await onHand(h, FLOOR)]).toEqual([35, 14]);
    // The same acceptance again (a re-sent queue item) is the same record: 200, nothing moves twice.
    const again = await post(h, 'u-box', path, payload(), 'k4');
    expect([again.status, (again.body as Body)['alreadyAccepted']]).toEqual([200, true]);
    expect([await onHand(h, BACK), await onHand(h, FLOOR)]).toEqual([35, 14]);
    const reg = (await get(h, 'u-mgr', '/v1/floor/indents/ind-1')).body as { returns: { returnId: string; state: string }[]; attention: string[] };
    expect(reg.returns).toEqual([expect.objectContaining({ returnId: 'ret-1', state: 'accepted' })]);
    expect(reg.attention).not.toContain('return_awaiting_back_store');
  });

  it('an acceptor without the right to move stock is recorded and FLAGGED, never silently trusted', async () => {
    const h = await aReturnWaiting();
    const r = await post(h, 'u-box', '/v1/floor/indents/ind-1/returns/ret-1/accepted/synced', { indentId: 'ind-1', returnId: 'ret-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 6 }], acceptedBy: 'u-acct', at: AT }, 'k');
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ flags: ['acceptor_lacks_authority'], return: { governanceFlags: ['acceptor_lacks_authority'] } });
  });
});
