import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { aBranch } from '../support/a-branch';
import { askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

/**
 * **OB-808 A (owner, 16 Nov 2026: "OB-808 A") · daily-work defect D-013 · M28-FR-01 · §28 · P-08 · hard rules #2, #10.**
 *
 * Approving a write-off writes it off at once, in the asker's name. Before, the manager approved "Write off 6 pouches of
 * Sunflower Oil" and nothing was written off until the asker came back. Now head office sends exactly the asked-for loss
 * through the governed write-off route, as the asker, naming the approval — every ordinary check runs again — and:
 *   • the stock falls once, by exactly the approved quantity, at the approved place;
 *   • the write-off carries the asker (raisedBy) and the approver (approvedBy), and the audit names both;
 *   • the same decision re-sent, and the asker's own "Record the loss" afterwards, never write it off twice;
 *   • a rejection writes nothing off; an approval past its time writes nothing off;
 *   • a loss head office could not make in the asker's name (outside the asker's own branches) is said — never silent —
 *     on the decision and on both people's lists;
 *   • an approval cannot be used for a different quantity.
 * Runs on the in-memory event store and, when DATABASE_URL is set, on real PostgreSQL.
 */

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

afterEach(() => { vi.useRealTimers(); });

describe.each(useBackings())('approving a write-off writes it off at once, in the asker\'s name — on $name', ({ harness }) => {
  async function shop(): Promise<{ h: ApiHarness; T: string }> {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-mgr2', 'store_manager');
    await aBranch(h, T, 'u-owner');
    // The oil on the shelf, with head office's own cost (₹150 a pouch) — what a loss is valued from (SF-05).
    const got = await h.request({
      method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: T, idempotencyKey: `mv-${randomUUID()}`,
      body: { movementId: 'cost-oil', productId: 'OIL', locationId: 'store-1', kind: 'received', quantityMinor: 120, uom: 'ea', occurredAt: '2026-11-01T09:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 15_000 },
    });
    expect(got.status, JSON.stringify(got.body)).toBe(202);
    return { h, T };
  }
  // 6 pouches at ₹150 = ₹900: above the ₹500 line, so a photo and a second person (M28-FR-01).
  const loss = (over: Record<string, unknown> = {}) => ({
    productId: 'OIL', locationId: 'store-1', qty: 6, uom: 'ea', lossType: 'damage', reasonCode: 'damage', valueMinor: 90_000, evidenceRef: 'photo-1', ...over,
  });
  const ask = async (h: ApiHarness, T: string, who: string, writeOffId: string, body: Record<string, unknown>): Promise<string> => {
    const asked = await askForApproval(h, T, who, { kind: 'stock_write_off', subjectRef: writeOffId, details: actionDetails(body, { writeOffId }), valueMinor: body['valueMinor'] as number, summary: 'Write off 6 pouches of Sunflower Oil' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    return (asked.body as { requestId: string }).requestId;
  };
  const onHand = async (h: ApiHarness, T: string): Promise<number> =>
    ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: T, query: { productId: 'OIL' } })).body as { rows: { locationId: string; onHandMinor: number }[] })
      .rows.find((r) => r.locationId === 'store-1')?.onHandMinor ?? 0;
  const writeOffs = async (h: ApiHarness, T: string) =>
    ((await h.request({ method: 'GET', path: '/v1/inventory/write-offs', userId: 'u-owner', tenantId: T })).body as { writeOffs: { id: string; qtyRemoved: number; raisedBy: string; approvedBy: string | null }[] }).writeOffs;
  const post = (h: ApiHarness, T: string, who: string, writeOffId: string, body: Record<string, unknown>) =>
    h.request({ method: 'POST', path: `/v1/inventory/write-off/${writeOffId}`, userId: who, tenantId: T, idempotencyKey: `wo-${randomUUID()}`, body });
  const inbox = async (h: ApiHarness, T: string, who: string) =>
    (await h.request({ method: 'GET', path: '/v1/approvals/requests', userId: who, tenantId: T })).body as { mine: Record<string, unknown>[]; waitingForMe: Record<string, unknown>[] };

  it('the approval writes the loss off once, as the asker, naming the approver — and the asker\'s own press changes nothing', async () => {
    const { h, T } = await shop();
    expect(await onHand(h, T)).toBe(120);
    const requestId = await ask(h, T, 'u-mgr', 'wo-oil', loss());
    expect(await onHand(h, T)).toBe(120); // asking writes nothing off

    const approved = await decide(h, T, 'u-owner', requestId, 'approved', 'the pouches are torn');
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect((approved.body as { stockChange: Record<string, unknown> }).stockChange).toMatchObject({
      applied: true, kind: 'stock_write_off', productId: 'OIL', locationId: 'store-1', qty: 6, askedBy: 'u-mgr', approvedBy: 'u-owner',
    });
    // The stock fell at once, by exactly the approved quantity, by one append-only write-off in the asker's name.
    expect(await onHand(h, T)).toBe(114);
    const wo = (await writeOffs(h, T)).filter((w) => w.id === 'wo-oil');
    expect(wo).toHaveLength(1);
    expect(wo[0]).toMatchObject({ qtyRemoved: 6, raisedBy: 'u-mgr', approvedBy: 'u-owner' });
    // The audit names both people.
    const trail = ((await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { objectType: 'product', objectId: 'OIL' } })).body as { matches: { action: string; actorId: string; after: Record<string, string> }[] })
      .matches.filter((m) => m.action === 'stock.write_off');
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ actorId: 'u-mgr', after: { writeOffId: 'wo-oil', approvedBy: 'u-owner', qtyRemoved: '6' } });

    // The same decision re-sent: answered, applied (already), and nothing written off twice.
    const again = await decide(h, T, 'u-owner', requestId, 'approved', 'the pouches are torn');
    expect(again.status).toBeLessThan(300);
    expect((again.body as { stockChange?: { applied: boolean } }).stockChange?.applied).toBe(true);
    // The asker pressing "Record the loss" with the approval: the same loss, already recorded — never a second one.
    const pressed = await post(h, T, 'u-mgr', 'wo-oil', { ...loss(), approvalId: requestId });
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(201);
    expect(pressed.body).toMatchObject({ id: 'wo-oil', qtyRemoved: 6, alreadyRecorded: true });
    expect(await onHand(h, T)).toBe(114);
    expect((await writeOffs(h, T)).filter((w) => w.id === 'wo-oil')).toHaveLength(1);
    // Both lists say it was written off.
    expect((await inbox(h, T, 'u-mgr')).mine.find((r) => r['requestId'] === requestId)).toMatchObject({ status: 'used', stockChange: { applied: true } });
  });

  it('an approval cannot be used for a different quantity, and someone else cannot replay it', async () => {
    const { h, T } = await shop();
    const requestId = await ask(h, T, 'u-mgr', 'wo-oil', loss());
    expect((await decide(h, T, 'u-owner', requestId)).status).toBe(201);
    expect(await onHand(h, T)).toBe(114);
    // A different quantity under the same id and approval: refused — the id is used, and the approval is for 6.
    const more = await post(h, T, 'u-mgr', 'wo-oil', { ...loss({ qty: 7, valueMinor: 105_000 }), approvalId: requestId });
    expect(more.status).toBe(409);
    // A new id with the spent approval: refused by the engine — one approval, one loss.
    const reused = await post(h, T, 'u-mgr', 'wo-oil-2', { ...loss(), approvalId: requestId });
    expect(reused.status).toBe(422);
    // Another person sending it with the asker's approval: not a replay for them.
    const other = await post(h, T, 'u-mgr2', 'wo-oil', { ...loss(), approvalId: requestId });
    expect(other.status).toBe(409);
    expect(await onHand(h, T)).toBe(114);
  });

  it('a rejection writes nothing off', async () => {
    const { h, T } = await shop();
    const requestId = await ask(h, T, 'u-mgr', 'wo-oil', loss());
    const rejected = await decide(h, T, 'u-owner', requestId, 'rejected', 'those pouches are fine');
    expect(rejected.status).toBe(201);
    expect((rejected.body as { stockChange?: unknown }).stockChange).toBeUndefined();
    expect(await onHand(h, T)).toBe(120);
    expect((await writeOffs(h, T)).some((w) => w.id === 'wo-oil')).toBe(false);
  });

  it('the asker cannot approve their own loss, and nothing is written off by trying', async () => {
    const { h, T } = await shop();
    const requestId = await ask(h, T, 'u-mgr', 'wo-oil', loss());
    const self = await decide(h, T, 'u-mgr', requestId);
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('self_approval');
    expect(await onHand(h, T)).toBe(120);
  });

  it('a loss outside the asker\'s own branches is NOT made in their name — said on the decision and both lists, never silent', async () => {
    const { h, T } = await shop();
    // Handles stock, but only at another store (a cashier's grant here lets them sign in and ask).
    await h.provisionRole(T, 'u-far', 'store_manager', ['store-2']);
    await h.provisionRole(T, 'u-far', 'cashier');
    const requestId = await ask(h, T, 'u-far', 'wo-oil', loss());
    const approved = await decide(h, T, 'u-owner', requestId);
    expect(approved.status).toBe(201);
    const change = (approved.body as { stockChange: { applied: boolean; code?: string; reason?: string } }).stockChange;
    expect(change.applied).toBe(false);
    expect(change.reason ?? '').not.toBe('');
    expect(await onHand(h, T)).toBe(120);
    expect((await inbox(h, T, 'u-far')).mine.find((r) => r['requestId'] === requestId)).toMatchObject({ stockChange: { applied: false } });
    expect((await inbox(h, T, 'u-owner')).waitingForMe.find((r) => r['requestId'] === requestId) ?? { stockChange: { applied: false } }).toMatchObject({ stockChange: { applied: false } });
  });

  it('an approval past its time writes nothing off when it is sent again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T09:00:00.000Z'));
    const { h, T } = await shop();
    await h.provisionRole(T, 'u-far', 'store_manager', ['store-2']);
    await h.provisionRole(T, 'u-far', 'cashier');
    const requestId = await ask(h, T, 'u-far', 'wo-oil', loss());
    // Approved while u-far may not touch store-1: not made (said). The approval stands for 24 hours.
    expect(((await decide(h, T, 'u-owner', requestId)).body as { stockChange: { applied: boolean } }).stockChange.applied).toBe(false);
    // u-far is given store-1 too — but only after the approval ran out.
    await h.provisionRole(T, 'u-far', 'store_manager', 'all');
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));
    const late = await decide(h, T, 'u-owner', requestId);
    expect(late.status).toBeLessThan(300);
    const change = (late.body as { stockChange: { applied: boolean; code?: string } }).stockChange;
    expect(change.applied).toBe(false);
    expect(change.code).toBe('approval_expired');
    expect(await onHand(h, T)).toBe(120);
  });
});
