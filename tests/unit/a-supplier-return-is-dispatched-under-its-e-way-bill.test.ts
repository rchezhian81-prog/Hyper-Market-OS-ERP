import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  dispatchSupplierReturn, returnRejectedExcess, returnDisposedLine, supplierReturnEwbMovementId,
  type GoodsReceiptDeps, type GrnRecord, type SupplierReturnDispatch,
} from '../../services/inventory/src/goods-receipt';
import { checkDispatchEwb } from '../../packages/e-way-bill/src/index';
import type { EwbLifecycleState } from '../../packages/e-way-bill/src/index';

/**
 * R3 · A23 · OB-194 "A" (owner, 18 Oct 2026, in writing, "Add a 'dispatch' step") — the pure flow: a supplier return above
 * the e-way-bill threshold is dispatched first, refused by name (`ewb_required`) unless a GENERATED e-way bill exists for its
 * own movement; the `…/returned` record follows the dispatch and links its EWB number. At or below the threshold nothing
 * changes. The gate is Lane 2's `checkDispatchEwb`. Synthetic receipts.
 */
const AT = '2026-10-18T05:00:00.000Z';
const cost = (minor: number) => ({ minor, currency: 'INR' });
/** A receipt: 'L1' a quarantined line disposed of as a return (qty × ₹unit), plus a rejected over-delivery held on 'L2'. */
function receipt(grnId: string, lineQty: number, excessQty: number, unitMinor: number): GrnRecord {
  return {
    grnId, number: grnId, poId: 'po-1', warehouseId: 'WH', receivedBy: 'u-recv', receivedAt: AT, availableMinor: 0, heldMinor: excessQty,
    captured: {
      receiptId: grnId, discrepancies: [], requiresApproval: false, discrepancyValue: cost(0),
      lines: [
        { lineId: 'L1', productId: 'p-rice', orderedMinor: lineQty, countedMinor: lineQty, uom: 'ea', unitCost: cost(unitMinor), sellableMinor: 0, quarantinedMinor: lineQty, rejectedMinor: 0, heldMinor: 0, batchId: null },
        { lineId: 'L2', productId: 'p-rice', orderedMinor: 0, countedMinor: excessQty, uom: 'ea', unitCost: cost(unitMinor), sellableMinor: 0, quarantinedMinor: 0, rejectedMinor: 0, heldMinor: excessQty, batchId: null },
      ],
    } as unknown as GrnRecord['captured'],
    excessDecision: { decision: 'rejected', decidedBy: 'u-boss', decidedAt: AT, reason: 'over the order', releasedMinor: 0, movementIds: [], via: 'direct' },
    dispositions: [{ lineId: 'L1', productId: 'p-rice', quantityMinor: lineQty, disposition: 'return', decidedBy: 'u-boss', decidedAt: AT, reason: 'damaged', valueMinor: lineQty * unitMinor, currency: 'INR', movementIds: [], via: 'direct' }],
  };
}

function deps(records: GrnRecord[], ewbOf: Map<string, { state: EwbLifecycleState; ewbNo?: string }>, wired = true): GoodsReceiptDeps & { dispatched: SupplierReturnDispatch[]; byId: Map<string, GrnRecord> } {
  const byId = new Map(records.map((r) => [r.grnId, r] as const));
  const dispatched: SupplierReturnDispatch[] = [];
  const d = {
    byId, dispatched, now: () => AT,
    grn: (_t: string, id: string) => byId.get(id),
    commitExcessReturn: (_t: string, r: GrnRecord) => { byId.set(r.grnId, r); },
    commitLineReturn: (_t: string, r: GrnRecord) => { byId.set(r.grnId, r); },
    ...(wired ? {
      supplierReturnEwb: {
        // Intra-State (both ends in Tamil Nadu): the ₹1,00,000 threshold.
        gate: (_t: string, _r: GrnRecord, movementId: string, valueMinor: number) => checkDispatchEwb({ movementId, consignmentValueMinor: valueMinor, unvaluedLines: 0, supplyRoute: 'intra_state', ewb: ewbOf.get(movementId) }),
        dispatches: (_t: string, grnId: string) => dispatched.filter((x) => x.grnId === grnId),
        recordDispatch: (_t: string, x: SupplierReturnDispatch) => { dispatched.push(x); },
      },
    } : {}),
  };
  return d as unknown as GoodsReceiptDeps & { dispatched: SupplierReturnDispatch[]; byId: Map<string, GrnRecord> };
}
const base = { tenantId: 't', branchId: null };

describe('OB-194: a supplier return above the e-way-bill threshold', () => {
  it('at or below the threshold: the return is recorded as before — no dispatch needed; a dispatch, if recorded, says "not required"', async () => {
    // L1: 1,000 × ₹100 = ₹1,00,000 exactly; excess 500 × ₹100 = ₹50,000.
    const d = deps([receipt('g-small', 1_000, 500, 10_000)], new Map());
    expect(await returnDisposedLine(d, { ...base, grnId: 'g-small', lineId: 'L1', returnedBy: 'u-recv', reason: 'van' })).toMatchObject({ ok: true, alreadyReturned: false });
    const ex = await dispatchSupplierReturn(d, { ...base, grnId: 'g-small', target: { kind: 'excess' }, dispatchedBy: 'u-recv', reason: 'van' });
    expect(ex).toMatchObject({ ok: true, dispatch: { outcome: 'not_required', ewbNo: null, valueMinor: 5_000_000 } });
    const back = await returnRejectedExcess(d, { ...base, grnId: 'g-small', returnedBy: 'u-recv', reason: 'van' });
    expect(back.ok && back.record.excessReturn?.dispatch).toMatchObject({ movementId: 'supplier-return-g-small-excess', ewbNo: null });
  });

  it('above it: the return is refused until dispatched; the dispatch is refused by name until a GENERATED e-way bill exists; then both proceed, linking the EWB number', async () => {
    const ewbs = new Map<string, { state: EwbLifecycleState; ewbNo?: string }>();
    const d = deps([receipt('g-big', 1_001, 2_000, 10_000)], ewbs); // L1 ₹1,00,100; excess ₹2,00,000
    const line = supplierReturnEwbMovementId('g-big', { kind: 'line', lineId: 'L1' });
    expect(line).toBe('supplier-return-g-big-line-L1');

    // The returned record before any dispatch: refused, by name, saying why.
    const early = await returnDisposedLine(d, { ...base, grnId: 'g-big', lineId: 'L1', returnedBy: 'u-recv', reason: 'van' });
    expect(early).toMatchObject({ ok: false, refusedBecause: 'supplier_return_not_dispatched' });
    expect(early.ok === false && early.detail).toMatch(/₹1,00,000\.00 e-way-bill threshold/);
    // The dispatch: no e-way bill → ewb_required; pending, rejected, cancelled → still ewb_required, naming the state.
    for (const state of [undefined, 'pending_unknown', 'rejected', 'cancelled'] as const) {
      if (state === undefined) ewbs.delete(line); else ewbs.set(line, { state, ...(state === 'cancelled' ? { ewbNo: '391000000001' } : {}) });
      const r = await dispatchSupplierReturn(d, { ...base, grnId: 'g-big', target: { kind: 'line', lineId: 'L1' }, dispatchedBy: 'u-recv', reason: 'lorry TN-01' });
      expect(r).toMatchObject({ ok: false, refusedBecause: 'ewb_required' });
    }
    expect(d.dispatched).toEqual([]);
    // Generated: it proceeds and links the number; once only.
    ewbs.set(line, { state: 'generated', ewbNo: '391000123456' });
    const ok1 = await dispatchSupplierReturn(d, { ...base, grnId: 'g-big', target: { kind: 'line', lineId: 'L1' }, dispatchedBy: 'u-recv', reason: 'lorry TN-01' });
    expect(ok1).toMatchObject({ ok: true, alreadyDispatched: false, dispatch: { outcome: 'covered', ewbNo: '391000123456', movementId: line, valueMinor: 10_010_000 } });
    expect(await dispatchSupplierReturn(d, { ...base, grnId: 'g-big', target: { kind: 'line', lineId: 'L1' }, dispatchedBy: 'u-recv', reason: 'again' })).toMatchObject({ ok: true, alreadyDispatched: true });
    expect(d.dispatched).toHaveLength(1);
    // The returned record now follows it and carries the EWB number.
    const back = await returnDisposedLine(d, { ...base, grnId: 'g-big', lineId: 'L1', returnedBy: 'u-recv', reason: 'collected' });
    expect(back.ok && back.lineReturn.dispatch).toMatchObject({ ewbNo: '391000123456', movementId: line });
    // A dispatch after the return is recorded is refused; the excess (its own movement) still needs its own e-way bill.
    expect(await dispatchSupplierReturn(d, { ...base, grnId: 'g-big', target: { kind: 'line', lineId: 'L1' }, dispatchedBy: 'u-recv', reason: 'x' })).toMatchObject({ ok: true, alreadyDispatched: true });
    expect(await returnRejectedExcess(d, { ...base, grnId: 'g-big', returnedBy: 'u-recv', reason: 'van' })).toMatchObject({ ok: false, refusedBecause: 'supplier_return_not_dispatched' });
    expect(await dispatchSupplierReturn(d, { ...base, grnId: 'g-big', target: { kind: 'excess' }, dispatchedBy: 'u-recv', reason: 'van' })).toMatchObject({ ok: false, refusedBecause: 'ewb_required' });
  });

  it('only a return a second person decided can be dispatched; unknown receipt and line by name; not after the return; and a surface with no gate cannot dispatch', async () => {
    const r = receipt('g-x', 10, 5, 100);
    const undecided: GrnRecord = { ...r, grnId: 'g-u', dispositions: [] };
    const { excessDecision: _e, ...noDecision } = r; void _e;
    const d = deps([r, undecided, { ...noDecision, grnId: 'g-n' }], new Map());
    expect(await dispatchSupplierReturn(d, { ...base, grnId: 'g-none', target: { kind: 'excess' }, dispatchedBy: 'u', reason: 'x' })).toMatchObject({ ok: false, refusedBecause: 'receipt_unknown' });
    expect(await dispatchSupplierReturn(d, { ...base, grnId: 'g-x', target: { kind: 'line', lineId: 'L9' }, dispatchedBy: 'u', reason: 'x' })).toMatchObject({ ok: false, refusedBecause: 'line_unknown' });
    expect(await dispatchSupplierReturn(d, { ...base, grnId: 'g-u', target: { kind: 'line', lineId: 'L1' }, dispatchedBy: 'u', reason: 'x' })).toMatchObject({ ok: false, refusedBecause: 'line_not_disposed_for_return' });
    expect(await dispatchSupplierReturn(d, { ...base, grnId: 'g-n', target: { kind: 'excess' }, dispatchedBy: 'u', reason: 'x' })).toMatchObject({ ok: false, refusedBecause: 'excess_not_rejected' });
    await returnRejectedExcess(d, { ...base, grnId: 'g-x', returnedBy: 'u', reason: 'van' }); // small: no dispatch needed
    expect(await dispatchSupplierReturn(d, { ...base, grnId: 'g-x', target: { kind: 'excess' }, dispatchedBy: 'u', reason: 'x' })).toMatchObject({ ok: false, refusedBecause: 'supplier_return_already_recorded' });
    const bare = deps([receipt('g-b', 10, 5, 100)], new Map(), false);
    expect(await dispatchSupplierReturn(bare, { ...base, grnId: 'g-b', target: { kind: 'excess' }, dispatchedBy: 'u', reason: 'x' })).toMatchObject({ ok: false, refusedBecause: 'ewb_check_not_available' });
  });

  it('guardrail: the dispatch is refused on the gate\'s own verdict — no override, no caller-supplied number or value', () => {
    const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const src = strip(readFileSync('services/inventory/src/goods-receipt.ts', 'utf8'));
    const fn = src.slice(src.indexOf('export async function dispatchSupplierReturn'), src.indexOf('export type LineDispositionOutcome'));
    expect(fn).toContain("if (verdict.outcome === 'refused') return { ok: false, refusedBecause: 'ewb_required'");
    for (const bypass of ['override', 'force', 'ewbNo: input', 'valueMinor: input']) expect(fn).not.toContain(bypass);
    const followed = src.slice(src.indexOf('async function dispatchFollowed'), src.indexOf('export type ReturnDispatchOutcome'));
    expect(followed).toContain("if (verdict.outcome === 'not_required') return { ok: true };");
  });
});
