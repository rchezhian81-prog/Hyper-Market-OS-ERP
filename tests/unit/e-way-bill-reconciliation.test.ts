import { describe, it, expect } from 'vitest';
import { ewbQueueCategory, isEwbException } from '../../packages/e-way-bill/src/index';

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
