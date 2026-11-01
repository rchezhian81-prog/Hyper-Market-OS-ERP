import { describe, it, expect } from 'vitest';
import { concessionInvoiceFigures, concessionSettlementComponents, financialYearOf, nextConcessionInvoiceNumber, type PeriodCharge } from '../../packages/concession/src/index';
import { createConcessionInvoicesSession, bpsOf, CONCESSION_INVOICES_COPY } from '../../apps/web-erp/src/concession-invoices-session';

/** Round 4d (M27-FR-03): the invoice's figures, its gap-free numbering, and the page's session. */

const charge = (over: Partial<PeriodCharge> = {}): PeriodCharge => ({
  contractId: 'ct', concessionaireId: 'cx', from: '2026-08-01', to: '2026-08-31', grossSalesMinor: 0, fixedRentMinor: 0, revenueShareMinor: 3_000_000,
  chargeMinor: 3_000_000, utilitiesMinor: 50_000, totalDueMinor: 3_050_000, basis: 'revenue_share', detail: '', ...over,
});
const GST = { rentBps: 1800, revenueShareBps: 1800, utilitiesBps: 0, supply: 'intra_state' as const };

describe('the concession invoice', () => {
  it('charges the share and utilities each at its own rate, nets what was collected, states the deposit', () => {
    const f = concessionInvoiceFigures({ charge: charge(), collectedForThemMinor: 20_000_000, depositHeldMinor: 5_000_000, gst: GST });
    expect(f.lines).toEqual([
      { kind: 'revenue_share', taxableMinor: 3_000_000, rateBps: 1800, cgstMinor: 270_000, sgstMinor: 270_000, igstMinor: 0, totalMinor: 3_540_000 },
      { kind: 'utilities', taxableMinor: 50_000, rateBps: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: 50_000 },
    ]);
    expect(f).toMatchObject({ invoiceTotalMinor: 3_590_000, netPayableToThemMinor: 16_410_000, depositHeldMinor: 5_000_000 });
    const c = concessionSettlementComponents(f);
    expect(c['collected']! + c['receivable']!).toBe(c['charge']! + c['utilities']! + c['cgst']! + c['sgst']! + c['igst']! + c['payable']!);
  });
  it('OB-647 (owner, 1 Nov 2026): the contract\'s amounts are BEFORE GST — GST is added on top, never taken out of them', () => {
    // a ₹10,000 rent at 18%: ₹10,000 stays the taxable value and ₹1,800 GST is added — the invoice is ₹11,800, not ₹10,000
    const f = concessionInvoiceFigures({ charge: charge({ basis: 'fixed_rent', fixedRentMinor: 1_000_000, chargeMinor: 1_000_000, revenueShareMinor: 0, utilitiesMinor: 0 }), collectedForThemMinor: 0, depositHeldMinor: 0, gst: GST });
    expect(f.lines).toEqual([{ kind: 'rent', taxableMinor: 1_000_000, rateBps: 1800, cgstMinor: 90_000, sgstMinor: 90_000, igstMinor: 0, totalMinor: 1_180_000 }]);
    expect(f.taxableMinor).toBe(1_000_000);
    expect(f.invoiceTotalMinor).toBe(1_180_000);
  });
  it('across states it is IGST; higher-of-both names the rent when the rent is higher; they may owe the shop', () => {
    const f = concessionInvoiceFigures({ charge: charge({ basis: 'higher_of_both', fixedRentMinor: 4_000_000, chargeMinor: 4_000_000, utilitiesMinor: 0 }), collectedForThemMinor: 1_000_000, depositHeldMinor: 0, gst: { ...GST, supply: 'inter_state' } });
    expect(f.lines).toEqual([{ kind: 'rent', taxableMinor: 4_000_000, rateBps: 1800, cgstMinor: 0, sgstMinor: 0, igstMinor: 720_000, totalMinor: 4_720_000 }]);
    expect(f.netPayableToThemMinor).toBe(-3_720_000);
    expect(concessionSettlementComponents(f)).toMatchObject({ receivable: 3_720_000, payable: 0 });
  });
  it('the series is gap-free per financial year (April to March)', () => {
    expect(financialYearOf('2026-03-31')).toBe('2025-26');
    expect(financialYearOf('2026-04-01')).toBe('2026-27');
    expect(nextConcessionInvoiceNumber([], '2026-27')).toBe('CI/2026-27/0001');
    expect(nextConcessionInvoiceNumber(['CI/2026-27/0001', 'CI/2026-27/0002', 'CI/2025-26/0009'], '2026-27')).toBe('CI/2026-27/0003');
  });
});

describe('the Concessions page\'s invoice session', () => {
  it('every word has a Tamil twin; a percentage is basis points', () => {
    expect(Object.keys(CONCESSION_INVOICES_COPY.ta).sort()).toEqual(Object.keys(CONCESSION_INVOICES_COPY.en).sort());
    expect(bpsOf('18')).toBe(1800); expect(bpsOf('2.5')).toBe(250); expect(bpsOf('120')).toBeNull(); expect(bpsOf('lots')).toBeNull();
  });
  it('asks for approval of exactly the issue body plus the path ids, with the previewed total', async () => {
    const sent: { path: string; body: unknown }[] = [];
    const fetch = (async (path: string, init: { body?: string }) => { sent.push({ path, body: init.body === undefined ? undefined : JSON.parse(init.body) }); return { ok: true, status: 201, json: async () => ({}) } as unknown as Response; }) as unknown as typeof globalThis.fetch;
    const s = createConcessionInvoicesSession({ viewer: { userId: 'u-o', permissions: ['concession.charge.read', 'concession.contract.manage'] }, fetch, makeId: () => 'CINV-1' });
    expect(await s.ask({ contractId: 'ct', from: '2026-08-01', to: 'x', banked: '1', metered: '' }, 1)).toEqual({ result: 'invalid', why: 'needWindow' });
    expect(await s.ask({ contractId: 'ct', from: '2026-08-01', to: '2026-08-31', banked: '2,00,000', metered: '' }, 3_599_000)).toEqual({ result: 'ok', value: { invoiceId: 'CINV-1' } });
    expect(sent[0]).toMatchObject({ path: '/v1/approvals/requests', body: { kind: 'concession_invoice', subjectRef: 'concession-invoice:CINV-1', valueMinor: 3_599_000, details: { from: '2026-08-01', to: '2026-08-31', bankedForThemMinor: 20_000_000, contractId: 'ct', invoiceId: 'CINV-1' } } });
    expect(await createConcessionInvoicesSession({ viewer: { userId: 'u-c', permissions: ['concession.charge.read'] }, fetch }).setGst({ rent: '18', share: '18', utilities: '18', supply: 'intra_state', note: '' })).toEqual({ result: 'invalid', why: 'cannotConfigure' });
  });
});
