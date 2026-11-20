import { describe, it, expect } from 'vitest';
import { PosSession, taxRateFromPercent, createPosView } from '../../apps/pos/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { CatalogueCache, type CatalogueSnapshot, type CatalogueProduct } from '../../packages/catalogue/src/catalogue';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/sale-intake';
import { standingBarcodes, type BarcodeLinkEvent } from '../../services/catalogue/src/barcodes';
import { barcodeHistoryOf } from '../../services/api/src/barcode-link-changes';
import { BarcodeRegistry } from '../../packages/product/src/index';

// C-7 (M03-FR-02 · batch 20d): the pure rules under "remove or move a wrongly keyed barcode".
//   • the register's codes standing now come from its append-only events — a removed code stands nowhere, a moved code on
//     its new item — and the tested one-code-one-item register rebuilds from them without a clash;
//   • an item's barcode history keeps every link: given, removed, moved away, moved here — with who, when and why;
//   • the till keeps the plain code it scanned on the sale line (a weight label carries none);
//   • head office raises a line whose scanned code now names another item (or none) when the till's pack was older — and
//     nothing when the till was on the current pack, or the code still names the same item.

const assigned = (code: string, productId: string, at: string): BarcodeLinkEvent => ({ type: 'assigned', at, assignment: { code, productId, kind: 'internal' } });
const meta = { requestId: 'req-1', proposedBy: 'u-mgr', approvedBy: 'u-owner', reason: 'keyed wrong (synthetic)' };

describe('C-7: the barcode register after a removal and a move', () => {
  const events: BarcodeLinkEvent[] = [
    assigned('A1', 'SALT', '2026-11-01T00:00:00Z'),
    assigned('WRONG', 'SALT', '2026-11-02T00:00:00Z'),
    assigned('O1', 'OIL', '2026-11-02T00:00:00Z'),
    assigned('WRONG', 'SALT', '2026-11-03T00:00:00Z'), // an import re-run: the same link again, said once
    { type: 'released', at: '2026-11-10T00:00:00Z', release: { code: 'WRONG', productId: 'SALT', kind: 'internal', movedTo: { code: 'WRONG', productId: 'SUGAR', kind: 'internal' }, ...meta } },
    assigned('WRONG', 'SUGAR', '2026-11-10T00:00:00Z'),
    { type: 'released', at: '2026-11-11T00:00:00Z', release: { code: 'O1', productId: 'OIL', kind: 'internal', ...meta, requestId: 'req-2' } },
  ];

  it('stands where it was last put; a removed code stands nowhere; the tested register rebuilds without a clash', () => {
    const standing = standingBarcodes(events);
    expect(standing.map((a) => [a.code, a.productId])).toEqual([['A1', 'SALT'], ['WRONG', 'SUGAR']]);
    const registry = new BarcodeRegistry(standing);
    expect(registry.lookup('WRONG')?.productId).toBe('SUGAR');
    expect(registry.lookup('O1')).toBeUndefined();
    // A code freed by a removal can be given again (to the right item).
    expect(standingBarcodes([...events, assigned('O1', 'GHEE', '2026-11-12T00:00:00Z')]).find((a) => a.code === 'O1')?.productId).toBe('GHEE');
    // A release that names an item the code is not on changes nothing (never trusted blindly).
    expect(standingBarcodes([assigned('X', 'A', 't1'), { type: 'released', at: 't2', release: { code: 'X', productId: 'B', kind: 'internal', ...meta } }]).map((a) => a.productId)).toEqual(['A']);
  });

  it('every link stays in the item\'s history, with who proposed it, who approved it and why', () => {
    expect(barcodeHistoryOf(events, 'SALT').map((r) => [r.code, r.what, r.otherProductId ?? ''])).toEqual([['A1', 'given', ''], ['WRONG', 'given', ''], ['WRONG', 'moved_away', 'SUGAR']]);
    expect(barcodeHistoryOf(events, 'SUGAR')).toEqual([{ code: 'WRONG', what: 'moved_here', at: '2026-11-10T00:00:00Z', kind: 'internal', otherProductId: 'SALT', ...meta }]);
    expect(barcodeHistoryOf(events, 'OIL').map((r) => [r.code, r.what, r.requestId ?? ''])).toEqual([['O1', 'given', ''], ['O1', 'removed', 'req-2']]);
    expect(barcodeHistoryOf(events, 'NOTHING')).toEqual([]);
  });
});

const product = (productId: string, name: string): CatalogueProduct => ({ productId, sku: productId, name, baseUom: 'ea', unitPriceMinor: 50_00, taxBps: 500, status: 'active' });

describe('C-7: the till keeps the code it scanned on the sale line', () => {
  it('a plain scan carries its code onto the basket line and the sale record; a line added by id carries none', async () => {
    const records: Record<string, unknown>[] = [];
    const clock = '2030-06-10T06:00:00.000Z';
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2030-06-10', currency: 'INR', defaultTaxRate: taxRateFromPercent(5), clock: () => clock },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      (_id, record) => { records.push(JSON.parse(String(record)) as Record<string, unknown>); return Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'Sale complete.' }); },
    );
    const snapshot: CatalogueSnapshot = { tenantId: 't', version: 1, builtAt: clock, products: [product('SALT', 'Salt'), product('SUGAR', 'Sugar')], barcodes: [{ code: 'C7-WRONG', productId: 'SALT', kind: 'standard' }] };
    const catalogue = new CatalogueCache(snapshot);
    expect(catalogue.scan('C7-WRONG')).toMatchObject({ product: { productId: 'SALT' }, scannedCode: 'C7-WRONG' });
    const view = createPosView(session, 'INR', catalogue);
    view.scanBarcode(' C7-WRONG ');
    view.scan({ productId: 'SUGAR', description: 'Sugar', unitPriceMinor: 50_00, qty: 1, uom: 'ea' });
    await view.tenderCash('S-1', 'R-1', clock);
    const lines = records[0]!['lines'] as { productId: string; scannedCode?: string }[];
    expect(lines.map((l) => [l.productId, l.scannedCode])).toEqual([['SALT', 'C7-WRONG'], ['SUGAR', undefined]]);
  });
});

describe('C-7: head office raises a scanned code that now names another item', () => {
  const ctx = (barcodeOwners?: ReadonlyMap<string, string>, currentPackVersion = 2): IntakeContext => ({
    catalogue: new Map([['SALT', product('SALT', 'Salt')], ['SUGAR', product('SUGAR', 'Sugar')]]), currentPackVersion,
    saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2030-06-10T10:00:00.000Z', ...(barcodeOwners === undefined ? {} : { barcodeOwners }),
  });
  const sale = (productId: string, packVersion: number, scannedCode?: string): IncomingSale => ({
    saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2030-06-10', committedAt: '2030-06-10T10:00:00.000Z',
    totalMinor: 50_00, currency: 'INR', packVersion, tenders: [{ kind: 'cash', amountMinor: 50_00 }],
    lines: [{ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: 50_00, lineTotalMinor: 50_00, ...(scannedCode === undefined ? {} : { scannedCode }) }],
  });
  const found = (s: IncomingSale, c: IntakeContext) => acceptSale(s, c).exceptions.filter((e) => e.kind === 'barcode_changed_since_the_tills_pack');

  it('moved: a till on the old pack sold it as the old item — material, naming both items; the sale still banks', () => {
    const result = acceptSale(sale('SALT', 1, 'C7-WRONG'), ctx(new Map([['C7-WRONG', 'SUGAR']])));
    expect(result.banked).toBe(true);
    const f = result.exceptions.filter((e) => e.kind === 'barcode_changed_since_the_tills_pack');
    expect(f).toEqual([expect.objectContaining({ severity: 'material', productId: 'SALT', detail: "barcode C7-WRONG was sold as SALT by a till on catalogue v1; head office's catalogue v2 has it on SUGAR" })]);
  });
  it('removed: the code names no item now — said so', () => {
    expect(found(sale('SALT', 1, 'C7-WRONG'), ctx(new Map()))[0]!.detail).toMatch(/no longer has this barcode on any item$/);
  });
  it('nothing raised: the same item; the till on the current pack; no code on the line; nobody looked', () => {
    expect(found(sale('SALT', 1, 'C7-SALT'), ctx(new Map([['C7-SALT', 'SALT']])))).toEqual([]);
    expect(found(sale('SALT', 2, 'C7-WRONG'), ctx(new Map([['C7-WRONG', 'SUGAR']])))).toEqual([]);
    expect(found(sale('SALT', 1), ctx(new Map([['C7-WRONG', 'SUGAR']])))).toEqual([]);
    expect(found(sale('SALT', 1, 'C7-WRONG'), ctx())).toEqual([]);
  });
});
