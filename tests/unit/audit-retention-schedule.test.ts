import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUDIT_RETENTION,
  DEFAULT_AUDIT_RETENTION_YEARS,
  defaultRetentionPolicyFor,
  retentionPoliciesOrDefault,
  planRetention,
  type AuditRecord,
  type LegalHold,
} from '../../packages/audit/src/index';

// The owner-approved default audit-retention schedule (M34-FR-02 / hard rule #6). It exists so the
// retention routes can classify the audit trail without the caller re-supplying a policy set every
// call — and so the answer is "statutory, never deleted" rather than the vaguer "no policy".

// Every object type the M34 producers actually seal today (role.grant→user, secret.*→secret,
// price.change & stock.write_off→product, purchase.order.place→purchase-order, refund.accept→sale,
// settlement.batch.import→settlement-batch).
const M34_OBJECT_TYPES = ['user', 'secret', 'product', 'purchase-order', 'sale', 'settlement-batch'];

describe('the default audit-retention schedule covers every audit class as statutory (hard rule #6)', () => {
  it('names a policy for every object type the M34 producers seal', () => {
    const covered = DEFAULT_AUDIT_RETENTION.map((p) => p.objectType).sort();
    expect(covered).toEqual([...M34_OBJECT_TYPES].sort());
  });

  it('marks EVERY class statutory — audit evidence is never deleted through retention', () => {
    // If a future producer's class is added here without statutory:true, this fails on purpose:
    // the whole point of the schedule is that money-path and privilege evidence cannot age out.
    expect(DEFAULT_AUDIT_RETENTION.every((p) => p.statutory === true)).toBe(true);
  });

  it('keeps the owner-approved 8-year minimum floor, with a plain-English basis for the auditor', () => {
    expect(DEFAULT_AUDIT_RETENTION_YEARS).toBe(8);
    for (const p of DEFAULT_AUDIT_RETENTION) {
      expect(p.retainDays).toBe(8 * 365);
      expect(p.basis).toBeTruthy();
      expect(p.basis).toMatch(/hard rule #6/);
    }
  });

  it('resolves a known class and returns nothing for an unknown one', () => {
    expect(defaultRetentionPolicyFor('secret')?.statutory).toBe(true);
    expect(defaultRetentionPolicyFor('not-an-audit-class')).toBeUndefined();
  });
});

describe('retentionPoliciesOrDefault: omit for the default, malformed is still rejected', () => {
  it('uses the default schedule when the caller sent no policies field', () => {
    expect(retentionPoliciesOrDefault(undefined, false)).toBe(DEFAULT_AUDIT_RETENTION);
  });

  it('passes the caller\'s own policies through when they supplied a readable set', () => {
    const supplied = [{ objectType: 'secret', retainDays: 30 }];
    expect(retentionPoliciesOrDefault(supplied, true)).toBe(supplied);
  });

  it('returns undefined (→ the route answers 400) when a policies field was sent but did not read', () => {
    // A malformed policy set is a mistake to surface, never to silently replace with the default.
    expect(retentionPoliciesOrDefault(undefined, true)).toBeUndefined();
  });
});

const rec = (over: Partial<AuditRecord>): AuditRecord => ({
  sequence: 1,
  objectType: 'secret',
  objectId: 'k1',
  at: '2020-01-01T00:00:00.000Z',
  actorId: 'u-owner',
  action: 'secret.register',
  ...over,
} as AuditRecord);

describe('planRetention over the default schedule classifies audit evidence as statutory, forever', () => {
  it('an ancient audit record is STATUTORY under the default — never eligible for review', () => {
    const decisions = planRetention(
      [rec({ objectType: 'sale', objectId: 'S-1' }), rec({ objectType: 'user', objectId: 'U-1', sequence: 2 })],
      DEFAULT_AUDIT_RETENTION,
      [],
      '2100-01-01T00:00:00.000Z', // 80 years later — far past any floor
    );
    expect(decisions.decisions.every((d) => d.outcome === 'statutory')).toBe(true);
    expect(decisions.eligibleForReview).toEqual([]);
    expect(decisions.statutoryCount).toBe(2);
  });

  it('a legal hold still outranks the default schedule', () => {
    const hold: LegalHold = {
      holdId: 'H1', objectType: 'secret', placedBy: 'u-owner',
      placedAt: '2026-01-01T00:00:00.000Z', reason: 'investigation',
    };
    const plan = planRetention([rec({})], DEFAULT_AUDIT_RETENTION, [hold], '2100-01-01T00:00:00.000Z');
    expect(plan.decisions[0]?.outcome).toBe('legal_hold');
    expect(plan.heldCount).toBe(1);
  });

  it('a class outside the schedule is KEPT as no_policy — silence never means discard', () => {
    const plan = planRetention([rec({ objectType: 'mystery' })], DEFAULT_AUDIT_RETENTION, [], '2100-01-01T00:00:00.000Z');
    expect(plan.decisions[0]?.outcome).toBe('no_policy');
    expect(plan.noPolicyCount).toBe(1);
  });
});
