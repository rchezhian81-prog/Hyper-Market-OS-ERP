import { describe, it, expect } from 'vitest';
import { readRatingInput, ratingSummary, ratingSummaries, currentRatings, nextRatingVersion, type RatingRecord } from '../../packages/storefront/src/ratings';
import { digitalCopyOf, switchedOnAt, RECEIPT_SENDING, type BankedSaleForCopy } from '../../packages/receipt/src/digital-copy';
import { checkProductImage, sniffImageType, currentImage, appContentCompleteness, MAX_IMAGE_BYTES, type ProductImageVersion } from '../../packages/product/src/images';

/** R4 · M20-FR-04 ratings · D-28 digital copies · D01-FR-06 images — the pure engines. */

describe('ratings — stars only, one per customer, no names (M20-FR-04 · OB-218)', () => {
  it('reads whole stars 1–5 and nothing else', () => {
    expect(readRatingInput({ stars: 3 })).toEqual({ ok: true, stars: 3 });
    expect(readRatingInput({ stars: 3, comment: 'x' })).toMatchObject({ ok: false, code: 'stars_only' });
    for (const bad of [0, 6, 2.5, '4', null]) expect(readRatingInput({ stars: bad })).toMatchObject({ ok: false, code: 'not_whole_stars' });
    expect(readRatingInput([])).toMatchObject({ ok: false });
  });
  it('a later rating replaces the customer\'s own in the average; the history keeps both; the summary names nobody', () => {
    const h: RatingRecord[] = [
      { productId: 'P', customerRef: 'a', stars: 1, version: 1, at: '1' },
      { productId: 'P', customerRef: 'b', stars: 4, version: 1, at: '2' },
      { productId: 'P', customerRef: 'a', stars: 5, version: 2, at: '3' },
    ];
    expect(currentRatings(h)).toHaveLength(2);
    expect(ratingSummary(h, 'P')).toEqual({ productId: 'P', count: 2, average: 4.5 });
    expect(ratingSummary(h, 'Q')).toEqual({ productId: 'Q', count: 0 });
    expect(JSON.stringify(ratingSummaries(h))).not.toMatch(/"a"|"b"|customerRef/);
    expect(nextRatingVersion(h, 'P', 'a')).toBe(3);
    expect(nextRatingVersion(h, 'P', 'c')).toBe(1);
  });
});

const SALE: BankedSaleForCopy = {
  saleId: 's1', receiptNumber: 'S01-000001', tradingDay: '2026-10-19', committedAt: '2026-10-19T05:00:00.000Z', totalMinor: 270_00, currency: 'INR', customerRef: 'm-x',
  lines: [
    { productId: 'MILK', quantityMinor: 2, uom: 'ea', unitPriceMinor: 60_00, lineTotalMinor: 120_00, taxRateBps: 500 },
    { productId: 'BROOM', quantityMinor: 1, uom: 'ea', unitPriceMinor: 150_00, lineTotalMinor: 150_00 },
  ],
  tenders: [{ kind: 'card', amountMinor: 200_00, card: { last4: '4242', network: 'visa' } }, { kind: 'upi', amountMinor: 70_00 }],
};

describe('a member\'s digital copy (D-28 · OB-214 · hard rule #3)', () => {
  it('is the same bill — number, lines, tax inside the price, payments — with a card as its last four only', () => {
    const c = digitalCopyOf(SALE, (id) => (id === 'MILK' ? 'Milk' : undefined));
    expect(c.receiptNumber).toBe('S01-000001');
    expect(c.lines.map((l) => l.name)).toEqual(['Milk', 'BROOM']);
    expect(c.taxBands).toEqual([{ rateBps: 500, netMinor: 11_429, taxMinor: 571 }]);
    // A line whose rate the bill did not carry is said, never guessed as zero tax.
    expect(c.taxNotKnownMinor).toBe(150_00);
    expect(c.payments).toEqual([{ kind: 'card', amountMinor: 200_00, cardLast4: '4242', say: 'Card ending 4242 ₹200.00' }, { kind: 'upi', amountMinor: 70_00, say: 'upi ₹70.00' }]);
    expect(JSON.stringify(c)).not.toMatch(/visa|network/);
    // A malformed last-four is not shown at all.
    expect(digitalCopyOf({ ...SALE, tenders: [{ kind: 'card', amountMinor: 1, card: { last4: '42424242' } }] }).payments[0]).toEqual({ kind: 'card', amountMinor: 1, say: 'Card ₹0.01' });
  });
  it('off by default; on only from the member\'s own choice; off again stops it', () => {
    expect(switchedOnAt([], '2026-10-19T00:00:00.000Z')).toBe(false);
    const choices = [{ customerRef: 'c', on: true, at: '2026-10-10T00:00:00.000Z' }, { customerRef: 'c', on: false, at: '2026-10-15T00:00:00.000Z' }];
    expect(switchedOnAt(choices, '2026-10-09T00:00:00.000Z')).toBe(false);
    expect(switchedOnAt(choices, '2026-10-12T00:00:00.000Z')).toBe(true);
    expect(switchedOnAt(choices, '2026-10-16T00:00:00.000Z')).toBe(false);
    expect(RECEIPT_SENDING.switchedOn).toBe(false);
  });
});

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(n).fill(1)]);

describe('product images on the shop\'s own server (D01-FR-06 · OB-215)', () => {
  it('the type comes from the file\'s own bytes and must agree with what was declared', () => {
    expect(sniffImageType(png(4))).toBe('image/png');
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('<svg></svg>'))).toBeUndefined();
    expect(checkProductImage('image/png', png(4))).toMatchObject({ ok: true, mediaType: 'image/png' });
    expect(checkProductImage('image/jpeg', png(4))).toMatchObject({ ok: false, code: 'image_type_not_allowed', refusal: 'image type not allowed' });
    expect(checkProductImage('image/svg+xml', new TextEncoder().encode('<svg/>'))).toMatchObject({ ok: false, refusal: 'image type not allowed' });
    expect(checkProductImage('image/png', new Uint8Array())).toMatchObject({ ok: false });
  });
  it('a file over the limit is "image too large"', () => {
    expect(checkProductImage('image/png', png(MAX_IMAGE_BYTES))).toMatchObject({ ok: false, code: 'image_too_large', refusal: 'image too large' });
    expect(checkProductImage('image/png', png(MAX_IMAGE_BYTES - 8)).ok).toBe(true);
  });
  it('the current image is the highest version; the app content score names what is missing', () => {
    const v = (version: number): ProductImageVersion => ({ productId: 'P', version, imageId: `i${version}`, mediaType: 'image/png', bytes: 1, sha256: 'x', setBy: 'u', setAt: 't' });
    expect(currentImage([v(1), v(3), v(2)], 'P')?.version).toBe(3);
    expect(currentImage([], 'P')).toBeUndefined();
    expect(appContentCompleteness({ descriptionEn: 'x', synonyms: ['y'], hasImage: false })).toEqual({ scorePercent: 40, missing: ['Tamil name', 'Tamil description', 'image'] });
    expect(appContentCompleteness({ nameTa: 'a', descriptionEn: 'b', descriptionTa: 'c', synonyms: ['d'], hasImage: true })).toEqual({ scorePercent: 100, missing: [] });
  });
});
