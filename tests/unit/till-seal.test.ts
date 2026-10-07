import { describe, it, expect } from 'vitest';
import {
  tillSealKey, sealTillFact, tillSealMatches, checkOperatorStamp, checkApprovalStamp, type TillSealSubject,
} from '../../packages/identity/src/till-seal';
import { tillPinKey } from '../../packages/identity/src/till-pin';
import { cashierSealFlags, approvalSealFlags, stampIn } from '../../services/pos/src/store-seal';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/sale-intake';

/**
 * **The store computer's seal on who it verified (ADR-0023 · Wave 2b-v-d · audit PF-02).** The box signs what it verified
 * — the fact, the shop, the record, the till, the person, how they proved it, the amount — under a key derived from the
 * pack signing key; head office checks it and flags (never refuses) a fact with no seal or a seal that does not match.
 */

// Built at run time, never a literal secret (hard rule #4).
const PACK = ['seal', 'unit', 'test', 'pack', 'key'].join('-').padEnd(48, '0');
const OTHER = ['another', 'store', 'pack', 'key'].join('-').padEnd(48, '0');
const KEY = tillSealKey(PACK);
const subject: TillSealSubject = { fact: 'sale', tenantId: 't-sre', recordId: 'S-1', laneId: 'lane-1', userId: 'u-meena', via: 'pin', amountMinor: 96_000 };

describe('the seal key and the seal', () => {
  it('derives its own key under its own label — never the pack key, never the till-PIN key', () => {
    expect(KEY).toHaveLength(32);
    expect(KEY.equals(tillPinKey(PACK))).toBe(false);
    expect(KEY.equals(Buffer.from(PACK))).toBe(false);
    expect(tillSealKey(PACK).equals(KEY)).toBe(true);          // the box and head office derive the same key
    expect(tillSealKey(OTHER).equals(KEY)).toBe(false);
    expect(() => tillSealKey('short')).toThrow(/full pack signing key/);
  });

  it('is deterministic — a record re-sent after a lost reply seals the same', () => {
    expect(sealTillFact(KEY, subject)).toBe(sealTillFact(KEY, { ...subject }));
    expect(sealTillFact(KEY, subject)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds every field: change any one and the seal no longer matches', () => {
    const seal = sealTillFact(KEY, subject);
    expect(tillSealMatches(KEY, subject, seal)).toBe(true);
    const changes: Partial<TillSealSubject>[] = [
      { fact: 'return' }, { tenantId: 't-other' }, { recordId: 'S-2' }, { laneId: 'lane-2' }, { userId: 'u-ravi' },
      { via: 'verified_sign_in' }, { amountMinor: 96_001 }, { approvalId: 'apr-1' },
    ];
    for (const change of changes) expect(tillSealMatches(KEY, { ...subject, ...change }, seal)).toBe(false);
    expect(tillSealMatches(tillSealKey(OTHER), subject, seal)).toBe(false); // another key: not this box's seal
  });

  it('anything that is not a well-formed seal is simply no match', () => {
    for (const bad of [undefined, null, 7, '', 'zz', 'a'.repeat(63), 'g'.repeat(64), { seal: 'x' }]) {
      expect(tillSealMatches(KEY, subject, bad)).toBe(false);
    }
  });
});

describe('head office checks a stamp on the person a fact names', () => {
  const stamp = { userId: 'u-meena', via: 'pin', laneId: 'lane-1', seal: sealTillFact(KEY, subject) };
  const check = (over: Partial<Parameters<typeof checkOperatorStamp>[1]> = {}) =>
    checkOperatorStamp(KEY, { fact: 'sale', tenantId: 't-sre', recordId: 'S-1', amountMinor: 96_000, named: 'u-meena', stamp, ...over });

  it('the box\'s seal on this person and this fact: verified', () => {
    expect(check()).toBe('verified');
  });
  it('no stamp, or a stamp without a seal (an old box, or no till at all): missing', () => {
    expect(check({ stamp: undefined })).toBe('missing');
    expect(check({ stamp: { userId: 'u-meena', via: 'pin', laneId: 'lane-1' } })).toBe('missing');
    expect(check({ stamp: 'u-meena' })).toBe('missing');
  });
  it('the fact names someone other than the person the box verified: does not match', () => {
    expect(check({ named: 'u-ravi' })).toBe('does_not_match');
  });
  it('the seal copied onto another record, another amount, another shop, or forged: does not match', () => {
    expect(check({ recordId: 'S-2' })).toBe('does_not_match');
    expect(check({ amountMinor: 1 })).toBe('does_not_match');
    expect(check({ tenantId: 't-other' })).toBe('does_not_match');
    expect(check({ fact: 'return' })).toBe('does_not_match');
    expect(check({ stamp: { ...stamp, seal: '0'.repeat(64) } })).toBe('does_not_match');
    expect(check({ stamp: { ...stamp, laneId: 'lane-2' } })).toBe('does_not_match');
  });
});

describe('head office checks the stamp on a manager\'s approval', () => {
  const approvalSubject: TillSealSubject = { fact: 'approval', tenantId: 't-sre', recordId: 'RT-1', laneId: 'lane-1', userId: 'u-mgr', via: 'approval', amountMinor: 48_000, approvalId: 'apr-1' };
  const stamp = { approvalId: 'apr-1', approvedBy: 'u-mgr', laneId: 'lane-1', seal: sealTillFact(KEY, approvalSubject) };
  const check = (over: Partial<Parameters<typeof checkApprovalStamp>[1]> = {}) =>
    checkApprovalStamp(KEY, { tenantId: 't-sre', recordId: 'RT-1', amountMinor: 48_000, approvedBy: 'u-mgr', stamp, ...over });

  it('verified, missing, or not matching (another manager named, another refund, another amount, another approval)', () => {
    expect(check()).toBe('verified');
    expect(check({ stamp: undefined })).toBe('missing');
    expect(check({ stamp: { approvalId: 'apr-1', approvedBy: 'u-mgr', laneId: 'lane-1' } })).toBe('missing');
    expect(check({ approvedBy: 'u-owner' })).toBe('does_not_match');
    expect(check({ recordId: 'RT-2' })).toBe('does_not_match');
    expect(check({ amountMinor: 48_001 })).toBe('does_not_match');
    expect(check({ stamp: { ...stamp, approvalId: 'apr-2' } })).toBe('does_not_match');
  });
});

describe('the flags head office raises (record-and-flag, never a refusal)', () => {
  const seal = sealTillFact(KEY, { ...subject, fact: 'return', recordId: 'RT-1', amountMinor: 48_000 });
  const base = { fact: 'return' as const, tenantId: 't-sre', recordId: 'RT-1', amountMinor: 48_000, named: 'u-meena' };

  it('no flag when the seal matches, or when nobody checks (no key), or nobody is named', () => {
    expect(cashierSealFlags(KEY, { ...base, stamp: { userId: 'u-meena', via: 'pin', laneId: 'lane-1', seal } })).toEqual([]);
    expect(cashierSealFlags(undefined, { ...base, stamp: undefined })).toEqual([]);
    expect(cashierSealFlags(KEY, { ...base, named: ' ', stamp: undefined })).toEqual([]);
    expect(approvalSealFlags(KEY, { tenantId: 't-sre', recordId: 'RT-1', amountMinor: 48_000, approvedBy: undefined, stamp: undefined })).toEqual([]);
    expect(approvalSealFlags(undefined, { tenantId: 't-sre', recordId: 'RT-1', amountMinor: 48_000, approvedBy: 'u-mgr', stamp: undefined })).toEqual([]);
  });
  it('names what it found: not verified at the store, or a seal that does not match', () => {
    expect(cashierSealFlags(KEY, { ...base, stamp: undefined })).toEqual(['cashier_not_verified_at_store']);
    expect(cashierSealFlags(KEY, { ...base, stamp: { userId: 'u-meena', via: 'pin', laneId: 'lane-1', seal: '1'.repeat(64) } })).toEqual(['cashier_seal_does_not_match']);
    expect(approvalSealFlags(KEY, { tenantId: 't-sre', recordId: 'RT-1', amountMinor: 48_000, approvedBy: 'u-mgr', stamp: undefined })).toEqual(['approval_not_verified_at_store']);
    expect(approvalSealFlags(KEY, { tenantId: 't-sre', recordId: 'RT-1', amountMinor: 48_000, approvedBy: 'u-mgr', stamp: { approvalId: 'a', approvedBy: 'u-mgr', laneId: 'lane-1', seal: '2'.repeat(64) } })).toEqual(['approval_seal_does_not_match']);
  });
  it('reads a stamp off a relayed body without trusting its shape', () => {
    expect(stampIn({ operatorVerified: { userId: 'x' } }, 'operatorVerified')).toEqual({ userId: 'x' });
    expect(stampIn(null, 'approvalVerified')).toBeUndefined();
    expect(stampIn('text', 'operatorVerified')).toBeUndefined();
  });
});

describe('the sale intake says what it made of the seal (M12-FR-04 · PF-02)', () => {
  const sale: IncomingSale = {
    saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-10-06', committedAt: '2026-10-06T10:00:00.000Z',
    totalMinor: 48_000, currency: 'INR', packVersion: 1,
    lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 48_000, lineTotalMinor: 48_000 }],
    tenders: [{ kind: 'cash', amountMinor: 48_000 }],
  };
  const ctx = (over: Partial<IntakeContext> = {}): IntakeContext => ({
    catalogue: new Map(), currentPackVersion: 1, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2026-10-06T11:00:00.000Z', ...over,
  });
  const sealKinds = (over: Partial<IntakeContext>, s: IncomingSale = sale) =>
    acceptSale(s, ctx(over)).exceptions.filter((e) => e.kind.startsWith('cashier_')).map((e) => `${e.kind}:${e.severity}`);

  it('verified, or not checked at all: no finding', () => {
    expect(sealKinds({ cashierSeal: 'verified' })).toEqual([]);
    expect(sealKinds({})).toEqual([]);
  });
  it('missing is material; not matching is critical — and the sale is banked either way', () => {
    expect(sealKinds({ cashierSeal: 'missing' })).toEqual(['cashier_not_verified_at_store:material']);
    expect(sealKinds({ cashierSeal: 'does_not_match' })).toEqual(['cashier_seal_does_not_match:critical']);
    expect(acceptSale(sale, ctx({ cashierSeal: 'does_not_match' })).banked).toBe(true);
  });
  it('a sale naming no cashier is already its own finding — no seal finding on top', () => {
    expect(acceptSale({ ...sale, cashierId: '' }, ctx({ cashierSeal: 'missing' })).exceptions.map((e) => e.kind)).toContain('sale_names_no_cashier');
    expect(sealKinds({ cashierSeal: 'missing' }, { ...sale, cashierId: '' })).toEqual([]);
  });
});
