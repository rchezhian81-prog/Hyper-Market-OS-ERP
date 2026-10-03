import { describe, it, expect } from 'vitest';
import { packOrder, dispatchOrder, type PackLine } from '../../packages/fulfilment/src/packing';

// M19-FR-02 acceptance: "A WEIGHED ORDER'S FINAL PRICE IS CAPTURED; cold-chain evidence
// recorded; the manifest [is derived from what was packed]."

const line = (over: Partial<PackLine>): PackLine => ({
  lineId: 'l-1',
  orderId: 'O-1',
  productId: 'p-atta',
  name: 'Atta 5kg',
  handling: 'ambient',
  orderedMinor: 2,
  pickedMinor: 2,
  uom: 'ea',
  unitPriceMinor: 26_500,
  ...over,
});

const CHICKEN = line({
  lineId: 'l-chicken', productId: 'p-chicken', name: 'Fresh chicken',
  handling: 'raw_meat', orderedMinor: 1, pickedMinor: 1, uom: 'kg',
  unitPriceMinor: 24_000, weighed: true, packedGrams: 1_187, packTenthsC: 22,
});

function pack(lines: readonly PackLine[], crates: Record<string, string> = {}) {
  return packOrder({ orderId: 'O-1', lines, crateAssignment: crates, at: '2026-08-05T09:00:00Z' });
}

describe('a weighed line is priced at its ACTUAL packed weight (D09)', () => {
  it('prices 1.187 kg of chicken at ₹240/kg exactly', () => {
    const result = pack([CHICKEN], { 'l-chicken': 'crate-cold' });
    expect(result.packed).toBe(true);
    // 24,000 × 1187 / 1000 = 28,488 → ₹284.88
    expect(result.lines[0]?.finalPriceMinor).toBe(28_488);
    expect(result.lines[0]?.detail).toBe('1187g at 24000 per kg = 28488');
  });

  it('REFUSES a weighed line with no weight — the price would be a guess at the doorstep', () => {
    const result = pack([{ ...CHICKEN, packedGrams: undefined }], { 'l-chicken': 'crate-cold' });
    expect(result.lines).toEqual([]);
    expect(result.refused[0]?.reason).toBe('weight_not_captured');
    expect(result.refused[0]?.detail).toContain('a guess at the doorstep');
  });

  it('prices an ordinary line by count', () => {
    const result = pack([line({})]);
    expect(result.lines[0]?.finalPriceMinor).toBe(53_000);
  });

  it('charges only for what is actually going when a line is short', () => {
    const result = pack([line({ orderedMinor: 3, pickedMinor: 2 })]);
    expect(result.lines[0]?.finalPriceMinor).toBe(53_000);
    expect(result.lines[0]?.shortMinor).toBe(1);
    expect(result.lines[0]?.detail).toContain('charged only for what is going');
  });
});

describe('a price settled at pick stands (D09 · M19-FR-02 fold)', () => {
  it('keeps the handheld\'s final price exactly — the pack never re-prices what the scale settled, and a weighed line needs no grams here', () => {
    const r = pack([
      line({ lineId: 'l-chicken', productId: 'p-chicken', name: 'Fresh chicken', handling: 'raw_meat', orderedMinor: 1, pickedMinor: 1, uom: 'kg', unitPriceMinor: 0, weighed: true, packTenthsC: 22, finalPriceMinor: 28_488 }),
      line({ orderedMinor: 3, pickedMinor: 2, unitPriceMinor: 0, finalPriceMinor: 53_000 }),
    ]);
    expect(r.outcome).toBe('packed');
    expect(r.lines.map((l) => [l.lineId, l.finalPriceMinor, l.shortMinor])).toEqual([['l-chicken', 28_488, 0], ['l-1', 53_000, 1]]);
    expect(r.totalMinor).toBe(81_488);
    expect(r.lines[1]!.detail).toContain('2 of 3, short, and charged only for what is going');
    expect(r.lines[0]!.detail).toContain('settled at pick');
  });

  it('a line without one is priced here as before — by count, or by weight when the grams were captured', () => {
    expect(pack([line({})]).lines[0]!.finalPriceMinor).toBe(53_000);
    expect(pack([CHICKEN]).lines[0]!.finalPriceMinor).toBe(28_488);
  });
});

describe('a product\'s own cold-chain limit stands in for the class default, and the line says which judged it (HA-3)', () => {
  it('packs under the product limit and names it; refuses outside it naming the product; a line with no limit of its own is judged by the approved class default and says so; an ambient line carries none', () => {
    const milk = line({ lineId: 'l-milk', productId: 'p-milk', name: 'Milk 1L', handling: 'chilled', orderedMinor: 1, pickedMinor: 1, packTenthsC: 40 });
    const own = pack([{ ...milk, coldChain: { maxTenthsC: 45 } }]);
    expect(own.lines[0]!.coldChain).toEqual({ maxTenthsC: 45, source: 'product' });
    const tooWarm = pack([{ ...milk, coldChain: { maxTenthsC: 30 } }]);
    expect(tooWarm.refused[0]).toMatchObject({ lineId: 'l-milk', reason: 'temperature_out_of_range' });
    expect(tooWarm.refused[0]!.detail).toContain('outside the chilled range set on the product');
    expect(pack([milk]).lines[0]!.coldChain).toEqual({ minTenthsC: -20, maxTenthsC: 50, source: 'class_default' });
    expect(pack([milk, line({ packTenthsC: 60 })]).refused).toEqual([]);
    expect(pack([milk, line({ packTenthsC: 60 })]).lines[1]!.coldChain).toBeUndefined();
    expect(pack([{ ...milk, packTenthsC: 70 }]).refused[0]!.detail).toContain('outside the chilled range (the approved class default)');
  });
});

describe('a missing pack temperature is a failure, not a gap (M10-FR-02)', () => {
  it('REFUSES a chilled line with no reading taken', () => {
    const result = pack([{ ...CHICKEN, packTenthsC: undefined }], { 'l-chicken': 'crate-cold' });
    expect(result.refused[0]?.reason).toBe('temperature_not_taken');
    expect(result.refused[0]?.detail).toContain('an unmeasured cold chain is an unproven one');
  });

  it('refuses a line packed outside its range', () => {
    const warm = pack([{ ...CHICKEN, packTenthsC: 95 }], { 'l-chicken': 'crate-cold' });
    expect(warm.refused[0]?.reason).toBe('temperature_out_of_range');
    expect(warm.refused[0]?.detail).toContain('it does not go on the van');
  });

  it('needs no reading for an ambient line', () => {
    expect(pack([line({})]).refused).toEqual([]);
  });

  it('refuses frozen goods packed above the frozen limit', () => {
    const result = pack(
      [line({ lineId: 'l-peas', name: 'Frozen peas', handling: 'frozen', packTenthsC: -50 })],
      { 'l-peas': 'crate-frozen' },
    );
    expect(result.refused[0]?.reason).toBe('temperature_out_of_range');

    const ok = pack(
      [line({ lineId: 'l-peas', name: 'Frozen peas', handling: 'frozen', packTenthsC: -180 })],
      { 'l-peas': 'crate-frozen' },
    );
    expect(ok.refused).toEqual([]);
  });
});

describe('a crate cannot mix incompatible handling', () => {
  it('REFUSES frozen and ambient in one crate — that is a wet bag of atta', () => {
    const result = pack(
      [
        line({ lineId: 'l-atta' }),
        line({ lineId: 'l-peas', name: 'Frozen peas', handling: 'frozen', packTenthsC: -180 }),
      ],
      { 'l-atta': 'crate-1', 'l-peas': 'crate-1' },
    );
    expect(result.refused[0]?.reason).toBe('incompatible_crate');
    expect(result.refused[0]?.detail).toContain('cannot travel in the same crate as');
  });

  it('REFUSES raw meat with ready-to-eat food', () => {
    const result = pack(
      [
        line({ lineId: 'l-salad', name: 'Salad box', handling: 'ready_to_eat' }),
        { ...CHICKEN, lineId: 'l-chicken' },
      ],
      { 'l-salad': 'crate-1', 'l-chicken': 'crate-1' },
    );
    expect(result.refused.some((r) => r.reason === 'incompatible_crate')).toBe(true);
  });

  it('accepts them in SEPARATE crates', () => {
    const result = pack(
      [
        line({ lineId: 'l-salad', name: 'Salad box', handling: 'ready_to_eat' }),
        { ...CHICKEN, lineId: 'l-chicken' },
      ],
      { 'l-salad': 'crate-ambient', 'l-chicken': 'crate-cold' },
    );
    expect(result.refused).toEqual([]);
    expect(result.lines).toHaveLength(2);
  });

  it('does NOT stop the rest of the order — the customer gets most of their shopping', () => {
    const result = pack(
      [
        line({ lineId: 'l-atta' }),
        line({ lineId: 'l-peas', name: 'Frozen peas', handling: 'frozen', packTenthsC: -180 }),
        line({ lineId: 'l-rice', name: 'Rice 5kg' }),
      ],
      { 'l-atta': 'crate-1', 'l-peas': 'crate-1', 'l-rice': 'crate-2' },
    );
    expect(result.packed).toBe(true);
    expect(result.lines.map((l) => l.lineId)).toContain('l-rice');
    expect(result.detail).toContain('refused and listed rather than quietly left out');
  });
});

describe('the manifest is derived from what was PACKED, never from what was ordered', () => {
  const good = pack([line({ lineId: 'l-atta' }), { ...CHICKEN }], {
    'l-atta': 'crate-ambient',
    'l-chicken': 'crate-cold',
  });

  it('carries exactly the packed lines and their crates', () => {
    const result = dispatchOrder({
      manifestId: 'MAN-1', orderId: 'O-1', locationId: 'store-1', pack: good,
      seals: { 'crate-ambient': 'seal-a', 'crate-cold': 'seal-b' },
      dispatchedBy: 'u-packer', at: '2026-08-05T10:00:00Z',
    });
    expect(result.dispatched).toBe(true);
    expect(result.manifest?.lines.map((l) => l.lineId).sort()).toEqual(['l-atta', 'l-chicken']);
    expect(result.manifest?.crates).toEqual(['crate-ambient', 'crate-cold']);
    expect(result.manifest?.totalMinor).toBe(53_000 + 28_488);
    expect(result.manifest?.detail).toContain('not from what was ordered');
  });

  it('REFUSES to dispatch an unsealed crate', () => {
    const result = dispatchOrder({
      manifestId: 'MAN-1', orderId: 'O-1', locationId: 'store-1', pack: good,
      seals: { 'crate-ambient': 'seal-a' },
      dispatchedBy: 'u-packer', at: '2026-08-05T10:00:00Z',
    });
    expect(result.dispatched).toBe(false);
    expect(result.outcome).toBe('unsealed_crate');
    expect(result.detail).toContain('cannot be shown to have arrived as it left');
  });

  it('REFUSES while a short or refused line has not been resolved with the customer', () => {
    const short = pack([line({ orderedMinor: 3, pickedMinor: 2 })], { 'l-1': 'crate-1' });
    const result = dispatchOrder({
      manifestId: 'MAN-2', orderId: 'O-1', locationId: 'store-1', pack: short,
      seals: { 'crate-1': 'seal-a' }, dispatchedBy: 'u-packer', at: '2026-08-05T10:00:00Z',
    });
    expect(result.dispatched).toBe(false);
    expect(result.outcome).toBe('unresolved_lines');
    expect(result.detail).toContain('The doorstep is the worst place to have that conversation');

    // Once the customer has been told, it goes.
    const resolved = dispatchOrder({
      manifestId: 'MAN-2', orderId: 'O-1', locationId: 'store-1', pack: short,
      seals: { 'crate-1': 'seal-a' }, resolvedLineIds: ['l-1'],
      dispatchedBy: 'u-packer', at: '2026-08-05T10:00:00Z',
    });
    expect(resolved.dispatched).toBe(true);
  });

  it('refuses to dispatch nothing', () => {
    const empty = pack([]);
    const result = dispatchOrder({
      manifestId: 'MAN-3', orderId: 'O-1', locationId: 'store-1', pack: empty,
      seals: {}, dispatchedBy: 'u-packer', at: '2026-08-05T10:00:00Z',
    });
    expect(result.outcome).toBe('nothing_packed');
  });
});
