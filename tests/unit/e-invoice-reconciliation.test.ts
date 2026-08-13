import { describe, it, expect } from 'vitest';
import { eInvoiceQueueCategory, isEInvoiceException } from '../../packages/e-invoice/src/index';

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
