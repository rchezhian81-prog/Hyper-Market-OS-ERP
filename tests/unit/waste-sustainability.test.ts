import { describe, it, expect } from 'vitest';
import { reviewScrap, type ScrapSale } from '../../packages/waste/src/scrap';
import {
  chargeForBags,
  projectPackaging,
  type PackagingItem,
  type PackagingMovement,
  type BagChargePolicy,
} from '../../packages/waste/src/packaging';
import {
  buildSustainabilityReport,
  compareWaste,
  type WasteRecord,
} from '../../packages/waste/src/sustainability';

// M28-FR-02/03/04 acceptance: "a scrap sale records proceeds and evidence and reconciles;
// carry-bag charge appears on the bill where enabled and packaging stock tracks; a
// waste/sustainability report computes from recorded losses and energy."

const scrap = (over: Partial<ScrapSale>): ScrapSale => ({
  scrapId: 'sc-1',
  tenantId: 't-sre',
  branchId: 'b-main',
  category: 'cardboard',
  disposal: 'sold',
  at: '2026-07-05T10:00:00Z',
  grams: 500_000,
  proceedsMinor: 400_000,
  buyerName: 'Anand Traders',
  evidenceRefs: ['weighbridge-1'],
  handledBy: 'u-raj',
  postedToFinance: true,
  ...over,
});

describe('scrap proceeds are made to EXIST and posted (M28-FR-02)', () => {
  const period = { branchId: 'b-main', from: '2026-07-01', to: '2026-07-31' };

  it('accepts a properly evidenced, posted sale with nothing to say', () => {
    const review = reviewScrap({ ...period, sales: [scrap({})] });
    expect(review.findings).toEqual([]);
    expect(review.totalProceedsMinor).toBe(400_000);
    expect(review.detail).toContain('all posted');
  });

  it('names proceeds that have not reached the books as off-books cash', () => {
    const review = reviewScrap({ ...period, sales: [scrap({ postedToFinance: false })] });
    expect(review.unpostedMinor).toBe(400_000);
    expect(review.findings.some((f) => f.flag === 'not_posted_to_finance')).toBe(true);
    expect(review.findings.find((f) => f.flag === 'not_posted_to_finance')?.detail).toContain('off-books cash');
  });

  it('FLAGS an unevidenced sale rather than refusing it', () => {
    const review = reviewScrap({ ...period, sales: [scrap({ evidenceRefs: [] })] });
    expect(review.findings[0]?.flag).toBe('no_evidence');
    // Refusing would put the transaction back outside the system, which is the problem.
    expect(review.findings[0]?.detail).toContain('back outside the system');
    expect(review.totalProceedsMinor).toBe(400_000);
  });

  it('flags a sale to nobody in particular', () => {
    const review = reviewScrap({ ...period, sales: [scrap({ buyerName: '  ' })] });
    expect(review.findings.some((f) => f.flag === 'no_buyer_named')).toBe(true);
  });

  it('asks about the RATE when it falls well below this shop\'s own average', () => {
    const review = reviewScrap({
      ...period,
      sales: [
        scrap({ scrapId: 'sc-a', grams: 500_000, proceedsMinor: 400_000 }),
        scrap({ scrapId: 'sc-b', grams: 500_000, proceedsMinor: 410_000 }),
        scrap({ scrapId: 'sc-c', grams: 500_000, proceedsMinor: 395_000 }),
        scrap({ scrapId: 'sc-low', grams: 500_000, proceedsMinor: 150_000 }),
      ],
    });
    const finding = review.findings.find((f) => f.flag === 'rate_below_average');
    expect(finding?.scrapId).toBe('sc-low');
    expect(finding?.detail).toContain('Ask about the RATE, not about the person');
  });

  it('does NOT call a rate low until there is enough history for an average', () => {
    const review = reviewScrap({
      ...period,
      sales: [scrap({ scrapId: 'sc-a' }), scrap({ scrapId: 'sc-low', proceedsMinor: 10_000 })],
    });
    expect(review.findings.some((f) => f.flag === 'rate_below_average')).toBe(false);
  });

  it('requires a registered recycler for e-waste and used oil', () => {
    const review = reviewScrap({
      ...period,
      sales: [scrap({ scrapId: 'sc-e', category: 'e_waste', disposal: 'recycled', proceedsMinor: 0 })],
    });
    expect(review.findings.some((f) => f.flag === 'unauthorised_recycler')).toBe(true);
    const ok = reviewScrap({
      ...period,
      sales: [scrap({ scrapId: 'sc-e', category: 'e_waste', disposal: 'recycled', proceedsMinor: 0, recyclerRegistration: 'TN-EW-118' })],
    });
    expect(ok.findings.some((f) => f.flag === 'unauthorised_recycler')).toBe(false);
  });

  it('flags stock recorded as SOLD for nothing', () => {
    const review = reviewScrap({ ...period, sales: [scrap({ proceedsMinor: 0 })] });
    expect(review.findings.some((f) => f.flag === 'sold_with_no_proceeds')).toBe(true);
  });

  it('says an empty month is itself a question', () => {
    const review = reviewScrap({ ...period, sales: [] });
    expect(review.detail).toContain('the cardboard still left the building');
  });
});

const bag: PackagingItem = {
  packagingId: 'pk-bag', tenantId: 't-sre', name: 'Carry bag (large)',
  kind: 'carry_bag', chargeMinor: 1_000, taxRateBps: 1_800, returnable: false,
};

const crate: PackagingItem = {
  packagingId: 'pk-crate', tenantId: 't-sre', name: 'Delivery crate',
  kind: 'reusable_crate', returnable: true, depositMinor: 10_000,
};

const policy = (over: Partial<BagChargePolicy> = {}): BagChargePolicy => ({
  enabled: true, chargeOnlyIfIssued: true, ...over,
});

describe('a bag charge is a VISIBLE LINE or it does not exist (M28-FR-03)', () => {
  it('bills the bag as its own line with its own tax', () => {
    const result = chargeForBags({ item: bag, policy: policy(), bagsIssued: 2 });
    expect(result.charged).toBe(true);
    expect(result.line?.netMinor).toBe(2_000);
    expect(result.line?.taxMinor).toBe(360);
    expect(result.line?.grossMinor).toBe(2_360);
    expect(result.detail).toContain('shown as its own line on the bill');
  });

  it('produces NO line when the tenant has not enabled it — not a zero-value line', () => {
    const result = chargeForBags({ item: bag, policy: policy({ enabled: false }), bagsIssued: 2 });
    expect(result.charged).toBe(false);
    expect(result.line).toBeUndefined();
    expect(result.detail).toContain('not a line worth nothing');
  });

  it('does not charge a customer who took no bag', () => {
    expect(chargeForBags({ item: bag, policy: policy(), bagsIssued: 0 }).outcome).toBe('none_issued');
  });

  it('does not charge on a channel the shop packs itself', () => {
    const result = chargeForBags({
      item: bag, policy: policy({ exemptChannels: ['delivery'] }), bagsIssued: 3, channel: 'delivery',
    });
    expect(result.outcome).toBe('exempt_channel');
    expect(result.detail).toContain('the shop pays for it');
  });

  it('refuses to invent a price', () => {
    const result = chargeForBags({ item: { ...bag, chargeMinor: undefined }, policy: policy(), bagsIssued: 1 });
    expect(result.outcome).toBe('no_price');
  });
});

describe('a reusable crate is an asset in circulation, not a consumable (M28-FR-03)', () => {
  const movement = (over: Partial<PackagingMovement>): PackagingMovement => ({
    movementId: 'm-1', packagingId: 'pk-crate', branchId: 'b-main',
    kind: 'received', qty: 400, at: '2026-01-01T00:00:00Z', ...over,
  });

  it('counts what went out and never came back', () => {
    const position = projectPackaging({
      item: crate, branchId: 'b-main',
      movements: [
        movement({}),
        movement({ movementId: 'm-2', kind: 'issued_to_delivery', qty: 300 }),
        movement({ movementId: 'm-3', kind: 'returned', qty: 182 }),
      ],
    });
    expect(position.onHand).toBe(282);
    expect(position.inCirculation).toBe(118);
    expect(position.lossRateBps).toBe(3_933);
    expect(position.detail).toContain('has not come back');
  });

  it('reports a NEGATIVE position rather than clamping it to zero', () => {
    const position = projectPackaging({
      item: bag, branchId: 'b-main',
      movements: [movement({ packagingId: 'pk-bag', kind: 'issued_to_customer', qty: 250 })],
    });
    expect(position.negative).toBe(true);
    expect(position.onHand).toBe(-250);
    // Clamping to zero destroys the only evidence that a goods-in was never entered.
    expect(position.detail).toContain('the negative IS the evidence');
  });

  it('does not pretend a carry bag is in circulation', () => {
    const position = projectPackaging({
      item: bag, branchId: 'b-main',
      movements: [
        movement({ packagingId: 'pk-bag', kind: 'received', qty: 1_000 }),
        movement({ movementId: 'm-2', packagingId: 'pk-bag', kind: 'issued_to_customer', qty: 400 }),
      ],
    });
    expect(position.inCirculation).toBe(0);
    expect(position.lossRateBps).toBe('not_meaningful');
    expect(position.onHand).toBe(600);
  });

  it('ignores another branch\'s movements', () => {
    const position = projectPackaging({
      item: crate, branchId: 'b-main',
      movements: [movement({}), movement({ movementId: 'm-x', branchId: 'b-other', qty: 900 })],
    });
    expect(position.onHand).toBe(400);
  });
});

const waste = (over: Partial<WasteRecord>): WasteRecord => ({
  wasteId: 'w-1', branchId: 'b-main', departmentId: 'd-fresh', productId: 'p-tomato',
  source: 'expiry', at: '2026-07-05T18:00:00Z', grams: 40_000, valueMinor: 180_000,
  disposal: 'composted', ...over,
});

const COVERAGE = {
  expected: [
    { branchId: 'b-main', departmentId: 'd-fresh' },
    { branchId: 'b-main', departmentId: 'd-grocery' },
    { branchId: 'b-main', departmentId: 'd-dairy' },
    { branchId: 'b-main', departmentId: 'd-cafe' },
    { branchId: 'b-main', departmentId: 'd-nonfood' },
  ],
};

const NAMES = {
  'd-fresh': 'Fresh produce', 'd-grocery': 'Grocery', 'd-dairy': 'Dairy',
  'd-cafe': 'Cafe', 'd-nonfood': 'Non-food',
};

describe('a waste figure carries its reporting COVERAGE (M28-FR-04)', () => {
  const period = { branchId: 'b-main', from: '2026-07-01', to: '2026-07-31', coverage: COVERAGE, departmentNames: NAMES };

  const FULL: readonly WasteRecord[] = [
    waste({ wasteId: 'w-1' }),
    waste({ wasteId: 'w-2', departmentId: 'd-grocery', valueMinor: 40_000, disposal: 'landfill', grams: 20_000 }),
    waste({ wasteId: 'w-3', departmentId: 'd-dairy', source: 'damage', valueMinor: 15_000, disposal: 'donated', grams: 8_000 }),
    waste({ wasteId: 'w-4', departmentId: 'd-cafe', source: 'preparation', valueMinor: 5_000, disposal: 'composted', grams: 12_000 }),
    waste({ wasteId: 'w-5', departmentId: 'd-nonfood', source: 'shrinkage', valueMinor: 60_000, disposal: 'landfill', grams: 2_000 }),
  ];

  it('reports reliable when everybody reported, and names the biggest cause', () => {
    const report = buildSustainabilityReport({ ...period, waste: FULL });
    expect(report.confidence).toBe('reliable');
    expect(report.coverageBps).toBe(10_000);
    expect(report.caveat).toBeUndefined();
    expect(report.totalWasteValueMinor).toBe(300_000);
    expect(report.bySource[0]?.label).toBe('expiry');
    expect(report.byDepartment[0]?.label).toBe('Fresh produce');
    expect(report.detail).toContain('Fresh produce accounts for 60% of the money');
  });

  it('computes diversion from landfill on weighed waste only', () => {
    const report = buildSustainabilityReport({ ...period, waste: FULL });
    // composted 40,000 + donated 8,000 + composted 12,000 = 60,000 of 82,000
    expect(report.diversionBps).toBe(7_317);
  });

  it('says NOT COMPARABLE when half the estate did not report', () => {
    const report = buildSustainabilityReport({
      ...period, waste: [waste({ wasteId: 'w-1' }), waste({ wasteId: 'w-2', departmentId: 'd-grocery' })],
    });
    expect(report.confidence).toBe('not_comparable');
    expect(report.coverageBps).toBe(4_000);
    expect(report.notReporting).toEqual(['Cafe', 'Dairy', 'Non-food']);
    expect(report.caveat).toContain('less RECORDING, not less waste');
  });

  it('says the real figure is higher when one department is missing', () => {
    const report = buildSustainabilityReport({
      ...period, waste: FULL.filter((w) => w.departmentId !== 'd-nonfood'),
    });
    expect(report.confidence).toBe('partial');
    expect(report.caveat).toContain('the real figure is higher than this one');
  });

  it('says an empty report means nobody logged it, not that nothing was thrown away', () => {
    const report = buildSustainabilityReport({ ...period, waste: [] });
    expect(report.detail).toContain('nobody logged it');
  });

  it('carries energy and scrap alongside, without blending them into the waste figure', () => {
    const report = buildSustainabilityReport({
      ...period, waste: FULL, energyKilowattHours: 18_400, energyCostMinor: 14_720_000,
      scrapProceedsMinor: 400_000,
    });
    expect(report.energyKilowattHours).toBe(18_400);
    expect(report.scrapProceedsMinor).toBe(400_000);
    expect(report.totalWasteValueMinor).toBe(300_000);
  });
});

describe('a fall in RECORDED waste is not a fall in waste (M28-FR-04)', () => {
  it('REFUSES to call an 18% fall an improvement when coverage collapsed', () => {
    const trend = compareWaste({
      from: { label: 'June', valueMinor: 500_000, coverageBps: 10_000 },
      to: { label: 'July', valueMinor: 410_000, coverageBps: 6_200 },
    });
    expect(trend.direction).toBe('unknown');
    expect(trend.changeBps).toBe('not_meaningful');
    expect(trend.detail).toContain('less recording, not less waste');
  });

  it('calls a genuine improvement an improvement on comparable coverage', () => {
    const trend = compareWaste({
      from: { label: 'June', valueMinor: 500_000, coverageBps: 10_000 },
      to: { label: 'July', valueMinor: 410_000, coverageBps: 10_000 },
    });
    expect(trend.direction).toBe('improved');
    expect(trend.changeBps).toBe(-1_800);
    expect(trend.detail).toContain('on comparable reporting coverage');
  });

  it('calls a rise a rise', () => {
    expect(compareWaste({
      from: { label: 'June', valueMinor: 400_000, coverageBps: 10_000 },
      to: { label: 'July', valueMinor: 520_000, coverageBps: 10_000 },
    }).direction).toBe('worsened');
  });

  it('reports flat when it barely moved', () => {
    expect(compareWaste({
      from: { label: 'June', valueMinor: 500_000, coverageBps: 10_000 },
      to: { label: 'July', valueMinor: 500_100, coverageBps: 10_000 },
    }).direction).toBe('flat');
  });

  it('has nothing to compare against when the earlier period is empty', () => {
    const trend = compareWaste({
      from: { label: 'June', valueMinor: 0, coverageBps: 10_000 },
      to: { label: 'July', valueMinor: 500_000, coverageBps: 10_000 },
    });
    expect(trend.direction).toBe('unknown');
    expect(trend.detail).toContain('nothing to compare against');
  });
});
