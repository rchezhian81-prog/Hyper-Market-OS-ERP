import { describe, it, expect } from 'vitest';
import { canNotify, NotificationQueue } from '../../packages/notifications/src/index';
import type { ConsentState } from '../../packages/customer/src/index';

// A notification is consent-safe by construction (blocked on any breach), and a
// poison send lands in a visible dead-letter, never dropped (M31-FR-03/04).

const consent: ConsentState = {
  grants: [{ purpose: 'marketing', channel: 'sms', granted: true }],
};

function base(overrides: Record<string, unknown> = {}) {
  return {
    consent,
    purpose: 'marketing',
    channel: 'sms',
    templateApproved: true,
    ...overrides,
  };
}

describe('canNotify', () => {
  it('allows a fully consented, approved, in-budget send', () => {
    expect(canNotify(base())).toEqual({ allowed: true });
  });

  it('blocks an unapproved template first', () => {
    expect(canNotify(base({ templateApproved: false }))).toEqual({
      allowed: false,
      reason: 'unapproved_template',
    });
  });

  it('blocks a suppressed (do-not-contact) recipient absolutely', () => {
    expect(canNotify(base({ suppressed: true }))).toEqual({ allowed: false, reason: 'suppressed' });
  });

  it('blocks a send with no consent for the channel', () => {
    expect(canNotify(base({ channel: 'whatsapp' }))).toEqual({
      allowed: false,
      reason: 'no_consent',
    });
  });

  it('blocks a send at the frequency cap', () => {
    expect(canNotify(base({ sentInWindow: 3, frequencyCap: 3 }))).toEqual({
      allowed: false,
      reason: 'frequency_cap',
    });
  });

  it('blocks a send over the messaging budget', () => {
    expect(canNotify(base({ costMinor: 500, budgetRemainingMinor: 100 }))).toEqual({
      allowed: false,
      reason: 'over_budget',
    });
  });
});

describe('NotificationQueue', () => {
  it('enqueues idempotently and marks delivered', () => {
    const q = new NotificationQueue();
    q.enqueue('n1', 'sms');
    q.enqueue('n1', 'sms'); // idempotent
    expect(q.pending()).toHaveLength(1);
    q.markDelivered('n1');
    expect(q.pending()).toHaveLength(0);
    expect(q.find('n1')?.state).toBe('delivered');
  });

  it('retries then dead-letters a poison send after maxAttempts (never dropped)', () => {
    const q = new NotificationQueue();
    q.enqueue('n1', 'sms');
    q.recordFailure('n1', 'provider timeout', 3);
    q.recordFailure('n1', 'provider timeout', 3);
    expect(q.find('n1')?.state).toBe('pending'); // still retrying
    q.recordFailure('n1', 'provider timeout', 3);
    expect(q.find('n1')?.state).toBe('dead_letter');
    expect(q.deadLetters()).toHaveLength(1);
    expect(q.deadLetters()[0]?.attempts).toBe(3);
  });

  it('can force a poison item to the dead-letter queue', () => {
    const q = new NotificationQueue();
    q.enqueue('n1', 'email');
    q.deadLetter('n1', 'invalid address');
    expect(q.deadLetters()).toHaveLength(1);
    expect(q.pending()).toHaveLength(0);
  });
});
