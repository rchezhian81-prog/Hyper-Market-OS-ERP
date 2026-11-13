import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';

/**
 * **U6 (UI/UX gap audit §27 "Purchase — claims": PARTIAL) · M07-FR-03 "supplier claim raised where due" · M24-FR-02 "a supplier
 * raises claims and sees them".** The claims between the shop and a supplier were spread over the goods receipt page
 * (dispositions), the supplier account (debit notes) and the review desk (a supplier's claim). Now ONE register reads both
 * sides from the records head office already holds — never a second copy:
 *   • a second person's CLAIM on a damaged line raises a debit note (the account's), listed as raised until a person ISSUES it
 *     under a number, then as issued; stock refused at the dock is listed as never owed; a RETURN as pending until it goes back;
 *   • a supplier's own claim through the portal is listed as awaiting a buyer, then accepted or rejected with the reason;
 *   • the supplier reads the shop's claims against IT (its own, never another's) on its portal;
 *   • the counts say how many of each. A cashier reads none of it.
 */
const T = randomUUID();
const post = (h: ApiHarness, path: string, userId: string, body: unknown, key = `${path}-${userId}-${randomUUID()}`) => h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId: string, query?: Readonly<Record<string, string>>) => h.request({ method: 'GET', path, userId, tenantId: T, ...(query === undefined ? {} : { query }) });
const rl = (lineId: string, productId: string, ordered: number, counted: number, unit: number, extra: Record<string, unknown> = {}) =>
  ({ lineId, productId, orderedMinor: ordered, countedMinor: counted, uom: 'ea', unitCost: { minor: unit, currency: 'INR' }, condition: 'good', ...extra });

interface ShopClaim { supplierId: string; claimId: string; kind: string; state: string; number: string | null; valueMinor: number | null; productId: string | null }
interface Register { shopClaims: ShopClaim[]; supplierClaims: { supplierId: string; submissionId: string; state: string; claimMinor: number | null; why: string; reason: string | null }[]; counts: Record<string, number>; supplierNames: Record<string, string> }

describe('U6 · supplier claims are one register, both sides (M07-FR-03 · M24-FR-02)', () => {
  it('a claim on a damaged line → a debit note raised then issued; refused stock never owed; a return pending; the supplier\'s own claim decided; the supplier reads its own', async () => {
    const h = apiHarness();
    await h.seedOwner(T, 'u-owner');
    await approvedSuppliers(h, T, 's-1', 's-2');
    await deliveryPlaces(h, T, 'store-1');
    for (const [u, r] of [['u-buyer', 'store_manager'], ['u-recv', 'store_manager'], ['u-boss', 'store_manager'], ['u-acct', 'accountant'], ['u-cash', 'cashier'], ['u-sup', 'supplier'], ['u-sup2', 'supplier']] as const) await h.provisionRole(T, u, r);
    expect((await post(h, '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 })).status).toBe(201);
    expect((await post(h, '/v1/purchase/orders/po-1', 'u-buyer', { supplierId: 's-1', deliverToLocationId: 'store-1', lines: [{ productId: 'p1', orderedQty: 10, unitCost: { minor: 500, currency: 'INR' } }, { productId: 'p2', orderedQty: 4, unitCost: { minor: 1000, currency: 'INR' } }] })).status).toBe(201);
    expect((await post(h, '/v1/purchase/orders/po-1/approval', 'u-owner', { reason: 'fixture' })).status).toBe(200);
    // One delivery: p1 all good; p2 two good, two damaged (quarantined); five p1 expired at the dock (refused).
    const grn = await post(h, '/v1/inventory/goods-receipt/grn-1', 'u-recv', { warehouseId: 'store-1', receivedOnDate: '2026-09-30', currency: 'INR', poId: 'po-1', lines: [
      rl('L1', 'p1', 10, 10, 500), rl('L2', 'p2', 2, 2, 1000), rl('L3', 'p2', 2, 2, 1000, { condition: 'damaged' }), rl('L4', 'p1', 0, 5, 500, { batchId: 'old', expiry: '2026-01-01' }),
    ] });
    expect(grn.status, JSON.stringify(grn.body)).toBe(201);

    // Nothing claimed yet: the register is empty on both sides, and says so with zero counts (an honest zero, read).
    const empty = (await get(h, '/v1/purchase/supplier-claims', 'u-acct')).body as Register;
    expect(empty.shopClaims).toEqual([]);
    expect(empty.counts).toMatchObject({ raised: 0, issued: 0, awaitingBuyer: 0 });
    expect((await get(h, '/v1/purchase/supplier-claims', 'u-cash')).status).toBe(403);

    // A second person CLAIMS the damaged line and returns the refused one: a debit note (raised) and a refused-never-owed row.
    expect((await post(h, '/v1/inventory/goods-receipt/grn-1/lines/L3/disposition', 'u-boss', { disposition: 'claim', reason: 'two cartons crushed' })).status).toBeLessThan(300);
    expect((await post(h, '/v1/inventory/goods-receipt/grn-1/lines/L4/disposition', 'u-boss', { disposition: 'return', reason: 'expired on arrival' })).status).toBeLessThan(300);
    const one = (await get(h, '/v1/purchase/supplier-claims', 'u-acct')).body as Register;
    const note = one.shopClaims.find((c) => c.kind === 'debit_note');
    expect(note).toMatchObject({ supplierId: 's-1', state: 'raised', number: null, productId: 'p2' });
    expect(note!.valueMinor).toBeGreaterThan(0);
    expect(one.shopClaims.find((c) => c.kind === 'refused_at_door')).toMatchObject({ supplierId: 's-1', state: 'never_owed', productId: 'p1' });
    expect(one.counts).toMatchObject({ raised: 1, neverOwed: 1 });
    expect(one.supplierNames['s-1']).toMatch(/Synthetic supplier s-1/);

    // The accountant ISSUES the debit note under a number: the row says issued, with the number.
    const issued = await post(h, `/v1/purchase/suppliers/s-1/debit-notes/${note!.claimId}/issue`, 'u-acct', {});
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const two = (await get(h, '/v1/purchase/supplier-claims', 'u-acct')).body as Register;
    expect(two.shopClaims.find((c) => c.claimId === note!.claimId)).toMatchObject({ state: 'issued', number: expect.stringMatching(/^DN-\d{6}$/) });
    expect(two.counts).toMatchObject({ raised: 0, issued: 1 });

    // The SUPPLIER raises its own claim through the portal (M24-FR-02): awaiting a buyer; a buyer rejects it with the reason.
    for (const [partner, login] of [['s-1', 'u-sup'], ['s-2', 'u-sup2']] as const) {
      expect((await post(h, `/v1/supplier-portal/partners/${partner}`, 'u-buyer', { grants: ['raise_claim', 'view_statement', 'view_orders'], documents: [], requiredDocuments: [], logins: [login] })).status).toBeLessThan(300);
    }
    expect((await post(h, '/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: 'claim-s1-1', kind: 'claim', document: { poId: 'po-1', claimMinor: 1_500, why: 'freight paid by us, not billed' } })).status).toBe(201);
    const three = (await get(h, '/v1/purchase/supplier-claims', 'u-buyer')).body as Register;
    expect(three.supplierClaims).toEqual([expect.objectContaining({ supplierId: 's-1', submissionId: 'claim-s1-1', state: 'awaiting_buyer', claimMinor: 1_500, why: 'freight paid by us, not billed' })]);
    expect(three.counts).toMatchObject({ awaitingBuyer: 1 });
    expect((await post(h, '/v1/supplier-portal/partners/s-1/submissions/claim-s1-1/review', 'u-boss', { decision: 'reject', reason: 'freight was in the order price' })).status).toBe(201);
    const four = (await get(h, '/v1/purchase/supplier-claims', 'u-buyer')).body as Register;
    expect(four.supplierClaims[0]).toMatchObject({ state: 'rejected', reason: 'freight was in the order price' });
    expect(four.counts).toMatchObject({ awaitingBuyer: 0, rejected: 1 });

    // The supplier reads the shop's claims against IT on its portal — the issued debit note and the refused line; s-2 sees none; a probe is refused.
    const mine = (await get(h, '/v1/supplier-portal/me/claims', 'u-sup')).body as { claimsKnown: boolean; claims: { claimId: string; kind: string; state: string; number: string | null }[] };
    expect(mine.claimsKnown).toBe(true);
    expect(mine.claims.map((c) => [c.kind, c.state])).toEqual(expect.arrayContaining([['debit_note', 'issued'], ['refused_at_door', 'never_owed']]));
    expect(mine.claims.find((c) => c.kind === 'debit_note')?.number).toMatch(/^DN-/);
    expect((await get(h, '/v1/supplier-portal/me/claims', 'u-sup2')).body).toMatchObject({ claimsKnown: true, claims: [] });
    expect((await get(h, '/v1/supplier-portal/me/claims', 'u-sup2', { partnerId: 's-1' })).status).toBe(403);
  });
});
