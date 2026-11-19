import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { aBranch } from '../support/a-branch';
import { approvedSuppliers } from '../support/approved-supplier';
import { askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

/**
 * **S1 · batch 18c — expired, near-expiry or damaged SHELF stock goes back to the supplier (roadmap §29 purchase_return ·
 * API-03 · M10-FR-01 · OB-872) — on the in-memory event store and, with DATABASE_URL, on real PostgreSQL.**
 *
 *   • one save gives the return its `RTS1/YY-YY/NNNNN` number, takes the stock off by a `returned_to_supplier` movement
 *     (off the batch named) and issues the supplier's debit note under `SDN/YY-YY/NNNNN`;
 *   • the debit note is on the supplier's account, SHOWN and not netted until the GST treatment is decided (said in words);
 *   • more than is on hand is refused in plain words; an unknown supplier is refused; nothing is saved either way;
 *   • at or above the write-off limit it needs the same approval as a write-off of that value — never the raiser's own;
 *   • above the e-way-bill limit it is refused by name until an e-way bill is generated for its movement;
 *   • the audit trail names who, what, why and the approver.
 */

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface Rts { returnId: string; documentNumber?: string; approvedBy: string | null; valueMinor: number; debitNote: { number?: string; valueMinor: number; gstTreatment: string } }

describe.each(useBackings())('S1: shelf stock goes back to the supplier — on $name', ({ harness }) => {
  it('numbers, moves stock, issues the debit note, refuses what it must, and asks a second person above the limit', async () => {
    const h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await aBranch(h, T, 'u-owner');
    await approvedSuppliers(h, T, 'sup-1');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-mgr', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const receive = async (movementId: string, productId: string, qty: number, batchId?: string) => {
      const r = await req('POST', '/v1/inventory/movements', { movementId, productId, locationId: 'store-1', kind: 'received', quantityMinor: qty, uom: 'ea', occurredAt: '2026-11-01T09:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 15_000, ...(batchId === undefined ? {} : { batchId }) }, 'u-owner');
      expect(r.status, JSON.stringify(r.body)).toBe(202);
    };
    await receive('rx-oil', 'OIL', 120, 'B-OLD');
    await receive('rx-ghee', 'GHEE', 500);
    const onHand = async (productId: string): Promise<number> =>
      ((await req('GET', '/v1/inventory/availability', undefined, 'u-owner', { productId })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((r) => r.locationId === 'store-1')?.onHandMinor ?? 0;
    const ret = (returnId: string, over: Record<string, unknown> = {}) => ({ productId: 'OIL', locationId: 'store-1', qty: 2, uom: 'ea', supplierId: 'sup-1', reason: 'expired', batchId: 'B-OLD', note: 'found on the shelf past its date', ...over });

    // ₹300 — below the ₹500 write-off limit: the raiser's own act.
    const small = await req('POST', '/v1/inventory/shelf-returns/rts-a', ret('rts-a'));
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    const a = (small.body as { shelfReturn: Rts }).shelfReturn;
    expect(a.documentNumber).toMatch(/^RTS1\/\d\d-\d\d\/00001$/);
    expect(a.debitNote.number).toMatch(/^SDN\/\d\d-\d\d\/\d{5}$/);
    expect([a.valueMinor, a.debitNote.valueMinor, a.debitNote.gstTreatment, a.approvedBy]).toEqual([30_000, 30_000, 'not_decided', null]);
    expect(await onHand('OIL')).toBe(118);
    // A re-send is the same return, not a second one.
    expect(((await req('POST', '/v1/inventory/shelf-returns/rts-a', ret('rts-a'))).body as { alreadyRecorded?: boolean }).alreadyRecorded).toBe(true);
    expect(await onHand('OIL')).toBe(118);

    // The debit note is on the supplier's account: shown, not netted, and why.
    const acct = (await req('GET', '/v1/purchase/suppliers/sup-1/account', undefined, 'u-owner')).body as { shelfReturnDebitNotes: { number: string; returnNumber: string; valueMinor: number }[]; shelfReturnDebitNotesTotal: { valueMinor: number; nettedInBalance: boolean; why: string } };
    expect(acct.shelfReturnDebitNotes.map((d) => [d.number, d.returnNumber, d.valueMinor])).toEqual([[a.debitNote.number, a.documentNumber, 30_000]]);
    expect(acct.shelfReturnDebitNotesTotal).toMatchObject({ valueMinor: 30_000, nettedInBalance: false });
    // OB-874 C: not taken off what is owed until the supplier accepts it — said plainly.
    expect(acct.shelfReturnDebitNotesTotal.why).toMatch(/^Waiting for the supplier to accept\. .*not taken off what is owed until the supplier accepts it/);

    // More than is on hand of that batch: refused in plain words, nothing saved.
    const tooMany = await req('POST', '/v1/inventory/shelf-returns/rts-b', ret('rts-b', { qty: 119 }));
    expect(codeOf(tooMany)).toBe('more_than_on_hand');
    expect((tooMany.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/Only 118 of OIL \(batch B-OLD\) is on hand at store-1/);
    // An unknown supplier: refused.
    expect(codeOf(await req('POST', '/v1/inventory/shelf-returns/rts-c', ret('rts-c', { supplierId: 'sup-nobody' })))).toBe('supplier_unknown');
    expect(await onHand('OIL')).toBe(118);

    // ₹900 — above the limit: a second person approves exactly this return, as for a write-off of that value.
    const big = ret('rts-d', { qty: 6, reason: 'damaged', note: 'pouches torn' });
    expect(codeOf(await req('POST', '/v1/inventory/shelf-returns/rts-d', big))).toBe('shelf_return_needs_approval');
    const asked = await askForApproval(h, T, 'u-mgr', { kind: 'stock_write_off', subjectRef: 'rts-d', details: actionDetails(big, { returnId: 'rts-d' }), valueMinor: 90_000, summary: 'Return 6 torn pouches of oil to Sri Foods' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const requestId = (asked.body as { requestId: string }).requestId;
    expect((await decide(h, T, 'u-mgr', requestId)).status).toBeGreaterThanOrEqual(400); // never the raiser's own
    expect((await decide(h, T, 'u-owner', requestId, 'approved', 'torn, supplier agreed')).status).toBe(201);
    const bigDone = await req('POST', '/v1/inventory/shelf-returns/rts-d', { ...big, approvalId: requestId });
    expect(bigDone.status, JSON.stringify(bigDone.body)).toBe(201);
    const d = (bigDone.body as { shelfReturn: Rts }).shelfReturn;
    expect([d.documentNumber, d.approvedBy, d.valueMinor]).toEqual([a.documentNumber!.replace(/00001$/, '00002'), 'u-owner', 90_000]);
    expect(await onHand('OIL')).toBe(112);

    // ₹60,000 of ghee — above the e-way-bill limit: refused by name until an e-way bill is generated for its movement.
    const ghee = { productId: 'GHEE', locationId: 'store-1', qty: 400, uom: 'ea', supplierId: 'sup-1', reason: 'near_expiry' };
    const gheeAsk = await askForApproval(h, T, 'u-mgr', { kind: 'stock_write_off', subjectRef: 'rts-e', details: actionDetails(ghee, { returnId: 'rts-e' }), valueMinor: 6_000_000 });
    const gheeId = (gheeAsk.body as { requestId: string }).requestId;
    expect((await decide(h, T, 'u-owner', gheeId)).status).toBe(201);
    const noEwb = await req('POST', '/v1/inventory/shelf-returns/rts-e', { ...ghee, approvalId: gheeId });
    expect(codeOf(noEwb)).toBe('ewb_required');
    expect((noEwb.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/shelf-return-rts-e/);
    expect(await onHand('GHEE')).toBe(500);

    // The register and the audit trail.
    const list = (await req('GET', '/v1/inventory/shelf-returns')).body as { returns: Rts[] };
    expect(list.returns.map((r) => r.returnId)).toEqual(['rts-d', 'rts-a']);
    const trail = ((await req('GET', '/v1/audit/trail', undefined, 'u-owner', { action: 'stock.return_to_supplier' })).body as { matches: { actorId: string; reason?: string; after: Record<string, string> }[] }).matches;
    expect(trail.map((m) => [m.actorId, m.after['returnId'], m.after['approvedBy'], m.reason]).sort()).toEqual([
      ['u-mgr', 'rts-a', '', 'found on the shelf past its date'], ['u-mgr', 'rts-d', 'u-owner', 'pouches torn'],
    ]);
  }, 120_000);
});
