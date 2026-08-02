import { describe, it, expect } from 'vitest';
import {
  makeEvent,
  isKnownEventType,
  isIsoUtcTimestamp,
} from '../../packages/contracts/src/index';

// The domain event envelope is the integration backbone (§30.2) and carries the
// idempotency key that makes replay safe (§31.1). These tests pin its validation
// so a malformed event can never be published.

const base = {
  id: 'evt_1',
  type: 'SaleCommitted' as const,
  occurredAt: '2026-08-02T09:30:00Z',
  idempotencyKey: 'sale-42',
  source: 'lane-3',
  payload: { saleId: 'sale-42' },
};

describe('makeEvent', () => {
  it('builds a frozen event and defaults version to 1', () => {
    const e = makeEvent(base);
    expect(e.type).toBe('SaleCommitted');
    expect(e.version).toBe(1);
    expect(e.idempotencyKey).toBe('sale-42');
    expect(Object.isFrozen(e)).toBe(true);
  });

  it('accepts an explicit version and rejects bad versions', () => {
    expect(makeEvent({ ...base, version: 3 }).version).toBe(3);
    expect(() => makeEvent({ ...base, version: 0 })).toThrow(RangeError);
    expect(() => makeEvent({ ...base, version: 1.5 })).toThrow(RangeError);
  });

  it('rejects empty required fields', () => {
    expect(() => makeEvent({ ...base, id: '' })).toThrow(RangeError);
    expect(() => makeEvent({ ...base, idempotencyKey: '  ' })).toThrow(RangeError);
    expect(() => makeEvent({ ...base, source: '' })).toThrow(RangeError);
  });

  it('rejects a non-UTC or malformed timestamp', () => {
    expect(() => makeEvent({ ...base, occurredAt: '2026-08-02T09:30:00' })).toThrow(RangeError);
    expect(() => makeEvent({ ...base, occurredAt: '2026-08-02 09:30:00Z' })).toThrow(RangeError);
    expect(() => makeEvent({ ...base, occurredAt: 'not-a-date' })).toThrow(RangeError);
    expect(() => makeEvent({ ...base, occurredAt: '2026-13-40T00:00:00Z' })).toThrow(RangeError);
  });
});

describe('timestamp and event-type helpers', () => {
  it('accepts ISO-8601 UTC with and without milliseconds', () => {
    expect(isIsoUtcTimestamp('2026-08-02T09:30:00Z')).toBe(true);
    expect(isIsoUtcTimestamp('2026-08-02T09:30:00.250Z')).toBe(true);
    expect(isIsoUtcTimestamp('2026-08-02T09:30:00+05:30')).toBe(false);
  });

  it('recognises the confirmed §30.2 event types', () => {
    expect(isKnownEventType('InventoryMoved')).toBe(true);
    expect(isKnownEventType('PeriodClosed')).toBe(true);
    expect(isKnownEventType('SomethingElse')).toBe(false);
  });
});
