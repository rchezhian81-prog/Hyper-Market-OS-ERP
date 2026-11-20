import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { WarehouseSession, FEEDBACK_CODES } from '../../apps/warehouse-app/src/warehouse-session';
import { casePacksFor } from '../../edge/store-edge/src/screen-data';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { readCasePacks } from '../../apps/web-erp/src/browser-entry';
import { createManagerSession, type ManagerConfig } from '../../apps/web-erp/src/manager-session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';

/**
 * **Batch 20a — offline on the store computer and the handheld (synthetic data):**
 *   • The warehouse handheld's receive takes the MRP printed on the pack and "failed quality check / refused at the door" —
 *     the same engine and rules as Receive (office): a failed scan is received but held out of stock (quarantine, never put
 *     where it sells); an MRP that is not an amount is refused on the phone, nothing queued; both ride on the scan.
 *   • R7: the store computer serves head office's case sizes read strictly; the manager's screen reads them strictly too.
 */

const AT = '2026-11-20T06:00:00.000Z';
const PACKS = [{ productId: 'p-oil', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890OIL' }] }];
const handheld = (outbox: SyncOutbox) => new WarehouseSession({
  assignmentId: 'A-1', workerId: 'u-recv', storeId: 'store-1', grnId: 'g-1', poId: 'po-32',
  bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
  barcodes: [{ barcode: '890OIL', productId: 'p-oil', level: 'unit' }], packs: PACKS,
} as never, outbox, { now: () => AT });

describe('the handheld: the pack\'s MRP and a failed quality check (M07-FR-02/03)', () => {
  it('an MRP that is not an amount is refused on the phone — nothing received, nothing queued — in words in both languages', () => {
    const outbox = new SyncOutbox();
    const s = handheld(outbox);
    for (const bad of [0, -100, 99.5]) {
      const r = s.receive({ commandId: `c-bad-${bad}`, grnId: 'g-1', barcode: '890OIL', scannedQuantity: 1, source: 'po', mrpMinor: bad });
      expect([r.result.accepted, r.signal.code, r.signal.feedback]).toEqual([false, 'mrp_not_an_amount', 'reject']);
    }
    expect(outbox.all()).toEqual([]);
    expect(FEEDBACK_CODES).toContain('mrp_not_an_amount');
  });

  it('a good scan carries the MRP; a failed scan is received but held out (quarantine) and cannot be put where it sells', () => {
    const outbox = new SyncOutbox();
    const s = handheld(outbox);
    expect(s.receive({ commandId: 'c-1', grnId: 'g-1', barcode: '890OIL', scannedQuantity: 9, source: 'po', mrpMinor: 22_000 }).result.accepted).toBe(true);
    expect(s.receive({ commandId: 'c-2', grnId: 'g-1', barcode: '890OIL', scannedQuantity: 3, source: 'po', qcFailed: true }).result.accepted).toBe(true);
    const payloads = outbox.all().map((i) => i.event.payload as Record<string, unknown>);
    expect(payloads[0]).toMatchObject({ productId: 'p-oil', quantityMinor: 9, state: 'on_hand', mrpMinor: 22_000 });
    expect(payloads[0]).not.toHaveProperty('qcFailed');
    expect(payloads[1]).toMatchObject({ productId: 'p-oil', quantityMinor: 3, state: 'quarantine', qcFailed: true });
    expect(payloads[1]).not.toHaveProperty('mrpMinor');
    // The failed goods wait apart; putting them into a pickable bin is refused.
    const held = s.goodsIn().find((g) => g.state === 'quarantine');
    expect(held).toMatchObject({ productId: 'p-oil', quantityMinor: 3 });
  });
});

describe('R7: the case sizes on the store computer and the manager\'s screen (M03-FR-02)', () => {
  it('the box serves head office\'s case sizes read strictly; absent stays absent', () => {
    const pack = readPack({ version: 1, casePacks: { 'p-oil': [{ level: 'case', units: 12 }, { level: 'bad', units: 1 }, { level: '', units: 6 }], 'p-x': 'no', '': [{ level: 'case', units: 4 }] } }, AT);
    expect(casePacksFor({ pack } as never)).toEqual({ casePacks: { 'p-oil': [{ level: 'case', units: 12 }] } });
    expect(casePacksFor({ pack: readPack({ version: 1 }, AT) } as never)).toEqual({});
    expect(readCasePacks({ 'p-oil': [{ level: 'case', units: 12 }, { level: 'x', units: 2.5 }] })).toEqual({ casePacks: { 'p-oil': [{ level: 'case', units: 12 }] } });
    expect(readCasePacks(undefined)).toEqual({});
  });

  it('the manager\'s session offers an item\'s case sizes, largest first, and works the units out exactly', () => {
    const session = createManagerSession({ casePacks: { 'p-soap': [{ level: 'inner', units: 6 }, { level: 'case', units: 24 }] } } as unknown as ManagerConfig, {} as never, new Ledger(new InMemoryLedgerStore()), new SyncOutbox());
    expect(session.casePacksOf('p-soap')).toEqual([{ level: 'case', units: 24 }, { level: 'inner', units: 6 }]);
    expect(session.casePacksOf('p-oil')).toEqual([]);
    expect(session.unitsFromCases(4, 24, 3)).toBe(99);
    expect(session.unitsFromCases(4, 24, 0.5)).toBeUndefined();
  });
});
