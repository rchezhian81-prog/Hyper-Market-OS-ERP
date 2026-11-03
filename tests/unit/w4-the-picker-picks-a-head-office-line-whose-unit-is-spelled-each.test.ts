import { describe, it, expect } from 'vitest';
import { PickSession, type PickLineInput } from '../../apps/picker-app/src/pick-session';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';

// W4 · M19-FR-02 — found by the connected run of the picker's phone (tests/e2e/w4-m19-the-picker-and-driver-phones-reach-
// head-office-on-postgresql.e2e.ts). Head office's wave lines carry the product master's unit AS SPELLED — "each" for most
// of the shop — while the phone's quantity helpers were keyed on the stored code "ea". The quantity sheet was pre-filled
// "NaN.NaN", what the picker confirmed read as nothing, and the pick silently did not happen: no banner, no record, the line
// still "Not done yet". The session now reads each line's unit through the one shared spelling map (OB-31 rule 4), so an
// "each" line is a whole count, a "KG" line is grams, and the line is priced exactly. Synthetic data only.

// The phone's type promises a stored code; the store computer serves head office's line as it came (a plain string).
type AsServed = PickLineInput['uom'];
const WORK: PickLineInput[] = [
  { lineId: 'ORD-1:RICE', orderRef: 'ORD-1', productId: 'RICE', description: 'Synthetic RICE', bin: 'A-01', requiredQty: 2, uom: 'each' as AsServed, unitPrice: money(80_00, 'INR') },
  { lineId: 'ORD-1:DAL', orderRef: 'ORD-1', productId: 'DAL', description: 'Synthetic DAL (loose)', bin: 'A-02', requiredQty: 1500, uom: 'KG' as AsServed, unitPrice: money(120_00, 'INR') },
];
const wave = () => new PickSession('W-1', WORK, new SyncOutbox(), { now: () => '2026-11-03T10:00:00Z', pickerId: 'u-picker' });

describe('W4 — the picker picks a head-office line whose unit is spelled "each" (M19-FR-02)', () => {
  it('the sheet is pre-filled "2", the typed "2" is two items, and the pick is recorded at the exact price', () => {
    const s = wave();
    expect(s.typedText('ORD-1:RICE', 2)).toBe('2');
    expect(s.takesDecimal('ORD-1:RICE')).toBe(false);
    const qty = s.quantityFromTyped('ORD-1:RICE', s.typedText('ORD-1:RICE', 2));
    expect(qty).toBe(2);
    s.scanBin('A-01');
    const line = s.pick('ORD-1:RICE', 'RICE', qty!);
    expect(line.state).toBe('picked');
    expect(line.finalPrice.minor).toBe(160_00);
  });

  it('a line spelled "KG" is weighed in grams and priced to the paisa', () => {
    const s = wave();
    expect(s.typedText('ORD-1:DAL', 1500)).toBe('1.500');
    expect(s.takesDecimal('ORD-1:DAL')).toBe(true);
    s.scanBin('A-02');
    const line = s.pick('ORD-1:DAL', 'DAL', s.quantityFromTyped('ORD-1:DAL', '1.25')!);
    expect(line.pickedQty).toBe(1250);
    expect(line.finalPrice.minor).toBe(150_00);
  });
});
