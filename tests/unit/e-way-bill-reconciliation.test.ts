import { describe, it, expect } from 'vitest';
import {
  ewbQueueCategory, isEwbException, detectEwbMismatch, ewbRowCategory, ewbNeedsAttention, foldEwayBill,
  type EwbRecord, type EwayBillRequest, type EwbEvent,
} from '../../packages/e-way-bill/src/index';

// The operator reconciliation-queue vocabulary for e-way bills (item 2), mirroring the e-invoice one.

describe('ewbQueueCategory + isEwbException', () => {
  it('maps each lifecycle state to its operator category', () => {
    expect(ewbQueueCategory('generated')).toBe('generated');
    expect(ewbQueueCategory('rejected')).toBe('rejected');
    expect(ewbQueueCategory('pending_unknown')).toBe('unknown');
    expect(ewbQueueCategory('provider_error')).toBe('error');
    expect(ewbQueueCategory('cancelled')).toBe('cancelled');
  });

  it('flags unknown, provider_error and rejected as exceptions; nothing else', () => {
    expect(isEwbException('pending_unknown')).toBe(true);
    expect(isEwbException('provider_error')).toBe(true);
    expect(isEwbException('rejected')).toBe(true);
    expect(isEwbException('generated')).toBe(false);
    expect(isEwbException('cancelled')).toBe(false);
  });
});

// --- mismatch detection (item 2 inc4): a re-query disagreeing with the stored EWB number --------------

const REQ: EwayBillRequest = {
  supplierGstin: '33ABCDE1234F1Z5', documentType: 'INV', documentNumber: 'INV/1', documentDate: '2026-08-11',
  financialYear: '2026-27', hsnCode: '100610', consignmentValueMinor: 6_000_000, supplyRoute: 'inter_state',
  movementReason: 'supply', fromPincode: '600001', toPincode: '560001',
};
const gen = (ewbNo: string): EwbRecord => ({ movementId: 'm', state: 'generated', ewbNo, ewbDate: '2026-08-11', validUpto: '2026-08-12', detail: 'generated' });
// A generated aggregate folded from real events (EWB '111111111111').
const generated = foldEwayBill('m', [
  { kind: 'submitted', request: REQ, at: '2026-08-11T00:00:00Z' },
  { kind: 'response', record: gen('111111111111'), at: '2026-08-11T00:01:00Z' },
])!;

describe('detectEwbMismatch', () => {
  it('flags a different EWB number and a portal rejection against a generated movement', () => {
    expect(detectEwbMismatch(generated, gen('222222222222'), 'now')?.observedEwbNo).toBe('222222222222');
    const rej = detectEwbMismatch(generated, { movementId: 'm', state: 'rejected', errors: ['gone'], detail: 'rejected' }, 'now');
    expect(rej?.observedState).toBe('rejected');
  });

  it('does NOT flag the same number (agreement) or a non-answer (unknown/error)', () => {
    expect(detectEwbMismatch(generated, gen('111111111111'), 'now')).toBeUndefined();
    expect(detectEwbMismatch(generated, { movementId: 'm', state: 'pending_unknown', detail: 'timeout' }, 'now')).toBeUndefined();
    expect(detectEwbMismatch(generated, { movementId: 'm', state: 'provider_error', detail: 'bad no' }, 'now')).toBeUndefined();
  });
});

describe('the mismatch flag is additive — never an overwrite (rule #10)', () => {
  it('folds a mismatch event without touching the stored number or state, and is replay-safe', () => {
    const mismatch = detectEwbMismatch(generated, gen('222222222222'), '2026-08-12T00:00:00Z')!;
    const events: EwbEvent[] = [
      { kind: 'submitted', request: REQ, at: '2026-08-11T00:00:00Z' },
      { kind: 'response', record: gen('111111111111'), at: '2026-08-11T00:01:00Z' },
      { kind: 'mismatch', mismatch, at: '2026-08-12T00:00:00Z' },
      { kind: 'mismatch', mismatch, at: '2026-08-12T00:00:00Z' }, // replayed — idempotent
    ];
    const agg = foldEwayBill('m', events)!;
    expect(agg.state).toBe('generated');            // state unchanged
    expect(agg.ewbNo).toBe('111111111111');         // stored number unchanged
    expect(agg.mismatch?.observedEwbNo).toBe('222222222222');
    expect(ewbRowCategory(agg)).toBe('mismatch');
    expect(ewbNeedsAttention(agg)).toBe(true);
    expect(ewbRowCategory(generated)).toBe('generated');
    expect(ewbNeedsAttention(generated)).toBe(false);
  });
});
