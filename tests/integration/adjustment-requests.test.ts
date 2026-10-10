import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { ADJUSTMENT_REQUEST_FLAGS, adjustmentMovementId } from '../../services/inventory/src/adjustment-requests';

/**
 * **An adjustment REQUEST relayed from the warehouse handheld is held at head office until a SEPARATE person approves
 * it — only then does one compensating movement post (SP-3b · W3 · M08-FR-03 · §28 · hard rules #2/#5/#6/#10, API-04).**
 *
 * The box relays what the worker asked for under its sync credential (`inventory.adjustment.sync`). The route records it
 * PENDING, valued at the cloud's own cost, with the requester re-verified (flags, never a silent drop). A supervisor
 * with `inventory.adjustment.approve` decides it: the raiser cannot; approval appends ONE M08 movement keyed on the
 * request (a re-approval is the same movement); rejection appends none; a conflicting second decision is refused; the
 * same decision again is 200. The wrong credential, an unknown request, a malformed body and the wrong tenant are all
 * refused. Synthetic data (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-09-30T11:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Recorded { requestId: string; recorded: boolean; alreadyRecorded?: boolean; status: string; valueMinor: number; flags: string[] }
interface Decided { requestId: string; status: string; movementId: string | null; decidedBy: string; alreadyDecided?: boolean }
interface Listed { requests: { requestId: string; status: string; deltaMinor: number; valueMinor: number; requestedBy: string; relayedBy: string; governanceFlags: string[]; movementId: string | null }[]; count: number; pending: number }

const request = (requestId: string, over: Record<string, unknown> = {}) => ({
  requestId, productId: 'P1', locationId: 'S1', binId: 'BIN-A', deltaMinor: -3, uom: 'EA', reasonCode: 'damaged', note: 'crushed carton',
  requestedBy: 'u-worker', at: AT, storeId: 'S1', source: 'warehouse-handheld', ...over,
});
const relay = (h: ApiHarness, body: Record<string, unknown>, key: string, opts: { user?: string; tenant?: string } = {}) =>
  h.request({ method: 'POST', path: `/v1/inventory/adjustment-requests/${String(body['requestId'])}/synced`, userId: opts.user ?? 'u-box', tenantId: opts.tenant ?? A, idempotencyKey: key, body });
const decide = (h: ApiHarness, requestId: string, decision: string, key: string, user = 'u-mgr', reason = 'checked the shelf myself') =>
  h.request({ method: 'POST', path: `/v1/inventory/adjustment-requests/${requestId}/decide`, userId: user, tenantId: A, idempotencyKey: key, body: { decision, reason } });
const list = async (h: ApiHarness, query: Record<string, string> = {}): Promise<Listed> =>
  (await h.request({ method: 'GET', path: '/v1/inventory/adjustment-requests', userId: 'u-owner', tenantId: A, query })).body as Listed;
const onHand = async (h: ApiHarness): Promise<number> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId: 'P1' } })).body as { rows: { locationId: string; onHandMinor: number }[] })
    .rows.filter((r) => r.locationId === 'S1').reduce((s, r) => s + r.onHandMinor, 0);

/** The cast, and 100 of P1 at S1 received at ₹25.00 — the cloud's own value for a request. */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-worker', 'store_manager'); // the raiser: holds inventory.movement.append AND approve — but never on their own request
  await h.provisionRole(A, 'u-mgr', 'store_manager');    // the supervisor
  await h.provisionRole(A, 'u-box', 'store_computer');          // the store box's sync identity
  await h.provisionRole(A, 'u-cust', 'customer');        // no inventory authority
  const seed = await h.request({
    method: 'POST', path: '/v1/inventory/goods-receipt/grn-seed', userId: 'u-mgr', tenantId: A, idempotencyKey: 'k-seed',
    body: {
      warehouseId: 'S1', receivedOnDate: '2026-09-01', currency: 'INR',
      lines: [{ lineId: 'L1', productId: 'P1', orderedMinor: 100, countedMinor: 100, uom: 'EA', unitCost: { minor: 2500, currency: 'INR' }, condition: 'good' }],
    },
  });
  expect(seed.status).toBe(201);
  expect(await onHand(h)).toBe(100);
  return h;
}

describe('an adjustment request from the handheld: recorded pending, decided by a separate person, posted once', () => {
  it('is recorded PENDING, valued at the cloud\'s cost, nothing moved; the same request again is 200 with one record', async () => {
    const h = await seeded();
    const res = await relay(h, request('ar-1'), 'k-ar-1');
    expect(res.status).toBe(202);
    expect(res.body as Recorded).toMatchObject({ requestId: 'ar-1', recorded: true, status: 'pending', valueMinor: 7_500, flags: [] });
    expect(await onHand(h)).toBe(100);
    const again = await relay(h, request('ar-1'), 'k-ar-1-again');
    expect(again.status).toBe(200);
    expect(again.body as Recorded).toMatchObject({ alreadyRecorded: true, status: 'pending' });
    const listed = await list(h);
    expect(listed.count).toBe(1);
    expect(listed.pending).toBe(1);
    expect(listed.requests[0]).toMatchObject({ requestId: 'ar-1', status: 'pending', deltaMinor: -3, valueMinor: 7_500, requestedBy: 'u-worker', relayedBy: 'u-box', movementId: null });
  });

  it('APPROVED by a different person → ONE compensating movement (wasted for a shortfall), on-hand falls once, a re-approval is the same movement', async () => {
    const h = await seeded();
    await relay(h, request('ar-2'), 'k-ar-2');
    const ok = await decide(h, 'ar-2', 'approved', 'k-d-2');
    expect(ok.status).toBe(200);
    expect(ok.body as Decided).toMatchObject({ requestId: 'ar-2', status: 'posted', movementId: adjustmentMovementId('ar-2'), decidedBy: 'u-mgr' });
    expect(await onHand(h)).toBe(97);
    // The same decision again — a retry — is 200 and moves nothing more.
    const again = await decide(h, 'ar-2', 'approved', 'k-d-2-again');
    expect(again.status).toBe(200);
    expect(again.body as Decided).toMatchObject({ status: 'posted', alreadyDecided: true });
    expect(await onHand(h)).toBe(97);
    expect((await list(h, { status: 'posted' })).requests.map((r) => r.requestId)).toEqual(['ar-2']);
    // Found more → adjusted (+).
    await relay(h, request('ar-3', { deltaMinor: 5, reasonCode: 'found', note: null }), 'k-ar-3');
    expect((await decide(h, 'ar-3', 'approved', 'k-d-3')).status).toBe(200);
    expect(await onHand(h)).toBe(102);
  });

  it('the RAISER cannot decide their own request (§28); REJECTED posts nothing; a conflicting second decision is 409 and changes nothing', async () => {
    const h = await seeded();
    await relay(h, request('ar-4'), 'k-ar-4');
    const self = await decide(h, 'ar-4', 'approved', 'k-d-4-self', 'u-worker');
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('self_approval');
    expect(await onHand(h)).toBe(100);
    const rejected = await decide(h, 'ar-4', 'rejected', 'k-d-4', 'u-mgr', 'the carton is fine — recount');
    expect(rejected.status).toBe(200);
    expect(rejected.body as Decided).toMatchObject({ status: 'rejected', movementId: null });
    expect(await onHand(h)).toBe(100);
    const flip = await decide(h, 'ar-4', 'approved', 'k-d-4-flip');
    expect(flip.status).toBe(409);
    expect(codeOf(flip)).toBe('adjustment_request_already_decided');
    expect(await onHand(h)).toBe(100);
    expect((await list(h)).pending).toBe(0);
  });

  it('re-verifies the REQUESTER and says when the value is unknown — flagged, recorded, never dropped', async () => {
    const h = await seeded();
    const lacks = await relay(h, request('ar-5', { requestedBy: 'u-cust' }), 'k-ar-5');
    expect(lacks.status).toBe(202);
    expect((lacks.body as Recorded).flags).toEqual(['requester_lacks_authority']);
    const unknown = await relay(h, request('ar-6', { requestedBy: 'u-nobody' }), 'k-ar-6');
    expect((unknown.body as Recorded).flags).toEqual(['requester_unknown']);
    const uncosted = await relay(h, request('ar-7', { productId: 'P9' }), 'k-ar-7');
    expect((uncosted.body as Recorded)).toMatchObject({ valueMinor: 0, flags: ['value_unknown'] });
    for (const f of [lacks, unknown, uncosted].flatMap((r) => (r.body as Recorded).flags)) expect(ADJUSTMENT_REQUEST_FLAGS).toContain(f);
    expect((await list(h)).requests.every((r) => r.status === 'pending')).toBe(true);
  });

  it('refuses the wrong credential, the wrong tenant, an unknown request, a reason off the list, a zero quantity and a malformed decision', async () => {
    const h = await seeded();
    expect((await relay(h, request('ar-8'), 'k-ar-8-cust', { user: 'u-cust' })).status).toBe(403);
    expect((await relay(h, request('ar-8'), 'k-ar-8-mgr', { user: 'u-mgr' })).status).toBe(403); // a manager is not the box
    expect((await relay(h, request('ar-8'), 'k-ar-8-b', { tenant: B })).status).toBeGreaterThanOrEqual(401);
    expect((await relay(h, request('ar-9', { reasonCode: 'because' }), 'k-ar-9')).status).toBe(400);
    expect((await relay(h, request('ar-10', { deltaMinor: 0 }), 'k-ar-10')).status).toBe(400);
    expect(codeOf(await relay(h, request('ar-11', { deltaMinor: 1.5 }), 'k-ar-11'))).toBe('not_readable_as_an_adjustment_request');
    expect(codeOf(await decide(h, 'ar-nope', 'approved', 'k-d-nope'))).toBe('adjustment_request_unknown');
    await relay(h, request('ar-12'), 'k-ar-12');
    expect((await decide(h, 'ar-12', 'maybe', 'k-d-12')).status).toBe(400);
    expect((await h.request({ method: 'POST', path: '/v1/inventory/adjustment-requests/ar-12/decide', userId: 'u-mgr', tenantId: A, idempotencyKey: 'k-d-12-nr', body: { decision: 'approved' } })).status).toBe(400);
    expect((await decide(h, 'ar-12', 'approved', 'k-d-12-cust', 'u-cust')).status).toBe(403);
    expect((await h.request({ method: 'GET', path: '/v1/inventory/adjustment-requests', userId: 'u-owner', tenantId: A, query: { status: 'lost' } })).status).toBe(400);
    expect(await onHand(h)).toBe(100);
  });
});
