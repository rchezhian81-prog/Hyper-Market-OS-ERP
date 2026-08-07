import { describe, it, expect } from 'vitest';
import {
  AuditTrail,
  InMemoryAuditStore,
  IncompleteEvidenceError,
  fnv1a64,
  buildEvidencePack,
  planRetention,
  liftHold,
  type AuditEntry,
  type AuditRecord,
  type LegalHold,
  type RetentionPolicy,
} from '../../packages/audit/src/index';

// M34-FR-01/02 — the tamper-evident memory of the system. Every sensitive action is
// reconstructable from evidence alone (NFR-15), no user can edit the log, and
// nothing here deletes evidence (hard rule #6).

const ORIGIN = { tenantId: 't1', branchId: 'b1', deviceId: 'till-3' } as const;

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    actorId: 'manager-1',
    action: 'price.change',
    objectType: 'product_price',
    objectId: 'p-100',
    at: '2026-08-01T10:00:00Z',
    origin: ORIGIN,
    before: { price_minor: '5000' },
    after: { price_minor: '4500' },
    reason: 'competitor match',
    approvalId: 'apr-9',
    ...over,
  };
}

function trail(): AuditTrail {
  return new AuditTrail(new InMemoryAuditStore());
}

describe('AuditTrail — immutable who/what/when/where/before/after (M34-FR-01)', () => {
  it('records who did what, when, where, and the before/after state', () => {
    const record = trail().record(entry());
    expect(record.sequence).toBe(1);
    expect(record.actorId).toBe('manager-1');
    expect(record.action).toBe('price.change');
    expect(record.origin.deviceId).toBe('till-3');
    expect(record.before).toEqual({ price_minor: '5000' });
    expect(record.after).toEqual({ price_minor: '4500' });
    expect(record.approvalId).toBe('apr-9');
  });

  it('offers no way to edit or delete a record — not even to the owner', () => {
    const audit = trail();
    audit.record(entry());
    // The requirement is an absence: the API cannot express a change or a removal.
    const surface = audit as unknown as Record<string, unknown>;
    for (const forbidden of ['update', 'edit', 'delete', 'remove', 'purge', 'clear']) {
      expect(surface[forbidden]).toBeUndefined();
    }
  });

  it('seals each record to the one before it, so the trail is a chain', () => {
    const audit = trail();
    const first = audit.record(entry());
    const second = audit.record(entry({ at: '2026-08-01T11:00:00Z', objectId: 'p-101' }));
    expect(first.previousHash).toBe('');
    expect(second.previousHash).toBe(first.hash);
    expect(second.sequence).toBe(2);
    expect(audit.verify()).toEqual({ intact: true, recordsChecked: 2, findings: [] });
  });

  it('detects a record edited behind our back, and names it (SEC-07, P-08)', () => {
    const store = new InMemoryAuditStore();
    const audit = new AuditTrail(store);
    audit.record(entry());
    audit.record(entry({ at: '2026-08-01T11:00:00Z', action: 'refund.approve', objectId: 'r-1' }));

    // Somebody rewrites history directly in storage — the discount never happened.
    const tampered = store.all().map((r): AuditRecord =>
      r.sequence === 1 ? { ...r, after: { price_minor: '5000' } } : r,
    );
    const forged = new InMemoryAuditStore();
    for (const r of tampered) forged.append(r);

    const result = new AuditTrail(forged).verify();
    expect(result.intact).toBe(false);
    expect(result.findings[0]?.sequence).toBe(1);
    expect(result.findings.map((f) => f.reason)).toContain('hash_mismatch');
  });

  it('detects a record quietly removed from the middle of the trail', () => {
    const store = new InMemoryAuditStore();
    const audit = new AuditTrail(store);
    audit.record(entry());
    audit.record(entry({ at: '2026-08-01T11:00:00Z', objectId: 'p-101' }));
    audit.record(entry({ at: '2026-08-01T12:00:00Z', objectId: 'p-102' }));

    const gapped = new InMemoryAuditStore();
    for (const r of store.all().filter((r) => r.sequence !== 2)) gapped.append(r);

    const result = new AuditTrail(gapped).verify();
    expect(result.intact).toBe(false);
    expect(result.findings.map((f) => f.reason)).toEqual(
      expect.arrayContaining(['sequence_gap', 'broken_link']),
    );
  });

  it('refuses an entry that could not stand up as evidence', () => {
    const audit = trail();
    expect(() => audit.record(entry({ actorId: '  ' }))).toThrow(IncompleteEvidenceError);
    expect(() => audit.record(entry({ action: '' }))).toThrow(IncompleteEvidenceError);
    expect(() => audit.record(entry({ objectId: '' }))).toThrow(IncompleteEvidenceError);
    expect(() => audit.record(entry({ before: null, after: null }))).toThrow(IncompleteEvidenceError);
  });

  it('accepts an offline action and keeps the fact that it was offline (§31)', () => {
    const record = trail().record(
      entry({ origin: { tenantId: 't1', branchId: 'b1', deviceId: 'till-3', capturedOffline: true } }),
    );
    expect(record.origin.capturedOffline).toBe(true);
  });

  it('takes a stronger hasher through the port without changing the engine (P-06)', () => {
    // A deployment injects a real cryptographic digest; the chain logic is identical.
    const reversed = (input: string): string => `x${[...input].reverse().join('')}`;
    const audit = new AuditTrail(new InMemoryAuditStore(), reversed);
    const record = audit.record(entry());
    expect(record.hash.startsWith('x')).toBe(true);
    expect(audit.verify().intact).toBe(true);
  });

  it('hashes deterministically and differently for different content', () => {
    expect(fnv1a64('a')).toBe(fnv1a64('a'));
    expect(fnv1a64('a')).not.toBe(fnv1a64('b'));
    expect(fnv1a64('a')).toHaveLength(16);
  });
});

describe('AuditTrail — reconstruct and search (NFR-15, M34-FR-02)', () => {
  it('reconstructs an object’s state from evidence alone, with its history', () => {
    const audit = trail();
    audit.record(entry({ at: '2026-08-01T10:00:00Z', before: null, after: { price_minor: '5000' } }));
    audit.record(entry({ at: '2026-08-02T10:00:00Z', before: { price_minor: '5000' }, after: { price_minor: '4500' } }));
    audit.record(entry({ at: '2026-08-03T10:00:00Z', before: { price_minor: '4500' }, after: { price_minor: '4700' } }));

    const { state, history } = audit.reconstruct('product_price', 'p-100');
    expect(state).toEqual({ price_minor: '4700' });
    expect(history).toHaveLength(3);
    // The whole story: who moved it, when, and why — no screen involved.
    expect(history.map((r) => r.after?.price_minor)).toEqual(['5000', '4500', '4700']);
    expect(history[1]?.reason).toBe('competitor match');
  });

  it('searches by actor, action and period', () => {
    const audit = trail();
    audit.record(entry({ actorId: 'cashier-1', action: 'sale.void', objectId: 's-1', at: '2026-08-01T09:00:00Z' }));
    audit.record(entry({ actorId: 'cashier-1', action: 'sale.void', objectId: 's-2', at: '2026-08-02T09:00:00Z' }));
    audit.record(entry({ actorId: 'manager-1', action: 'price.change', objectId: 'p-1', at: '2026-08-02T09:30:00Z' }));

    expect(audit.search({ actorId: 'cashier-1' })).toHaveLength(2);
    expect(audit.search({ action: 'price.change' })).toHaveLength(1);
    expect(
      audit.search({ from: '2026-08-02T00:00:00Z', until: '2026-08-03T00:00:00Z' }),
    ).toHaveLength(2);
    expect(audit.search({ branchId: 'b9' })).toHaveLength(0);
  });
});

describe('Retention and legal hold (M34-FR-02, hard rule #6)', () => {
  const POLICIES: RetentionPolicy[] = [
    { objectType: 'marketing_consent', retainDays: 30 },
    { objectType: 'tax_invoice', retainDays: 2555, statutory: true, basis: 'GST record-keeping' },
  ];
  const AS_OF = '2026-08-03T00:00:00Z';

  function aged(objectType: string, objectId: string, at: string, actorId = 'staff-1'): AuditRecord {
    const audit = trail();
    return audit.record(entry({ objectType, objectId, at, actorId, approvalId: undefined }));
  }

  it('keeps anything with no policy — silence never means discard', () => {
    const plan = planRetention([aged('unknown_thing', 'x-1', '2020-01-01T00:00:00Z')], POLICIES, [], AS_OF);
    expect(plan.eligibleForReview).toHaveLength(0);
    expect(plan.noPolicyCount).toBe(1);
    expect(plan.decisions[0]?.explanation).toContain('never means discard');
  });

  it('never proposes a statutory record, however old', () => {
    const plan = planRetention([aged('tax_invoice', 'inv-1', '2010-01-01T00:00:00Z')], POLICIES, [], AS_OF);
    expect(plan.eligibleForReview).toHaveLength(0);
    expect(plan.statutoryCount).toBe(1);
  });

  it('keeps a record still inside its retention period, and says how long is left', () => {
    const plan = planRetention([aged('marketing_consent', 'c-1', '2026-07-30T00:00:00Z')], POLICIES, [], AS_OF);
    expect(plan.decisions[0]?.outcome).toBe('within_retention');
    expect(plan.decisions[0]?.explanation).toContain('26 to go');
  });

  it('a record under legal hold survives past its retention date (acceptance)', () => {
    const old = aged('marketing_consent', 'c-2', '2026-01-01T00:00:00Z');
    const hold: LegalHold = {
      holdId: 'hold-1',
      objectType: 'marketing_consent',
      placedBy: 'compliance-1',
      placedAt: '2026-06-01T00:00:00Z',
      reason: 'consumer complaint under investigation',
    };
    const held = planRetention([old], POLICIES, [hold], AS_OF);
    expect(held.eligibleForReview).toHaveLength(0);
    expect(held.decisions[0]?.outcome).toBe('legal_hold');
    expect(held.decisions[0]?.holdId).toBe('hold-1');

    // Lift the hold and the same record becomes reviewable — still not deleted.
    const lifted = liftHold(hold, 'compliance-1', '2026-08-02T00:00:00Z');
    const after = planRetention([old], POLICIES, [lifted], AS_OF);
    expect(after.decisions[0]?.outcome).toBe('eligible_for_review');
    expect(lifted.placedBy).toBe('compliance-1'); // the original hold is never erased
    expect(lifted.liftedBy).toBe('compliance-1');
  });

  it('holds one person’s activity for an investigation, leaving others alone', () => {
    const suspect = aged('marketing_consent', 'c-3', '2026-01-01T00:00:00Z', 'staff-9');
    const other = aged('marketing_consent', 'c-4', '2026-01-01T00:00:00Z', 'staff-2');
    const hold: LegalHold = {
      holdId: 'hold-2',
      actorId: 'staff-9',
      placedBy: 'security-1',
      placedAt: '2026-02-01T00:00:00Z',
      reason: 'internal investigation',
    };
    const plan = planRetention([suspect, other], POLICIES, [hold], AS_OF);
    expect(plan.heldCount).toBe(1);
    expect(plan.eligibleForReview.map((d) => d.objectId)).toEqual(['c-4']);
  });

  it('proposes, never deletes — the plan is a list for a human to decide on', () => {
    const records = [aged('marketing_consent', 'c-5', '2026-01-01T00:00:00Z')];
    const plan = planRetention(records, POLICIES, [], AS_OF);
    expect(plan.eligibleForReview).toHaveLength(1);
    expect(plan.eligibleForReview[0]?.explanation).toContain('nothing is deleted here');
    // The source evidence is untouched by planning.
    expect(records).toHaveLength(1);
  });
});

describe('Evidence pack (M34-FR-02)', () => {
  it('exports a period, names who took it, and seals it to the trail', () => {
    const audit = trail();
    audit.record(entry({ at: '2026-07-31T10:00:00Z', objectId: 'p-1' }));
    const inPeriod = audit.record(entry({ at: '2026-08-01T10:00:00Z', objectId: 'p-2' }));
    audit.record(entry({ at: '2026-08-05T10:00:00Z', objectId: 'p-3' }));

    const pack = buildEvidencePack({
      records: audit.all(),
      from: '2026-08-01T00:00:00Z',
      until: '2026-08-02T00:00:00Z',
      exportedBy: 'auditor-1',
      exportedAt: '2026-08-06T09:00:00Z',
      sourceIntact: audit.verify().intact,
    });

    expect(pack.records).toHaveLength(1);
    expect(pack.records[0]?.objectId).toBe('p-2');
    expect(pack.chainHash).toBe(inPeriod.hash);
    expect(pack.exportedBy).toBe('auditor-1');
    expect(pack.sourceIntact).toBe(true);
  });

  it('says plainly when the trail it came from did not verify', () => {
    const pack = buildEvidencePack({
      records: [],
      from: '2026-08-01T00:00:00Z',
      until: '2026-08-02T00:00:00Z',
      exportedBy: 'auditor-1',
      exportedAt: '2026-08-06T09:00:00Z',
      sourceIntact: false,
    });
    // An empty pack is honest about being empty, and about its source (P-08).
    expect(pack.records).toEqual([]);
    expect(pack.chainHash).toBe('');
    expect(pack.sourceIntact).toBe(false);
  });
});
