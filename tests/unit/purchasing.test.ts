import { describe, it, expect } from 'vitest';
import {
  issuePurchaseOrder,
  computeOpenCommitment,
  EmptyPurchaseOrderError,
  BlockedSupplierError,
  ApprovalRequiredError,
  InvalidPurchaseOrderLineError,
} from '../../packages/purchasing/src/index';
import { money } from '../../packages/contracts/src/money';
import { requestApproval, decide, type Approver } from '../../packages/approvals/src/index';

// A PO is an approved commitment: separation of duties, unblocked supplier, and an
// open commitment that reconciles to receipts (M06-FR-02/04).

const AT = '2026-08-02T20:00:00Z';

function lines() {
  return [
    { productId: 'p1', orderedQty: 10, unitCost: money(50_00, 'INR') },
    { productId: 'p2', orderedQty: 4, unitCost: money(25_00, 'INR') },
  ];
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'po-1',
    number: 'PO-0001',
    supplierId: 'sup-1',
    requisitionedBy: 'buyer-1',
    at: AT,
    lines: lines(),
    ...overrides,
  };
}

function approvalFor(subjectRef: string, by = 'manager-9') {
  const req = requestApproval({
    id: subjectRef,
    subjectType: 'purchase_order',
    subjectRef,
    requestedBy: 'requester-0',
    value: money(600_00, 'INR'),
  });
  const approver: Approver = { userId: by, branchScope: 'all', authorityLimit: null };
  const outcome = decide(req, approver, 'approved', 'within budget', AT);
  if (!outcome.ok) throw new Error('expected approval');
  return outcome.request;
}

describe('issuePurchaseOrder', () => {
  it('issues a PO with a valid separate approval and totals the lines', () => {
    const po = issuePurchaseOrder(baseInput({ approval: approvalFor('po-1') }));
    expect(po.status).toBe('issued');
    expect(po.total).toEqual(money(600_00, 'INR')); // 10×50 + 4×25 = 500 + 100
    expect(po.approvedBy).toBe('manager-9');
  });

  it('blocks a PO without approval', () => {
    expect(() => issuePurchaseOrder(baseInput())).toThrow(ApprovalRequiredError);
  });

  it('blocks a self-approved PO (requisitioner cannot approve) (§28)', () => {
    const selfApproval = approvalFor('po-1', 'buyer-1'); // same as requisitionedBy
    expect(() => issuePurchaseOrder(baseInput({ approval: selfApproval }))).toThrow(
      ApprovalRequiredError,
    );
  });

  it('blocks a PO to a blocked supplier', () => {
    expect(() =>
      issuePurchaseOrder(baseInput({ supplierBlocked: true, approval: approvalFor('po-1') })),
    ).toThrow(BlockedSupplierError);
  });

  it('rejects an empty PO and an invalid line quantity', () => {
    expect(() => issuePurchaseOrder(baseInput({ lines: [], approval: approvalFor('po-1') }))).toThrow(
      EmptyPurchaseOrderError,
    );
    expect(() =>
      issuePurchaseOrder(
        baseInput({
          lines: [{ productId: 'p1', orderedQty: 0, unitCost: money(50_00, 'INR') }],
          approval: approvalFor('po-1'),
        }),
      ),
    ).toThrow(InvalidPurchaseOrderLineError);
  });
});

describe('computeOpenCommitment', () => {
  it('computes open = ordered − received − cancelled, valued at unit cost', () => {
    const oc = computeOpenCommitment(lines(), { p1: 6 }, { p2: 1 });
    const p1 = oc.lines.find((l) => l.productId === 'p1');
    const p2 = oc.lines.find((l) => l.productId === 'p2');
    expect(p1?.openQty).toBe(4); // 10 − 6 − 0
    expect(p1?.openValue).toEqual(money(200_00, 'INR')); // 4 × 50
    expect(p2?.openQty).toBe(3); // 4 − 0 − 1
    expect(oc.totalOpenValue).toEqual(money(275_00, 'INR')); // 200 + 75
    expect(oc.fullyReceived).toBe(false);
  });

  it('is fully received when nothing remains open', () => {
    const oc = computeOpenCommitment(lines(), { p1: 10, p2: 4 });
    expect(oc.fullyReceived).toBe(true);
    expect(oc.totalOpenValue).toEqual(money(0, 'INR'));
  });

  it('signals over-receipt as a negative open quantity', () => {
    const oc = computeOpenCommitment(lines(), { p1: 12 }); // received more than ordered
    const p1 = oc.lines.find((l) => l.productId === 'p1');
    expect(p1?.openQty).toBe(-2);
  });
});
