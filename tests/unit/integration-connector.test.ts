import { describe, it, expect } from 'vitest';
import * as integration from '../../packages/integration/src/index';
import {
  applyMapping,
  drainConnector,
  deadLetters,
  queueHealth,
  requeueCorrected,
  backoffSeconds,
  type Mapping,
  type ConnectorMessage,
  type DeliveryResult,
} from '../../packages/integration/src/connector';

// M32-FR-02 acceptance: "a poison message lands in a visible dead-letter queue and cannot be
// deleted by an operator; retries are bounded; a connector upgrade doesn't break in-flight
// messages."

const MAPPING: Mapping = {
  connectorId: 'tally',
  version: 'v1',
  rules: [
    { kind: 'copy', from: 'voucherNo', to: 'VOUCHERNUMBER' },
    { kind: 'copy', from: 'amountMinor', to: 'AMOUNT' },
    { kind: 'lookup', from: 'ledger', to: 'LEDGERNAME', table: { sales: 'Sales Account', gst: 'Output GST' } },
    { kind: 'constant', to: 'VCHTYPE', value: 'Sales' },
  ],
  required: ['VOUCHERNUMBER', 'AMOUNT', 'LEDGERNAME', 'VCHTYPE'],
};

describe('an unmapped field is an EXCEPTION, not a dropped field (M32-FR-02)', () => {
  it('maps a clean record', () => {
    const r = applyMapping({
      mapping: MAPPING, source: { voucherNo: 'V-1', amountMinor: 412_000, ledger: 'sales' },
    });
    expect(r.mapped).toBe(true);
    expect(r.output).toEqual({
      VOUCHERNUMBER: 'V-1', AMOUNT: 412_000, LEDGERNAME: 'Sales Account', VCHTYPE: 'Sales',
    });
  });

  it('REFUSES when a source field no rule accounts for appears', () => {
    const r = applyMapping({
      mapping: MAPPING,
      source: { voucherNo: 'V-1', amountMinor: 412_000, ledger: 'sales', cessMinor: 4_000 },
    });
    expect(r.mapped).toBe(false);
    expect(r.outcome).toBe('unmapped_fields');
    expect(r.unmapped).toEqual(['cessMinor']);
    // Dropping it silently is how a tax code stops reaching the accounts package.
    expect(r.detail).toContain('for a quarter');
  });

  it('accepts a field deliberately ignored, because that is a decision with a name on it', () => {
    const r = applyMapping({
      mapping: MAPPING,
      source: { voucherNo: 'V-1', amountMinor: 412_000, ledger: 'sales', internalRef: 'x' },
      ignore: ['internalRef'],
    });
    expect(r.mapped).toBe(true);
  });

  it('REFUSES a lookup miss rather than mapping an unknown code to blank', () => {
    const r = applyMapping({
      mapping: MAPPING, source: { voucherNo: 'V-1', amountMinor: 412_000, ledger: 'mystery' },
    });
    expect(r.outcome).toBe('lookup_miss');
    expect(r.detail).toContain('posts and is wrong');
  });

  it('refuses when the destination\'s required field was not produced', () => {
    const r = applyMapping({
      mapping: MAPPING, source: { voucherNo: 'V-1', ledger: 'sales' },
    });
    expect(r.outcome).toBe('missing_required');
    expect(r.detail).toContain('AMOUNT');
  });
});

const message = (over: Partial<ConnectorMessage>): ConnectorMessage => ({
  messageId: 'm-1', tenantId: 't-sre', connectorId: 'tally', connectorVersion: 'v1',
  kind: 'journal', payload: { voucherNo: 'V-1' }, deliveryKey: 'k-1',
  enqueuedAt: '2026-08-04T09:00:00Z', state: 'queued', attempts: 0, ...over,
});

const always =
  (outcome: DeliveryResult['outcome'], detail?: string) => (): DeliveryResult => ({
    outcome,
    detail: detail ?? outcome,
  });

function drain(over: Partial<Parameters<typeof drainConnector>[0]> = {}) {
  return drainConnector({
    connectorId: 'tally', messages: [message({})], transport: always('delivered'),
    at: '2026-08-04T09:05:00Z', ...over,
  });
}

describe('retries are bounded and a permanent error skips them entirely', () => {
  it('delivers and marks it delivered', () => {
    const r = drain();
    expect(r.delivered).toEqual(['m-1']);
    expect(r.messages[0]?.state).toBe('delivered');
  });

  it('counts a DUPLICATE as delivered — the destination already has it', () => {
    const r = drain({ transport: always('duplicate') });
    expect(r.delivered).toEqual(['m-1']);
    // Treating a duplicate as a failure re-sends it forever.
    expect(r.messages[0]?.state).toBe('delivered');
  });

  it('DEAD-LETTERS a permanent error immediately, without burning retries', () => {
    const r = drain({ transport: always('permanent', 'ledger does not exist') });
    expect(r.deadLettered).toEqual(['m-1']);
    expect(r.messages[0]?.attempts).toBe(1);
    expect(r.messages[0]?.lastError).toBe('ledger does not exist');
  });

  it('backs off a retryable error and gives up at the bound', () => {
    const first = drain({ transport: always('retryable', 'connection reset') });
    expect(first.requeued).toEqual([{ messageId: 'm-1', nextAttemptInSeconds: 2 }]);
    expect(first.messages[0]?.state).toBe('queued');

    const last = drain({
      messages: [message({ attempts: 4 })], transport: always('retryable', 'connection reset'),
    });
    expect(last.deadLettered).toEqual(['m-1']);
    expect(last.messages[0]?.lastError).toContain('gave up after 5 attempts');
  });

  it('backs off exponentially and caps', () => {
    expect([1, 2, 3, 4].map((n) => backoffSeconds(n))).toEqual([2, 4, 8, 16]);
    expect(backoffSeconds(20)).toBe(900);
  });

  it('THROTTLING WAITS — a rate limit never discards a message', () => {
    const r = drain({ transport: always('throttled', 'HTTP 429') });
    expect(r.throttled).toEqual(['m-1']);
    expect(r.messages[0]?.state).toBe('queued');
    // A provider's capacity problem is not a reason to lose our message.
    expect(r.messages[0]?.attempts).toBe(0);
  });

  it('respects the per-drain rate and leaves the rest queued', () => {
    const many = Array.from({ length: 5 }, (_, n) => message({ messageId: `m-${n}`, deliveryKey: `k-${n}` }));
    const r = drain({ messages: many, policy: { ratePerDrain: 2 } });
    expect(r.delivered).toHaveLength(2);
    expect(r.throttled).toHaveLength(3);
  });

  it('does not touch another connector\'s queue', () => {
    const r = drain({ messages: [message({}), message({ messageId: 'm-other', connectorId: 'whatsapp' })] });
    expect(r.messages.find((m) => m.messageId === 'm-other')?.state).toBe('queued');
  });

  it('delivers an IN-FLIGHT message under the version it was enqueued with', () => {
    // A connector upgraded to v2 while this message was queued still sends it as v1.
    const r = drain({ messages: [message({ connectorVersion: 'v1' })] });
    expect(r.messages[0]?.connectorVersion).toBe('v1');
  });
});

describe('a dead letter is READ, never deleted (hard rule #6)', () => {
  const failed = message({ state: 'dead_lettered', attempts: 5, lastError: 'ledger does not exist', deadLetteredAt: '2026-08-01T09:00:00Z' });

  it('lists dead letters oldest first', () => {
    const list = deadLetters([
      failed,
      { ...failed, messageId: 'm-2', deadLetteredAt: '2026-07-28T09:00:00Z' },
      message({ messageId: 'm-live' }),
    ]);
    expect(list.map((m) => m.messageId)).toEqual(['m-2', 'm-1']);
  });

  it('EXPOSES NO FUNCTION that could empty the queue', () => {
    // Absence as a control: an operator cannot delete evidence, because the verb does
    // not exist anywhere in the package.
    const named = Object.keys(integration);
    for (const forbidden of ['purgeDeadLetters', 'clearDeadLetters', 'deleteMessage', 'removeDeadLetter', 'dropQueue']) {
      expect(named).not.toContain(forbidden);
    }
  });

  it('resolves a failure with a NEW message and a NEW key, keeping the original', () => {
    const r = requeueCorrected({
      original: failed, correctedPayload: { voucherNo: 'V-1', ledger: 'sales' },
      newMessageId: 'm-1c', newDeliveryKey: 'k-1c', correctedBy: 'u-finance',
      messages: [failed], at: '2026-08-04T10:00:00Z',
    });
    expect(r.requeued).toBe(true);
    // The original still stands, marked rather than edited away.
    const original = r.messages.find((m) => m.messageId === 'm-1');
    expect(original?.state).toBe('dead_lettered');
    expect(original?.supersededBy).toBe('m-1c');
    expect(original?.lastError).toBe('ledger does not exist');

    const corrected = r.messages.find((m) => m.messageId === 'm-1c');
    expect(corrected?.state).toBe('queued');
    expect(corrected?.attempts).toBe(0);
    expect(corrected?.connectorVersion).toBe('v1');
  });

  it('REFUSES a correction that reuses the old delivery key', () => {
    const r = requeueCorrected({
      original: failed, correctedPayload: {}, newMessageId: 'm-1c', newDeliveryKey: 'k-1',
      correctedBy: 'u-finance', messages: [failed], at: '2026-08-04T10:00:00Z',
    });
    expect(r.outcome).toBe('same_key');
    expect(r.detail).toContain('indistinguishable from a retry');
  });

  it('refuses to correct a message that is not dead-lettered, or one already superseded', () => {
    expect(requeueCorrected({
      original: message({}), correctedPayload: {}, newMessageId: 'm-x', newDeliveryKey: 'k-x',
      correctedBy: 'u-finance', messages: [], at: '2026-08-04T10:00:00Z',
    }).outcome).toBe('not_dead_lettered');

    expect(requeueCorrected({
      original: { ...failed, supersededBy: 'm-old' }, correctedPayload: {},
      newMessageId: 'm-x', newDeliveryKey: 'k-x', correctedBy: 'u-finance',
      messages: [], at: '2026-08-04T10:00:00Z',
    }).outcome).toBe('already_superseded');
  });
});

describe('a queue that is neither growing nor moving is an outage nobody noticed (P-08)', () => {
  it('flags a stalled queue by AGE, not by depth', () => {
    const h = queueHealth({
      connectorId: 'tally',
      messages: [message({ enqueuedAt: '2026-08-04T06:00:00Z' })],
      at: '2026-08-04T09:00:00Z',
    });
    expect(h.needsAttention).toBe(true);
    expect(h.oldestQueuedMinutes).toBe(180);
    expect(h.detail).toContain('depth alone says nothing');
  });

  it('is quiet on a queue that is moving', () => {
    const h = queueHealth({
      connectorId: 'tally',
      messages: [message({ enqueuedAt: '2026-08-04T08:50:00Z' })],
      at: '2026-08-04T09:00:00Z',
    });
    expect(h.needsAttention).toBe(false);
  });

  it('needs attention while an unresolved dead letter sits there', () => {
    const h = queueHealth({
      connectorId: 'tally',
      messages: [message({ state: 'dead_lettered', deadLetteredAt: '2026-08-01T09:00:00Z' })],
      at: '2026-08-04T09:00:00Z',
    });
    expect(h.needsAttention).toBe(true);
    expect(h.oldestDeadLetterDays).toBe(3);
    expect(h.detail).toContain('read, never deleted');
  });

  it('stops nagging once every dead letter has been superseded', () => {
    const h = queueHealth({
      connectorId: 'tally',
      messages: [message({ state: 'dead_lettered', deadLetteredAt: '2026-08-01T09:00:00Z', supersededBy: 'm-1c' })],
      at: '2026-08-04T09:00:00Z',
    });
    expect(h.needsAttention).toBe(false);
  });

  it('reports an empty queue plainly', () => {
    const h = queueHealth({ connectorId: 'tally', messages: [], at: '2026-08-04T09:00:00Z' });
    expect(h.oldestQueuedMinutes).toBe('nothing_queued');
    expect(h.oldestDeadLetterDays).toBe('none');
  });
});
