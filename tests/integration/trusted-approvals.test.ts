import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sealedDecision } from '../support/store-seal';
import { SUBJECT_AUTHORITY } from '../../services/identity/src/approval-decisions';

/**
 * **Approve-then-apply: a manager's decision relayed from the store REACHES the held count or pending adjustment
 * request it names — once, and only when the decider is genuinely allowed (SP-4 · W03 · F07 · M02-FR-03 · M08-FR-03 ·
 * M09-FR-04 · §28 · hard rules #2/#5/#6/#10, API-01/API-04).**
 *
 * SP-2a recorded the manager's relayed `ApprovalDecided`; SP-3b/SP-4 gave head office subjects that WAIT for a person —
 * a blind count whose variance is material, an adjustment request from the racking. This proves the two meet: a clean
 * relayed approval by a person with `inventory.adjustment.approve` who is not the maker applies the subject through the
 * SAME decide step the direct routes run (one correction, one movement); a FLAGGED decision (self-approval, no
 * authority, unknown decider) is recorded and applies NOTHING — the subject still waits, and the reply says why; a
 * relayed rejection settles the subject rejected; the same decision relayed twice (a lost reply) applies once; a subject
 * type nobody applies is recorded only. Synthetic data (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-30T12:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Relayed { requestId: string; status: string; flags: string[]; applied?: boolean; appliedDetail?: string; notAppliedBecause?: string; alreadyRecorded?: boolean }
interface Position { correctedOnHandMinor: number; pending: number; counts: { countId: string; adjusted: boolean; pendingApproval?: boolean; decision?: string; approvedBy: string | null }[] }
interface Requests { requests: { requestId: string; status: string; movementId: string | null; decidedBy: string | null }[] }

const relayDecision = (h: ApiHarness, over: Record<string, unknown>, key: string) => {
  const body = {
    id: 'ap-1', subjectType: 'stock_count', subjectRef: 'c1', requestedBy: 'u-worker', branchId: 'store-1', value: null,
    status: 'approved', decidedBy: 'u-mgr', reason: 'checked the shelf', decidedAt: AT, storeId: 'store-1', source: 'manager-screen', ...over,
  };
  return h.request({ method: 'POST', path: `/v1/approvals/decisions/${String(body.id)}/synced`, userId: 'u-box', tenantId: A, idempotencyKey: key, body: sealedDecision(A, 'ApprovalDecided', body) });
};
const position = async (h: ApiHarness): Promise<Position> =>
  (await h.request({ method: 'GET', path: '/v1/inventory/counts', userId: 'u-owner', tenantId: A, query: { productId: 'P1', locationId: 'S1' } })).body as Position;
const requests = async (h: ApiHarness): Promise<Requests> =>
  (await h.request({ method: 'GET', path: '/v1/inventory/adjustment-requests', userId: 'u-owner', tenantId: A })).body as Requests;
const onHand = async (h: ApiHarness): Promise<number> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId: 'P1' } })).body as { rows: { locationId: string; onHandMinor: number }[] })
    .rows.filter((r) => r.locationId === 'S1').reduce((s, r) => s + r.onHandMinor, 0);

/**
 * The cast; 100 of P1 at S1 at ₹1.00; a low count threshold; a HELD count `c1` (counted 50 → −50, ₹50.00, material) raised
 * by the worker; a PENDING adjustment request `ar-1` (−3, damaged) relayed from the handheld.
 */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-worker', 'store_manager'); // counts and raises; holds approve too — but never on their own
  await h.provisionRole(A, 'u-mgr', 'store_manager');    // the supervisor who decides
  await h.provisionRole(A, 'u-box', 'store_computer');          // the store box: relays decisions, counts, requests
  await h.provisionRole(A, 'u-cashier', 'cashier');      // holds no approval authority
  expect((await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: A, idempotencyKey: 'seed', body: { movementId: 'seed', productId: 'P1', locationId: 'S1', kind: 'received', quantityMinor: 100, uom: 'EA', occurredAt: AT, enteredBy: 'u-owner', unitCostMinor: 100 } })).status).toBe(202);
  expect((await h.request({ method: 'POST', path: '/v1/inventory/count-policy', userId: 'u-owner', tenantId: A, idempotencyKey: 'pol', body: { approvalThresholdMinor: 1_000 } })).status).toBe(201);
  const held = await h.request({ method: 'POST', path: '/v1/inventory/counts/c1', userId: 'u-worker', tenantId: A, idempotencyKey: 'c1', body: { productId: 'P1', locationId: 'S1', uom: 'EA', countedMinor: 50, reasonCode: 'cycle_count' } });
  expect(held.body).toMatchObject({ varianceMinor: -50, pendingApproval: true });
  const req = await h.request({ method: 'POST', path: '/v1/inventory/adjustment-requests/ar-1/synced', userId: 'u-box', tenantId: A, idempotencyKey: 'ar-1', body: { requestId: 'ar-1', productId: 'P1', locationId: 'S1', binId: null, deltaMinor: -3, uom: 'EA', reasonCode: 'damaged', requestedBy: 'u-worker', at: AT, storeId: 'S1', source: 'warehouse-handheld' } });
  expect(req.status).toBe(202);
  expect(await onHand(h)).toBe(100);
  return h;
}

describe('a clean relayed decision reaches its subject; a flagged one is recorded and waits (approve-then-apply, SP-4)', () => {
  it('the manager\'s relayed APPROVAL of a held count applies the correction — once — and the register says so', async () => {
    const h = await seeded();
    const res = await relayDecision(h, {}, 'k-ap-1');
    expect(res.status).toBe(202);
    expect(res.body as Relayed).toMatchObject({ requestId: 'ap-1', status: 'approved', flags: [], applied: true });
    expect((res.body as Relayed).appliedDetail).toMatch(/count c1 approved — correction applied/);
    const pos = await position(h);
    expect(pos).toMatchObject({ correctedOnHandMinor: 50, pending: 0 });
    expect(pos.counts[0]).toMatchObject({ countId: 'c1', adjusted: true, decision: 'approved', approvedBy: 'u-mgr' });
    // The same decision relayed again (a lost reply): recorded once, applied once, still 50.
    const again = await relayDecision(h, {}, 'k-ap-1-again');
    expect(again.status).toBe(200);
    expect(again.body as Relayed).toMatchObject({ alreadyRecorded: true, applied: true });
    expect((await position(h)).correctedOnHandMinor).toBe(50);
  });

  it('the manager\'s relayed APPROVAL of an adjustment request posts ONE movement; a relayed REJECTION posts none', async () => {
    const h = await seeded();
    const res = await relayDecision(h, { id: 'ap-2', subjectType: 'stock_adjustment', subjectRef: 'ar-1' }, 'k-ap-2');
    expect(res.status).toBe(202);
    expect(res.body as Relayed).toMatchObject({ applied: true, flags: [] });
    expect((res.body as Relayed).appliedDetail).toMatch(/request ar-1 posted — movement adj-req:ar-1/);
    expect(await onHand(h)).toBe(97);
    expect((await requests(h)).requests[0]).toMatchObject({ requestId: 'ar-1', status: 'posted', movementId: 'adj-req:ar-1', decidedBy: 'u-mgr' });
    // Relayed again: one movement.
    await relayDecision(h, { id: 'ap-2', subjectType: 'stock_adjustment', subjectRef: 'ar-1' }, 'k-ap-2-again');
    expect(await onHand(h)).toBe(97);
    // A second request, REJECTED from the manager's screen: settled rejected, nothing posts.
    await h.request({ method: 'POST', path: '/v1/inventory/adjustment-requests/ar-2/synced', userId: 'u-box', tenantId: A, idempotencyKey: 'ar-2', body: { requestId: 'ar-2', productId: 'P1', locationId: 'S1', binId: null, deltaMinor: -10, uom: 'EA', reasonCode: 'miscount', requestedBy: 'u-worker', at: AT, storeId: 'S1', source: 'warehouse-handheld' } });
    const rejected = await relayDecision(h, { id: 'ap-3', subjectType: 'stock_adjustment', subjectRef: 'ar-2', status: 'rejected', reason: 'counted it myself — it is there' }, 'k-ap-3');
    expect(rejected.body as Relayed).toMatchObject({ applied: true });
    expect(await onHand(h)).toBe(97);
    expect((await requests(h)).requests.find((r) => r.requestId === 'ar-2')).toMatchObject({ status: 'rejected', movementId: null });
  });

  it('a FLAGGED decision — self-approval, a decider without authority, an unknown decider — is recorded and applies NOTHING; the subject still waits', async () => {
    const h = await seeded();
    const self = await relayDecision(h, { id: 'ap-4', decidedBy: 'u-worker' }, 'k-ap-4');
    expect(self.status).toBe(202);
    expect(self.body as Relayed).toMatchObject({ flags: ['self_approval'], applied: false, notAppliedBecause: 'decision_flagged' });
    const lacks = await relayDecision(h, { id: 'ap-5', decidedBy: 'u-cashier' }, 'k-ap-5');
    expect(lacks.body as Relayed).toMatchObject({ flags: ['decider_lacks_authority'], applied: false, notAppliedBecause: 'decision_flagged' });
    const unknown = await relayDecision(h, { id: 'ap-6', decidedBy: 'u-nobody' }, 'k-ap-6');
    expect(unknown.body as Relayed).toMatchObject({ flags: ['decider_unknown'], applied: false });
    // Nothing moved; the count still waits for a person.
    expect(await position(h)).toMatchObject({ correctedOnHandMinor: 100, pending: 1 });
    expect(SUBJECT_AUTHORITY['stock_count']).toBe('inventory.adjustment.approve');
    expect(SUBJECT_AUTHORITY['stock_adjustment']).toBe('inventory.adjustment.approve');
    // A clean decision afterwards still applies it.
    expect((await relayDecision(h, { id: 'ap-7' }, 'k-ap-7')).body as Relayed).toMatchObject({ applied: true });
    expect((await position(h)).correctedOnHandMinor).toBe(50);
  });

  it('a clean decision the subject itself refuses — a count not held, a request already decided the other way, an unknown ref — is recorded with the refusal by name', async () => {
    const h = await seeded();
    // The request is decided on the direct route first; the manager's later contradicting relay cannot overturn it.
    expect((await h.request({ method: 'POST', path: '/v1/inventory/adjustment-requests/ar-1/decide', userId: 'u-mgr', tenantId: A, idempotencyKey: 'd-direct', body: { decision: 'rejected', reason: 'not damaged' } })).status).toBe(200);
    const flip = await relayDecision(h, { id: 'ap-8', subjectType: 'stock_adjustment', subjectRef: 'ar-1', decidedBy: 'u-owner' }, 'k-ap-8');
    expect(flip.status).toBe(202);
    expect(flip.body as Relayed).toMatchObject({ applied: false, notAppliedBecause: 'adjustment_request_already_decided' });
    expect(await onHand(h)).toBe(100);
    const ghost = await relayDecision(h, { id: 'ap-9', subjectType: 'stock_count', subjectRef: 'c-ghost' }, 'k-ap-9');
    expect(ghost.body as Relayed).toMatchObject({ applied: false, notAppliedBecause: 'count_unknown' });
    // A subject type head office does not apply yet is recorded only, and says so.
    const refund = await relayDecision(h, { id: 'ap-10', subjectType: 'refund', subjectRef: 'sale-1', requestedBy: 'u-cashier' }, 'k-ap-10');
    expect(refund.body as Relayed).toMatchObject({ flags: [], applied: false, notAppliedBecause: 'no_handler' });
  });

  it('the direct decide routes and the relayed decision are the same rule: a count decided directly cannot be re-decided differently by relay, and vice versa', async () => {
    const h = await seeded();
    expect((await relayDecision(h, { id: 'ap-11', status: 'rejected', reason: 'recount ordered' }, 'k-ap-11')).body as Relayed).toMatchObject({ applied: true });
    expect((await position(h)).counts[0]).toMatchObject({ decision: 'rejected', adjusted: false });
    const direct = await h.request({ method: 'POST', path: '/v1/inventory/counts/c1/decide', userId: 'u-mgr', tenantId: A, idempotencyKey: 'cd-c1', body: { decision: 'approved', reason: 'changed my mind' } });
    expect(direct.status).toBe(409);
    expect(codeOf(direct)).toBe('count_already_decided');
    expect((await position(h)).correctedOnHandMinor).toBe(100);
  });
});
