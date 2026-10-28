import { describe, it, expect } from 'vitest';
import {
  buildPackLabel, renderLabel, readNetQuantity, readLabelTemplate, labelPrintFacts, IncompleteLabelError, LabelTooSmallError,
  COUNTER_LABEL_TEMPLATE, DEPARTMENT_CATALOGUE, type PackLabel,
} from '../../packages/production/src/index';
import { money } from '../../packages/contracts/src/money';

/**
 * Round 6 · B9 · B24 · B3 — the tested `checkLooseFoodLabel`, `validateLabelHeight` and `unitSalePrice` now run inside
 * `buildPackLabel`, the one engine head office's label route and the store computer's counter label both call.
 */

const CAFE = DEPARTMENT_CATALOGUE['cafe']!;
const DELI = DEPARTMENT_CATALOGUE['deli']!;
const label = (over: Partial<PackLabel> = {}): PackLabel => ({
  productId: 'CAKE', productName: 'Synthetic cake', batchId: 'B-1', netQuantity: '450 g', packerDetails: 'SRE Hyper Market',
  useBy: '2026-10-29T06:00:00.000Z', price: money(120_00, 'INR'), allergens: ['eggs'], vegClass: 'non_veg', producedAt: '2026-10-27T06:00:00.000Z',
  ...over,
});

describe('B9: the veg mark and the eight allergen groups', () => {
  it('a food label with no veg / non-veg mark is blocked, naming the mark', () => {
    expect(() => buildPackLabel(label({ vegClass: undefined }), CAFE)).toThrow(/veg or non-veg mark/);
  });
  it('an allergen that is not one of the eight groups is blocked, listing the eight', () => {
    expect(() => buildPackLabel(label({ allergens: ['wheat'] }), CAFE)).toThrow(/"wheat" is not one of the recognised major allergen groups.*Sulphites/);
  });
  it('a silent declaration is blocked; an empty list is "none of the eight" and prints so', () => {
    expect(() => buildPackLabel(label({ allergens: undefined }), CAFE)).toThrow(IncompleteLabelError);
    expect(renderLabel(buildPackLabel(label({ allergens: [], vegClass: 'veg' }), CAFE))).toEqual(expect.arrayContaining(['[●] VEG', 'Allergens: none of the 8 major groups']));
  });
  it('the groups print in words, the mark first', () => {
    const lines = renderLabel(buildPackLabel(label({ allergens: ['peanuts_tree_nuts', 'sulphites'] }), CAFE));
    expect(lines[0]).toBe('[▲] NON-VEG');
    expect(lines).toContain('Contains: Peanuts and tree nuts, Sulphites');
  });
});

describe('B24: the template is judged against Rule 9 before anything prints', () => {
  it('the standard counter template carries its panel and heights, and passes', () => {
    const p = buildPackLabel(label(), CAFE);
    expect(p.template).toEqual(COUNTER_LABEL_TEMPLATE);
    expect(labelPrintFacts(p).print).toEqual({ templateId: 'counter-58x40', principalPanelAreaCm2: 23.2, minHeightMm: 1, letterHeightMm: 2, numeralHeightMm: 2 });
  });
  it('letters or numerals below the minimum for the panel fail — a too-small render', () => {
    expect(() => buildPackLabel(label({ template: { templateId: 'a', principalPanelAreaCm2: 600, letterHeightMm: 3, numeralHeightMm: 4 } }), CAFE)).toThrow(LabelTooSmallError);
    expect(() => buildPackLabel(label({ template: { templateId: 'b', principalPanelAreaCm2: 50, letterHeightMm: 0.8, numeralHeightMm: 1 } }), CAFE)).toThrow(/letters 0.8 mm is below the 1 mm minimum/);
    expect(() => buildPackLabel(label({ template: { templateId: 'c', principalPanelAreaCm2: 600, letterHeightMm: 4, numeralHeightMm: 4 } }), CAFE)).not.toThrow();
  });
  it('reads a printer template strictly', () => {
    expect(readLabelTemplate({ templateId: 't', principalPanelAreaCm2: 40, letterHeightMm: 2, numeralHeightMm: 2 })).toBeDefined();
    for (const bad of [null, [], {}, { templateId: '', principalPanelAreaCm2: 40, letterHeightMm: 2, numeralHeightMm: 2 }, { templateId: 't', principalPanelAreaCm2: 0, letterHeightMm: 2, numeralHeightMm: 2 }, { templateId: 't', principalPanelAreaCm2: 40, letterHeightMm: '2', numeralHeightMm: 2 }]) {
      expect(readLabelTemplate(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('B3: the unit sale price is on the label', () => {
  it('reads a net quantity into whole grams, millilitres or pieces', () => {
    expect(readNetQuantity('180 g')).toEqual({ netQuantity: 180, unit: 'g' });
    expect(readNetQuantity('1.5 kg')).toEqual({ netQuantity: 1500, unit: 'g' });
    expect(readNetQuantity('500ml')).toEqual({ netQuantity: 500, unit: 'ml' });
    expect(readNetQuantity('1 L')).toEqual({ netQuantity: 1000, unit: 'ml' });
    expect(readNetQuantity('6 pieces')).toEqual({ netQuantity: 6, unit: 'piece' });
    for (const bad of ['', '1', 'one slab', '1.5 g', '0 kg', '2 cups']) expect(readNetQuantity(bad), bad).toBeUndefined();
  });
  it('per kg from the net quantity, per kg from a weighed pack\'s weight, per piece for count', () => {
    expect(buildPackLabel(label(), CAFE).unitPrice).toMatchObject({ unitPriceMinor: 266_67, per: 'kg' });
    expect(buildPackLabel(label({ netQuantity: '250 g', weightMinor: 250, price: money(200_00, 'INR') }), DELI).unitPrice).toMatchObject({ unitPriceMinor: 800_00, per: 'kg' });
    expect(renderLabel(buildPackLabel(label({ netQuantity: '6 pieces', price: money(90_00, 'INR') }), CAFE))).toContain('Unit price ₹15.00 per piece');
  });
  it('a Legal Metrology label whose quantity cannot be divided, or with no price, is refused — never printed without it', () => {
    expect(() => buildPackLabel(label({ netQuantity: '1 slab' }), CAFE)).toThrow(/price per unit/);
    expect(() => buildPackLabel(label({ price: money(0, 'INR') }), CAFE)).toThrow(/a price above zero/);
  });
});
