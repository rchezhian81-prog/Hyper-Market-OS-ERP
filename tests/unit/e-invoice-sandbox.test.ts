import { describe, it, expect } from 'vitest';
import {
  sandboxGspProvider,
  sandboxIrn,
  registerViaProvider,
  type IrnRequest,
} from '../../packages/e-invoice/src/index';

const REQUEST: IrnRequest = {
  supplierGstin: '33ABCDE1234F1Z5',
  documentType: 'INV',
  documentNumber: 'INV/2627/000001',
  documentDate: '2026-08-11',
  financialYear: '2026-27',
  recipientGstin: '33ZZZZZ9999Z1Z5',
  taxableMinor: 100_000,
};
const IRN64 = /^[0-9a-fA-F]{64}$/;

describe('sandbox GSP provider', () => {
  it('produces a deterministic 64-hex IRN from the invoice identity', () => {
    const a = sandboxIrn(REQUEST);
    const b = sandboxIrn({ ...REQUEST, taxableMinor: 999 }); // taxable is not part of the identity basis
    expect(a).toMatch(IRN64);
    expect(a).toBe(b); // same identity → same IRN
    expect(sandboxIrn({ ...REQUEST, documentNumber: 'INV/2627/000002' })).not.toBe(a);
  });

  it('registers the first submission and marks a repeat of the same invoice a duplicate with the same IRN', () => {
    const p = sandboxGspProvider();
    const first = p.register(REQUEST);
    expect(first.status).toBe('registered');
    if (first.status !== 'registered') throw new Error('unreachable');
    expect(first.irn).toMatch(IRN64);
    expect(first.signedQr.startsWith('SANDBOX.')).toBe(true); // never a real government signature
    expect(first.ackNo).toMatch(/^\d{15}$/);
    expect(first.ackDate).toBe('2026-08-11');

    const again = p.register(REQUEST);
    expect(again.status).toBe('duplicate');
    if (again.status !== 'duplicate') throw new Error('unreachable');
    expect(again.irn).toBe(first.irn); // idempotent — the IRP's existing IRN
  });

  it('gives a fresh provider no memory (first call always registers)', () => {
    expect(sandboxGspProvider().register(REQUEST).status).toBe('registered');
  });

  it('rejects a non-positive taxable value even in the sandbox', () => {
    const r = sandboxGspProvider().register({ ...REQUEST, taxableMinor: 0 });
    expect(r.status).toBe('rejected');
  });

  it('forces the unknown (timeout) and rejected paths for testing', () => {
    expect(sandboxGspProvider({ forceOutcome: 'unknown' }).register(REQUEST).status).toBe('unknown');
    const rej = sandboxGspProvider({ forceOutcome: 'rejected', rejectReasons: ['duplicate IRN'] }).register(REQUEST);
    expect(rej.status).toBe('rejected');
    if (rej.status !== 'rejected') throw new Error('unreachable');
    expect(rej.errors).toEqual(['duplicate IRN']);
  });
});

describe('registerViaProvider — closing submit → register → apply', () => {
  it('turns a registered answer into a stored registered record', async () => {
    const { record } = await registerViaProvider({ invoiceId: 'inv-1', request: REQUEST, provider: sandboxGspProvider() });
    expect(record.state).toBe('registered');
    expect(record.irn).toMatch(IRN64);
    expect(record.signedQr?.startsWith('SANDBOX.')).toBe(true);
  });

  it('keeps an unknown answer as pending_unknown (never a silent success)', async () => {
    const { record } = await registerViaProvider({ invoiceId: 'inv-2', request: REQUEST, provider: sandboxGspProvider({ forceOutcome: 'unknown' }) });
    expect(record.state).toBe('pending_unknown');
    expect(record.irn).toBeUndefined();
  });

  it('records a rejection with its reasons', async () => {
    const { record } = await registerViaProvider({ invoiceId: 'inv-3', request: REQUEST, provider: sandboxGspProvider({ forceOutcome: 'rejected' }) });
    expect(record.state).toBe('rejected');
    expect((record.errors ?? []).length).toBeGreaterThan(0);
  });
});
