import { describe, it, expect } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { REAL_TRADING_AND_MIRROR_WORDS, TaxInvoiceRefusedError } from '../../apps/pos/src/session';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { readMachineReference, MACHINE_REF_WORDS } from '../../packages/tender/src/machine-reference';
import { withoutCardData, TENDER_FIELDS } from '../../packages/tender/src/tender-card-data';
import { realTradingSaleRefusal } from '../../edge/store-edge/src/real-trading';

/**
 * **OB-271 — the till in REAL TRADING: a sale whose bill would not be a complete tax invoice is refused BEFORE the disk; a
 * card/UPI payment carries the shop's own machine's approval number (never card data); everything is OFF otherwise.** The
 * till's own model, with a counting double for its disk — no network anywhere (hard rule #1). Synthetic data only.
 */

const NOW = new Date().toISOString();
const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33ABCDE1234F1Z5', address: ['12 Main Road', 'Tiruppur 641601'] };
const CAT: CatalogueSnapshot = {
  tenantId: 't-rt', version: 1, builtAt: NOW,
  products: [
    { productId: 'P-DAL', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active', hsnCode: '071360' },
    { productId: 'P-OLD', sku: 'OLD', name: 'Old-code item', baseUom: 'ea', unitPriceMinor: 5_000, taxBps: 1_200, status: 'active', hsnCode: '1704' },
    { productId: 'P-VEG', sku: 'VEG', name: 'Fresh coriander', baseUom: 'ea', unitPriceMinor: 1_000, taxBps: 0, status: 'active', hsnCode: '070999' },
  ],
  barcodes: [{ code: '890000000001', productId: 'P-DAL', kind: 'standard' }, { code: '890000000002', productId: 'P-OLD', kind: 'standard' }, { code: '890000000003', productId: 'P-VEG', kind: 'standard' }],
};

function till(opts: { realTrading?: boolean; taxInvoice?: typeof SHOP | null; mirrorPilot?: boolean } = {}) {
  const writes: string[] = [];
  const pos = bootPos({
    laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: NOW.slice(0, 10), catalogue: CAT, taxPercent: 5,
    ...(opts.realTrading === true ? { realTrading: true, taxInvoice: opts.taxInvoice === undefined ? SHOP : opts.taxInvoice } : {}),
    ...(opts.mirrorPilot === true ? { mirrorPilot: true, guestSalesOnly: true } : {}),
    durable: async (_id, record) => { writes.push(record); return { committed: true, durable: true, detail: 'd', laneMessage: 'ok' }; },
  });
  return { pos, writes };
}

describe('OB-271 — real trading: the till refuses a bill that is not a tax invoice, before the disk', () => {
  it('a complete bill is saved, and its tax invoice prints every field — 80 mm by default, English and Tamil, DUPLICATE on a reprint', async () => {
    const { pos, writes } = till({ realTrading: true });
    expect(pos.realTrading()).toBe(true);
    pos.scanBarcode('890000000001');
    pos.scanBarcode('890000000001');
    await pos.tenderCash('S-1', 'L1-0001', NOW);
    expect(writes).toHaveLength(1);
    const inv = pos.taxInvoice();
    if (!inv.ok) throw new Error(inv.why);
    expect(inv).toMatchObject({ paper: 'thermal-80', paperWidthMm: 80, number: 'L1-0001' });
    const text = inv.lines.join('\n');
    for (const words of ['Tax Invoice', 'SRE Hyper Market Private Limited', '12 Main Road', 'GSTIN: 33ABCDE1234F1Z5', 'Invoice No:', 'L1-0001', 'Place of supply: Tamil Nadu (33)', 'Toor dal 1kg', 'HSN 071360', '1 Nos × 105.00', 'CGST @ 2.5%', 'SGST @ 2.5%', '210.00']) {
      expect(text).toContain(words);
    }
    const ta = pos.taxInvoice({ language: 'ta', duplicate: true });
    if (!ta.ok) throw new Error(ta.why);
    expect(ta.lines.join('\n')).toContain('நகல் (DUPLICATE)');
    expect(ta.rows.some((r) => r.fields.includes('duplicate'))).toBe(true);
  });

  it('no GSTIN in the store\'s setup → REFUSED before the disk, in words; nothing saved, no bill', async () => {
    const { pos, writes } = till({ realTrading: true, taxInvoice: { ...SHOP, gstin: '' } });
    pos.scanBarcode('890000000001');
    const refused = await pos.tenderCash('S-2', 'L1-0002', NOW).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TaxInvoiceRefusedError);
    expect((refused as TaxInvoiceRefusedError).laneMessage).toMatch(/NOT saved — do not take money\. the shop's GSTIN is not set up/);
    expect((refused as TaxInvoiceRefusedError).problems.map((p) => p.code)).toEqual(['supplier_gstin']);
    expect(writes).toHaveLength(0);
    expect(pos.taxInvoice().ok).toBe(false);
  });

  it('no legal identity at all, a 4-digit HSN, an exempt item — each refused before the disk, naming what is missing', async () => {
    for (const [taxInvoice, code, expected] of [[null, '890000000001', 'supplier_legal_name'], [SHOP, '890000000002', 'line_hsn_digits'], [SHOP, '890000000003', 'exempt_line']] as const) {
      const { pos, writes } = till({ realTrading: true, taxInvoice });
      pos.scanBarcode(code);
      const refused = await pos.tenderCash('S-3', 'L1-0003', NOW).catch((e: unknown) => e) as TaxInvoiceRefusedError;
      expect(refused.problems.map((p) => p.code)).toContain(expected);
      expect(writes).toHaveLength(0);
    }
  });

  it('a card payment in real trading needs the machine\'s approval number on the tender — and keeps it, never card data', async () => {
    const { pos, writes } = till({ realTrading: true });
    pos.scanBarcode('890000000001');
    await expect(pos.tenderCardOrUpi({ saleId: 'S-4', receiptNumber: 'L1-0004', atIsoUtc: NOW, kind: 'card', outcome: 'approved', ref: 'PAY-1' }))
      .rejects.toMatchObject({ laneMessage: expect.stringContaining(MACHINE_REF_WORDS.missing) });
    expect(writes).toHaveLength(0);
    await pos.tenderCardOrUpi({ saleId: 'S-4', receiptNumber: 'L1-0004', atIsoUtc: NOW, kind: 'card', outcome: 'approved', ref: 'PAY-1', machineRef: 'A1B2C3' });
    expect(JSON.parse(writes[0]!).tenders).toEqual([expect.objectContaining({ kind: 'card', ref: 'PAY-1', machineRef: 'A1B2C3' })]);
    const inv = pos.taxInvoice();
    if (!inv.ok) throw new Error(inv.why);
    expect(inv.lines.join('\n')).toContain('Paid: Card (approval A1B2C3)');
  });

  it('the mirror pilot and real trading together → refused before the disk (the box also refuses to start like that)', async () => {
    const { pos, writes } = till({ realTrading: true, mirrorPilot: true });
    pos.scanBarcode('890000000001');
    await expect(pos.tenderPaidOnOldErp('S-5', 'L1-0005', NOW, 'OLD/1')).rejects.toMatchObject({ laneMessage: REAL_TRADING_AND_MIRROR_WORDS });
    expect(writes).toHaveLength(0);
  });

  it('OFF (not set, or the mirror pilot): nothing changes — no invoice is asked for, a bill with no GSTIN sells as before', async () => {
    const off = till();
    expect(off.pos.realTrading()).toBe(false);
    off.pos.scanBarcode('890000000003'); // an exempt item, no identity anywhere: sold exactly as before
    await off.pos.tenderCash('S-6', 'L1-0006', NOW);
    expect(off.writes).toHaveLength(1);
    expect(off.pos.taxInvoice()).toEqual({ ok: false, why: 'this sale was not taken in real trading, so it has no tax invoice' });
    expect(off.pos.receiptLines().ok).toBe(true);
    const mirror = till({ mirrorPilot: true });
    mirror.pos.scanBarcode('890000000001');
    await mirror.pos.tenderPaidOnOldErp('S-7', 'L1-0007', NOW, 'OLD/7');
    expect(mirror.writes).toHaveLength(1);
    expect(JSON.parse(mirror.writes[0]!).tenders[0]).not.toHaveProperty('machineRef');
  });
});

describe('OB-271 · audit A9 — the machine\'s approval / reference number: its shape, and never card data (hard rule #3)', () => {
  it('the approval code or the RRN / UPI reference is kept in capitals; spaces and dashes are taken out', () => {
    expect(readMachineReference('a1b2c3')).toEqual({ ok: true, value: 'A1B2C3' });
    expect(readMachineReference('4123 4567 8901')).toEqual({ ok: true, value: '412345678901' });
    expect(readMachineReference('0042')).toEqual({ ok: true, value: '0042' });
  });

  it('too short, too long, or not letters and digits → refused with what to type', () => {
    for (const bad of ['123', 'ABCDEFGHIJKLM', 'AB/12', '12.34.56']) expect(readMachineReference(bad)).toMatchObject({ ok: false, refusedBecause: 'machine_ref_not_valid' });
    for (const none of ['', '   ', undefined, 42]) expect(readMachineReference(none)).toMatchObject({ ok: false, refusedBecause: 'machine_ref_missing' });
  });

  it('a card number — bare, spaced or dashed — is refused as card data, and never repeated in the words', () => {
    const card = ['4111', '1111', '1111', '1111'];
    for (const typed of [card.join(''), card.join(' '), card.join('-'), `5${'0'.repeat(14)}4`]) {
      const r = readMachineReference(typed);
      expect(r).toMatchObject({ ok: false, refusedBecause: 'machine_ref_looks_like_card' });
      if (!r.ok) expect(r.laneMessage).not.toContain(typed.replace(/\D/g, '').slice(0, 6));
    }
  });

  it('a tender may now keep `machineRef` — and a card number put in it is REMOVED like any other field', () => {
    expect(TENDER_FIELDS).toContain('machineRef');
    const kept = withoutCardData([{ kind: 'card', amountMinor: 100, ref: 'PAY-1', machineRef: 'A1B2C3' }]);
    expect(kept.removed).toEqual([]);
    const card = ['4111', '1111', '1111', '1111'].join('');
    const cleaned = withoutCardData([{ kind: 'card', amountMinor: 100, ref: 'PAY-1', machineRef: card }]);
    expect(cleaned.removed).toEqual([{ tender: 0, kind: 'card', fields: ['machineRef'] }]);
    expect(JSON.stringify(cleaned.tenders)).not.toContain(card);
  });
});

describe('OB-271 — the store computer runs the same invoice rule on the record before ITS disk', () => {
  const record = {
    id: 'S-9', number: 'L1-0009', committedAt: NOW, laneId: 'lane-1', cashierId: 'u-cashier',
    lines: [{ productId: 'P-DAL', quantityMinor: 1, uom: 'ea', unitPriceMinor: 10_500, lineTotalMinor: 10_500, taxRateBps: 500, hsnCode: '071360' }],
  };
  it('a complete record passes; no identity, a short HSN or an exempt line is refused in words', () => {
    expect(realTradingSaleRefusal(record, SHOP)).toBeUndefined();
    expect(realTradingSaleRefusal(record, null)).toMatchObject({ refusedBecause: 'tax_invoice_incomplete', laneMessage: expect.stringContaining('legal name') });
    expect(realTradingSaleRefusal({ ...record, lines: [{ ...record.lines[0]!, hsnCode: '0713' }] }, SHOP)?.laneMessage).toContain('HSN code is too short');
    expect(realTradingSaleRefusal({ ...record, lines: [{ ...record.lines[0]!, taxRateBps: 0 }] }, SHOP)?.laneMessage).toContain('exempt or nil-rated');
  });
});
