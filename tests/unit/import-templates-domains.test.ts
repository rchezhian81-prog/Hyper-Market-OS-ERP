import { describe, it, expect } from 'vitest';
import {
  supplierTemplate, priceListTemplate, openingStockTemplate, customerTemplate, loyaltyOpeningTemplate, DOMAIN_TEMPLATE_VIEWS,
} from '../../services/purchase/src/import-templates-domains';
import { memberRefFor } from '../../packages/loyalty/src/index';
import type { MemberRecord } from '../../services/customer/src/loyalty-members';
import type { RecordedPointsMovement } from '../../services/customer/src/index';

/**
 * OB-315 — the five further templates' own rules, over stand-in registers (pure; the integration test drives the API):
 * each refusal is a row exception with its reason; an opening is the first fact; the mobile number is never kept.
 */

const ctx = { jobId: 'J1', uploadedBy: 'u-mgr', approvedBy: 'u-owner', approvedAt: '2026-10-24T05:00:00Z', at: '2026-10-24T05:00:00Z' };
const KEY = Buffer.from('synthetic-member-key-for-tests-only');

describe('OB-315 templates', () => {
  it('ships five templates for the import screen', () => {
    expect(DOMAIN_TEMPLATE_VIEWS.map((t) => t.id)).toEqual(['supplier-v1', 'price-list-v1', 'opening-stock-v1', 'customer-v1', 'loyalty-opening-v1']);
  });

  it('suppliers arrive PROPOSED, with any shared name said as a possible duplicate, never merged', async () => {
    const t = supplierTemplate({ suppliers: async () => [{ supplierId: 'S-1', name: 'Amma Traders', gstin: null } as never], supplierInUse: async () => undefined });
    const [e] = await t.effects('T', [{ supplierId: 'SUP-9', name: 'amma traders' }], ctx);
    expect(e).toMatchObject({ kind: 'supplier', supplier: { status: 'proposed', createdBy: 'u-mgr', possibleDuplicates: ['S-1'], documents: [], version: 1 } });
  });

  it('a price is never loaded above MRP, below cost, below the floor, or where no floor is set', async () => {
    const t = priceListTemplate({ productIds: async () => ['P1'], storeIds: async () => ['S1', 'S2'], marginFloorFor: async (_t, s) => (s === 'S1' ? 2_000 : undefined), entries: async () => [] });
    const rows = [
      { productId: 'P1', storeId: 'S1', priceMinor: '12000', mrpMinor: '15000', costMinor: '9000' },
      { productId: 'P1', storeId: 'S1', priceMinor: '16000', mrpMinor: '15000', costMinor: '9000' },
      { productId: 'P1', storeId: 'S1', priceMinor: '8000', mrpMinor: '15000', costMinor: '9000' },
      { productId: 'P1', storeId: 'S1', priceMinor: '10000', mrpMinor: '15000', costMinor: '9000' },
      { productId: 'P1', storeId: 'S2', priceMinor: '12000', mrpMinor: '15000', costMinor: '9000' },
    ];
    const errors = await t.check('T', rows, [2, 3, 4, 5, 6], undefined);
    expect(errors.map((e) => [e.line, e.message.split(' ').slice(0, 3).join(' ')])).toEqual([
      [3, ['₹160.00', 'is', 'above'].join(' ')], [4, ['₹80.00', 'is', 'below'].join(' ')], [5, ['₹100.00', 'is', 'below'].join(' ')], [6, 'No margin floor'],
    ]);
  });

  it('opening stock is the first fact at a place — a product that already moved there is refused', async () => {
    const t = openingStockTemplate({
      productIds: async () => ['P1', 'P2'], knownPlace: async () => (l: string) => l === 'S1', productUom: async () => 'ea',
      movements: async () => [{ movementId: 'm1', productId: 'P2', locationId: 'S1', kind: 'received' }],
    });
    const errors = await t.check('T', [{ productId: 'P1', locationId: 'S1', quantity: '5', unitCostMinor: '100' }, { productId: 'P2', locationId: 'S1', quantity: '5', unitCostMinor: '100' }], [2, 3], undefined);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(3);
    const [e] = await t.effects('T', [{ productId: 'P1', locationId: 'S1', quantity: '5', unitCostMinor: '100' }], ctx);
    expect(e).toMatchObject({ kind: 'opening_stock', movement: { kind: 'received', quantityMinor: 5, unitCostMinor: 100, uom: 'ea', enteredBy: 'u-mgr', approvedBy: 'u-owner' } });
  });

  it('a customer loads only with their recorded yes; the job keeps the member code and last four, never the number', async () => {
    const t = customerTemplate({ memberKey: KEY, memberHistory: async () => [], pointsMovements: async () => [] });
    const row = { mobile: '9876543210', loyaltyConsent: 'yes', consentGivenOn: '2025-04-01', consentEvidence: 'paper form', name: 'Lakshmi R' };
    expect(await t.check('T', [row, { ...row, mobile: '9876543211', loyaltyConsent: 'no' }], [2, 3], undefined)).toHaveLength(1);
    const kept = t.storedRow!('T', row);
    expect(JSON.stringify(kept)).not.toContain('9876543210');
    expect(kept).toMatchObject({ memberRef: memberRefFor(KEY, '9876543210'), mobileLast4: '3210' });
    expect(kept['name']).toBeUndefined();
    const [e] = await t.effects('T', [row], ctx);
    expect(e).toMatchObject({ kind: 'customer', member: { status: 'member', verifiedHow: 'carried_from_old_erp', fullName: 'Lakshmi R', consentGivenAt: '2025-04-01T00:00:00.000Z' }, marketingConsent: { purpose: 'marketing', given: false } });
    // With no member key, nothing can be loaded — said on every row.
    const none = customerTemplate({ memberHistory: async () => [], pointsMovements: async () => [] });
    expect((await none.check('T', [row], [2], undefined))[0]!.message).toContain('no member key');
  });

  it('an opening points balance is refused for a member who already has points, and for a non-member', async () => {
    const ref = memberRefFor(KEY, '9876543210')!;
    const member: MemberRecord = { memberRef: ref, mobileLast4: '3210', status: 'member', consentGivenAt: '2025-01-01T00:00:00Z', enrolledBy: 'u', verifiedHow: 'seen_on_phone' };
    const moved: RecordedPointsMovement = { movementId: 'x', customerId: ref, delta: 10, reason: 'earn', sourceRef: null, at: '2026-01-01T00:00:00Z' };
    const t = loyaltyOpeningTemplate({ memberKey: KEY, memberHistory: async (_t, r) => (r === ref ? [member] : []), pointsMovements: async () => [moved] });
    const errors = await t.check('T', [{ mobile: '9876543210', points: '50', asOn: '2026-10-20' }, { mobile: '9999999999', points: '50', asOn: '2026-10-20' }], [2, 3], undefined);
    expect(errors.map((e) => `${e.line}:${e.column}`)).toEqual(['2:points', '3:mobile']);
    const [e] = await t.effects('T', [{ mobile: '9876543210', points: '50', asOn: '2026-10-20' }], ctx);
    expect(e).toMatchObject({ kind: 'loyalty_opening', movement: { movementId: `import-J1-opening-${ref}`, delta: 50, reason: 'earn' } });
    expect((e as { movement: RecordedPointsMovement }).movement.sourceRef).toContain('opening balance');
  });
});
