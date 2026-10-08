import { describe, it, expect } from 'vitest';
import { SEALED_DECISIONS, withDeciderSeal } from '../../edge/store-edge/src/decision-seal';
import { checkDeciderStamp, tillSealKey, DECIDER_STAMP_FIELD, type DecisionKind } from '../../packages/identity/src/till-seal';
import { deciderSealFlags } from '../../services/pos/src/store-seal';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **The store computer seals a back-office decision only for the person it verified, and head office checks every word
 * (2b-vi-c-3 · ADR-0023 amended · audit PA-03 · hard rule #10).**
 *
 * For each of the five decisions the box carries — an approval decided, a supplier bill captured, a checklist signed, a
 * migration exception resolved, a control total signed — the box stamps the record when the person it verified is the
 * person the record names, and never otherwise; a stamp the device wrote itself is removed. Head office's check passes
 * the stamped record and fails one changed after the seal, one for another shop, one moved to another record, and one
 * whose stamp names somebody other than the decider. Keys are built at run time (no secret in the repository).
 */

const key = tillSealKey(['decision', 'seal', 'unit', 'key'].join('-').padEnd(48, '0'));
const otherKey = tillSealKey(['another', 'store', 'entirely'].join('-').padEnd(48, '0'));
const A = 'tenant-a';
const MEENA = { userId: 'u-meena', via: 'pin', laneId: 'lane-1' };

const CASES: { type: string; payload: Record<string, unknown> }[] = [
  { type: 'ApprovalDecided', payload: { id: 'ap-1', subjectType: 'refund', status: 'approved', decidedBy: 'u-meena', reason: 'ok' } },
  { type: 'SupplierInvoiceCaptured', payload: { invoiceId: 'inv-1', supplierId: 's1', declaredTotalMinor: 100, capturedBy: 'u-meena' } },
  { type: 'ChecklistCompleted', payload: { checklistId: 'cl-1', items: [{ id: 'i1', done: true }], signedBy: 'u-meena' } },
  { type: 'MigrationExceptionResolved', payload: { exceptionId: 'ex-1', action: 'exclude', decidedBy: 'u-meena', reason: 'obsolete' } },
  { type: 'MigrationTotalSigned', payload: { totalId: 'ct-1', signerRole: 'owner', signedBy: 'u-meena', statement: 'counted' } },
];
const eventOf = (type: string, payload: Record<string, unknown>) =>
  makeEvent({ id: `e-${type}`, type, occurredAt: '2026-10-08T10:00:00.000Z', idempotencyKey: `k-${type}`, source: 'web-erp', payload });
const payloadOf = (e: { payload: unknown }) => e.payload as Record<string, unknown>;

describe('the box seals a decision for the person it verified, and only them', () => {
  for (const c of CASES) {
    const shape = SEALED_DECISIONS[c.type]!;
    const named = String(c.payload[shape.named]);
    const recordId = String(c.payload[shape.id]);
    const check = (k: Buffer, record: unknown, over: Partial<{ tenantId: string; kind: DecisionKind; recordId: string; named: string }> = {}) =>
      checkDeciderStamp(k, { tenantId: A, kind: shape.kind, recordId, named, record, ...over });

    it(`${c.type}: sealed when the verified person is the one named; head office verifies it`, () => {
      const sealed = payloadOf(withDeciderSeal(key, A, eventOf(c.type, c.payload), MEENA));
      expect(sealed[DECIDER_STAMP_FIELD]).toMatchObject({ userId: 'u-meena', via: 'pin', laneId: 'lane-1' });
      expect(check(key, sealed)).toBe('verified');
      expect(deciderSealFlags(key, { tenantId: A, kind: shape.kind, recordId, named, record: sealed })).toEqual([]);
      // Key order does not matter: the record is digested canonically.
      const reordered = Object.fromEntries(Object.entries(sealed).reverse());
      expect(check(key, reordered)).toBe('verified');
    });

    it(`${c.type}: any change after the seal, another shop, another record, another kind or another key does not match`, () => {
      const sealed = payloadOf(withDeciderSeal(key, A, eventOf(c.type, c.payload), MEENA));
      const firstField = Object.keys(c.payload).find((k) => k !== shape.id && k !== shape.named)!;
      expect(check(key, { ...sealed, [firstField]: 'changed after the seal' })).toBe('does_not_match');
      expect(check(key, sealed, { tenantId: 'tenant-b' })).toBe('does_not_match');
      expect(check(key, sealed, { recordId: `${recordId}-other` })).toBe('does_not_match');
      expect(check(key, sealed, { kind: shape.kind === 'checklist' ? 'approval_decision' : 'checklist' })).toBe('does_not_match');
      expect(check(otherKey, sealed)).toBe('does_not_match');
      // A stamp that names somebody else than the decider the record names.
      expect(check(key, sealed, { named: 'u-other' })).toBe('does_not_match');
      expect(deciderSealFlags(key, { tenantId: A, kind: shape.kind, recordId, named, record: { ...sealed, [firstField]: 'x' } })).toEqual(['decider_seal_does_not_match']);
    });

    it(`${c.type}: nobody verified, or somebody else verified → unstamped; a device-written stamp is removed`, () => {
      expect(payloadOf(withDeciderSeal(key, A, eventOf(c.type, c.payload), undefined))[DECIDER_STAMP_FIELD]).toBeUndefined();
      expect(payloadOf(withDeciderSeal(key, A, eventOf(c.type, c.payload), { ...MEENA, userId: 'u-other' }))[DECIDER_STAMP_FIELD]).toBeUndefined();
      const forged = { ...c.payload, [DECIDER_STAMP_FIELD]: { userId: 'u-meena', via: 'pin', laneId: 'lane-1', seal: 'made-up' } };
      const relayed = payloadOf(withDeciderSeal(key, A, eventOf(c.type, forged), undefined));
      expect(relayed[DECIDER_STAMP_FIELD]).toBeUndefined();
      expect(check(key, relayed)).toBe('missing');
      expect(deciderSealFlags(key, { tenantId: A, kind: shape.kind, recordId, named, record: relayed })).toEqual(['decider_not_verified_at_store']);
    });
  }

  it('a record the box does not seal passes through untouched; without a key head office claims nothing', () => {
    const sale = eventOf('GoodsReceived', { grnId: 'g1', receivedBy: 'u-meena' });
    expect(withDeciderSeal(key, A, sale, MEENA)).toBe(sale);
    expect(deciderSealFlags(undefined, { tenantId: A, kind: 'checklist', recordId: 'cl-1', named: 'u-meena', record: {} })).toEqual([]);
  });
});
