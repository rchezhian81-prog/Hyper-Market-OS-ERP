import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedRequestId, sentWithApproval } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { STREAM } from '../../services/api/src/adapters';

// An upward stock correction (`adjusted`) at head office — M08 · §28 · hard rule #2 · audit PA-03 · ADR-0024 (2b-vi-b-3).
// It makes stock appear, so it takes two people. Before, both people were strings in the request ("enteredBy" and
// "approvedBy") and the only rule was that the two strings differed. Now the person entering it is the signed-in caller,
// and the second person is an approval ANOTHER person who handles stock gave in their own session for exactly this
// correction (kind `stock_adjustment_up`), used once. A typed approver is refused by name.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const move = (h: ApiHarness, u: string, m: Record<string, unknown>, key = `mv-${String(m['movementId'])}`) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: u, tenantId: A, idempotencyKey: key, body: m });
const onHand = async (h: ApiHarness): Promise<number> => {
  const rows = ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A })).body as { rows: { productId: string; locationId: string; onHandMinor: number }[] }).rows;
  return rows.find((r) => r.productId === 'MILK-1' && r.locationId === 'store-1')?.onHandMinor ?? 0;
};
const correction = (movementId: string, quantityMinor = 4): Record<string, unknown> => ({
  movementId, productId: 'MILK-1', locationId: 'store-1', kind: 'adjusted', quantityMinor, uom: 'ea',
  occurredAt: '2026-10-07T09:00:00.000Z', reason: 'found behind the chiller after the count',
});
/** The correction as two people make it: the person entering it asks; `checker` approves in their own session. */
const approvedMove = (h: ApiHarness, u: string, checker: string, m: Record<string, unknown>) =>
  sentWithApproval(h, A, u, checker, { kind: 'stock_adjustment_up', subjectRef: String(m['movementId']) }, m, (b) => move(h, u, b));

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds inventory.movement.append
  await h.provisionRole(A, 'u-cash', 'cashier');       // does not
  // 20 received first, so a correction moves a known figure.
  expect((await move(h, 'u-owner', { movementId: 'rcv-1', productId: 'MILK-1', locationId: 'store-1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: '2026-10-07T08:00:00.000Z', enteredBy: 'u-owner' })).status).toBe(202);
  return h;
}

describe('an upward stock correction takes two real people (M08 · §28 · ADR-0024)', () => {
  it('with another stock handler\'s own approval for exactly it: the stock moves once, and the record names the approver', async () => {
    const h = await cast();
    const res = await approvedMove(h, 'u-owner', 'u-mgr', correction('adj-1'));
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(await onHand(h)).toBe(24);
    const moved = await h.store.readStream(A, STREAM.inventory, { type: 'InventoryMoved' });
    const appended = moved.map((e) => e.event.payload as { movementId?: string; approvedBy?: string; enteredBy?: string }).filter((p) => p.movementId === 'adj-1');
    expect(appended).toEqual([expect.objectContaining({ enteredBy: 'u-owner', approvedBy: 'u-mgr' })]);
  });

  it('refuses a typed approver by name, no approval at all, and a typed "entered by" someone else — nothing moves', async () => {
    const h = await cast();
    // THE BYPASS, CLOSED (audit PA-03): two strings that differ used to be enough.
    expect(codeOf(await move(h, 'u-owner', { ...correction('adj-2'), enteredBy: 'u-owner', approvedBy: 'u-mgr' }))).toBe('approver_named_without_approval');
    expect(codeOf(await move(h, 'u-owner', correction('adj-3')))).toBe('adjustment_not_approved');
    expect(codeOf(await move(h, 'u-owner', { ...correction('adj-4'), enteredBy: 'u-mgr' }))).toBe('actor_is_the_caller');
    expect(await onHand(h)).toBe(20);
  });

  it('nobody approves their own correction, and someone who does not handle stock cannot approve one', async () => {
    const h = await cast();
    expect(codeOf(await approvedMove(h, 'u-owner', 'u-owner', correction('adj-5')))).toBe('self_approval');
    expect((await approvedMove(h, 'u-owner', 'u-cash', correction('adj-6'))).status).toBe(403);
    expect(await onHand(h)).toBe(20);
  });

  it('an approval for one correction never moves another, or a bigger one; and it is used once', async () => {
    const h = await cast();
    const id = await approvedRequestId(h, A, 'u-owner', 'u-mgr', { kind: 'stock_adjustment_up', subjectRef: 'adj-7', details: actionDetails(correction('adj-7')), valueMinor: null });
    // Another movement, and the same movement for more stock, are refused.
    expect(codeOf(await move(h, 'u-owner', { ...correction('adj-8'), approvalId: id }))).toBe('approval_does_not_match');
    expect(codeOf(await move(h, 'u-owner', { ...correction('adj-7', 40), approvalId: id }, 'mv-adj-7-bigger'))).toBe('approval_does_not_match');
    expect(await onHand(h)).toBe(20);
    // The approved correction lands once; re-sent under a new key it is the same movement, not a second one.
    const landed = await move(h, 'u-owner', { ...correction('adj-7'), approvalId: id });
    expect(landed.status, JSON.stringify(landed.body)).toBe(202);
    expect((await move(h, 'u-owner', { ...correction('adj-7'), approvalId: id }, 'mv-adj-7-again')).status).toBe(202);
    expect(await onHand(h)).toBe(24);
  });
});
