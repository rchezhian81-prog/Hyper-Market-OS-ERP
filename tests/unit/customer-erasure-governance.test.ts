import { describe, it, expect } from 'vitest';
import {
  authoriseErasureExecution,
  sealTombstone,
  guardAgainstRestore,
  executeErasurePlan,
  type DataSubjectRequest,
  type ErasurePlan,
  type ErasableSource,
  type PrivacyTombstone,
} from '../../packages/customer/src/index';

// Erasure GOVERNANCE (M20-FR-04 / PRV / DPDP, owner decision — DEVELOPMENT-APPROVED, LEGAL CONFIRMATION
// REQUIRED). The three controls around carrying out an erasure: maker-checker authorisation (SoD §28), a
// PII-free privacy tombstone, and the prevent-restore guard (hard rule #10, P-08). Pure and deterministic.

const AT = '2026-09-25T10:00:00.000Z';

const req = (over: Partial<DataSubjectRequest> = {}): DataSubjectRequest => ({
  requestId: 'dsr-1',
  tenantId: 't-1',
  customerRef: 'cust-1',
  kind: 'erasure',
  raisedAt: '2026-09-20T09:00:00.000Z',
  verifiedBy: 'dpo-ravi',
  verifiedAt: '2026-09-21T09:00:00.000Z',
  state: 'verified',
  dueBy: '2026-10-20',
  ...over,
});

const plan = (over: Partial<ErasurePlan> = {}): ErasurePlan => ({
  requestId: 'dsr-1',
  customerRef: 'cust-1',
  plan: [
    { category: 'marketing_profile', recordCount: 3, disposition: 'erase', explanation: '' },
    { category: 'order_history', recordCount: 5, disposition: 'minimise', retentionBasis: 'audit_evidence', explanation: '' },
    { category: 'tax_invoice', recordCount: 4, disposition: 'retain', retentionBasis: 'tax_invoice', retainUntil: '2034-03-31', explanation: '' },
  ],
  erasedRecordCount: 3,
  minimisedRecordCount: 5,
  retainedRecordCount: 4,
  partial: true,
  customerStatement: [],
  ...over,
});

// A store that records what it was asked, so a real ErasureExecutionReport can be built for the tombstone.
const memorySource = (category: string, records: number): ErasableSource => ({
  category,
  erase: () => ({ recordsAffected: records, note: `${records} erased` }),
  minimise: () => ({ recordsAffected: records, note: `${records} minimised` }),
});

describe('authoriseErasureExecution — maker-checker on top of data-subject verification (SoD §28)', () => {
  it('authorises a verified erasure with a distinct checker', () => {
    const r = authoriseErasureExecution({ request: req(), plan: plan(), maker: 'dpo-ravi', checker: 'officer-mala', at: AT });
    expect(r.authorised).toBe(true);
    expect(r.outcome).toBe('authorised');
    if (r.authorised) {
      expect(r.authorisation).toMatchObject({ requestId: 'dsr-1', customerRef: 'cust-1', maker: 'dpo-ravi', checker: 'officer-mala', authorisedAt: AT });
    }
  });

  it('refuses when the request was never verified as the data subject (identity gate carried through)', () => {
    const r = authoriseErasureExecution({ request: req({ verifiedBy: undefined, verifiedAt: undefined, state: 'raised' }), plan: plan(), maker: 'dpo-ravi', checker: 'officer-mala', at: AT });
    expect(r).toMatchObject({ authorised: false, outcome: 'not_verified' });
  });

  it('refuses when no second officer approved', () => {
    const r = authoriseErasureExecution({ request: req(), plan: plan(), maker: 'dpo-ravi', checker: '  ', at: AT });
    expect(r).toMatchObject({ authorised: false, outcome: 'checker_missing' });
  });

  it('refuses when the preparer and approver are the same person (not a control)', () => {
    const r = authoriseErasureExecution({ request: req(), plan: plan(), maker: 'dpo-ravi', checker: 'dpo-ravi', at: AT });
    expect(r).toMatchObject({ authorised: false, outcome: 'maker_is_checker' });
  });

  it('refuses a plan built for a different request', () => {
    const r = authoriseErasureExecution({ request: req({ requestId: 'dsr-1' }), plan: plan({ requestId: 'dsr-OTHER' }), maker: 'dpo-ravi', checker: 'officer-mala', at: AT });
    expect(r).toMatchObject({ authorised: false, outcome: 'plan_mismatch' });
  });

  it('refuses when the request is not an erasure', () => {
    const r = authoriseErasureExecution({ request: req({ kind: 'access' }), plan: plan(), maker: 'dpo-ravi', checker: 'officer-mala', at: AT });
    expect(r).toMatchObject({ authorised: false, outcome: 'not_an_erasure' });
  });
});

describe('sealTombstone — a PII-free record of what was erased and what the law kept', () => {
  it('derives the erased / minimised / retained categories from the execution report', async () => {
    const report = await executeErasurePlan({
      plan: plan(),
      sources: [memorySource('marketing_profile', 3), memorySource('order_history', 5)],
      at: AT,
    });
    const auth = { requestId: 'dsr-1', customerRef: 'cust-1', maker: 'dpo-ravi', checker: 'officer-mala', authorisedAt: AT };
    const tomb = sealTombstone({ authorisation: auth, report, at: AT });

    expect(tomb.categoriesErased).toEqual(['marketing_profile']);
    expect(tomb.categoriesMinimised).toEqual(['order_history']);
    expect(tomb.categoriesRetained).toEqual([{ category: 'tax_invoice', retentionBasis: 'tax_invoice', retainUntil: '2034-03-31' }]);
    expect(tomb).toMatchObject({ customerRef: 'cust-1', requestId: 'dsr-1', maker: 'dpo-ravi', checker: 'officer-mala', erasedAt: AT, complete: true });
  });

  it('carries NO personal data — only category names and statutory bases', async () => {
    const report = await executeErasurePlan({ plan: plan(), sources: [memorySource('marketing_profile', 3), memorySource('order_history', 5)], at: AT });
    const tomb = sealTombstone({ authorisation: { requestId: 'dsr-1', customerRef: 'cust-1', maker: 'm', checker: 'c', authorisedAt: AT }, report, at: AT });
    const asText = JSON.stringify(tomb);
    // The subject reference is a pseudonymous id; no name/phone/email/address is copied onto the tombstone.
    expect(asText).not.toMatch(/@|\+?\d{10}/); // no email or phone-shaped value
    expect(Object.keys(tomb)).toEqual(
      expect.arrayContaining(['customerRef', 'requestId', 'erasedAt', 'maker', 'checker', 'categoriesErased', 'categoriesMinimised', 'categoriesRetained', 'complete']),
    );
  });

  it('is honest about an incomplete erasure — complete is false when a store had no source', async () => {
    // No source registered for 'marketing_profile' → a visible exception → report.complete false.
    const report = await executeErasurePlan({ plan: plan(), sources: [memorySource('order_history', 5)], at: AT });
    const tomb = sealTombstone({ authorisation: { requestId: 'dsr-1', customerRef: 'cust-1', maker: 'm', checker: 'c', authorisedAt: AT }, report, at: AT });
    expect(tomb.complete).toBe(false);
    expect(tomb.categoriesErased).toEqual([]); // the erase never reached a store
  });
});

describe('guardAgainstRestore — an erased subject does not quietly come back (hard rule #10, P-08)', () => {
  const tombstone: PrivacyTombstone = {
    customerRef: 'cust-1',
    requestId: 'dsr-1',
    erasedAt: AT,
    maker: 'dpo-ravi',
    checker: 'officer-mala',
    categoriesErased: ['marketing_profile'],
    categoriesMinimised: ['order_history'],
    categoriesRetained: [{ category: 'tax_invoice', retentionBasis: 'tax_invoice' }],
    complete: true,
  };

  it('allows a write for a subject with no erasure on record', () => {
    const r = guardAgainstRestore({ attempt: { customerRef: 'cust-2', carriesPii: true, source: 'edge-sync' }, tombstones: [tombstone], at: AT });
    expect(r.decision).toBe('allowed');
  });

  it('REFUSES a late sync that would re-create the erased subject\'s PII, and surfaces the tombstone', () => {
    const r = guardAgainstRestore({ attempt: { customerRef: 'cust-1', carriesPii: true, source: 'offline-lane-3 sync' }, tombstones: [tombstone], at: AT });
    expect(r.decision).toBe('refused_erased_subject');
    expect(r.tombstone).toBe(tombstone);
    expect(r.detail).toContain('offline-lane-3 sync');
  });

  it('allows a lawful retained record that references the pseudonymised ref (carries no PII to restore)', () => {
    const r = guardAgainstRestore({ attempt: { customerRef: 'cust-1', carriesPii: false, source: 'tax-invoice ledger' }, tombstones: [tombstone], at: AT });
    expect(r.decision).toBe('allowed');
    expect(r.tombstone).toBe(tombstone); // still linked, so the caller can see why it was allowed
  });

  it('is tenant-isolated by construction — only the tombstones passed in are considered', () => {
    // The caller passes only its own tenant's tombstones; another tenant's erased ref is unknown here.
    const r = guardAgainstRestore({ attempt: { customerRef: 'cust-1', carriesPii: true, source: 'x' }, tombstones: [], at: AT });
    expect(r.decision).toBe('allowed');
  });
});
