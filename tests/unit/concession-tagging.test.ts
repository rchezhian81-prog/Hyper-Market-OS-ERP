import { describe, it, expect } from 'vitest';
import {
  captureConcessionTag,
  captureConcessionTagIdempotent,
  reverseConcessionTag,
  adjustConcessionTag,
  markSettlementStatus,
  concessionTagTotals,
  mayCorrectConcessionTag,
  type CaptureInput,
  type CommissionSchemeSnapshot,
  type ConcessionTag,
} from '../../packages/concession/src/index';

// Till-side concession tagging (M27, owner decision) — sale + line-item capture: which partner, counter,
// scheme, till/shift, product/qty, gross/discount/tax/net/commission; idempotent capture from an approved
// source by a cashier; supervisor-only correction by reversal/adjustment (never a silent rewrite, hard
// rule #2 / SoD §28); returns/cancellations linked; append-only audit; totals feed settlement.

const scheme = (over: Partial<CommissionSchemeSnapshot> = {}): CommissionSchemeSnapshot => ({
  contractId: 'ct-1',
  basis: 'revenue_share',
  commissionOn: 'gross',
  revenueShareBps: 1_500, // 15%
  ...over,
});

const capture = (over: Partial<CaptureInput> = {}): CaptureInput => ({
  tenantId: 't1',
  tagId: 'tag-1',
  kind: 'sale',
  saleId: 'sale-1',
  lineId: 'line-1',
  concessionaireId: 'jeweller-1',
  counterId: 'counter-gold',
  branchId: 'br-1',
  tillId: 'till-3',
  shiftId: 'shift-a',
  productId: 'ring-22k',
  qty: 1,
  grossMinor: 100_000, // ₹1,000.00
  discountMinor: 0,
  taxMinor: 3_000,
  scheme: scheme(),
  capturedBy: 'cashier-anita',
  byRole: 'cashier',
  source: 'docket-8842',
  idempotencyKey: 'till-3:sale-1:line-1',
  at: '2026-09-25T10:00:00.000Z',
  ...over,
});

describe('captureConcessionTag — the till-side line capture (M27, owner decision)', () => {
  it('captures every field the owner asked for, nets discount and computes commission on the snapshot', () => {
    const tag = captureConcessionTag(capture({ grossMinor: 100_000, discountMinor: 20_000 }));
    expect(tag).toMatchObject({
      concessionaireId: 'jeweller-1', contractId: 'ct-1', counterId: 'counter-gold',
      branchId: 'br-1', tillId: 'till-3', shiftId: 'shift-a', productId: 'ring-22k', qty: 1,
      grossMinor: 100_000, discountMinor: 20_000, netMinor: 80_000, taxMinor: 3_000,
      capturedBy: 'cashier-anita', source: 'docket-8842', settlementStatus: 'pending',
    });
    // commission on GROSS at 15% = 15_000
    expect(tag.commissionBaseMinor).toBe(100_000);
    expect(tag.commissionMinor).toBe(15_000);
    expect(tag.history).toHaveLength(1);
    expect(tag.history[0]).toMatchObject({ op: 'captured', by: 'cashier-anita', byRole: 'cashier', source: 'docket-8842' });
  });

  it('can take commission on NET when the scheme says so', () => {
    const tag = captureConcessionTag(capture({ grossMinor: 100_000, discountMinor: 20_000, scheme: scheme({ commissionOn: 'net' }) }));
    expect(tag.commissionBaseMinor).toBe(80_000);
    expect(tag.commissionMinor).toBe(12_000); // 15% of 80_000
  });

  it('a fixed_rent scheme carries no per-line commission (it settles at the period level)', () => {
    const tag = captureConcessionTag(capture({ scheme: scheme({ basis: 'fixed_rent', revenueShareBps: undefined }) }));
    expect(tag.commissionMinor).toBe(0);
  });

  it('exact integer money — a busy counter does not drift by a paisa', () => {
    // 15% of 33_337 = 5000.55 → floors to 5_000 (BigInt division), never a float
    const tag = captureConcessionTag(capture({ grossMinor: 33_337 }));
    expect(tag.commissionMinor).toBe(5_000);
  });
});

describe('captureConcessionTagIdempotent — a resend or double-scan never charges twice', () => {
  it('captures the first time and returns the SAME tag on a repeat idempotency key', () => {
    const first = captureConcessionTagIdempotent(capture(), []);
    expect(first.captured).toBe(true);
    const stream = [first.tag!];
    const again = captureConcessionTagIdempotent(capture({ tagId: 'tag-DIFFERENT' }), stream);
    expect(again.captured).toBe(false);
    expect(again.refusal).toBe('duplicate_idempotency_key');
    expect(again.existing?.tagId).toBe('tag-1'); // the original, not the resend
  });

  it('a different idempotency key is a different capture', () => {
    const first = captureConcessionTagIdempotent(capture(), []);
    const other = captureConcessionTagIdempotent(capture({ tagId: 'tag-2', idempotencyKey: 'till-3:sale-1:line-2', lineId: 'line-2' }), [first.tag!]);
    expect(other.captured).toBe(true);
  });

  it('isolates idempotency by tenant', () => {
    const mine = captureConcessionTag(capture());
    const theirs: ConcessionTag = { ...captureConcessionTag(capture()), tenantId: 't2' };
    const res = captureConcessionTagIdempotent(capture({ tenantId: 't1' }), [theirs]);
    expect(res.captured).toBe(true); // t2's identical key does not block t1
    expect(mine.tenantId).toBe('t1');
  });
});

describe('separation of duties + never-rewrite (SoD §28, hard rule #2)', () => {
  it('a cashier may capture but may NOT correct; a supervisor may correct', () => {
    expect(mayCorrectConcessionTag('cashier')).toBe(false);
    expect(mayCorrectConcessionTag('supervisor')).toBe(true);
    expect(mayCorrectConcessionTag('store_manager')).toBe(true);
  });

  it('a cashier reversal is refused, and the refusal is RECORDED on the original (never silent)', () => {
    const tag = captureConcessionTag(capture());
    const res = reverseConcessionTag({ original: tag, newTagId: 'rev-1', by: 'cashier-anita', byRole: 'cashier', reasonCode: 'WRONG-COUNTER', now: '2026-09-25T10:05:00.000Z' });
    expect(res.corrected).toBe(false);
    expect(res.refusal).toBe('not_permitted_for_role');
    expect(res.correction).toBeUndefined();
    expect(res.original.history.at(-1)).toMatchObject({ op: 'correct_refused', by: 'cashier-anita', byRole: 'cashier' });
    // the original money is untouched — nothing was rewritten
    expect(res.original.grossMinor).toBe(100_000);
  });

  it('a supervisor reversal emits a NEW negated tag naming the original, and records it on the original', () => {
    const tag = captureConcessionTag(capture({ grossMinor: 100_000, discountMinor: 20_000 }));
    const res = reverseConcessionTag({ original: tag, newTagId: 'rev-1', by: 'sup-ravi', byRole: 'supervisor', reasonCode: 'WRONG-COUNTER', now: '2026-09-25T10:05:00.000Z' });
    expect(res.corrected).toBe(true);
    expect(res.correction).toMatchObject({
      tagId: 'rev-1', kind: 'reversal', correctsTagId: 'tag-1',
      grossMinor: -100_000, discountMinor: -20_000, netMinor: -80_000, commissionMinor: -15_000,
    });
    // original preserved, correction recorded on its history
    expect(res.original.grossMinor).toBe(100_000);
    expect(res.original.history.at(-1)).toMatchObject({ op: 'reversed', by: 'sup-ravi' });
  });

  it('a tag already reversed cannot be reversed again', () => {
    const tag = captureConcessionTag(capture());
    const res = reverseConcessionTag({ original: tag, newTagId: 'rev-2', by: 'sup-ravi', byRole: 'supervisor', reasonCode: 'DUP', now: '2026-09-25T10:06:00.000Z', alreadyReversed: true });
    expect(res.corrected).toBe(false);
    expect(res.refusal).toBe('already_corrected_by_reversal');
  });

  it('a supervisor adjustment emits a compensating DELTA tag with recomputed commission', () => {
    const tag = captureConcessionTag(capture({ grossMinor: 100_000 }));
    const res = adjustConcessionTag({ original: tag, newTagId: 'adj-1', by: 'sup-ravi', byRole: 'supervisor', grossDeltaMinor: -10_000, discountDeltaMinor: 0, taxDeltaMinor: -300, reasonCode: 'PRICE-FIX', now: '2026-09-25T10:07:00.000Z' });
    expect(res.corrected).toBe(true);
    expect(res.correction).toMatchObject({ tagId: 'adj-1', kind: 'adjustment', correctsTagId: 'tag-1', grossMinor: -10_000, netMinor: -10_000, commissionMinor: -1_500 });
    expect(res.original.history.at(-1)).toMatchObject({ op: 'adjusted', by: 'sup-ravi' });
  });

  it('a cashier adjustment is refused and recorded', () => {
    const tag = captureConcessionTag(capture());
    const res = adjustConcessionTag({ original: tag, newTagId: 'adj-x', by: 'cashier-anita', byRole: 'cashier', grossDeltaMinor: -10_000, discountDeltaMinor: 0, taxDeltaMinor: 0, reasonCode: 'X', now: '2026-09-25T10:08:00.000Z' });
    expect(res.corrected).toBe(false);
    expect(res.refusal).toBe('not_permitted_for_role');
    expect(res.original.history.at(-1)).toMatchObject({ op: 'correct_refused' });
  });
});

describe('returns / cancellations are linked, and settlement status is set not guessed', () => {
  it('a return carries negative money, names the sale it reverses, and nets commission out', () => {
    const ret = captureConcessionTag(capture({ tagId: 'tag-ret', kind: 'return', grossMinor: -100_000, taxMinor: -3_000, correctsTagId: 'tag-1', idempotencyKey: 'till-3:sale-1:line-1:return' }));
    expect(ret.kind).toBe('return');
    expect(ret.correctsTagId).toBe('tag-1');
    expect(ret.commissionMinor).toBe(-15_000); // sign preserved
  });

  it('markSettlementStatus advances the status and records it (append-only)', () => {
    const tag = captureConcessionTag(capture());
    const marked = markSettlementStatus(tag, 'included_in_charge', 'settle-run', 'store_manager', '2026-09-26T00:00:00.000Z');
    expect(marked.settlementStatus).toBe('included_in_charge');
    expect(marked.history.at(-1)).toMatchObject({ op: 'settlement_marked', detail: 'settlement included_in_charge' });
  });
});

describe('concessionTagTotals — folds tags into settlement figures, netting reversals/returns', () => {
  it('sums gross/net/commission for a concession over a window, with a return netted out', () => {
    const sale = captureConcessionTag(capture({ tagId: 't-sale', grossMinor: 100_000, discountMinor: 0, taxMinor: 3_000 }));
    const ret = captureConcessionTag(capture({ tagId: 't-ret', kind: 'return', grossMinor: -40_000, taxMinor: -1_200, correctsTagId: 't-sale', idempotencyKey: 'k-ret' }));
    const totals = concessionTagTotals({ tags: [sale, ret], tenantId: 't1', concessionaireId: 'jeweller-1', from: '2026-09-25', to: '2026-09-25' });
    expect(totals.tags).toBe(2);
    expect(totals.grossMinor).toBe(60_000);
    expect(totals.netMinor).toBe(60_000);
    expect(totals.commissionMinor).toBe(9_000); // 15_000 - 6_000
  });

  it('scopes to tenant and concessionaire, and excludes tags outside the window', () => {
    const mine = captureConcessionTag(capture({ tagId: 'a', at: '2026-09-25T10:00:00.000Z' }));
    const otherPartner = captureConcessionTag(capture({ tagId: 'b', concessionaireId: 'mobile-kiosk', at: '2026-09-25T11:00:00.000Z' }));
    const outOfWindow = captureConcessionTag(capture({ tagId: 'c', at: '2026-09-20T10:00:00.000Z', idempotencyKey: 'k-c' }));
    const totals = concessionTagTotals({ tags: [mine, otherPartner, outOfWindow], tenantId: 't1', concessionaireId: 'jeweller-1', from: '2026-09-25', to: '2026-09-25' });
    expect(totals.tags).toBe(1);
    expect(totals.grossMinor).toBe(100_000);
  });
});
