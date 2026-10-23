import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { encodeQr, qrPenalty, qrSvg, QrTooLongError } from '../../packages/receipt/src/qr-code';
import { b2cDynamicQrFor, b2cQrMissing } from '../../packages/receipt/src/b2c-dynamic-qr';
import { setupItem } from '../../packages/tenant/src/setup';
import { SETTINGS } from '../../packages/tenant/src/settings';
import { posLanePayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { emptyPack, known } from '../../edge/store-edge/src/store-pack';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **A22 (roadmap v2.1 · CGST Notification 14/2020-CT · owner OB-326 "build, switched OFF") — the dynamic QR on a B2C
 * invoice.** Off by default: SRE's bills do not change. Switched on with the shop's UPI ID, bank account and IFSC, the
 * real-trading tax invoice carries a QR whose UPI payment link holds the supplier's GSTIN, the UPI ID, the bank account
 * and IFSC, the invoice number and date, the total and the GST breakup (CGST, SGST, IGST, cess). Switched on with a detail
 * missing, no QR prints and the till says which is "not set". The QR encoder is checked module for module against an
 * independent implementation (python-qrcode 8.2, fixed masks). Synthetic data only.
 */

const rowsOf = (dark: readonly (readonly boolean[])[]): string[] => dark.map((r) => r.map((v) => (v ? '1' : '0')).join(''));
const sha = (rows: readonly string[]): string => createHash('sha256').update(rows.join('\n')).digest('hex');

describe('A22 — the QR encoder (ISO/IEC 18004, byte mode)', () => {
  it('matches an independent implementation module for module: version 1, 2, 10 and 13, with version info and many blocks', () => {
    const v1 = encodeQr('SRE', { ecl: 'M', mask: 2 });
    expect(v1).toMatchObject({ version: 1, size: 21, mask: 2, errorCorrection: 'M' });
    expect(rowsOf(v1.dark)).toEqual([
      '111111100110101111111', '100000100110001000001', '101110101011001011101', '101110101011101011101', '101110101110101011101',
      '100000101111001000001', '111111101010101111111', '000000001010000000000', '101111100111001111100', '000100011101111000110',
      '011010101110101100010', '001001010111111001111', '010000100010100100100', '000000001010100101110', '111111100011010011110',
      '100000101110000110111', '101110101111010010100', '101110101001111001000', '101110101100101100000', '100000100001111001000',
      '111111101000100100110',
    ]);
    const v2 = encodeQr('SRE Hyper Market', { ecl: 'M', mask: 2 });
    expect([v2.version, sha(rowsOf(v2.dark))]).toEqual([2, '33f2f56ca3e96c94b24a712853abe988c3aa3f3a5edd53ce0c7111887b508788']);
    const upi = 'upi://pay?pa=srehyper@okaxis&pn=SRE%20Hyper%20Market&am=1234.50&cu=INR&tr=TN01L1-26-000123&gstIn=33AAACS1234F1Z5&invoiceNo=TN01L1-26-000123&invoiceDate=2026-10-23&gstBrkUp=CGST:55.50|SGST:55.50|IGST:0.00|CESS:0.00';
    const v10 = encodeQr(upi, { ecl: 'M', mask: 5 });
    expect([v10.version, sha(rowsOf(v10.dark))]).toEqual([10, 'a69668fa76fb4205a07a98e4e6cadded752e2d9605076ec17cdd0bf38df0522f']);
    const v13 = encodeQr('x'.repeat(300), { ecl: 'M', mask: 7 });
    expect([v13.version, sha(rowsOf(v13.dark))]).toEqual([13, '0cfd1fee6e5cc6901de086d61debc646d3f80f5180898a1b724548d6c42006af']);
  });
  it('chooses the mask with the lowest penalty, is deterministic, refuses what cannot fit, and draws a quiet zone', () => {
    const chosen = encodeQr('upi://pay?pa=shop@bank&am=10.00');
    const penalties = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => qrPenalty(encodeQr('upi://pay?pa=shop@bank&am=10.00', { mask: m }).dark));
    expect(penalties[chosen.mask]).toBe(Math.min(...penalties));
    expect(encodeQr('upi://pay?pa=shop@bank&am=10.00')).toEqual(chosen);
    expect(() => encodeQr('x'.repeat(3_000), { ecl: 'H' })).toThrow(QrTooLongError);
    const svg = qrSvg(encodeQr('SRE', { mask: 2 }), { moduleSize: 2, title: 'A & B' });
    expect(svg).toContain('viewBox="0 0 58 58"'); // (21 + 2 × 4) × 2
    expect(svg).toContain('<title>A &amp; B</title>');
  });
});

const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33ABCDE1234F1Z5', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601'] };
const QR_ON = { on: true, upiId: 'srehyper@okaxis', bankAccountNo: '123456789012', ifsc: 'HDFC0001234' } as const;
const NOW = new Date().toISOString();
const CAT: CatalogueSnapshot = {
  tenantId: 't-a22', version: 1, builtAt: NOW,
  products: [{ productId: 'P-DAL', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active', hsnCode: '071360' }],
  barcodes: [{ code: '890000000001', productId: 'P-DAL', kind: 'standard' }],
};
const billWith = async (extra: Record<string, unknown>) => {
  const till = bootPos({
    laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: NOW.slice(0, 10), catalogue: CAT, taxPercent: 5, realTrading: true, taxInvoice: SHOP, ...extra,
    durable: async () => ({ committed: true, durable: true, detail: 'd', laneMessage: 'ok' }),
  });
  till.scanBarcode('890000000001');
  await till.tenderCash('S-1', 'TN01L1-26-000123', NOW);
  return till;
};

describe('A22 — the QR on the till\'s tax invoice, switched off by default', () => {
  it('OFF (the default, and SRE\'s answer): no QR on the bill, nothing said', async () => {
    for (const extra of [{}, { b2cDynamicQr: null }, { b2cDynamicQr: { ...QR_ON, on: false } }]) {
      const inv = (await billWith(extra)).taxInvoice();
      if (!inv.ok) throw new Error(inv.why);
      expect(inv.rows.some((r) => r.kind === 'qr')).toBe(false);
      expect(inv.qrNotSet).toBeUndefined();
      expect(inv.lines.join('\n')).not.toContain('QR');
    }
    expect(setupItem(SETTINGS.INVOICE_B2C_DYNAMIC_QR_ON.key)?.setting.defaultValue).toBe(false);
  });

  it('ON with every detail: the invoice carries the QR, whose link holds the notification\'s fields; English and Tamil caption', async () => {
    const till = await billWith({ b2cDynamicQr: QR_ON });
    const inv = till.taxInvoice();
    if (!inv.ok) throw new Error(inv.why);
    const row = inv.rows.find((r) => r.kind === 'qr');
    expect(row?.fields).toEqual(['b2c_qr']);
    expect(row?.text).toBe('Scan to pay this bill by UPI');
    const link = new URL(row!.qr!.payload);
    expect(link.protocol).toBe('upi:');
    const p = Object.fromEntries(new URLSearchParams(row!.qr!.payload.split('?')[1]));
    expect(p).toMatchObject({
      pa: 'srehyper@okaxis', pn: SHOP.legalName, cu: 'INR', tr: inv.number, gstIn: SHOP.gstin, invoiceNo: inv.number,
      bankAcc: '123456789012', ifsc: 'HDFC0001234',
    });
    expect(p['invoiceDate']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p['am']).toBe('105.00');
    expect(p['gstBrkUp']).toMatch(/^CGST:\d+\.\d\d\|SGST:\d+\.\d\d\|IGST:0\.00\|CESS:0\.00$/);
    expect(row!.qr!.svg.startsWith('<svg')).toBe(true);
    expect(inv.lines.join('\n')).toContain('[QR] Scan to pay this bill by UPI');
    const ta = till.taxInvoice({ language: 'ta' });
    if (!ta.ok) throw new Error(ta.why);
    expect(ta.rows.find((r) => r.kind === 'qr')?.text).toBe('இந்த பில்லை UPI மூலம் செலுத்த ஸ்கேன் செய்யவும்');
  });

  it('ON with a detail missing or malformed: no QR prints, and the screen says which is not set — never a guessed detail', async () => {
    const inv = (await billWith({ b2cDynamicQr: { on: true, upiId: 'srehyper@okaxis' } })).taxInvoice();
    if (!inv.ok) throw new Error(inv.why);
    expect(inv.rows.some((r) => r.kind === 'qr')).toBe(false);
    expect(inv.qrNotSet).toEqual(['bank_account', 'ifsc']);
    expect(inv.lines[inv.lines.length - 1]).toBe('UPI QR switched on but NOT SET: bank account number, IFSC — no QR printed. Tell the manager.');
    expect(b2cQrMissing({ on: true, upiId: 'no-at-sign', bankAccountNo: '12', ifsc: 'hdfc0001234' })).toEqual(['upi_id', 'bank_account']);
  });

  it('the same invoice and setting give the same QR (a reprint is the same symbol)', async () => {
    const till = await billWith({ b2cDynamicQr: QR_ON });
    const a = till.taxInvoice();
    const b = till.taxInvoice({ duplicate: true });
    if (!a.ok || !b.ok) throw new Error('no invoice');
    expect(a.rows.find((r) => r.kind === 'qr')?.qr).toEqual(b.rows.find((r) => r.kind === 'qr')?.qr);
    expect(b2cDynamicQrFor(undefined, {} as never)).toEqual({ state: 'off' });
  });
});

describe('A22 — store setup takes the details or "not set", and the box tells the served till only when switched on', () => {
  it('each detail is empty (not set) or well formed; anything else is refused by name', () => {
    const v = (key: string, value: unknown) => setupItem(key)!.validate!(value);
    expect(v(SETTINGS.INVOICE_B2C_DYNAMIC_QR_UPI_ID.key, '')).toBeNull();
    expect(v(SETTINGS.INVOICE_B2C_DYNAMIC_QR_UPI_ID.key, 'shop@okaxis')).toBeNull();
    expect(v(SETTINGS.INVOICE_B2C_DYNAMIC_QR_UPI_ID.key, 'shop')).toMatch(/UPI ID/);
    expect(v(SETTINGS.INVOICE_B2C_DYNAMIC_QR_BANK_ACCOUNT.key, '1234')).toMatch(/digits only/);
    expect(v(SETTINGS.INVOICE_B2C_DYNAMIC_QR_IFSC.key, 'sbin0001234')).toBeNull();
    expect(v(SETTINGS.INVOICE_B2C_DYNAMIC_QR_IFSC.key, 'SBIN1234')).toMatch(/IFSC/);
    expect(v(SETTINGS.INVOICE_B2C_DYNAMIC_QR_ON.key, 'yes')).not.toBeNull();
  });

  it('the lane payload carries the switch only when on (and each detail only as text), and the store\'s FSSAI licence', () => {
    const input = (policies: Record<string, unknown>): ScreenInput => ({
      pack: { ...emptyPack(), policies: known({ storeId: 'S1', branchId: 'S1', branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 0, ...policies } as never) },
      sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: NOW.slice(0, 10),
    });
    expect(posLanePayload(input({}), 'lane-1')).not.toHaveProperty('b2cDynamicQr');
    expect(posLanePayload(input({ b2cDynamicQr: { on: false, upiId: 'x@y' } }), 'lane-1')).not.toHaveProperty('b2cDynamicQr');
    expect(posLanePayload(input({ b2cDynamicQr: { on: true, upiId: 'shop@okaxis', bankAccountNo: 5 } }), 'lane-1')['b2cDynamicQr']).toEqual({ on: true, upiId: 'shop@okaxis' });
    expect(posLanePayload(input({ fssaiLicence: { number: '12419999000123', validUntil: '2099-12-31' } }), 'lane-1')['fssaiLicence']).toEqual({ number: '12419999000123', validUntil: '2099-12-31' });
    expect(posLanePayload(input({ fssaiLicence: { number: '' } }), 'lane-1')).not.toHaveProperty('fssaiLicence');
  });
});
