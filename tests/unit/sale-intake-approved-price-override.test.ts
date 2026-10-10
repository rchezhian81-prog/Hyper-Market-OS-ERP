import { describe, it, expect } from 'vitest';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/sale-intake';
import type { CatalogueProduct } from '../../packages/catalogue/src/catalogue';

/**
 * PF-07 · M12-FR-04 — a price LOWERED at the till with a manager's approval reaches head office on the sale line with
 * where it came from and who approved it. The intake still lists the difference (a record, never a control), but as
 * explained — not "the lane was on the current pack and still charged a different price. Check the lane." An unexplained
 * difference keeps its material finding.
 */
describe('the sale intake recognises an approved till price override (PF-07)', () => {
  const ghee = { productId: 'P1', sku: 'GHEE-1L', name: 'Ghee 1L', unitPriceMinor: 64_000, mrpMinor: 70_000 } as unknown as CatalogueProduct;
  const sale = (line: Partial<IncomingSale['lines'][number]> = {}): IncomingSale => ({
    saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-10-10', committedAt: '2026-10-10T10:00:00.000Z',
    totalMinor: 50_000, currency: 'INR', packVersion: 1,
    lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 50_000, lineTotalMinor: 50_000, ...line }],
    tenders: [{ kind: 'cash', amountMinor: 50_000 }],
  });
  const ctx: IntakeContext = { catalogue: new Map([['P1', ghee]]), currentPackVersion: 1, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2026-10-10T11:00:00.000Z' };
  const priceFinding = (s: IncomingSale) => acceptSale(s, ctx).exceptions.find((e) => e.kind === 'price_differs_from_catalogue');

  it('an approved override from the catalogue price is informational and names the approver and the evidence', () => {
    const f = priceFinding(sale({ priceOverride: { fromUnitPriceMinor: 64_000, approvedBy: 'u-manager', activityId: 'O-1' } }));
    expect(f).toMatchObject({ severity: 'informational', differenceMinor: -14_000 });
    expect(f!.detail).toMatch(/u-manager's approval/);
    expect(f!.ownerAction).toMatch(/O-1/);
  });
  it('without an approval — or claiming a different starting price — it stays material', () => {
    expect(priceFinding(sale())).toMatchObject({ severity: 'material' });
    expect(priceFinding(sale({ priceOverride: { fromUnitPriceMinor: 64_000 } }))).toMatchObject({ severity: 'material' });
    expect(priceFinding(sale({ priceOverride: { fromUnitPriceMinor: 99_000, approvedBy: 'u-manager' } }))).toMatchObject({ severity: 'material' });
  });
});
