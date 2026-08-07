import { describe, it, expect } from 'vitest';
import {
  isMember,
  TENDER_KINDS,
  isTenderKind,
  isTenderStatus,
  isSaleStatus,
  STOCK_STATES,
  isStockState,
  isApprovalDecision,
  isRecordLifecycle,
  isConnectionState,
} from '../../packages/contracts/src/index';

// The shared vocabularies are the single source of truth for allowed values.
// These tests pin the members and the runtime guards used to validate external
// or parsed data.

describe('domain vocabularies', () => {
  it('validates tender kinds and rejects unknowns', () => {
    expect(isTenderKind('cash')).toBe(true);
    expect(isTenderKind('upi')).toBe(true);
    expect(isTenderKind('bitcoin')).toBe(false);
    expect(TENDER_KINDS).toContain('store_credit');
  });

  it('validates tender status, sale status and approval decision', () => {
    expect(isTenderStatus('uncertain')).toBe(true);
    expect(isTenderStatus('approved')).toBe(false);
    expect(isSaleStatus('voided')).toBe(true);
    expect(isSaleStatus('deleted')).toBe(false);
    expect(isApprovalDecision('rejected')).toBe(true);
    expect(isApprovalDecision('maybe')).toBe(false);
  });

  it('validates stock states (all six)', () => {
    for (const s of ['on_hand', 'reserved', 'quarantine', 'damaged', 'expired', 'in_transit']) {
      expect(isStockState(s)).toBe(true);
    }
    expect(isStockState('sold')).toBe(false);
    expect(STOCK_STATES).toHaveLength(6);
  });

  it('validates record lifecycle and connection state (§27.1)', () => {
    expect(isRecordLifecycle('pending_approval')).toBe(true);
    expect(isRecordLifecycle('archived')).toBe(true);
    expect(isRecordLifecycle('open')).toBe(false);
    expect(isConnectionState('offline')).toBe(true);
    expect(isConnectionState('reconnecting')).toBe(true);
    expect(isConnectionState('flaky')).toBe(false);
  });

  it('isMember is a reusable guard', () => {
    expect(isMember(['a', 'b'] as const, 'a')).toBe(true);
    expect(isMember(['a', 'b'] as const, 'c')).toBe(false);
  });
});
