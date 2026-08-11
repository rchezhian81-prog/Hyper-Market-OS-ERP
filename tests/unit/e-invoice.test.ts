import { describe, it, expect } from 'vitest';
import { assessEInvoiceEligibility, buildIrnRequest, applyIrpResult } from '../../packages/e-invoice/src/index';
import type { TaxInvoiceFields as TIF } from '../../packages/finance/src/index';

// A20 — GST e-invoicing. ₹5-crore-gated, B2C-excluded eligibility; a malformed invoice never reaches the
// IRP; and above all the IRN + signed QR are the government's signature, never fabricated.

const OVER = 6_000_000_000;  // ₹6 cr — over the ₹5 cr threshold
const UNDER = 4_000_000_000; // ₹4 cr — at/under threshold
const GSTIN = '33ABCDE1234F1Z5';
const IRN64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex chars

const INVOICE: TIF = {
  documentType: 'Tax Invoice', supplierGstin: GSTIN, invoiceNumber: 'INV/2627/000001', invoiceDate: '2026-08-11',
  hsnCode: '100610', taxableMinor: 100000, rateBps: 500, placeOfSupply: 'intra_state', taxComponents: ['CGST', 'SGST'],
};

describe('e-invoicing eligibility (A20)', () => {
  it('requires an IRN for a B2B supply over ₹5 crore', () => {
    const r = assessEInvoiceEligibility({ annualTurnoverMinor: OVER, supplyType: 'b2b', recipientGstin: GSTIN, documentType: 'INV' });
    expect(r.required).toBe(true);
    expect(r.reason).toBe('required');
  });

  it('excludes B2C, sub-threshold turnover, and a B2B supply with no recipient GSTIN', () => {
    expect(assessEInvoiceEligibility({ annualTurnoverMinor: OVER, supplyType: 'b2c', documentType: 'INV' }).reason).toBe('b2c_excluded');
    expect(assessEInvoiceEligibility({ annualTurnoverMinor: UNDER, supplyType: 'b2b', recipientGstin: GSTIN, documentType: 'INV' }).reason).toBe('below_threshold');
    // Exactly ₹5 cr is NOT "over" ₹5 cr.
    expect(assessEInvoiceEligibility({ annualTurnoverMinor: 5_000_000_000, supplyType: 'b2b', recipientGstin: GSTIN, documentType: 'INV' }).required).toBe(false);
    // Marked B2B but no registered buyer → B2C in substance.
    expect(assessEInvoiceEligibility({ annualTurnoverMinor: OVER, supplyType: 'b2b', documentType: 'INV' }).reason).toBe('no_recipient_gstin');
  });
});

describe('building the IRP request (A20)', () => {
  const eligible = assessEInvoiceEligibility({ annualTurnoverMinor: OVER, supplyType: 'b2b', recipientGstin: GSTIN, documentType: 'INV' });

  it('builds the canonical request with the IRP idempotency key from a valid invoice', () => {
    const b = buildIrnRequest({ invoice: INVOICE, eligibility: eligible, documentType: 'INV', recipientGstin: GSTIN });
    expect(b.built).toBe(true);
    expect(b.request?.financialYear).toBe('2026-27');
    expect(b.idempotencyKey).toBe('33ABCDE1234F1Z5|INV|INV/2627/000001|2026-27');
  });

  it('refuses to send a Rule-46-invalid invoice to the IRP, naming the problem', () => {
    const bad: TIF = { ...INVOICE, supplierGstin: 'NOTAGSTIN' };
    const b = buildIrnRequest({ invoice: bad, eligibility: eligible, documentType: 'INV', recipientGstin: GSTIN });
    expect(b.built).toBe(false);
    expect(b.outcome).toBe('invalid_invoice');
  });

  it('does not build when e-invoicing is not required', () => {
    const notReq = assessEInvoiceEligibility({ annualTurnoverMinor: UNDER, supplyType: 'b2b', recipientGstin: GSTIN, documentType: 'INV' });
    expect(buildIrnRequest({ invoice: INVOICE, eligibility: notReq, documentType: 'INV' }).outcome).toBe('not_required');
  });
});

describe('applying the IRP answer — never fabricating a signature (A20)', () => {
  it('stores a registration only when the IRP returned a well-formed IRN and signed QR', () => {
    const ok = applyIrpResult({ invoiceId: 'inv-1', result: { status: 'registered', irn: IRN64, signedQr: 'eyJ...signed', ackNo: 'ACK1', ackDate: '2026-08-11' } });
    expect(ok.state).toBe('registered');
    expect(ok.irn).toBe(IRN64);
  });

  it('refuses to store a malformed IRN or an empty QR as registered', () => {
    expect(applyIrpResult({ invoiceId: 'inv-1', result: { status: 'registered', irn: 'not-64-hex', signedQr: 'x', ackNo: 'A', ackDate: 'd' } }).state).toBe('provider_error');
    expect(applyIrpResult({ invoiceId: 'inv-1', result: { status: 'registered', irn: IRN64, signedQr: '   ', ackNo: 'A', ackDate: 'd' } }).state).toBe('provider_error');
  });

  it('treats a duplicate as an idempotent success and keeps unknown/rejected as their own states', () => {
    expect(applyIrpResult({ invoiceId: 'inv-1', result: { status: 'duplicate', irn: IRN64 } }).state).toBe('registered');
    expect(applyIrpResult({ invoiceId: 'inv-1', result: { status: 'rejected', errors: ['2172: duplicate IRN for the document'] } }).state).toBe('rejected');
    // An unknown answer is NOT a success — the invoice is not e-invoiced until reconciled.
    expect(applyIrpResult({ invoiceId: 'inv-1', result: { status: 'unknown', reason: 'timeout' } }).state).toBe('pending_unknown');
  });
});
