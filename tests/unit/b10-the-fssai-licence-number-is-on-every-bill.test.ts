import { describe, it, expect } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { currentFoodLicence, type Obligation } from '../../packages/compliance/src/obligations';
import { fssaiLicenceNumberOn } from '../../packages/receipt/src/receipt';

/**
 * **B10 (FSSAI Licensing and Registration Regulations — the licence number on every cash memo / bill).** The store's
 * current FSSAI licence comes from head office's compliance register (an active FSSAI licence with its number, for this
 * store or the whole business, in force today); the till prints `FSSAI Lic. No. …` on every bill — the plain bill and the
 * real-trading tax invoice, English and Tamil — while the licence is in force by the till's OWN clock (no network); when
 * none is held, or it has run out, NO number is printed (never a made-up or expired one). Synthetic data only.
 */

const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const lic = (o: Partial<Obligation> & { obligationId: string }): Obligation => ({
  tenantId: 't', branchId: 'S1', kind: 'licence', name: 'FSSAI State Licence', authority: 'FSSAI', reference: '12419999000123',
  validFrom: '2025-01-01', expiresOn: '2099-12-31', responsible: { userId: 'u-owner', name: 'Owner' }, status: 'active', ...o,
});

describe('B10 — which licence is the store\'s current FSSAI licence', () => {
  it('an active FSSAI licence with its number, for this store or the business, in force on the day; the store\'s own first', () => {
    expect(currentFoodLicence([lic({ obligationId: 'o1' })], { branchId: 'S1', day: TODAY })).toEqual({ number: '12419999000123', validUntil: '2099-12-31', obligationId: 'o1' });
    expect(currentFoodLicence([lic({ obligationId: 'o1', authority: ' fssai ' })], { branchId: 'S1', day: TODAY })?.number).toBe('12419999000123');
    // Not a licence, another authority, closed, another store, no number, not yet in force, run out — none of them.
    for (const o of [
      lic({ obligationId: 'x1', kind: 'certificate' }), lic({ obligationId: 'x2', authority: 'Legal Metrology' }),
      lic({ obligationId: 'x3', status: 'closed' }), lic({ obligationId: 'x4', branchId: 'S2' }),
      lic({ obligationId: 'x5', reference: '  ' }), lic({ obligationId: 'x6', validFrom: '2099-01-01' }),
      lic({ obligationId: 'x7', expiresOn: '2020-03-31' }),
    ]) expect(currentFoodLicence([o], { branchId: 'S1', day: TODAY }), o.obligationId).toBeUndefined();
    // The store's own licence beats the business-wide registration; of two of the store's own, the later one.
    const all = [lic({ obligationId: 'biz', branchId: null, reference: 'BIZ-1' }), lic({ obligationId: 'old', reference: 'OLD-1', validFrom: '2024-01-01' }), lic({ obligationId: 'new', reference: 'NEW-1', validFrom: '2025-06-01' })];
    expect(currentFoodLicence(all, { branchId: 'S1', day: TODAY })?.number).toBe('NEW-1');
    expect(currentFoodLicence(all, { branchId: 'S9', day: TODAY })?.number).toBe('BIZ-1');
  });
  it('the till prints it only while it is in force by its own clock; a malformed one prints nothing', () => {
    expect(fssaiLicenceNumberOn({ number: ' 124 ', validUntil: '2027-03-31' }, '2027-03-31')).toBe('124');
    expect(fssaiLicenceNumberOn({ number: '124', validUntil: '2027-03-31' }, '2027-04-01')).toBeUndefined();
    expect(fssaiLicenceNumberOn({ number: '124' }, '2099-01-01')).toBe('124');
    for (const bad of [undefined, null, 'x', { number: '' }, { number: 5 }]) expect(fssaiLicenceNumberOn(bad, TODAY)).toBeUndefined();
  });
});

const CAT: CatalogueSnapshot = {
  tenantId: 't-b10', version: 1, builtAt: NOW,
  products: [{ productId: 'P-DAL', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active', hsnCode: '071360' }],
  barcodes: [{ code: '890000000001', productId: 'P-DAL', kind: 'standard' }],
};
const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33ABCDE1234F1Z5', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601'] };
const till = (extra: Record<string, unknown>) => bootPos({
  laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: TODAY, catalogue: CAT, taxPercent: 5, ...extra,
  durable: async () => ({ committed: true, durable: true, detail: 'd', laneMessage: 'ok' }),
});

describe('B10 — the till prints the FSSAI licence number on every bill, offline', () => {
  it('plain bill and real-trading tax invoice (English and Tamil) carry it; without one, or after it runs out, neither does', async () => {
    const plain = till({ fssaiLicence: { number: '12419999000123', validUntil: '2099-12-31' } });
    plain.scanBarcode('890000000001');
    await plain.tenderCash('S-1', 'L1-0001', NOW);
    const r = plain.receiptLines();
    if (!r.ok) throw new Error(r.why);
    expect(r.lines.join('\n')).toContain('FSSAI Lic. No. 12419999000123');

    const rt = till({ realTrading: true, taxInvoice: SHOP, fssaiLicence: { number: '12419999000123' } });
    rt.scanBarcode('890000000001');
    await rt.tenderCash('S-2', 'L1-0002', NOW);
    const en = rt.taxInvoice();
    const ta = rt.taxInvoice({ language: 'ta' });
    if (!en.ok || !ta.ok) throw new Error('no invoice');
    expect(en.lines.join('\n')).toContain('FSSAI Lic. No. 12419999000123');
    expect(en.rows.some((row) => row.fields.includes('fssai'))).toBe(true);
    expect(ta.lines.join('\n')).toContain('FSSAI உரிம எண் (Lic. No.) 12419999000123');

    for (const licence of [undefined, null, { number: '12419999000123', validUntil: '2020-03-31' }]) {
      const none = till({ realTrading: true, taxInvoice: SHOP, ...(licence === undefined ? {} : { fssaiLicence: licence }) });
      none.scanBarcode('890000000001');
      await none.tenderCash('S-3', 'L1-0003', NOW);
      const bill = none.receiptLines();
      const inv = none.taxInvoice();
      if (!bill.ok || !inv.ok) throw new Error('no bill');
      expect(bill.lines.join('\n')).not.toContain('FSSAI');
      expect(inv.lines.join('\n')).not.toContain('FSSAI');
    }
  });
});
