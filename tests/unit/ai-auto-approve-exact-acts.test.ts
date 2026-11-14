// CR-01 OI-12 step 6b · OB-761 A · OB-762 A — the assistants' drafts say EXACTLY what they would do, from numbers people
// already set (never invented), so an owner-set limit can measure them. Pure; synthetic data only.
//
//   • A02 reorder (OB-761 A): up to the product's MAX LEVEL from its stored reorder settings, through the tested replenishment
//     engine (pack rounding, supplier minimum), at the supplier's LAST price; the supplier's approval from the supplier master.
//     No settings, no known supplier or no last price → NO act (a person decides).
//   • A03 markdown (OB-762 A): the D-4 expiry ladder — only when a surplus will not sell in time; NO act when the ladder says
//     no markdown, or when the price, MRP or cost is not on record.
//   • A03 transfer: the destination's own reorder settings say how many; never more than the source can spare above what it
//     keeps for itself; valued at the source's cost. Anything not known → NO act.
import { describe, it, expect } from 'vitest';
import { reorderActOf, markdownActOf, transferActOf } from '../../services/api/src/ai-auto-approve-acts';

const settings = (over: Record<string, unknown> = {}) => ({
  storeId: 'br-1', productId: 'RICE', version: 2, maxLevel: 50_000, reorderPoint: 10_000, reason: 'synthetic', setBy: 'u-mgr', setAt: '2026-11-01T00:00:00.000Z', ...over,
});
const last = { supplierId: 'sup-synthetic-01', poId: 'po-old-1', unitCostMinor: 6_000 };

describe('A02 reorder — up to the max level, at the last price (OB-761 A)', () => {
  it('orders up to the max level through the tested engine, at the supplier\'s last price', () => {
    const r = reorderActOf({ productId: 'RICE', storeId: 'br-1', uom: 'kg', settings: settings(), position: { onHand: 2_000, onOrder: 0, reserved: 0 }, last, supplierStatus: 'active' });
    expect(r.act).toEqual({
      kind: 'reorder_from_approved_supplier', supplierId: 'sup-synthetic-01', supplierApproved: true, valueMinor: 288_000,
      lines: [{ productId: 'RICE', qty: 48_000, unitCostMinor: 6_000, uom: 'kg' }], deliverToLocationId: 'br-1',
      basis: expect.stringMatching(/version 2.*max level.*po-old-1/),
    });
  });

  it('rounds up to the pack and to the supplier minimum, as the engine does', () => {
    const r = reorderActOf({ productId: 'SOAP', storeId: 'br-1', uom: 'ea', settings: settings({ productId: 'SOAP', maxLevel: 100, reorderPoint: 20, orderMultiple: 24, minOrderQty: 48 }), position: { onHand: 10, onOrder: 5, reserved: 0 }, last: { ...last, unitCostMinor: 3_000 }, supplierStatus: 'active' });
    expect(r.act).toMatchObject({ lines: [{ qty: 96 }], valueMinor: 288_000 });
  });

  it('carries the supplier master\'s answer — a supplier still waiting for finance is said, not hidden', () => {
    const r = reorderActOf({ productId: 'RICE', storeId: 'br-1', uom: 'kg', settings: settings(), position: { onHand: 0, onOrder: 0, reserved: 0 }, last, supplierStatus: 'pending_approval' });
    expect(r.act).toMatchObject({ supplierApproved: false });
  });

  it('no act without reorder settings, without a known supplier and last price, or when nothing is due', () => {
    const base = { productId: 'RICE', storeId: 'br-1', uom: 'kg', position: { onHand: 0, onOrder: 0, reserved: 0 }, supplierStatus: 'active' } as const;
    expect(reorderActOf({ ...base, last })).toMatchObject({ why: expect.stringMatching(/no reorder settings/i) });
    expect(reorderActOf({ ...base, settings: settings() })).toMatchObject({ why: expect.stringMatching(/no earlier purchase order/i) });
    expect(reorderActOf({ ...base, settings: settings(), last, position: { onHand: 40_000, onOrder: 0, reserved: 0 } })).toMatchObject({ why: expect.stringMatching(/above its reorder point/i) });
    expect(reorderActOf({ ...base, settings: settings(), last: { ...last, per: 25 } })).toMatchObject({ why: expect.stringMatching(/per pack/i) });
  });
});

describe('A03 markdown — the D-4 ladder, only for the surplus (OB-762 A)', () => {
  const md = { productId: 'CURD', batchId: 'b-curd-1', storeId: 'br-1', shelfPriceMinor: 4_000, mrpMinor: 4_500, costMinor: 2_600 };
  it('cuts by the ladder for the days left when a surplus will not sell in time', () => {
    const r = markdownActOf({ ...md, daysToExpiry: 3, onHand: 24, avgDailyDemand: 4 });
    expect(r.act).toEqual({
      kind: 'markdown_short_dated', productId: 'CURD', batchId: 'b-curd-1', percentOffBps: 2_500, daysToExpiry: 3, storeId: 'br-1',
      currentPriceMinor: 4_000, newPriceMinor: 3_000, mrpMinor: 4_500, costMinor: 2_600, surplusQty: 12,
      basis: expect.stringMatching(/12 of 24.*25%/),
    });
    expect(markdownActOf({ ...md, daysToExpiry: 1, onHand: 24, avgDailyDemand: 4 }).act).toMatchObject({ percentOffBps: 5_000, newPriceMinor: 2_000 });
  });

  it('no act when it will sell in time, or the price, MRP or cost is not on record', () => {
    expect(markdownActOf({ ...md, daysToExpiry: 3, onHand: 10, avgDailyDemand: 4 })).toMatchObject({ why: expect.stringMatching(/sell before/i) });
    expect(markdownActOf({ ...md, shelfPriceMinor: undefined, daysToExpiry: 3, onHand: 24, avgDailyDemand: 0 }).act).toBeUndefined();
    expect(markdownActOf({ ...md, mrpMinor: undefined, daysToExpiry: 3, onHand: 24, avgDailyDemand: 0 }).act).toBeUndefined();
    expect(markdownActOf({ ...md, costMinor: undefined, daysToExpiry: 3, onHand: 24, avgDailyDemand: 0 }).act).toBeUndefined();
  });
});

describe('A03 transfer — the destination\'s settings, never more than the source can spare', () => {
  const tr = { productId: 'SOAP', fromLocationId: 'wh-1', toLocationId: 'br-1', uom: 'ea', unitCostMinor: 3_000 };
  it('moves what the destination\'s settings ask for, at the source\'s cost', () => {
    const r = transferActOf({ ...tr, destSettings: settings({ productId: 'SOAP', storeId: 'br-1', maxLevel: 24, reorderPoint: 6 }), destPosition: { onHand: 0, onOrder: 0, reserved: 0 }, sourceHeld: 100, sourceKeeps: 40 });
    expect(r.act).toEqual({ kind: 'stock_transfer', productId: 'SOAP', fromLocationId: 'wh-1', toLocationId: 'br-1', qty: 24, valueMinor: 72_000, uom: 'ea', basis: expect.stringMatching(/br-1.*max level 24.*wh-1 keeps 40/) });
  });

  it('never more than the source can spare', () => {
    expect(transferActOf({ ...tr, destSettings: settings({ productId: 'SOAP', maxLevel: 24, reorderPoint: 6 }), destPosition: { onHand: 0, onOrder: 0, reserved: 0 }, sourceHeld: 50, sourceKeeps: 40 }).act).toMatchObject({ qty: 10, valueMinor: 30_000 });
    expect(transferActOf({ ...tr, destSettings: settings({ productId: 'SOAP', maxLevel: 24, reorderPoint: 6 }), destPosition: { onHand: 0, onOrder: 0, reserved: 0 }, sourceHeld: 40, sourceKeeps: 40 })).toMatchObject({ why: expect.stringMatching(/nothing to spare/i) });
  });

  it('no act without the destination\'s settings, what the source keeps, or the source\'s cost', () => {
    const base = { ...tr, destPosition: { onHand: 0, onOrder: 0, reserved: 0 }, sourceHeld: 100 };
    expect(transferActOf({ ...base, sourceKeeps: 0 }).act).toBeUndefined();
    expect(transferActOf({ ...base, destSettings: settings({ productId: 'SOAP', maxLevel: 24 }) }).act).toBeUndefined();
    expect(transferActOf({ ...base, destSettings: settings({ productId: 'SOAP', maxLevel: 24 }), sourceKeeps: 10, unitCostMinor: undefined }).act).toBeUndefined();
  });
});
