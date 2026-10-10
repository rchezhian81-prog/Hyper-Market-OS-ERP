import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sealedDecision } from '../support/store-seal';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { SUBJECT_AUTHORITY } from '../../services/identity/src/approval-decisions';

/**
 * **An over-tolerance delivery excess is HELD until a second person decides it; the product rules and the tolerances are
 * head office's own, never the sender's (SP-4 (ii) · W03 · audit finding F03 · M07-FR-02 · M07-FR-03 · §28 · hard rules
 * #2/#5/#6/#10, API-04).**
 *
 * Before SP-4 (ii) the direct goods receipt took `rules[]` and `policy` from the request body and made an excess it had
 * itself flagged `requiresApproval` fully sellable at once (F03). Now: the owner sets the tenant's receiving tolerances
 * once; the catalogue says what is batch-tracked; a body naming either is refused by name; the ordered quantity becomes
 * stock and the excess beyond tolerance waits — on the GRN, visible, valued, not sellable — for a person who is not the
 * receiver to accept it (one inbound movement per held line, once) or refuse it (left for the supplier claim, SP-6). The
 * same decide step serves the direct route and the manager's decision relayed from the store through the box. Synthetic
 * data (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-09-30T09:00:00.000Z';
const WH = 'wh-1';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Grn {
  grnId: string; availableMinor: number; heldMinor: number; governanceFlags?: string[];
  excessDecision?: { decision: string; decidedBy: string; releasedMinor: number; movementIds: string[]; via: string };
  captured: { requiresApproval: boolean; lines: { lineId: string; sellableMinor: number; heldMinor: number; disposition: string }[] };
}
interface Decided { decision: string; releasedMinor: number; movementIds: string[]; availableMinor: number; heldMinor: number; alreadyDecided: boolean }
interface Relayed { flags: string[]; applied?: boolean; appliedDetail?: string; notAppliedBecause?: string }

const post = (h: ApiHarness, path: string, userId: string, body: unknown, key: string, tenantId = A) =>
  h.request({ method: 'POST', path, userId, tenantId, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId: string, query?: Readonly<Record<string, string>>, tenantId = A) =>
  h.request({ method: 'GET', path, userId, tenantId, ...(query === undefined ? {} : { query }) });
const receipt = (productId: string, ordered: number, counted: number, extra: Record<string, unknown> = {}) => ({
  warehouseId: WH, receivedOnDate: '2026-09-30', currency: 'INR',
  lines: [{ lineId: 'L1', productId, orderedMinor: ordered, countedMinor: counted, uom: 'ea', unitCost: { minor: 5000, currency: 'INR' }, condition: 'good', ...extra }],
});
const receive = (h: ApiHarness, grnId: string, body: unknown, key = grnId, userId = 'u-receiver') => post(h, `/v1/inventory/goods-receipt/${grnId}`, userId, body, key);
const decide = (h: ApiHarness, grnId: string, userId: string, decision: string, key: string) =>
  post(h, `/v1/inventory/goods-receipt/${grnId}/excess/decide`, userId, { decision, reason: `${decision} — checked with the supplier` }, key);
const grnOf = (res: { body: unknown }): Grn => (res.body as { grn: Grn }).grn;
const readGrn = async (h: ApiHarness, grnId: string): Promise<Grn> => grnOf(await get(h, `/v1/inventory/goods-receipt/${grnId}`, 'u-owner'));
const onHand = async (h: ApiHarness, productId: string, tenantId = A): Promise<number> =>
  ((await get(h, '/v1/inventory/availability', 'u-owner', { productId }, tenantId)).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0);
const relayDecision = (h: ApiHarness, over: Record<string, unknown>, key: string) => {
  const body = {
    id: 'ap-x', subjectType: 'goods_receipt_excess', subjectRef: 'g1', requestedBy: 'u-receiver', branchId: 'store-1', value: null,
    status: 'approved', decidedBy: 'u-boss', reason: 'supplier confirmed the extra is free', decidedAt: AT, storeId: 'store-1', source: 'manager-screen', ...over,
  };
  return post(h, `/v1/approvals/decisions/${String(body.id)}/synced`, 'u-box', sealedDecision(A, 'ApprovalDecided', body), key);
};

/** The cast, the product master (p1/p3 untracked, p2 batch-tracked) and the tenant's 5% excess tolerance. */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-receiver', 'store_manager'); // receives; holds approve too — but never on their own receipt
  await h.provisionRole(A, 'u-boss', 'store_manager');     // the second person
  await h.provisionRole(A, 'u-box', 'store_computer');            // the store box: relays the manager's decisions
  await h.provisionRole(A, 'u-cashier', 'cashier');        // holds no approval authority
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' },
        products: [
          { productId: 'p1', sku: 'p1', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false, handling: 'ambient' },
          { productId: 'p2', sku: 'p2', name: 'Fresh paneer 200g', unitPriceMinor: 9_000, taxBps: 500, status: 'active', uom: 'ea', batchTracked: true },
          { productId: 'p3', sku: 'p3', name: 'Biscuits 100g', unitPriceMinor: 2_000, taxBps: 1800, status: 'active', uom: 'ea', batchTracked: false, handling: 'ambient' },
        ],
        barcodes: [],
      },
    },
  }));
  expect((await post(h, '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 }, 'pol')).status).toBe(201);
  return h;
}

describe('the tenant\'s receiving tolerances are the owner\'s call, read by every receipt (F03)', () => {
  it('before any is set the default applies and is SAID; the owner sets one; a manager may not; it reads back with who set it', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');
    const none = await get(h, '/v1/inventory/receipt-policy', 'u-owner');
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ policy: null, defaultPolicy: { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 30 }, inForce: { excessToleranceBp: 0 } });
    // A receipt under the default: 101 against 100 is over a 0-tolerance → held 1, and the record says the default applied.
    const under = await receive(h, 'g-default', receipt('p1', 100, 101), 'g-default', 'u-mgr');
    expect(under.status).toBe(201);
    expect(grnOf(under)).toMatchObject({ availableMinor: 100, heldMinor: 1, governanceFlags: ['no_purchase_order', 'product_rules_unverified', 'handling_unknown', 'default_policy'] });
    // The manager cannot set the tenant's tolerances; the owner can.
    expect((await post(h, '/v1/inventory/receipt-policy', 'u-mgr', { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 }, 'p-mgr')).status).toBe(403);
    expect(codeOf(await post(h, '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: -1, shortageToleranceBp: 200, nearExpiryDays: 7 }, 'p-bad'))).toBe('not_readable_as_a_receipt_policy');
    const set = await post(h, '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7, coldChainMaxC: 8 }, 'p-ok');
    expect(set.status).toBe(201);
    expect(set.body).toMatchObject({ policy: { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7, coldChainMaxC: 8, setBy: 'u-owner' } });
    const read = await get(h, '/v1/inventory/receipt-policy', 'u-owner');
    expect(read.body).toMatchObject({ policy: { excessToleranceBp: 500, setBy: 'u-owner' }, inForce: { excessToleranceBp: 500 } });
    expect((await get(h, '/v1/inventory/receipt-policy', 'u-mgr')).status).toBe(403);
    // The same 1% excess is now within tolerance: nothing held, no default flag.
    const within = await receive(h, 'g-within', receipt('p1', 100, 101), 'g-within', 'u-mgr');
    expect(grnOf(within)).toMatchObject({ availableMinor: 101, heldMinor: 0, governanceFlags: ['no_purchase_order', 'product_rules_unverified', 'handling_unknown'] });
  });

  it('is the tenant\'s own: another tenant\'s policy never applies here', async () => {
    const h = await seeded();
    await h.seedOwner(B, 'u-owner-b');
    expect((await post(h, '/v1/inventory/receipt-policy', 'u-owner-b', { excessToleranceBp: 100_000, shortageToleranceBp: 0, nearExpiryDays: 30 }, 'pol-b', B)).status).toBe(201);
    // Tenant A still holds at 5%: 110 against 100 → 10 held.
    expect(grnOf(await receive(h, 'g-a', receipt('p1', 100, 110)))).toMatchObject({ availableMinor: 100, heldMinor: 10 });
    expect((await get(h, '/v1/inventory/receipt-policy', 'u-owner')).body).toMatchObject({ policy: { excessToleranceBp: 500 } });
  });
});

describe('an over-tolerance excess is HELD until a second person decides it (F03 · §28)', () => {
  it('the ordered quantity becomes stock; the excess is on the GRN, valued, and NOT on hand; the review list surfaces it first', async () => {
    const h = await seeded();
    const res = await receive(h, 'g1', receipt('p1', 100, 110));
    expect(res.status).toBe(201);
    const g = grnOf(res);
    expect(g).toMatchObject({ availableMinor: 100, heldMinor: 10, governanceFlags: ['no_purchase_order'], captured: { requiresApproval: true } });
    expect(g.captured.lines[0]).toMatchObject({ sellableMinor: 100, heldMinor: 10, disposition: 'sellable' });
    expect((res.body as { flags: string[] }).flags).toEqual(['no_purchase_order']); // a delivery with no order behind it is SAID (SP-6)
    expect(await onHand(h, 'p1')).toBe(100);
    // A within-tolerance receipt beside it holds nothing.
    expect(grnOf(await receive(h, 'g2', receipt('p3', 100, 104)))).toMatchObject({ availableMinor: 104, heldMinor: 0, captured: { requiresApproval: false } });
    const list = await get(h, '/v1/inventory/goods-receipt', 'u-owner');
    expect(list.body).toMatchObject({ count: 2, needingApprovalCount: 1, heldExcessCount: 1 });
    expect((list.body as { receipts: Grn[] }).receipts[0]?.grnId).toBe('g1');
    expect((await get(h, '/v1/inventory/goods-receipt/g1', 'u-owner')).body).toMatchObject({ awaitsDecision: true });
    // The same receipt again (a re-scan) is one effect and still holds.
    const again = await receive(h, 'g1', receipt('p1', 100, 110), 'g1-again');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyReceived: true, grn: { heldMinor: 10 } });
    expect(await onHand(h, 'p1')).toBe(100);
  });

  it('the receiver cannot decide their own; a cashier may not; a second person approves and the excess reaches stock ONCE — a retry, a lost reply and a re-decision add nothing', async () => {
    const h = await seeded();
    await receive(h, 'g1', receipt('p1', 100, 110));
    const self = await decide(h, 'g1', 'u-receiver', 'approved', 'd-self');
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('self_approval');
    expect((await decide(h, 'g1', 'u-cashier', 'approved', 'd-cashier')).status).toBe(403);
    expect(await onHand(h, 'p1')).toBe(100);

    const ok = await decide(h, 'g1', 'u-boss', 'approved', 'd-1');
    expect(ok.status).toBe(200);
    expect(ok.body as Decided).toMatchObject({ decision: 'approved', releasedMinor: 10, movementIds: ['g1:L1:excess'], availableMinor: 110, heldMinor: 10, alreadyDecided: false });
    expect(await onHand(h, 'p1')).toBe(110);
    const g = await readGrn(h, 'g1');
    expect(g.excessDecision).toMatchObject({ decision: 'approved', decidedBy: 'u-boss', releasedMinor: 10, via: 'direct' });
    expect(g.availableMinor).toBe(110);
    expect((await get(h, '/v1/inventory/goods-receipt/g1', 'u-owner')).body).toMatchObject({ awaitsDecision: false });
    expect((await get(h, '/v1/inventory/goods-receipt', 'u-owner')).body).toMatchObject({ needingApprovalCount: 0, heldExcessCount: 0 });

    // The same request again with the same key (a lost reply) → the kernel replays; a fresh key → alreadyDecided. Stock is unchanged.
    expect((await decide(h, 'g1', 'u-boss', 'approved', 'd-1')).status).toBe(200);
    const retry = await decide(h, 'g1', 'u-boss', 'approved', 'd-2');
    expect(retry.status).toBe(200);
    expect(retry.body as Decided).toMatchObject({ alreadyDecided: true, releasedMinor: 10 });
    // A DIFFERENT decision now would be a second truth — refused.
    const flip = await decide(h, 'g1', 'u-boss', 'rejected', 'd-3');
    expect(flip.status).toBe(409);
    expect(codeOf(flip)).toBe('excess_already_decided');
    expect(await onHand(h, 'p1')).toBe(110);
    // The released movement is valued at what the goods cost (₹50.00 × 110).
    const valuation = (await get(h, '/v1/inventory/valuation', 'u-owner')).body as { rows: { productId: string; onHandMinor: number; value: { minor: number } }[] };
    expect(valuation.rows.find((r) => r.productId === 'p1')).toMatchObject({ onHandMinor: 110, value: { minor: 550_000 } });
  });

  it('a rejection releases nothing: the excess stays on the record for the supplier claim, and the receipt no longer waits', async () => {
    const h = await seeded();
    await receive(h, 'g1', receipt('p3', 100, 120));
    const no = await decide(h, 'g1', 'u-boss', 'rejected', 'd-1');
    expect(no.status).toBe(200);
    expect(no.body as Decided).toMatchObject({ decision: 'rejected', releasedMinor: 0, movementIds: [], availableMinor: 100, heldMinor: 20 });
    expect(await onHand(h, 'p3')).toBe(100);
    expect((await readGrn(h, 'g1')).excessDecision).toMatchObject({ decision: 'rejected', releasedMinor: 0 });
    expect((await get(h, '/v1/inventory/goods-receipt/g1', 'u-owner')).body).toMatchObject({ awaitsDecision: false });
    // A later approval is refused: the refusal stands.
    expect(codeOf(await decide(h, 'g1', 'u-boss', 'approved', 'd-2'))).toBe('excess_already_decided');
  });

  it('there is nothing to decide on a receipt that holds no excess, or one head office has never seen', async () => {
    const h = await seeded();
    await receive(h, 'g-clean', receipt('p1', 100, 100));
    const none = await decide(h, 'g-clean', 'u-boss', 'approved', 'd-1');
    expect(none.status).toBe(409);
    expect(codeOf(none)).toBe('receipt_holds_no_excess');
    expect((await decide(h, 'g-nowhere', 'u-boss', 'approved', 'd-2')).status).toBe(404);
    expect(codeOf(await post(h, '/v1/inventory/goods-receipt/g-clean/excess/decide', 'u-boss', { decision: 'maybe', reason: 'x' }, 'd-3'))).toBe('not_readable_as_an_excess_decision');
  });

  it('the manager\'s decision relayed from the store through the box applies through the SAME step: once, only by a person who may, never by the receiver', async () => {
    const h = await seeded();
    await receive(h, 'g1', receipt('p1', 100, 110));
    expect(SUBJECT_AUTHORITY['goods_receipt_excess']).toBe('inventory.adjustment.approve');
    // The receiver's own relayed approval is recorded, FLAGGED, and applies nothing.
    const self = await relayDecision(h, { id: 'ap-self', decidedBy: 'u-receiver' }, 'r-self');
    expect(self.status).toBe(202);
    expect(self.body as Relayed).toMatchObject({ applied: false, notAppliedBecause: 'decision_flagged' });
    expect((self.body as Relayed).flags).toContain('self_approval');
    // A cashier's relayed approval — no authority — the same.
    const weak = await relayDecision(h, { id: 'ap-weak', decidedBy: 'u-cashier' }, 'r-weak');
    expect((weak.body as Relayed).flags).toContain('decider_lacks_authority');
    expect(weak.body as Relayed).toMatchObject({ applied: false });
    expect(await onHand(h, 'p1')).toBe(100);
    // The supervisor's clean relayed approval releases the 10 — and the record says it came relayed.
    const ok = await relayDecision(h, {}, 'r-1');
    expect(ok.status).toBe(202);
    expect(ok.body as Relayed).toMatchObject({ applied: true, flags: [] });
    expect((ok.body as Relayed).appliedDetail).toContain('10 released to stock');
    expect(await onHand(h, 'p1')).toBe(110);
    expect((await readGrn(h, 'g1')).excessDecision).toMatchObject({ decision: 'approved', decidedBy: 'u-boss', via: 'relayed', releasedMinor: 10 });
    // The same decision relayed twice (a lost reply between box and cloud) applies once.
    const again = await relayDecision(h, {}, 'r-2');
    expect(again.body as Relayed).toMatchObject({ applied: true });
    expect(await onHand(h, 'p1')).toBe(110);
  });

  it('survives a restart: the held receipt, its decision and the released stock are rebuilt from the event store', async () => {
    const h = await seeded();
    await receive(h, 'g1', receipt('p1', 100, 110));
    await receive(h, 'g2', receipt('p3', 100, 120));
    expect((await decide(h, 'g1', 'u-boss', 'approved', 'd-1')).status).toBe(200);
    const restarted = apiHarness({ store: h.store });
    expect((await readGrn(restarted, 'g1')).excessDecision).toMatchObject({ decision: 'approved', releasedMinor: 10 });
    expect((await readGrn(restarted, 'g2'))).toMatchObject({ heldMinor: 20, availableMinor: 100 });
    expect((await readGrn(restarted, 'g2')).excessDecision).toBeUndefined();
    expect(await onHand(restarted, 'p1')).toBe(110);
    expect(await onHand(restarted, 'p3')).toBe(100);
    expect((await get(restarted, '/v1/inventory/goods-receipt', 'u-owner')).body).toMatchObject({ heldExcessCount: 1 });
  });
});
