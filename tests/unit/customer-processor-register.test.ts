import { describe, it, expect } from 'vitest';
import {
  validateProcessorEntry, checkProcessorRegister, latestProcessorEntries,
  type ProcessorContractEntry, type ProcessingActivity,
} from '../../packages/customer/src/processor-register';

// C6 (v2.1 addendum · M16/M32 · DPDP s.8(2)): every vendor processing personal data has a register entry with a contract
// reference; processing without one is flagged. Synthetic vendors only.

const SMS: ProcessorContractEntry = {
  vendorId: 'sms-gw', vendorName: 'Example SMS Gateway', dataCategories: ['marketing_profile', 'notification_intents'],
  purpose: 'send bill and offer messages', contractRef: 'DPA-2026-014', contractFrom: '2026-04-01', contractUntil: '2027-03-31',
  recordedBy: 'u-owner', recordedAt: '2026-04-01T09:00:00.000Z',
};

const seen = (vendorName: string, seenIn: string, dataCategories: string[] = [], vendorId?: string): ProcessingActivity => ({
  vendorName, seenIn, dataCategories, ...(vendorId === undefined ? {} : { vendorId }),
});

describe('a register entry needs a contract reference (C6)', () => {
  it('accepts a complete entry', () => {
    expect(validateProcessorEntry(SMS)).toEqual({ ok: true, problems: [] });
  });

  it('refuses an entry with no contract reference, and names every other gap at once', () => {
    const r = validateProcessorEntry({ vendorId: '', vendorName: 'X', dataCategories: [], purpose: ' ', contractRef: '  ', contractFrom: '2026-13-01' });
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toEqual(['vendor_missing', 'contract_reference_missing', 'categories_missing', 'purpose_missing', 'dates_unreadable']);
  });

  it('refuses a contract that ends before it starts', () => {
    const r = validateProcessorEntry({ ...SMS, contractFrom: '2026-05-01', contractUntil: '2026-04-01' });
    expect(r.problems.map((p) => p.code)).toEqual(['contract_ends_before_it_starts']);
  });
});

describe('processing without a registered, in-force contract is flagged (C6)', () => {
  it('passes when every vendor seen has an entry with a contract in force covering what it handles', () => {
    const r = checkProcessorRegister({
      entries: [SMS],
      activities: [seen('example sms  gateway', 'integration-adapter:sms-1'), seen('sms-gw', 'erasure-notice:sms-gw', ['marketing_profile'], 'sms-gw')],
      asOf: '2026-10-16',
    });
    expect(r.compliant).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.vendorsSeen).toBe(1);
  });

  it('flags a vendor processing personal data with no entry at all', () => {
    const r = checkProcessorRegister({ entries: [SMS], activities: [seen('Example Courier', 'integration-adapter:courier-1')], asOf: '2026-10-16' });
    expect(r.compliant).toBe(false);
    expect(r.findings).toEqual([expect.objectContaining({ flag: 'processing_without_a_register_entry', vendorName: 'Example Courier', seenIn: 'integration-adapter:courier-1' })]);
    expect(r.detail).toContain('outside a registered, in-force contract');
  });

  it('flags a contract that has ended, or has not started', () => {
    expect(checkProcessorRegister({ entries: [SMS], activities: [seen('Example SMS Gateway', 'a')], asOf: '2027-04-01' }).findings[0]?.flag).toBe('contract_not_in_force');
    expect(checkProcessorRegister({ entries: [SMS], activities: [seen('Example SMS Gateway', 'a')], asOf: '2026-03-31' }).findings[0]?.flag).toBe('contract_not_in_force');
  });

  it('flags a category the contract does not cover', () => {
    const r = checkProcessorRegister({ entries: [SMS], activities: [seen('x', 'erasure-notice:sms-gw', ['delivery_records', 'marketing_profile'], 'sms-gw')], asOf: '2026-10-16' });
    expect(r.findings).toEqual([expect.objectContaining({ flag: 'category_not_covered_by_the_contract', categories: ['delivery_records'] })]);
  });

  it('the register is append-only: the latest entry per vendor applies, so a renewal clears the flag', () => {
    const renewed: ProcessorContractEntry = { ...SMS, contractRef: 'DPA-2027-002', contractFrom: '2027-04-01', contractUntil: '2028-03-31', recordedAt: '2027-03-20T09:00:00.000Z' };
    expect(latestProcessorEntries([renewed, SMS])).toEqual([renewed]);
    expect(checkProcessorRegister({ entries: [SMS, renewed], activities: [seen('Example SMS Gateway', 'a')], asOf: '2027-06-01' }).compliant).toBe(true);
  });
});
