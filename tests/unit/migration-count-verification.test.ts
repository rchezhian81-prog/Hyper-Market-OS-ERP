import { describe, it, expect } from 'vitest';
import {
  planCountSample, assessCountVerification, type StockLine, type CountedLine,
} from '../../packages/migration/src/count-verification';

// MG-06, OB-06, §28 — proving the extracted stock against the shelves.

/** A hypermarket's shape: a few lines hold most of the money, a long tail holds almost none. */
const LINES: readonly StockLine[] = [
  { lineId: 'L001', productId: 'P001', description: 'Amul Ghee Gold 1L', extractedQty: 200, extractedValueMinor: 12_800_000 },
  { lineId: 'L002', productId: 'P002', description: 'Sunflower Oil 5L', extractedQty: 300, extractedValueMinor: 9_000_000 },
  { lineId: 'L003', productId: 'P003', description: 'Aachi Rice Ponni 25kg', extractedQty: 150, extractedValueMinor: 6_000_000 },
  { lineId: 'L004', productId: 'P004', description: 'Toor Dal 5kg', extractedQty: 100, extractedValueMinor: 3_000_000 },
  ...Array.from({ length: 60 }, (_, i) => ({
    lineId: `T${String(i + 1).padStart(3, '0')}`,
    productId: `P${String(i + 100).padStart(3, '0')}`,
    description: `Tail item ${i + 1}`,
    extractedQty: 10 + i,
    extractedValueMinor: 5_000 + i * 100,
  })),
];

const plan = (over: Partial<Parameters<typeof planCountSample>[0]> = {}) => planCountSample({
  planId: 'cnt-1', lines: LINES, plannedBy: 'u-manager', extractionOperator: 'u-operator',
  seed: 20260807, ...over,
});

describe('the sample is value-stratified, not random', () => {
  const result = plan();

  it('counts the money in full and samples the tail', () => {
    expect(result.ok).toBe(true);
    const p = result.plan!;
    // The four big lines carry ~99% of the value, so the census is small and covers almost all
    // the money. A random sample of the same size would verify almost nothing.
    expect(p.censusLines).toBeLessThan(10);
    expect(p.censusValueCoverageBps).toBeGreaterThanOrEqual(8_000);
    expect(p.sampledLines).toBeGreaterThan(0);
    expect(p.detail).toContain('the hours go into a thin slice of the tail');
  });

  it('puts the highest-value lines in the census, never leaves one to chance', () => {
    const census = new Set(result.plan!.lines.filter((l) => l.stratum === 'census').map((l) => l.lineId));
    // A random sample that happens to miss the ghee has verified almost nothing while looking
    // thorough. The four big lines are counted because they are big, not because they were drawn.
    expect(census.has('L001')).toBe(true);
    expect(census.has('L002')).toBe(true);
  });

  it('never puts the expected quantity on the count sheet', () => {
    // A counter shown "expected: 40" writes 40, and the exercise measures their willingness to
    // disagree rather than the stock. Typed as the literal false so it cannot drift.
    for (const line of result.plan!.lines) {
      const shown: false = line.expectedQtyShownToCounter;
      expect(shown).toBe(false);
    }
    expect(JSON.stringify(result.plan!.lines)).not.toContain('extractedQty');
  });

  it('is reproducible from its seed, so an auditor can ask why THIS line', () => {
    const again = plan();
    expect(again.plan!.lines.map((l) => `${l.lineId}:${l.stratum}`))
      .toEqual(result.plan!.lines.map((l) => `${l.lineId}:${l.stratum}`));
    const different = plan({ seed: 99 });
    expect(different.plan!.sampledLines).toBeGreaterThan(0);
  });

  it('REFUSES a sample chosen by the person who ran the extraction (§28)', () => {
    const r = plan({ plannedBy: 'u-operator' });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('chosen_by_the_extractor');
    expect(r.detail).toContain('that is what confidence does');
  });

  it('honours a higher census target when the owner wants more of the value covered', () => {
    const thorough = plan({ censusValueTargetBps: 9_900 });
    expect(thorough.plan!.censusValueCoverageBps).toBeGreaterThanOrEqual(9_900);
    expect(thorough.plan!.censusLines).toBeGreaterThan(plan().plan!.censusLines);
  });
});

describe('a clean count, and what it does and does not prove', () => {
  const p = plan().plan!;
  const toCount = p.lines.filter((l) => l.stratum !== 'not_counted');
  const perfect: readonly CountedLine[] = toCount.map((l) => ({
    lineId: l.lineId,
    countedQty: LINES.find((x) => x.lineId === l.lineId)!.extractedQty,
    counterId: 'u-counter',
  }));

  it('reports a clean count as a measurement', () => {
    const r = assessCountVerification({ plan: p, extracted: LINES, counted: perfect, toleranceMinor: 0 });
    expect(r.cleanCount).toBe(true);
    expect(r.censusDifferenceMinor).toBe(0);
    expect(r.sufficientToVerify).toBe(true);
    expect(r.ownerAction).toContain('rests on your own shelves rather than on the old system\'s word');
  });

  it('states plainly that the uncounted lines are UNVERIFIED, not verified-as-correct', () => {
    const r = assessCountVerification({ plan: p, extracted: LINES, counted: perfect, toleranceMinor: 0 });
    if (p.notCountedLines > 0) {
      expect(r.estimateBasis).toMatch(/UNVERIFIED|ESTIMATE/);
    }
  });
});

describe('the estimate is an estimate, and refuses to be one when it cannot', () => {
  const p = plan().plan!;

  it('REFUSES to put a number on the uncounted lines from too small a sample', () => {
    // A rate from three lines is arithmetic, not evidence. `undefined` rather than a fabricated
    // figure — the same discipline as `not_meaningful` elsewhere in this codebase.
    const censusOnly = p.lines.filter((l) => l.stratum === 'census').map((l) => ({
      lineId: l.lineId,
      countedQty: LINES.find((x) => x.lineId === l.lineId)!.extractedQty,
      counterId: 'u-counter',
    }));
    const r = assessCountVerification({ plan: p, extracted: LINES, counted: censusOnly, toleranceMinor: 0 });
    expect(r.estimatedUncountedErrorMinor).toBeUndefined();
    expect(r.estimateBasis).toContain('too few to estimate anything from');
    expect(r.estimateBasis).toContain('not verified-as-correct');
  });

  it('labels the estimate as an estimate and forbids adding it to the measurement', () => {
    const big = planCountSample({
      planId: 'cnt-2', lines: LINES, plannedBy: 'u-manager', extractionOperator: 'u-operator',
      tailSampleRateBps: 5_000, seed: 7,
    }).plan!;
    const toCount = big.lines.filter((l) => l.stratum !== 'not_counted');
    const counted = toCount.map((l, i) => ({
      lineId: l.lineId,
      // Every fourth sampled tail line is one short.
      countedQty: LINES.find((x) => x.lineId === l.lineId)!.extractedQty - (l.stratum === 'sampled' && i % 4 === 0 ? 1 : 0),
      counterId: 'u-counter',
    }));

    const r = assessCountVerification({ plan: big, extracted: LINES, counted, toleranceMinor: 1_000_000 });
    if (r.estimatedUncountedErrorMinor !== undefined) {
      expect(r.estimateBasis).toContain('ESTIMATE from a sample, not a measurement');
      expect(r.estimateBasis).toContain('must not be added to the counted figure');
    }
  });

  it('has nothing to estimate when everything was counted', () => {
    const full = planCountSample({
      planId: 'cnt-3', lines: LINES, plannedBy: 'u-manager', extractionOperator: 'u-operator',
      tailSampleRateBps: 10_000, seed: 3,
    }).plan!;
    expect(full.notCountedLines).toBe(0);
    const counted = full.lines.map((l) => ({
      lineId: l.lineId,
      countedQty: LINES.find((x) => x.lineId === l.lineId)!.extractedQty,
      counterId: 'u-counter',
    }));
    const r = assessCountVerification({ plan: full, extracted: LINES, counted, toleranceMinor: 0 });
    expect(r.estimateBasis).toContain('the figure above is a measurement');
  });
});

describe('differences are settled one at a time, not averaged away', () => {
  const p = plan().plan!;
  const toCount = p.lines.filter((l) => l.stratum !== 'not_counted');

  it('names every line that differs, worst by value first', () => {
    const counted = toCount.map((l) => ({
      lineId: l.lineId,
      countedQty: LINES.find((x) => x.lineId === l.lineId)!.extractedQty - (l.lineId === 'L001' ? 10 : l.lineId === 'L003' ? 2 : 0),
      counterId: 'u-counter',
    }));
    const r = assessCountVerification({ plan: p, extracted: LINES, counted, toleranceMinor: 0 });

    expect(r.cleanCount).toBe(false);
    expect(r.variances[0]?.lineId).toBe('L001');
    expect(r.variances[0]?.differenceQty).toBe(-10);
    // 200 units at 12,800,000 = 64,000 per unit; ten short is -640,000.
    expect(r.variances[0]?.differenceValueMinor).toBe(-640_000);
    expect(r.variances.map((v) => v.lineId)).toContain('L003');
  });

  it('blocks the signature when the difference exceeds tolerance, and says so', () => {
    const counted = toCount.map((l) => ({
      lineId: l.lineId,
      countedQty: LINES.find((x) => x.lineId === l.lineId)!.extractedQty - (l.lineId === 'L001' ? 10 : 0),
      counterId: 'u-counter',
    }));
    const r = assessCountVerification({ plan: p, extracted: LINES, counted, toleranceMinor: 1_000 });
    expect(r.sufficientToVerify).toBe(false);
    expect(r.ownerAction).toContain('settled one at a time against the shelf, not averaged away');
  });

  it('REFUSES a plan so thin that nothing could be concluded from it', () => {
    // One line out of sixty-four supports no conclusion at all, and a result presented from it
    // would be a number with no basis behind it.
    const r = planCountSample({
      planId: 'cnt-thin', lines: LINES, plannedBy: 'u-manager', extractionOperator: 'u-operator',
      censusValueTargetBps: 1_000, tailSampleRateBps: 0, seed: 11,
    });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('sample_too_small');
  });

  it('blocks a plan that covered too little of the value to sign against', () => {
    const thin = planCountSample({
      planId: 'cnt-4', lines: LINES, plannedBy: 'u-manager', extractionOperator: 'u-operator',
      censusValueTargetBps: 1_000, tailSampleRateBps: 800, seed: 11,
    }).plan!;
    expect(thin.censusValueCoverageBps).toBeLessThan(7_000);
    const counted = thin.lines.filter((l) => l.stratum === 'census').map((l) => ({
      lineId: l.lineId,
      countedQty: LINES.find((x) => x.lineId === l.lineId)!.extractedQty,
      counterId: 'u-counter',
    }));
    const r = assessCountVerification({ plan: thin, extracted: LINES, counted, toleranceMinor: 0 });
    expect(r.sufficientToVerify).toBe(false);
    expect(r.ownerAction).toContain('the high-value lines are the ones worth the hours');
  });
});
