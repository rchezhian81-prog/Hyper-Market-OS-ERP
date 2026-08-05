import { describe, it, expect } from 'vitest';
import {
  acceptFiledReturn, reconcileTaxPeriod, taxPosition, taxOf, STATUTORY_SLABS_BPS,
  type FiledReturn, type TaxSlabLine,
} from '../../packages/migration/src/tax-verification';
import * as taxModule from '../../packages/migration/src/tax-verification';

// MG-06, OB-06, §34 — proving the migrated tax against returns already filed. The only check that
// runs backwards: the return is true as a matter of law, so the books are what must move.

/** An intra-state slab, with the tax following from the rate. */
const slab = (rateBps: number, taxableValueMinor: number): TaxSlabLine => {
  const half = Math.round((taxableValueMinor * rateBps) / 20_000);
  return { rateBps, taxableValueMinor, cgstMinor: half, sgstMinor: half, igstMinor: 0, cessMinor: 0 };
};

const LINES: readonly TaxSlabLine[] = [slab(0, 4_000_000), slab(500, 2_000_000), slab(1_200, 800_000), slab(1_800, 500_000)];

const filed = (over: Partial<FiledReturn> = {}): FiledReturn => ({
  period: '2026-04', kind: 'gstr1', gstin: '33AABCS1429B1ZQ',
  filedOn: '2026-05-11', acknowledgementRef: 'AA330426012345X',
  lines: LINES, ...over,
});

const reconcile = (over: Partial<Parameters<typeof reconcileTaxPeriod>[0]> = {}) =>
  reconcileTaxPeriod({
    period: '2026-04',
    gstr1: filed(),
    gstr3b: filed({ kind: 'gstr3b', acknowledgementRef: 'AB330426099999Y' }),
    books: LINES,
    ...over,
  });

const at = (r: ReturnType<typeof reconcile>, rateBps: number) => r.slabs.find((s) => s.rateBps === rateBps)!;

describe('what makes a return evidence at all', () => {
  it('REFUSES a return with no acknowledgement reference', () => {
    // A spreadsheet named GSTR1_April.xlsx is a working paper. The ARN is the only thing that
    // separates what was filed from what somebody prepared — and they differ exactly when it
    // matters.
    const a = acceptFiledReturn(filed({ acknowledgementRef: '   ' }));
    expect(a.ok).toBe(false);
    expect(a.refusedBecause).toBe('no_acknowledgement_reference');
    expect(a.detail).toContain('the difference between prepared and filed');
  });

  it('REFUSES a part period, which is short by design and looks like missing sales', () => {
    const a = acceptFiledReturn(filed({ period: '2026-04-01' }));
    expect(a.ok).toBe(false);
    expect(a.refusedBecause).toBe('not_a_whole_tax_period');
  });

  it('REFUSES a return that a later period restated', () => {
    // Reconciling to the superseded original gives a wrong answer with a flawless audit trail
    // behind it, which is the worst combination available.
    const a = acceptFiledReturn(filed({ amendedInPeriod: '2026-07' }));
    expect(a.ok).toBe(false);
    expect(a.refusedBecause).toBe('superseded_by_an_amendment');
    expect(a.detail).toContain('use the amended figures');
  });

  it('REFUSES a return whose own arithmetic does not hold', () => {
    const broken = filed({ lines: [{ ...slab(1_800, 500_000), cgstMinor: 90_000, sgstMinor: 90_000 }] });
    const a = acceptFiledReturn(broken);
    expect(a.ok).toBe(false);
    expect(a.refusedBecause).toBe('tax_does_not_follow_from_the_slab');
    expect(a.detail).toContain('spread the error through every opening figure');
  });

  it('REFUSES a line carrying both IGST and CGST, which would double-count', () => {
    const both = filed({ lines: [{ ...slab(1_800, 500_000), igstMinor: 90_000 }] });
    expect(acceptFiledReturn(both).refusedBecause).toBe('both_igst_and_cgst_on_one_line');
  });

  it('REFUSES an empty return, so a nil filing is distinguishable from an untranscribed one', () => {
    const a = acceptFiledReturn(filed({ lines: [] }));
    expect(a.refusedBecause).toBe('no_lines');
    expect(a.detail).toContain('nobody transcribed it');
  });

  it('allows the statutory rounding, and only the statutory rounding', () => {
    // 5,00,000 at 18% is 90,000 exactly. A return rounding each component to the rupee lands a
    // little either side of that and is fine; anything past the allowance is a different figure,
    // not a rounded one.
    const off = (by: number): FiledReturn => filed({
      lines: [{ ...slab(1_800, 500_000), cgstMinor: 45_000 + by, sgstMinor: 45_000 }],
    });
    expect(taxOf(off(0).lines[0]!)).toBe(90_000);
    expect(acceptFiledReturn(off(50)).ok).toBe(true);
    expect(acceptFiledReturn(off(100)).ok).toBe(true);
    expect(acceptFiledReturn(off(101)).refusedBecause).toBe('tax_does_not_follow_from_the_slab');
    // And the allowance itself is configurable, not a constant somebody has to argue with.
    expect(acceptFiledReturn(off(101), 500).ok).toBe(true);
  });

  it('accepts a properly filed return and says what makes it acceptable', () => {
    const a = acceptFiledReturn(filed());
    expect(a.ok).toBe(true);
    expect(a.detail).toContain('AA330426012345X');
    expect(a.detail).toContain('its own arithmetic holds slab by slab');
  });
});

describe('a slab rate is never inferred from a total', () => {
  it('REFUSES a books line at a rate nothing could have been sold at', () => {
    // 4,00,000 at 0%, 20,000 at 5%... blended across the basket comes out near 3.1%. Right in
    // total, wrong on every line, and wrong in the way the department checks automatically.
    const r = reconcile({ books: [slab(310, 7_300_000)] });
    expect(r.accepted).toBe(false);
    expect(r.refusedBecause).toBe('a_rate_that_is_not_a_slab');
    expect(r.detail).toContain('not a rate anything could have been sold at');
    expect(r.slabs).toEqual([]);
  });

  it('lets a tenant declare its own slabs, because rates move and shops differ', () => {
    // OB-05: this is not written for one shop in one tax regime.
    expect(STATUTORY_SLABS_BPS).toContain(500);
    expect(STATUTORY_SLABS_BPS).toContain(2_800);
    const r = reconcile({ books: [slab(310, 7_300_000)], permittedSlabsBps: [310] });
    expect(r.refusedBecause).toBeUndefined();
  });

  it('offers no entry point anywhere in the module that takes a total and a rate', () => {
    // Absence as a control: the moment such a function exists, somebody reconciles a hypermarket's
    // mixed basket at an average rate. Read off the module's real exports, not a list written
    // here — a list written here would still pass after somebody added one.
    const exported = Object.keys(taxModule);
    expect(exported).toContain('reconcileTaxPeriod');
    for (const name of exported) {
      expect(name).not.toMatch(/blend|average|effectiveRate|inferRate|estimateRate/i);
    }
  });
});

describe('the books are what must move', () => {
  it('reconciles a period that ties slab by slab', () => {
    const r = reconcile();
    expect(r.accepted).toBe(true);
    expect(r.reconciles).toBe(true);
    expect(r.booksMustMoveByMinor).toBe(0);
    expect(r.disclosureRequired).toBe(false);
    expect(r.ownerAction).toBe('nothing — the filed returns confirm the tax figures');
  });

  it('points the correction at the books, never at the return', () => {
    // The return is dated, acknowledged and cannot be adjusted to make a total come out.
    const r = reconcile({ books: [slab(0, 4_000_000), slab(500, 1_900_000), slab(1_200, 800_000), slab(1_800, 500_000)] });
    expect(r.reconciles).toBe(false);
    expect(at(r, 500).status).toBe('books_differ');
    expect(at(r, 500).taxableDifferenceMinor).toBe(-100_000);
    expect(at(r, 500).detail).toContain('The return cannot be changed, so the books move by');
    expect(r.booksMustMoveByMinor).toBe(5_000); // 5% of the missing 1,00,000
    expect(r.ownerAction).toContain('it is the books that are wrong');
  });

  it('treats a difference against a filed return as a DISCLOSURE, not a data fix', () => {
    // Somebody signed that return. Quietly adjusting to meet it is not ours to do.
    const r = reconcile({ books: [slab(0, 4_000_000), slab(500, 1_900_000), slab(1_200, 800_000), slab(1_800, 500_000)] });
    expect(r.disclosureRequired).toBe(true);
  });

  it('calls out a rate we traded at that no return declares', () => {
    const r = reconcile({ books: [...LINES, slab(2_800, 300_000)] });
    expect(r.slabsNeverDeclared).toEqual([2_800]);
    expect(at(r, 2_800).status).toBe('missing_from_the_return');
    expect(at(r, 2_800).detail).toContain('it is undeclared turnover');
    expect(r.ownerAction).toContain('not ours to correct quietly');
  });

  it('calls out a slab the return declares and the extraction lost', () => {
    const r = reconcile({ books: LINES.filter((l) => l.rateBps !== 1_200) });
    expect(at(r, 1_200).status).toBe('missing_from_the_books');
    expect(at(r, 1_200).detail).toContain('the extraction has lost this slab');
  });
});

describe('the two returns are checked against each other as well', () => {
  it('surfaces a GSTR-1 / GSTR-3B difference as inherited, not created', () => {
    // The department reconciles these two automatically, so a difference here is a notice waiting
    // to happen — and it was already there before we touched anything.
    const r = reconcile({
      gstr3b: filed({
        kind: 'gstr3b', acknowledgementRef: 'AB330426099999Y',
        lines: [slab(0, 4_000_000), slab(500, 2_000_000), slab(1_200, 800_000), slab(1_800, 400_000)],
      }),
    });
    expect(r.returnsDisagreeByMinor).toBe(taxOf(slab(1_800, 500_000)) - taxOf(slab(1_800, 400_000)));
    expect(r.reconciles).toBe(false);
    expect(r.ownerAction).toContain('inherited, not created by the migration');
  });

  it('applies the same acceptance test to the 3B as to the 1', () => {
    const r = reconcile({ gstr3b: filed({ kind: 'gstr3b', acknowledgementRef: '' }) });
    expect(r.accepted).toBe(false);
    expect(r.refusedBecause).toBe('no_acknowledgement_reference');
  });
});

describe('what a filed return cannot prove', () => {
  it('states that it never shows the tax was correctly CHARGED', () => {
    // Sell at 5% what should have been 12% and the books and the return agree exactly, because
    // both record the same mistake. Typed as the literal false so it cannot drift.
    const proves: false = reconcile().provesTaxWasCorrectlyCharged;
    expect(proves).toBe(false);
  });
});

describe('the position across every period', () => {
  const good = reconcile();

  it('NAMES a period with no filed return rather than skipping it', () => {
    // A gap in the middle of a reconciled run is the period somebody could not make agree, and it
    // is invisible unless the expected periods are stated up front.
    const p = taxPosition({ reconciliations: [good], periodsExpected: ['2026-03', '2026-04', '2026-05'] });
    expect(p.periodsWithNoReturn).toEqual(['2026-03', '2026-05']);
    expect(p.sufficientToVerify).toBe(false);
    expect(p.ownerAction).toContain('nobody has to agree to give them to you');
  });

  it('does not count a REFUSED period as held', () => {
    const refused = reconcile({ gstr1: filed({ acknowledgementRef: '' }) });
    const p = taxPosition({ reconciliations: [refused], periodsExpected: ['2026-04'] });
    expect(p.periodsWithNoReturn).toEqual(['2026-04']);
  });

  it('lists every period needing a disclosure, for the CA in writing', () => {
    const bad = reconcile({ books: [slab(0, 4_000_000), slab(500, 1_900_000), slab(1_200, 800_000), slab(1_800, 500_000)] });
    const p = taxPosition({ reconciliations: [good, bad], periodsExpected: ['2026-04'] });
    expect(p.disclosuresRequired).toEqual(['2026-04']);
    expect(p.sufficientToVerify).toBe(false);
    expect(p.ownerAction).toContain('before the opening balance is signed');
  });

  it('is satisfied only when every expected period ties', () => {
    const p = taxPosition({ reconciliations: [good], periodsExpected: ['2026-04'] });
    expect(p.sufficientToVerify).toBe(true);
    expect(p.detail).toContain('what was actually declared to the department');
  });
});
