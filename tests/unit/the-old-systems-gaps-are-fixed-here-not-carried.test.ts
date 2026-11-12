import { describe, it, expect } from 'vitest';
import { analyseOldSystem, importSummary, isReady, resolveImport, sliceFilesFor, validateFix, type ImportFix, type OldItem } from '../../packages/migration/src/old-system-import';
import { PILOT_CATEGORY_ID, type SheetRow } from '../../packages/migration/src/bpal-slice';
import { stageSlice } from '../../packages/migration/src/slice-import';

// OB-704 (owner, 7 Nov 2026): "I want to fill the gaps in our software. I don't want to carry the gaps." The old ERP's
// gaps — a barcode with a wrong check digit, one HSN at two GST rates, a missing price, the five label facts a packed
// food needs — are each FIXED here by a person, every fix kept; an item with any gap left is never written. Made-up data.

const table = (rows: readonly (readonly string[])[]): SheetRow[] => rows.slice(1).map((r) => Object.fromEntries(rows[0]!.map((h, i) => [h, r[i] ?? ''])));
const EAN = table([['Item Id', 'Item Name', 'EanCode'],
  ['11', 'TEST RICE 1KG', '8901234567890'], ['12', 'TEST DAL 500G', '8901234567911'] /* wrong check digit */, ['13', 'TEST TEA 250G', '8901234567920'],
  ['14', 'TEST COFFEE', '8901234567937'], ['15', 'TEST BISCUIT', '8901234567944'], ['16', 'TEST CHIPS', '8901234567944'] /* same as 15 */]);
const HSN = table([['Item Id', 'Item Name', 'Hsn Code', 'Item Quantity', 'Gst %', 'Cess Amt', 'Addl Cess Amt'],
  ['11', 'TEST RICE 1KG', '10063020', '500', '5', '0', '0'],
  ['12', 'TEST DAL 500G', '07133100', '300', '5', '0', '0'],
  ['13', 'TEST TEA 250G', '09023020', '200', '5', '0', '0'], ['13', 'TEST TEA 250G', '09023020', '10', '0', '0', '0'], // two readings
  ['14', 'TEST COFFEE', '09012190', '50', '5', '0', '0'],
  ['15', 'TEST BISCUIT', '19053100', '40', '18', '0', '0'], ['16', 'TEST CHIPS', '19053100', '30', '5', '0', '0'],
  ['90', 'TEST SOAP', '34011110', '900', '18', '0', '0']]);
const BUYS = table([['Purc Date', 'Purc No', 'Item Id', 'Cost', 'NetCost', 'Selling', 'MRP'],
  ['01/11/2026', '1', '11', '60', '60', '70', '80'], ['02/11/2026', '2', '12', '50', '50', '60', '65'],
  ['02/11/2026', '3', '13', '90', '90', '120', '110'] /* selling above MRP */, ['02/11/2026', '4', '15', '8', '8', '9', '10'], ['02/11/2026', '5', '16', '8', '8', '9', '10']]);

const items = (): readonly OldItem[] => analyseOldSystem({ eanRows: EAN, hsnRows: HSN, purchaseRows: BUYS, today: '2026-11-07' }).items;
const LABEL = { allergens: 'none', country_of_origin: 'India', net_quantity: '1 kg', packer: 'Test Foods, Chennai', consumer_care: '1800 000 000' };
let clock = 0;
const fix = (itemId: string, kind: ImportFix['kind'], value: Record<string, unknown>, by = 'owner-01'): ImportFix => ({ importId: 'imp-1', itemId, kind, value, reason: 'read off the pack', by, at: `2026-11-07T10:00:${String(clock++).padStart(2, '0')}.000Z` });
const byId = (r: ReturnType<typeof resolveImport>, id: string) => r.find((x) => x.itemId === id)!;
const kinds = (r: ReturnType<typeof resolveImport>, id: string) => byId(r, id).gaps.map((g) => g.kind).sort();

describe('the old system\'s gaps are fixed here, never carried (OB-704)', () => {
  it('reads the department (OB-694), best sellers first; soap is not in it', () => {
    expect(items().map((i) => i.itemId)).toEqual(['11', '12', '13', '14', '15', '16']);
  });

  it('every gap is named on its item — and with no fix, no item is ready (the label facts are never in the old ERP)', () => {
    const r = resolveImport(items(), []);
    expect(kinds(r, '11')).toEqual(['label']);
    expect(kinds(r, '12')).toEqual(['barcode', 'label']);
    expect(kinds(r, '13')).toEqual(['label', 'price', 'tax']);
    expect(kinds(r, '14')).toEqual(['label', 'price']);
    expect(kinds(r, '15')).toEqual(['barcode', 'label', 'tax']); // shares a barcode with 16; its HSN carries two rates
    expect(byId(r, '12').gaps.find((g) => g.kind === 'barcode')!.why).toContain('8901234567911 has a wrong check digit');
    expect(byId(r, '13').gaps.find((g) => g.kind === 'tax')!.why).toContain('2 HSN/GST readings');
    expect(byId(r, '15').gaps.find((g) => g.kind === 'barcode')!.why).toContain('also on item 16');
    expect(r.filter(isReady)).toEqual([]);
    expect(importSummary(r).gaps).toEqual({ label: 6, barcode: 3, tax: 3, price: 2 }); // 12 (check digit), 15 and 16 (one shared barcode)
    expect(importSummary(r)).toMatchObject({ items: 6, ready: 0 });
  });

  it('each fix closes its own gap; the latest fix of a kind applies; "not in this department" takes an item out of every count', () => {
    const fixes = [
      fix('11', 'label', LABEL),
      fix('12', 'barcode', { barcodes: ['8901234567913'] }), fix('12', 'label', LABEL),
      fix('13', 'tax', { hsn: '09023020', gstPercent: 5 }, 'accountant-01'), fix('13', 'price', { mrp: '110', sell: '100', cost: '90' }), fix('13', 'label', LABEL),
      fix('13', 'price', { mrp: '120', sell: '115', cost: '90' }), // a later price replaces the earlier one — both are kept
      fix('16', 'exclude', { excluded: true }),
    ];
    const r = resolveImport(items(), fixes);
    expect(r.filter(isReady).map((x) => x.itemId)).toEqual(['11', '12', '13']);
    expect(byId(r, '13').price).toEqual({ mrp: 12000, sell: 11500, cost: 9000 });
    expect(byId(r, '13').fixedBy.tax?.by).toBe('accountant-01');
    expect(byId(r, '16').excluded).toBe(true);
    // With 16 out, 15's barcode is its own again and 19053100 carries one rate: only its label facts are left.
    expect(kinds(r, '15')).toEqual(['label']);
    expect(importSummary(r)).toMatchObject({ ready: 3, excluded: 1 });
  });

  it('a fix that would carry a gap in is refused by name, never trimmed into something else', () => {
    expect(validateFix('barcode', { barcodes: ['8901234567911'] }, 'scanned')).toEqual(['8901234567911 is not a pack barcode: 8, 12, 13 or 14 digits with a right check digit — scan it again']);
    expect(validateFix('price', { mrp: '50', sell: '60', cost: '40' }, 'from the bill').join(' ')).toContain('above the MRP');
    expect(validateFix('price', { mrp: '', sell: '60', cost: '40' }, 'from the bill').join(' ')).toContain('MRP must be an amount');
    expect(validateFix('tax', { hsn: '09023020', gstPercent: 7 }, 'checked').join(' ')).toContain('one of the slabs');
    expect(validateFix('tax', { hsn: '34011110', gstPercent: 18 }, 'checked').join(' ')).toContain('not packaged food');
    expect(validateFix('label', { ...LABEL, packer: '' }, 'read').join(' ')).toContain('packer is blank');
    expect(validateFix('label', LABEL, '')).toEqual(['say why, in a few words (for example "read off the pack")']);
    expect(validateFix('barcode', { barcodes: ['8901234567890'] }, 'scanned')).toEqual([]);
  });

  it('a loaded item is not loaded again, and the ready items become the four files the real slice importer stages with no exception', () => {
    const fixes = [fix('11', 'label', LABEL), fix('12', 'barcode', { barcodes: ['8901234567913'] }), fix('12', 'label', LABEL)];
    expect(resolveImport(items(), fixes, new Set(['11'])).filter(isReady).map((x) => x.itemId)).toEqual(['12']);
    const ready = resolveImport(items(), fixes).filter(isReady);
    const staged = stageSlice({ department: { categoryId: PILOT_CATEGORY_ID, name: 'Packaged groceries', regulated: ['food', 'packed'] }, files: sliceFilesFor(ready, '2026-11-06') });
    expect(staged.headerProblems).toEqual([]);
    expect(staged.exceptions).toEqual([]);
    expect(staged.bundle.products.map((p) => [p.productId, p.priceMinor, p.barcodes.map((b) => (typeof b === 'string' ? b : (b as { code: string }).code))])).toEqual([['11', 7000, ['8901234567890']], ['12', 6000, ['8901234567913']]]);
  });
});
