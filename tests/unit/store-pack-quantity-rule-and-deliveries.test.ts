import { describe, it, expect } from 'vitest';
import { PACK_QUANTITY_SCALE } from '../../services/api/src/store-pack-builder';
import { withChosenDelivery } from '../../apps/warehouse-app/src/browser-entry';

/**
 * **PA-06 3b(e) · OB-31 "A" — one quantity rule across store-pack sections — and OB-37 "A", the phone chooses among the
 * store's open deliveries.** Every quantity is in the product's smallest step (grams for kg), every price per whole unit.
 */

describe('the store-pack quantity rule (OB-31, packages/contracts/src/quantity.ts)', () => {
  it('every quantity in every section is in the smallest step; units are the normalised codes', () => {
    for (const [section, fields] of Object.entries(PACK_QUANTITY_SCALE)) {
      for (const [field, scale] of Object.entries(fields)) {
        const ok = field.endsWith('uom') ? scale === 'normalised unit code' : scale.startsWith('smallest step');
        expect(ok, `${section}.${field}: ${scale}`).toBe(true);
      }
    }
  });
});

describe('the warehouse phone receives against the delivery at the door (OB-37)', () => {
  const ordered = (q: number) => [{ productId: 'rice', quantityMinor: q, unitCost: { minor: 5_000, currency: 'INR' as const } }];
  const base = { assignmentId: 'warehouse-S1', workerId: 'u-ravi', storeId: 'WH', bins: [] };
  const two = { ...base, openDeliveries: [
    { poId: 'po-1', number: 'PO-1', supplierId: 'sup-1', grnId: 'grn-po-1-1', ordered: ordered(25_000) },
    { poId: 'po-2', number: 'PO-2', supplierId: 'sup-2', grnId: 'grn-po-2-1', ordered: ordered(5_000) },
  ] };

  it('the chosen delivery fills the order lines and the receipt id', () => {
    expect(withChosenDelivery(two, 'po-2')).toMatchObject({ poId: 'po-2', grnId: 'grn-po-2-1', ordered: ordered(5_000) });
  });

  it('several waiting and none (or an unknown one) chosen: nothing is preset — never a made-up delivery', () => {
    for (const chosen of [null, 'po-9']) {
      const out = withChosenDelivery({ ...two, grnId: 'stale', poId: 'stale', ordered: ordered(1) }, chosen)!;
      expect([out.grnId, out.poId, out.ordered]).toEqual([undefined, undefined, undefined]);
      expect(out.openDeliveries).toHaveLength(2);
    }
  });

  it('exactly one waiting: it is preset; no list from the box: the assignment is left as it came', () => {
    expect(withChosenDelivery({ ...base, openDeliveries: [two.openDeliveries[0]!] }, null)).toMatchObject({ poId: 'po-1', grnId: 'grn-po-1-1' });
    const legacy = { ...base, grnId: 'g', poId: 'p', ordered: ordered(3) };
    expect(withChosenDelivery(legacy, 'po-1')).toBe(legacy);
    expect(withChosenDelivery(undefined, null)).toBeUndefined();
  });
});
