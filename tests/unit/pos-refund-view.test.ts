import { describe, it, expect, vi } from 'vitest';
import { createTillSession, type DurableReturnWrite } from '../../apps/pos/src/till-session';
import { createRefundView, type RefundDraft, type RefundCall } from '../../apps/pos/src/refund-view';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';
import type { OriginalSale, RecordedReturn } from '../../packages/returns/src/return-register';
import type { CommitReturnInput } from '../../packages/returns/src/returns';
import type { DecidedRequest } from '../../packages/approvals/src/approvals';

/**
 * **M13 · §27 "Return/exchange" — the refund screen's tested view surface.**
 *
 * The bridge is thin on purpose: it converts the cashier's display-primitive choices into the
 * engine's typed input, and converts every engine outcome — including the four money-critical error
 * types — into ONE plain-English screen state. It holds no money rule of its own; the rules stay in
 * `packages/returns` and `till.refund`, exercised here through the REAL till so the whole chain is
 * proven, not a fake of it. Synthetic data only (hard rule #7).
 */

const NOW = '2026-08-05T11:00:00Z';

const okDurable: DurableReturnWrite = async () => ({ committed: true, durable: true, detail: 'on disk', laneMessage: 'ok' });
const durableReturning = (outcome: Awaited<ReturnType<DurableReturnWrite>>): DurableReturnWrite => async () => outcome;

const till = (durable: DurableReturnWrite = okDurable) => createTillSession(
  { tillId: 'till-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-08-05', varianceToleranceMinor: 10_000 },
  new Ledger(new InMemoryLedgerStore()), new Ledger(new InMemoryLedgerStore()), new SyncOutbox(), durable,
);

// A ₹200 bill: two of P1, one of P2.
const SALE: OriginalSale = {
  saleId: 'S-1', number: 'B-1', tradingDay: '2026-08-05', committedAt: '2026-08-05T10:00:00Z',
  totalMinor: 20_000,
  lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 2 }, { productId: 'P2', uom: 'ea', quantityMinor: 1 }],
};

const view = (deps: {
  refund: RefundCall;
  approvalThresholdMinor?: number;
  noReceiptCapMinor?: number;
  priorReturns?: readonly RecordedReturn[];
  priorRefunds?: readonly { returnId: string; originalSaleId: string | null; refundMinor: number }[];
}) => createRefundView({
  refund: deps.refund,
  now: () => NOW,
  policy: {
    approvalThresholdMinor: deps.approvalThresholdMinor ?? 100_000, // ₹1,000 unless a test lowers it
    ...(deps.noReceiptCapMinor === undefined ? {} : { noReceiptCapMinor: deps.noReceiptCapMinor }),
  },
  ...(deps.priorReturns === undefined ? {} : { priorReturns: deps.priorReturns }),
  ...(deps.priorRefunds === undefined ? {} : { priorRefunds: deps.priorRefunds }),
});

const draft = (over: Partial<RefundDraft> = {}): RefundDraft => ({
  returnId: 'R-1', number: 'RET-1', originalSale: SALE, reasonCode: 'damaged',
  lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
  refundMinor: 10_000, refundTender: 'cash',
  ...over,
});

describe('what may come back, and how much money is left (display, from history)', () => {
  it('shows returnable per product as sold minus what already came back', () => {
    const priorReturns: RecordedReturn[] = [{
      returnId: 'R-old', originalSaleId: 'S-1', processedAt: '2026-08-05T10:30:00Z',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1 }],
    }];
    const v = view({ refund: okTill().refund, priorReturns });
    const p1 = v.returnable(SALE).find((l) => l.productId === 'P1')!;
    expect(p1.soldMinor).toBe(2);
    expect(p1.alreadyReturnedMinor).toBe(1);
    expect(p1.returnableMinor).toBe(1);
  });

  it('caps the refund at what is left of what was paid', () => {
    const v = view({ refund: okTill().refund, priorRefunds: [{ returnId: 'R-old', originalSaleId: 'S-1', refundMinor: 5_000 }] });
    expect(v.maxRefundMinor(SALE)).toBe(15_000); // ₹200 paid − ₹50 already refunded
  });
});

// A till whose durable write always confirms, reused where the outcome is not the point.
function okTill() { return till(); }

describe('a refund the cashier can complete', () => {
  it('settles a receipted cash refund → hand it over', async () => {
    const out = await view({ refund: okTill().refund }).submit(draft());
    expect(out.kind).toBe('settled');
    if (out.kind === 'settled') {
      expect(out.refundMinor).toBe(10_000);
      expect(out.number).toBe('RET-1');
      expect(out.laneMessage).toMatch(/hand over/i);
    }
  });

  it('leaves a CARD refund pending — money has not moved yet (M13-FR-04)', async () => {
    const out = await view({ refund: okTill().refund }).submit(draft({ refundTender: 'card' }));
    expect(out.kind).toBe('pending');
    if (out.kind === 'pending') expect(out.laneMessage).toMatch(/pending|do not hand over/i);
  });
});

describe('the money-critical outcomes keep the model\'s own words', () => {
  it('a lost reply is UNCERTAIN, never a definite failure (RR-F02)', async () => {
    const t = till(durableReturning({
      committed: false, unconfirmed: true, refusedBecause: 'could_not_write_durably',
      detail: 'no answer', laneMessage: 'Could not confirm the refund saved. Do NOT hand back cash and do NOT run it again.',
    }));
    const out = await view({ refund: t.refund }).submit(draft());
    expect(out.kind).toBe('uncertain');
    expect(out.laneMessage).toMatch(/do not run it again/i);
  });

  it('a reused id for different money is a CONFLICT (RR-F03)', async () => {
    const t = till(durableReturning({
      committed: false, refusedBecause: 'idempotency_conflict', detail: 'reused',
      laneMessage: 'This refund ID was already used for a different refund.',
    }));
    const out = await view({ refund: t.refund }).submit(draft());
    expect(out.kind).toBe('conflict');
    expect(out.laneMessage).toMatch(/already used/i);
  });

  it('an over-return reported by the edge is NOT_ENTITLED (RR-F04)', async () => {
    const t = till(durableReturning({
      committed: false, refusedBecause: 'over_return', detail: 'already returned',
      laneMessage: 'These goods were already returned.',
    }));
    const out = await view({ refund: t.refund }).submit(draft());
    expect(out.kind).toBe('not_entitled');
    expect(out.laneMessage).toMatch(/already returned/i);
  });

  it('a durable-write refusal is REFUSED — no cash leaves the drawer', async () => {
    const t = till(durableReturning({
      committed: false, refusedBecause: 'could_not_write_durably', detail: 'disk full',
      laneMessage: 'This lane cannot record a refund right now.',
    }));
    const out = await view({ refund: t.refund }).submit(draft());
    expect(out.kind).toBe('refused');
    expect(out.laneMessage).toMatch(/cannot record/i);
  });
});

describe('the rules the engine enforces, surfaced as screen states', () => {
  it('a refund with no approver is APPROVAL_REQUIRED at the default threshold of 0 (§28)', async () => {
    // threshold 0 → every positive refund needs a separate approver; none supplied.
    const out = await view({ refund: okTill().refund, approvalThresholdMinor: 0 }).submit(draft());
    expect(out.kind).toBe('approval_required');
    expect(out.laneMessage).toMatch(/manager/i);
  });

  it('a refund above what the bill allows is INVALID (M13-FR-03)', async () => {
    const out = await view({ refund: okTill().refund }).submit(draft({ refundMinor: 30_000 })); // > ₹200 paid
    expect(out.kind).toBe('invalid');
    expect(out.laneMessage).toMatch(/more than this bill allows/i);
  });

  it('returning more than is left on the bill is NOT_ENTITLED (at-most-once, from history)', async () => {
    // Both units of P1 already came back; another one is an over-return caught before any write.
    const priorReturns: RecordedReturn[] = [{
      returnId: 'R-old', originalSaleId: 'S-1', processedAt: '2026-08-05T10:30:00Z',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 2 }],
    }];
    const out = await view({ refund: okTill().refund, priorReturns }).submit(draft({ refundMinor: 5_000 }));
    expect(out.kind).toBe('not_entitled');
  });

  it('an empty return and a missing reason are INVALID', async () => {
    const v = view({ refund: okTill().refund });
    expect((await v.submit(draft({ lines: [] }))).kind).toBe('invalid');
    expect((await v.submit(draft({ reasonCode: '' }))).kind).toBe('invalid');
  });
});

describe('no-receipt returns are fail-safe when the cap is not configured', () => {
  it('refuses a no-receipt refund up front and NEVER calls the till when no cap is set', async () => {
    const refund = vi.fn<RefundCall>(okTill().refund);
    const out = await view({ refund }).submit(draft({ noReceipt: true, originalSale: undefined }));
    expect(out.kind).toBe('invalid');
    expect(out.laneMessage).toMatch(/not set up/i);
    expect(refund).not.toHaveBeenCalled(); // nothing reached the money path
  });

  it('needsApproval is always true for a no-receipt return, whatever the amount (§28)', () => {
    const v = view({ refund: okTill().refund, noReceiptCapMinor: 10_000, approvalThresholdMinor: 100_000 });
    expect(v.needsApproval(draft({ noReceipt: true, originalSale: undefined, refundMinor: 1 }))).toBe(true);
  });

  it('completes a no-receipt cash refund with a cap and a separate approver', async () => {
    const approval: DecidedRequest = {
      id: 'ap-1', subjectType: 'pos.return', subjectRef: 'R-nr', requestedBy: 'u-meena',
      branchId: null, value: null, status: 'approved', decidedBy: 'u-manager', reason: 'no receipt, checked',
      decidedAt: NOW,
    };
    const out = await view({ refund: okTill().refund, noReceiptCapMinor: 10_000 }).submit(draft({
      returnId: 'R-nr', number: 'RET-nr', noReceipt: true, originalSale: undefined, refundMinor: 5_000, approval,
    }));
    expect(out.kind).toBe('settled');
  });
});

describe('needsApproval mirrors the engine threshold (one source of the rule)', () => {
  it('is false below the threshold and true at/above it', () => {
    const v = view({ refund: okTill().refund, approvalThresholdMinor: 20_000 });
    expect(v.needsApproval(draft({ refundMinor: 19_999 }))).toBe(false);
    expect(v.needsApproval(draft({ refundMinor: 20_000 }))).toBe(true);
  });

  it('a zero-value refund is never material', () => {
    const v = view({ refund: okTill().refund, approvalThresholdMinor: 0 });
    expect(v.needsApproval(draft({ refundMinor: 0 }))).toBe(false);
  });
});

describe('the surface holds no money rule of its own', () => {
  it('passes the engine a maxRefund from history and the amount verbatim, and never throws', async () => {
    let captured: Omit<CommitReturnInput, 'laneId' | 'processedBy'> | undefined;
    const refund: RefundCall = async (input) => {
      captured = input;
      return { id: input.id, number: input.number, originalSaleId: input.originalSaleId, noReceipt: false,
        refund: input.refund, refundTender: input.refundTender, refundStatus: 'settled',
        requiredApproval: false, restockedLines: 1, processedAt: input.processedAt };
    };
    await view({ refund, priorRefunds: [{ returnId: 'R-old', originalSaleId: 'S-1', refundMinor: 5_000 }] })
      .submit(draft());
    expect(captured).toBeDefined();
    expect(captured!.refund).toEqual(money(10_000, 'INR'));
    expect(captured!.maxRefund).toEqual(money(15_000, 'INR')); // ₹200 paid − ₹50 already refunded
    expect(captured!.originalSaleId).toBe('S-1');
    // Line facts come from the bill/history, not from what the screen supplied.
    expect(captured!.lines[0]).toMatchObject({ productId: 'P1', originalQtyMinor: 2, alreadyReturnedMinor: 0 });
  });

  it('treats an unexpected error as a refusal — the safe reading for money out', async () => {
    const refund: RefundCall = async () => { throw new Error('something odd'); };
    const out = await view({ refund }).submit(draft());
    expect(out.kind).toBe('refused');
    expect(out.laneMessage).toMatch(/do not hand over cash/i);
  });
});
