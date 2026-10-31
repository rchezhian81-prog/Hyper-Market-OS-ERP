import { describe, it, expect } from 'vitest';
import { PickSession, type PickLineInput } from '../../apps/picker-app/src/pick-session';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';

// Round B (PR #852) follow-up, OB-31 rule 1: the picker handheld worded a kg line in kilos by hand, but a LITRE line showed
// and took raw millilitres — 750 ml of loose oil read "Asked for 750", and a picker typing "1" for one litre picked 1 ml
// (a short pick of 749 ml, priced at ₹0.18). Both kg and L are now shown and typed in their own unit, through the shared
// quantity helper the model carries; items stay whole numbers. Synthetic data only.

const WORK: PickLineInput[] = [
  { lineId: 'oil', orderRef: 'ORD-9', productId: 'OIL-LOOSE', description: 'Groundnut oil (loose)', bin: 'C-01', requiredQty: 750, uom: 'L', unitPrice: money(240_00, 'INR') },
  { lineId: 'tom', orderRef: 'ORD-9', productId: 'TOMATO', description: 'Tomato', bin: 'C-02', requiredQty: 1500, uom: 'kg', unitPrice: money(40_00, 'INR') },
  { lineId: 'soap', orderRef: 'ORD-9', productId: 'SOAP', description: 'Bath soap', bin: 'C-03', requiredQty: 2, uom: 'ea', unitPrice: money(35_00, 'INR') },
];
const wave = () => new PickSession('W-9', WORK, new SyncOutbox(), { now: () => '2026-10-31T10:00:00Z' });

describe('the picker shows and takes kg and litres in their own unit (OB-31 · Round B follow-up)', () => {
  it('a litre line reads "0.750 L" (it read "750") and is offered as "0.750"; a kg line "1.500 kg"; items stay a count', () => {
    const s = wave();
    expect(s.quantityText('oil', 750)).toBe('0.750 L');
    expect(s.typedText('oil', 750)).toBe('0.750');
    expect(s.quantityText('tom', 1500)).toBe('1.500 kg');
    expect(s.quantityText('soap', 2)).toBe('2');
    expect(s.typedText('soap', 2)).toBe('2');
    expect([s.takesDecimal('oil'), s.takesDecimal('tom'), s.takesDecimal('soap')]).toEqual([true, true, false]);
  });

  it('"0.75" typed on the litre line is 750 ml picked in full at ₹180.00 — "1" would have been 1 ml', () => {
    const s = wave();
    const qty = s.quantityFromTyped('oil', '0.75');
    expect(qty).toBe(750);
    s.scanBin('C-01');
    const line = s.pick('oil', 'OIL-LOOSE', qty!);
    expect(line.state).toBe('picked');
    expect(line.finalPrice.minor).toBe(180_00);
    expect(s.quantityFromTyped('tom', '1.5')).toBe(1500);
    expect(s.quantityFromTyped('oil', '1')).toBe(1000);
  });

  it('refuses what the unit does not hold exactly: half an item, a fourth decimal, nought, a word', () => {
    const s = wave();
    expect(s.quantityFromTyped('soap', '1.5')).toBeUndefined();
    expect(s.quantityFromTyped('tom', '1.5005')).toBeUndefined();
    expect(s.quantityFromTyped('oil', '0')).toBeUndefined();
    expect(s.quantityFromTyped('oil', 'one')).toBeUndefined();
  });
});
