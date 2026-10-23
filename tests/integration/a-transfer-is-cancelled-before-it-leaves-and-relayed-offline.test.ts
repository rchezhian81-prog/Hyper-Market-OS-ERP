import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { classify } from '../../edge/sync-agent/src/http-transport';

// OB-288 lane 2 · P2 · WF-07 (M09-FR-03 · §31 · §28 · hard rules #2 #6 #10) — on the REAL API with REAL RBAC, in memory
// and (with DATABASE_URL) on real PostgreSQL:
//
//   • CANCELLATION before dispatch: a compensating `TransferCancelled` (the proposal stays on the record); a cancelled
//     transfer can never be sent or counted in; once dispatched it can no longer be cancelled; the same cancel is one
//     effect; it survives a restart.
//   • the OFFLINE dispatch and receipt the store computer relays: only the store computer's hop, only for its OWN end of the
//     transfer; the PERSON re-verified from their own grants; head office's own stock and rules (proposer ≠ dispatcher,
//     dispatcher ≠ receiver); a receipt before head office has heard the dispatch is 425 (kept and sent again); the same
//     step again is 200 (one effect); a DIFFERENT dispatch or count is refused by name (a visible conflict, never
//     last-write-wins). Synthetic data only (hard rule #7).

const backings = useBackings();

const S1 = 'S1'; const S1_BACK = 'S1-BACK'; const S2 = 'S2';
const AT = '2026-10-20T08:00:00.000Z';
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const LINE = { productId: 'P1', batchId: null, quantityMinor: 10, uom: 'EA' };

async function shop(h: ApiHarness) {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-box-a', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-box-b', 'store_computer', [S2]);
  await h.provisionRole(T, 'u-wh1', 'store_manager', [S1]);
  await h.provisionRole(T, 'u-wh1b', 'store_manager', [S1]);
  await h.provisionRole(T, 'u-wh2', 'store_manager', [S2]);
  await h.provisionRole(T, 'u-cash1', 'cashier', [S1]);
  const BRANCH: Record<string, string> = { 'u-box-a': S1, 'u-box-b': S2, 'u-wh1': S1, 'u-wh1b': S1, 'u-wh2': S2, 'u-cash1': S1 };
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(BRANCH[userId] === undefined ? {} : { branchId: BRANCH[userId] }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    [S1, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }],
    [S1_BACK, { kind: 'warehouse', name: 'Store 1 back store', parentId: S1, companyId: 'C1' }],
    [S2, { kind: 'branch', name: 'Store 2', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', body, `org-${id}`)).status).toBe(201);
  // Head office's own stock at the sending place.
  expect((await call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'seed-1', productId: 'P1', locationId: S1_BACK, kind: 'received', quantityMinor: 40, uom: 'EA', occurredAt: '2026-10-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 2_500 }, 'seed-1')).status).toBeLessThan(300);
  const propose = async (id: string): Promise<void> => {
    expect((await call('POST', `/v1/warehouse/transfers/${id}`, 'u-owner', { fromLocationId: S1_BACK, toLocationId: S2, lines: [LINE] }, `p-${id}`)).status).toBe(201);
  };
  const onHandAt = async (loc: string): Promise<number> => {
    const rows = ((await call('GET', '/v1/inventory/availability', 'u-owner')).body as { rows: { productId: string; locationId: string; onHandMinor: number }[] }).rows;
    return rows.find((r) => r.productId === 'P1' && r.locationId === loc)?.onHandMinor ?? 0;
  };
  const read = async (id: string, userId = 'u-owner') => (await call('GET', `/v1/warehouse/transfers/${id}`, userId)).body as Record<string, unknown>;
  return { T, call, propose, onHandAt, read };
}

const dispatchBody = (transferId: string, over: Record<string, unknown> = {}) => ({ transferId, storeId: S1, dispatchedBy: 'u-wh1', at: AT, source: 'warehouse-handheld', ...over });
const receiveBody = (transferId: string, over: Record<string, unknown> = {}) => ({ transferId, storeId: S2, receivedBy: 'u-wh2', at: '2026-10-20T11:00:00.000Z', counted: [{ productId: 'P1', batchId: null, quantityMinor: 8 }], source: 'warehouse-handheld', ...over });

describe.each(backings)('WF-07: a transfer is cancelled only before it leaves — on $name', ({ harness }) => {
  it('cancels with a reason as a compensating event, never sends or counts a cancelled transfer, refuses a cancel after dispatch, and survives a restart', async () => {
    const h = harness();
    const { call, propose, onHandAt, read, T } = await shop(h);
    await propose('t-c1');
    // A cashier holds no stock-movement right; a cancel without a reason is not readable.
    expect((await call('POST', '/v1/warehouse/transfers/t-c1/cancel', 'u-cash1', { reason: 'not needed now' })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-c1/cancel', 'u-wh1', {}))).toBe('not_readable_as_a_cancellation');
    expect((await call('POST', '/v1/warehouse/transfers/ghost/cancel', 'u-wh1', { reason: 'not needed now' })).status).toBe(404);

    const c = await call('POST', '/v1/warehouse/transfers/t-c1/cancel', 'u-wh1', { reason: 'store 2 no longer needs it' }, 'cancel-1');
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ transferId: 't-c1', state: 'cancelled', cancelledBy: 'u-wh1', alreadyCancelled: false });
    // The same cancel again (a second tap, a new key) is the same fact — one effect.
    expect((await call('POST', '/v1/warehouse/transfers/t-c1/cancel', 'u-wh1b', { reason: 'second tap' })).body).toMatchObject({ alreadyCancelled: true, cancelledBy: 'u-wh1' });
    expect(await read('t-c1')).toMatchObject({ state: 'cancelled', requestedBy: 'u-owner', cancelledBy: 'u-wh1', cancelReason: 'store 2 no longer needs it', lines: [expect.objectContaining({ productId: 'P1', quantityMinor: 10 })] });
    // A cancelled transfer never leaves — directly or by relay — and nothing moves.
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-c1/dispatch', 'u-wh1b', {}))).toBe('transfer_cancelled');
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-c1/dispatch/synced', 'u-box-a', dispatchBody('t-c1')))).toBe('transfer_cancelled');
    expect(await onHandAt(S1_BACK)).toBe(40);

    // After it has left, it can no longer be cancelled — the receipt and its shortfall settle it.
    await propose('t-c2');
    expect((await call('POST', '/v1/warehouse/transfers/t-c2/dispatch', 'u-wh1', {})).status).toBe(200);
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-c2/cancel', 'u-wh1b', { reason: 'too late now' }))).toBe('transfer_already_dispatched');
    expect(await read('t-c2')).toMatchObject({ state: 'in_transit' });

    // A restart rebuilds the cancellation from the stored events.
    const again = apiHarness({ store: h.store });
    const after = (await again.request({ method: 'GET', path: '/v1/warehouse/transfers/t-c1', userId: 'u-owner', tenantId: T })).body;
    expect(after).toMatchObject({ state: 'cancelled', cancelledBy: 'u-wh1' });
  });
});

describe.each(backings)('WF-07 offline: a dispatch and a receipt made with the line down, relayed by each store\'s computer — on $name', ({ harness }) => {
  it('only the store computer relays, only for its own end; the person is re-verified; head office\'s own rules decide; a receipt before the dispatch waits (425)', async () => {
    const h = harness();
    const { call, propose, onHandAt } = await shop(h);
    await propose('t-o1');
    // A person cannot use the hop; store 2's computer cannot send store 1's transfer.
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-o1/dispatch/synced', 'u-wh1', dispatchBody('t-o1')))).toBe('forbidden');
    expect((await call('POST', '/v1/warehouse/transfers/t-o1/dispatch/synced', 'u-box-b', dispatchBody('t-o1', { storeId: S2 }))).status).toBe(403);
    // A payload that claims lines or stock is not a relayed dispatch.
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-o1/dispatch/synced', 'u-box-a', dispatchBody('t-o1', { lines: [LINE] })))).toBe('not_readable_as_a_relayed_dispatch');
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-o1/dispatch/synced', 'u-box-a', dispatchBody('t-other')))).toBe('not_readable_as_a_relayed_dispatch');
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/ghost/dispatch/synced', 'u-box-a', dispatchBody('ghost')))).toBe('transfer_not_known_at_head_office');
    // The receiving store counted it in before head office heard it left: kept and sent again (425), nothing booked.
    const early = await call('POST', '/v1/warehouse/transfers/t-o1/receive/synced', 'u-box-b', receiveBody('t-o1'));
    expect([early.status, codeOf(early)]).toEqual([425, 'transfer_not_dispatched_yet']);
    // The person is re-verified from their own grants; the proposer may not approve their own (§28, the engine's rule).
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-o1/dispatch/synced', 'u-box-a', dispatchBody('t-o1', { dispatchedBy: 'u-cash1' })))).toBe('person_lacks_authority');
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-o1/dispatch/synced', 'u-box-a', dispatchBody('t-o1', { dispatchedBy: 'u-nobody' })))).toBe('person_unknown_at_head_office');
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-o1/dispatch/synced', 'u-box-a', dispatchBody('t-o1', { dispatchedBy: 'u-owner' })))).toBe('transfer_refused');
    expect(await onHandAt(S1_BACK)).toBe(40);

    const sent = await call('POST', '/v1/warehouse/transfers/t-o1/dispatch/synced', 'u-box-a', dispatchBody('t-o1'), 'dispatch-o1');
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ transferId: 't-o1', state: 'in_transit', approvedBy: 'u-wh1', posted: ['t-o1-out-1'], relayed: { relayedBy: 'u-box-a', source: 'warehouse-handheld', storeId: S1 } });
    expect(await onHandAt(S1_BACK)).toBe(30);
    // The same dispatch again — a re-sent queue item under a new key — is one effect; a DIFFERENT dispatcher is a conflict.
    expect((await call('POST', '/v1/warehouse/transfers/t-o1/dispatch/synced', 'u-box-a', dispatchBody('t-o1'), 'dispatch-o1-again')).body).toMatchObject({ alreadyDispatched: true });
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-o1/dispatch/synced', 'u-box-a', dispatchBody('t-o1', { dispatchedBy: 'u-wh1b' })))).toBe('transfer_dispatched_by_another');
    expect(await onHandAt(S1_BACK)).toBe(30);

    // Store 1's computer cannot count it in at store 2; the dispatcher cannot count their own (§28).
    expect((await call('POST', '/v1/warehouse/transfers/t-o1/receive/synced', 'u-box-a', receiveBody('t-o1', { storeId: S1 }))).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-o1/receive/synced', 'u-box-b', receiveBody('t-o1', { receivedBy: 'u-wh1' })))).toBe('dispatcher_cannot_receive');
    const got = await call('POST', '/v1/warehouse/transfers/t-o1/receive/synced', 'u-box-b', receiveBody('t-o1'), 'receive-o1');
    expect(got.status).toBe(202);
    expect(got.body).toMatchObject({ state: 'received', posted: ['t-o1-recv-1'], relayed: { relayedBy: 'u-box-b', storeId: S2 } });
    expect((got.body as { discrepancies: { productId: string; differenceMinor: number }[] }).discrepancies).toEqual([expect.objectContaining({ productId: 'P1', differenceMinor: -2 })]);
    expect(await onHandAt(S2)).toBe(8);
    // The same count again is the same receipt; different figures — or another person — are a visible conflict.
    expect((await call('POST', '/v1/warehouse/transfers/t-o1/receive/synced', 'u-box-b', receiveBody('t-o1'), 'receive-o1-again')).body).toMatchObject({ alreadyReceived: true });
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/t-o1/receive/synced', 'u-box-b', receiveBody('t-o1', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 10 }] })))).toBe('transfer_received_differently');
    expect(await onHandAt(S2)).toBe(8);
    // The shortfall is head office's valued exception, as for a receipt typed at head office.
    const ex = (await call('GET', '/v1/inventory/exceptions', 'u-owner')).body as { transferShortfalls: { transferId: string }[] };
    expect(ex.transferShortfalls.map((s) => s.transferId)).toContain('t-o1');
  });
  it('a relayed dispatch head office refuses by its own rule (an open count froze the stock) is a refusal the box keeps for a person — never "already on file"', async () => {
    const h = harness();
    const { call, propose, onHandAt, read } = await shop(h);
    await propose('t-f1');
    expect((await call('POST', '/v1/inventory/count-plans/cp-1', 'u-owner', { locationId: S1_BACK, productIds: ['P1'], recountThresholdMinor: 1_000_000, note: 'back store', frozenKinds: ['transferred_out'] })).status).toBeLessThan(300);
    expect((await call('POST', '/v1/inventory/count-plans/cp-1/open', 'u-owner', {})).status).toBeLessThan(300);
    const r = await call('POST', '/v1/warehouse/transfers/t-f1/dispatch/synced', 'u-box-a', dispatchBody('t-f1'));
    // Said as 422 — the store computer's sender reads a 409 carrying a code as "already booked" and would drop it.
    expect([r.status, codeOf(r)]).toEqual([422, 'frozen_by_a_stock_count']);
    expect(classify(r.status, codeOf(r))).toBe('rejected');
    expect(await read('t-f1')).toMatchObject({ state: 'proposed' });
    expect(await onHandAt(S1_BACK)).toBe(40);
    // Typed at head office, the same refusal keeps its own 409 (unchanged for the direct route).
    expect((await call('POST', '/v1/warehouse/transfers/t-f1/dispatch', 'u-wh1', {})).status).toBe(409);
  });
});
