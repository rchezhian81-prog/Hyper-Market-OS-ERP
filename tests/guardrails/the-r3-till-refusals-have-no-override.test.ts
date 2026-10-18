import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CatalogueCache, RecalledItemError, type CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { tillLineRefusals } from '../../packages/restricted-sales/src/till-gate';
import { tobaccoWarningRoutes } from '../../services/catalogue/src/tobacco-warning';

/**
 * **Release R3, lane 3 — every "no override exists" claim, locked in.**
 *
 *   • SF-08 · OB-139 "A": only a barcode that CARRIES its batch (a GS1 2D code read by the tested reader) can sell a
 *     sibling of a recalled batch. Nothing the lane is TOLD — a typed batch, a context passed by a screen — can.
 *   • B16 · OB-140 "A": a tobacco product's warning confirmation is recorded only by a named person, one product and one
 *     picture at a time; a product publish can never type one in, and there is no "confirm all".
 *   • B13 · OB-138: a gold line with no HUID, a HUID already sold, or two pieces under one HUID is refused — the gate has
 *     no input that lets a cashier or a manager wave it through.
 */

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url).pathname, 'utf8');
/** The body of `interface Name { … }` in a source file (the first one). */
const interfaceBody = (src: string, name: string): string => {
  const start = src.indexOf(`export interface ${name} {`);
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
  return src.slice(start, src.indexOf('\n}', start));
};

describe('SF-08: a recalled batch is unblocked only by the batch its own barcode carries', () => {
  const snapshot: CatalogueSnapshot = {
    tenantId: 't', version: 1, builtAt: '2030-06-01T00:00:00Z', barcodes: [{ code: '8901000000019', productId: 'p', kind: 'standard' }],
    products: [{ productId: 'p', sku: 'p', name: 'Paneer', baseUom: 'ea', unitPriceMinor: 1, taxBps: 0, status: 'active', recallBlock: true, blockedBatches: ['B-1'] }],
  };
  it('a plain barcode is refused whatever context the lane passes', () => {
    const cache = new CatalogueCache(snapshot);
    for (const ctx of [undefined, { asOf: '2030-06-10' }, { asOf: '2030-06-10', batchExpiry: '2030-07-01' }, { batchId: 'B-2' } as never]) {
      expect(() => cache.scan('8901000000019', ctx)).toThrow(RecalledItemError);
    }
  });
  it('the lane\'s batch context has no batch field to unblock with (only its date and the expiry)', () => {
    const body = interfaceBody(read('packages/catalogue/src/catalogue.ts'), 'ScanBatchContext');
    expect(body).not.toMatch(/batchId/);
  });
});

describe('B16: no confirmation can be typed in, and none covers more than one product', () => {
  it('the product publish reads no confirmation from the body', () => {
    const src = read('services/catalogue/src/product-master.ts');
    const reader = src.slice(src.indexOf('function readProduct('), src.indexOf('export function productMasterRoutes('));
    expect(reader).not.toMatch(/tobaccoWarning/);
    expect(reader).not.toMatch(/\.\.\.p\b|Object\.assign/); // no spread of the whole body into the record
  });
  it('every confirmation route names exactly one product', () => {
    const none = <T>(): Promise<T[]> => Promise.resolve([]);
    const routes = tobaccoWarningRoutes({ now: () => '2026-01-01T00:00:00Z', pictures: none, recordPicture: async () => {}, product: async () => undefined, products: none, publish: async () => {} });
    const writes = routes.filter((r) => r.method === 'POST' && /confirm/.test(r.path));
    expect(writes.map((r) => r.path)).toEqual(['/v1/catalogue/products/:productId/tobacco-warning-confirmation']);
  });
});

describe('B13 · B16: the till gate takes nothing that waves a refusal through', () => {
  it('the gate\'s context and line carry no override, approval or manager field', () => {
    const src = read('packages/restricted-sales/src/till-gate.ts');
    for (const name of ['TillGateContext', 'TillGateLine']) expect(interfaceBody(src, name)).not.toMatch(/override|approv|manager|waive/i);
  });
  it('each refusal stands whatever else the line says', () => {
    const base = { productId: 'p', description: 'Gold ring', quantityMinor: 1, uom: 'ea', unitPriceMinor: 100 };
    const extra = { listUnitPriceMinor: 100, chargedMinor: 100, catalogueUom: 'ea' };
    expect(tillLineRefusals({ ...base, ...extra, regulatedFlags: { gold: true } }, { today: '2030-01-01' })[0]?.reason).toBe('gold_without_huid');
    expect(tillLineRefusals({ ...base, ...extra, regulatedFlags: { gold: true, huid: 'AB12CD' } }, { soldHuids: new Set(['AB12CD']) })[0]?.reason).toBe('gold_huid_already_sold');
    expect(tillLineRefusals({ ...base, ...extra, regulatedFlags: { tobacco: true, packMinimumMinor: 1, tobaccoWarningConfirmedUntil: '2029-12-31' } }, { today: '2030-01-01' })[0]?.reason).toBe('tobacco_warning_confirmation_expired');
  });
  it('TRIPWIRE — the interface reader finds a field when one is there', () => {
    expect(interfaceBody('export interface X {\n  readonly managerOverride?: boolean;\n}', 'X')).toMatch(/override/i);
  });
});
