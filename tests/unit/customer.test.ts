import { describe, it, expect } from 'vitest';
import {
  detectDuplicateCustomers,
  hasConsent,
  canSend,
  type CustomerRecord,
  type ConsentState,
} from '../../packages/customer/src/index';

// One customer truth: duplicates are proposed, never auto-merged; an uncertain match
// is a review exception. Consent breaches are blocked, not warned (M16-FR-01/02).

describe('detectDuplicateCustomers', () => {
  it('flags a verified-phone match as a high-confidence merge candidate', () => {
    const customers: CustomerRecord[] = [
      { customerId: 'c1', phone: '98765 43210', phoneVerified: true },
      { customerId: 'c2', phone: '9876543210', phoneVerified: true }, // same digits, different formatting
    ];
    const matches = detectDuplicateCustomers(customers);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      matchedOn: 'verified_phone',
      confidence: 'high',
      disposition: 'merge_candidate',
      customerIds: ['c1', 'c2'],
    });
  });

  it('treats an unverified contact match as a review exception, not an auto-merge', () => {
    const customers: CustomerRecord[] = [
      { customerId: 'c1', email: 'A@Example.com' },
      { customerId: 'c2', email: 'a@example.com' }, // same, but unverified
    ];
    const matches = detectDuplicateCustomers(customers);
    expect(matches[0]).toMatchObject({ confidence: 'low', disposition: 'review' });
  });

  it('treats a name-only match as a review exception', () => {
    const matches = detectDuplicateCustomers([
      { customerId: 'c1', name: 'Ravi Kumar' },
      { customerId: 'c2', name: 'ravi  kumar' },
    ]);
    expect(matches[0]).toMatchObject({ matchedOn: 'name', disposition: 'review' });
  });

  it('does not match unrelated customers', () => {
    const matches = detectDuplicateCustomers([
      { customerId: 'c1', phone: '111', phoneVerified: true, name: 'A' },
      { customerId: 'c2', phone: '222', phoneVerified: true, name: 'B' },
    ]);
    expect(matches).toEqual([]);
  });

  it('orders high-confidence matches before review exceptions', () => {
    const matches = detectDuplicateCustomers([
      { customerId: 'c1', name: 'Same Name' },
      { customerId: 'c2', name: 'Same Name' }, // low
      { customerId: 'c3', email: 'x@y.com', emailVerified: true },
      { customerId: 'c4', email: 'x@y.com', emailVerified: true }, // high
    ]);
    expect(matches[0]?.confidence).toBe('high');
    expect(matches[matches.length - 1]?.confidence).toBe('low');
  });
});

describe('consent', () => {
  const state: ConsentState = {
    grants: [
      { purpose: 'marketing', channel: 'sms', granted: true },
      { purpose: 'marketing', channel: 'email', granted: true, withdrawn: true },
    ],
  };

  it('hasConsent only where granted and not withdrawn', () => {
    expect(hasConsent(state, 'marketing', 'sms')).toBe(true);
    expect(hasConsent(state, 'marketing', 'email')).toBe(false); // withdrawn
    expect(hasConsent(state, 'marketing', 'whatsapp')).toBe(false); // no grant
  });

  it('blocks a send with no consent', () => {
    expect(canSend({ state, purpose: 'marketing', channel: 'whatsapp' })).toEqual({
      allowed: false,
      reason: 'no_consent',
    });
  });

  it('blocks a send on a withdrawn channel immediately', () => {
    expect(canSend({ state, purpose: 'marketing', channel: 'email' })).toEqual({
      allowed: false,
      reason: 'withdrawn',
    });
  });

  it('allows a consented send within the frequency cap and blocks at the cap', () => {
    expect(canSend({ state, purpose: 'marketing', channel: 'sms', sentInWindow: 1, frequencyCap: 3 })).toEqual({
      allowed: true,
    });
    expect(canSend({ state, purpose: 'marketing', channel: 'sms', sentInWindow: 3, frequencyCap: 3 })).toEqual({
      allowed: false,
      reason: 'frequency_cap',
    });
  });
});
