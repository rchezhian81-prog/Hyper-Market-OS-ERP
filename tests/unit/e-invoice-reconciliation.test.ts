import { describe, it, expect } from 'vitest';
import {
  eInvoiceQueueCategory, isEInvoiceException, detectEInvoiceMismatch, eInvoiceRowCategory,
  eInvoiceNeedsAttention, foldEInvoice,
  type EInvoiceRecord, type IrnRequest, type EInvoiceEvent,
} from '../../packages/e-invoice/src/index';

// The operator reconciliation-queue vocabulary (item 2): map each e-invoice lifecycle state to its
// operator category, and flag the ones that need attention.

describe('eInvoiceQueueCategory + isEInvoiceException', () => {
  it('maps each lifecycle state to its operator category', () => {
    expect(eInvoiceQueueCategory('submitted')).toBe('processing');
    expect(eInvoiceQueueCategory('registered')).toBe('registered');
    expect(eInvoiceQueueCategory('rejected')).toBe('rejected');
    expect(eInvoiceQueueCategory('pending_unknown')).toBe('unknown');
    expect(eInvoiceQueueCategory('provider_error')).toBe('error');
    expect(eInvoiceQueueCategory('cancelled')).toBe('cancelled');
  });

  it('flags unknown, provider_error and rejected as exceptions; nothing else', () => {
    expect(isEInvoiceException('pending_unknown')).toBe(true);
    expect(isEInvoiceException('provider_error')).toBe(true);
    expect(isEInvoiceException('rejected')).toBe(true);
    expect(isEInvoiceException('submitted')).toBe(false);
    expect(isEInvoiceException('registered')).toBe(false);
    expect(isEInvoiceException('cancelled')).toBe(false);
  });
});

// --- mismatch detection (item 2 inc4): a re-query disagreeing with the stored IRN ---------------------

const REQ: IrnRequest = { supplierGstin: '33ABCDE1234F1Z5', documentType: 'INV', documentNumber: 'INV/1', documentDate: '2026-08-11', financialYear: '2026-27', taxableMinor: 100_000 };
const reg = (irn: string): EInvoiceRecord => ({ invoiceId: 'i', state: 'registered', irn, signedQr: 'QR', ackNo: 'A1', ackDate: '2026-08-11', detail: 'registered' });
// A registered aggregate folded from real events (IRN 'IRN-A').
const registered = foldEInvoice('i', [
  { kind: 'submitted', request: REQ, at: '2026-08-11T00:00:00Z' },
  { kind: 'response', record: reg('IRN-A'), at: '2026-08-11T00:01:00Z' },
])!;

describe('detectEInvoiceMismatch', () => {
  it('flags a different IRN and a portal rejection against a registered invoice', () => {
    expect(detectEInvoiceMismatch(registered, reg('IRN-B'), 'now')?.observedIrn).toBe('IRN-B');
    const rej = detectEInvoiceMismatch(registered, { invoiceId: 'i', state: 'rejected', errors: ['gone'], detail: 'rejected' }, 'now');
    expect(rej?.observedState).toBe('rejected');
  });

  it('does NOT flag the same IRN (agreement) or a non-answer (unknown/error)', () => {
    expect(detectEInvoiceMismatch(registered, reg('IRN-A'), 'now')).toBeUndefined();
    expect(detectEInvoiceMismatch(registered, { invoiceId: 'i', state: 'pending_unknown', detail: 'timeout' }, 'now')).toBeUndefined();
    expect(detectEInvoiceMismatch(registered, { invoiceId: 'i', state: 'provider_error', detail: 'bad qr' }, 'now')).toBeUndefined();
  });

  it('flags a portal still showing a cancelled invoice as registered', () => {
    const cancelled = foldEInvoice('i', [
      { kind: 'submitted', request: REQ, at: '2026-08-11T00:00:00Z' },
      { kind: 'response', record: reg('IRN-A'), at: '2026-08-11T00:01:00Z' },
      { kind: 'cancelled', reason: 'wrong', at: '2026-08-11T01:00:00Z' },
    ])!;
    expect(cancelled.state).toBe('cancelled');
    expect(detectEInvoiceMismatch(cancelled, reg('IRN-A'), 'now')?.observedState).toBe('registered');
  });
});

describe('the mismatch flag is additive — never an overwrite (rule #10)', () => {
  it('folds a mismatch event without touching the stored IRN or state, and is replay-safe', () => {
    const mismatch = detectEInvoiceMismatch(registered, reg('IRN-B'), '2026-08-12T00:00:00Z')!;
    const events: EInvoiceEvent[] = [
      { kind: 'submitted', request: REQ, at: '2026-08-11T00:00:00Z' },
      { kind: 'response', record: reg('IRN-A'), at: '2026-08-11T00:01:00Z' },
      { kind: 'mismatch', mismatch, at: '2026-08-12T00:00:00Z' },
      { kind: 'mismatch', mismatch, at: '2026-08-12T00:00:00Z' }, // replayed — idempotent
    ];
    const agg = foldEInvoice('i', events)!;
    expect(agg.state).toBe('registered');       // state unchanged
    expect(agg.irn).toBe('IRN-A');              // stored IRN unchanged
    expect(agg.mismatch?.observedIrn).toBe('IRN-B');
    // The whole-aggregate category becomes `mismatch`, and it now needs attention.
    expect(eInvoiceRowCategory(agg)).toBe('mismatch');
    expect(eInvoiceNeedsAttention(agg)).toBe(true);
    // A clean registered invoice is neither.
    expect(eInvoiceRowCategory(registered)).toBe('registered');
    expect(eInvoiceNeedsAttention(registered)).toBe(false);
  });
});
