import { describe, it, expect } from 'vitest';
import { warningStanding, pictureInForce, nextPicture, validateProduct, type WarningImage, type TobaccoWarningRecord, type ProductRecord } from '../../packages/product/src/index';
import { tillLineRefusals, tillRuleFlagsOf } from '../../packages/restricted-sales/src/till-gate';
import { SoldHuids, huidsOnRecord } from '../../edge/store-edge/src/sold-huids';
import { buildReceipt, renderReceipt } from '../../packages/receipt/src/index';

// B16 (OB-140 "A") and B13 (OB-138) — the pure rules, clockless: "today" is always passed in.

const picture = (imageId: string, effectiveFrom: string): WarningImage => ({
  imageId, effectiveFrom, notifiedOn: '2019-01-01', reference: `G.S.R. ${imageId}`, evidenceRef: `DOC-${imageId}`, recordedBy: 'u-owner', recordedAt: '2019-01-02T00:00:00Z',
});
const confirmed = (imageId: string) => ({ imageId, confirmedBy: 'u-meena', confirmedByName: 'Meena', confirmedAt: '2026-01-01T00:00:00Z', evidenceRef: 'PHOTO' });

describe('B16: a tobacco product is sellable only with a confirmation for the picture in force', () => {
  const pictures = [picture('P1', '2020-01-01'), picture('P2', '2030-06-05')];
  it('the picture in force and the next one', () => {
    expect(pictureInForce(pictures, '2030-06-04')?.imageId).toBe('P1');
    expect(pictureInForce(pictures, '2030-06-05')?.imageId).toBe('P2');
    expect(pictureInForce(pictures, '2019-12-31')).toBeUndefined();
    expect(nextPicture(pictures, '2030-06-04')?.imageId).toBe('P2');
  });
  it('no picture → not sellable; never confirmed; confirmed → good until the day before the next; expired after it', () => {
    expect(warningStanding(undefined, '2030-01-01')).toMatchObject({ sellable: false, reason: 'no_picture_notified' });
    expect(warningStanding({ images: pictures, confirmations: [] }, '2030-01-01')).toMatchObject({ sellable: false, reason: 'never_confirmed' });
    const record: TobaccoWarningRecord = { images: pictures, confirmations: [confirmed('P1')] };
    expect(warningStanding(record, '2030-06-04')).toMatchObject({ sellable: true, reason: 'confirmed', goodUntil: '2030-06-04' });
    expect(warningStanding(record, '2030-06-05')).toMatchObject({ sellable: false, reason: 'confirmation_expired' });
    expect(warningStanding({ images: pictures, confirmations: [confirmed('P1'), confirmed('P2')] }, '2030-06-05')).toMatchObject({ sellable: true, image: { imageId: 'P2' } });
  });
  it('the till refuses an expired confirmation by its own date — offline, and only once the day has passed', () => {
    const line = { productId: 'p-cig', description: 'Cigarettes 10s', quantityMinor: 1, uom: 'ea', unitPriceMinor: 180_00, regulatedFlags: { tobacco: true, packMinimumMinor: 1, tobaccoWarningConfirmedUntil: '2030-06-04' } };
    expect(tillLineRefusals(line, { today: '2030-06-04' })).toEqual([]);
    expect(tillLineRefusals(line, { today: '2030-06-05' }).map((r) => r.reason)).toEqual(['tobacco_warning_confirmation_expired']);
    // A date the till cannot read is no date: the flag is ignored rather than guessed (the pack leaves the product out).
    expect(tillRuleFlagsOf({ tobacco: true, tobaccoWarningConfirmedUntil: '5 June' }).tobaccoWarningConfirmedUntil).toBeUndefined();
  });
});

describe('B13: a gold piece needs its HUID, once, one piece per line', () => {
  const ring = (flags: Record<string, unknown>, quantityMinor = 1) => ({ productId: 'p-ring', description: 'Gold ring 22K', quantityMinor, uom: 'ea', unitPriceMinor: 45_000_00, regulatedFlags: flags });
  it('no HUID, a malformed HUID, an already-sold HUID, two pieces on one line — each refused by name', () => {
    expect(tillLineRefusals(ring({ gold: true }), {}).map((r) => [r.reason, r.laneMessage.startsWith('Gold ring 22K')])).toEqual([['gold_without_huid', true]]);
    expect(tillLineRefusals(ring({ gold: true, huid: 'ab12cd' }), {})[0]?.reason).toBe('gold_without_huid');
    expect(tillLineRefusals(ring({ gold: true, huid: 'AB12CD' }), { soldHuids: new Set(['AB12CD']) })[0]?.reason).toBe('gold_huid_already_sold');
    expect(tillLineRefusals(ring({ gold: true, huid: 'AB12CD' }, 2), {})[0]?.reason).toBe('gold_huid_more_than_one_piece');
    expect(tillLineRefusals(ring({ gold: true, huid: 'AB12CD' }), { soldHuids: new Set(['ZZ99ZZ']) })).toEqual([]);
  });
  it('the product master refuses a HUID the till cannot read, and says a gold piece without one cannot be sold', () => {
    const product = (safety: ProductRecord['safety']): ProductRecord => ({ productId: 'p', tenantId: 't', sku: 'S', name: 'Ring', baseUom: 'ea', primaryCategoryId: 'c', taxClass: '7113', lifecycle: 'draft', ...(safety === undefined ? {} : { safety }) });
    const cats = [{ categoryId: 'c', name: 'Jewellery', parentId: null }];
    expect(validateProduct(product({ gold: true, huid: 'AB1' }), cats).issues).toContainEqual(expect.objectContaining({ field: 'safety.huid', severity: 'blocks_publish' }));
    expect(validateProduct(product({ gold: true }), cats)).toMatchObject({ publishable: true, issues: [expect.objectContaining({ field: 'safety.huid', severity: 'advisory' })] });
    expect(validateProduct(product({ gold: true, huid: 'AB12CD' }), cats).issues).toEqual([]);
  });
  it('the store computer\'s register is built from its own sale records and only grows', () => {
    const sale = (id: string, huid?: string) => JSON.stringify({ id, lines: [{ productId: 'p-ring', quantityMinor: 1, ...(huid === undefined ? {} : { huid }) }] });
    const box = new SoldHuids([sale('S-1', 'AB12CD'), sale('S-2'), 'not json']);
    expect(box.list()).toEqual(['AB12CD']);
    box.note(sale('S-3', 'QW34ER'));
    expect(box.has('QW34ER')).toBe(true);
    expect(huidsOnRecord({ lines: [{ huid: 'bad' }, { huid: 'AB12CD' }] })).toEqual(['AB12CD']);
  });
  it('the HUID (and a 2D batch) is printed on the bill under its line', () => {
    const doc = buildReceipt({
      number: 'R-1', saleId: 'S-1', tradingDay: '2030-06-10', committedAt: '2030-06-10T06:00:00Z', laneId: 'lane-1', cashierId: 'u-cash', currency: 'INR',
      header: ['SRE Hyper Market'], footer: [],
      lines: [{ description: 'Gold ring 22K', quantityMinor: 1, uom: 'ea', unitPriceMinor: 100, lineTotalMinor: 100, huid: 'AB12CD' }, { description: 'Paneer', quantityMinor: 1, uom: 'ea', unitPriceMinor: 0, lineTotalMinor: 0, batchId: 'B-2' }],
      netMinor: 100, taxMinor: 0, taxBands: [], totalMinor: 100, tenders: [{ kind: 'cash', amountMinor: 100 }],
    });
    const text = renderReceipt(doc).join('\n');
    expect(text).toContain('HUID: AB12CD');
    expect(text).toContain('Batch: B-2');
  });
});
