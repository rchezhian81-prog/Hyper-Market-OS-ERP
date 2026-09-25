import { describe, it, expect } from 'vitest';
import {
  planProcessorErasureNotices,
  type ProcessorRegistryEntry,
  type PrivacyTombstone,
} from '../../packages/customer/src/index';
import {
  drainConnector,
  deadLetters,
  type ConnectorMessage,
  type ConnectorTransport,
} from '../../packages/integration/src/index';

// Processor / sub-processor erasure notification (M20-FR-04 / PRV / DPDP, owner decision — DEVELOPMENT-
// APPROVED, LEGAL CONFIRMATION REQUIRED). The plan feeds the EXISTING durable connector queue (M32-FR-02):
// one notice per processor holding an affected category, and a processor we cannot reach is retried and
// dead-lettered for a person — never lost (hard rules #6 #8, P-08). Pure and deterministic.

const AT = '2026-09-25T10:00:00.000Z';

const tombstone: PrivacyTombstone = {
  customerRef: 'cust-1',
  requestId: 'dsr-1',
  erasedAt: AT,
  maker: 'dpo-ravi',
  checker: 'officer-mala',
  categoriesErased: ['marketing_profile', 'contact'],
  categoriesMinimised: ['order_history'],
  categoriesRetained: [{ category: 'tax_invoice', retentionBasis: 'tax_invoice' }],
  complete: true,
};

// Three processors: SMS shares an erased category; loyalty shares a minimised one; the tax filer shares
// ONLY a retained category, so it must not be told to erase anything.
const processors: ProcessorRegistryEntry[] = [
  { processorId: 'sms-gw', name: 'SMS gateway', connectorId: 'conn-sms', connectorVersion: 'v1', categoriesShared: ['contact', 'marketing_profile'] },
  { processorId: 'loyalty', name: 'Loyalty provider', connectorId: 'conn-loyalty', connectorVersion: 'v2', categoriesShared: ['order_history'] },
  { processorId: 'tax-filer', name: 'Tax e-filing', connectorId: 'conn-tax', connectorVersion: 'v1', categoriesShared: ['tax_invoice'] },
];

describe('planProcessorErasureNotices — one notice per processor holding erased/minimised data', () => {
  it('notifies only the processors that hold an affected category, for that intersection only', () => {
    const notices = planProcessorErasureNotices({ tombstone, processors, at: AT });
    expect(notices.map((n) => n.processor.processorId)).toEqual(['loyalty', 'sms-gw']); // sorted, tax-filer excluded
    const sms = notices.find((n) => n.processor.processorId === 'sms-gw')!;
    expect(sms.notice.categories).toEqual(['contact', 'marketing_profile']); // intersection, sorted
    const loyalty = notices.find((n) => n.processor.processorId === 'loyalty')!;
    expect(loyalty.notice.categories).toEqual(['order_history']);
  });

  it('does NOT notify a processor that shared only a legally-retained category (nothing to erase there)', () => {
    const notices = planProcessorErasureNotices({ tombstone, processors, at: AT });
    expect(notices.some((n) => n.processor.processorId === 'tax-filer')).toBe(false);
  });

  it('uses a stable, idempotent key per (request, processor) so a resend never doubles', () => {
    const notices = planProcessorErasureNotices({ tombstone, processors, at: AT });
    const sms = notices.find((n) => n.processor.processorId === 'sms-gw')!;
    expect(sms.messageId).toBe('erasure-dsr-1-sms-gw');
    expect(sms.deliveryKey).toBe('erasure-dsr-1-sms-gw');
    // Re-planning the same erasure produces the same keys — idempotent by construction.
    const again = planProcessorErasureNotices({ tombstone, processors, at: '2026-09-26T00:00:00.000Z' });
    expect(again.find((n) => n.processor.processorId === 'sms-gw')!.deliveryKey).toBe(sms.deliveryKey);
  });

  it('carries the provider-neutral erase instruction and the subject/request reference', () => {
    const [first] = planProcessorErasureNotices({ tombstone, processors, at: AT });
    expect(first?.notice).toMatchObject({ subjectRef: 'cust-1', requestId: 'dsr-1', instruction: 'erase', requestedAt: AT });
  });

  it('plans nothing when no processor holds any affected category', () => {
    const onlyRetained = planProcessorErasureNotices({ tombstone, processors: [processors[2]!], at: AT });
    expect(onlyRetained).toEqual([]);
  });
});

describe('the notices ride the existing durable connector queue — delivered or dead-lettered, never lost', () => {
  // Turn the plan into queue messages, exactly as the wiring slice will.
  const enqueue = (): ConnectorMessage[] =>
    planProcessorErasureNotices({ tombstone, processors, at: AT }).map((n) => ({
      messageId: n.messageId,
      tenantId: 't-1',
      connectorId: n.processor.connectorId,
      connectorVersion: n.processor.connectorVersion,
      kind: 'privacy.erasure',
      payload: n.notice,
      deliveryKey: n.deliveryKey,
      enqueuedAt: AT,
      state: 'queued',
      attempts: 0,
    }));

  it('delivers a reachable processor and DEAD-LETTERS an unreachable one (hard rule #6, P-08)', () => {
    const messages = enqueue();
    // The SMS gateway rejects permanently; the loyalty provider accepts.
    const transport: ConnectorTransport = (m) =>
      m.connectorId === 'conn-sms'
        ? { outcome: 'permanent', detail: 'processor endpoint decommissioned' }
        : { outcome: 'delivered', detail: 'accepted' };

    const afterLoyalty = drainConnector({ connectorId: 'conn-loyalty', messages, transport, at: AT });
    const afterSms = drainConnector({ connectorId: 'conn-sms', messages: afterLoyalty.messages, transport, at: AT });

    expect(afterLoyalty.delivered).toEqual(['erasure-dsr-1-loyalty']);
    expect(afterSms.deadLettered).toEqual(['erasure-dsr-1-sms-gw']);
    // The failed notice is on the dead-letter queue for a person — surfaced, not silently dropped.
    const dead = deadLetters(afterSms.messages);
    expect(dead.map((m) => m.messageId)).toEqual(['erasure-dsr-1-sms-gw']);
    expect(dead[0]?.state).toBe('dead_lettered');
  });
});
