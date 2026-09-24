import { describe, it, expect } from 'vitest';
import { planErasure, type DataCategory, type DataSubjectRequest } from '../../packages/customer/src/data-rights';
import {
  executeErasurePlan,
  type ErasableSource,
  type SourceResult,
} from '../../packages/customer/src/erasure-executor';

/**
 * The erasure-plan EXECUTOR (M16-FR-03 / M20-FR-04). `planErasure` decides erase / minimise / retain,
 * category by category. This engine carries that plan out against the stores that actually hold the
 * data — provider-neutral, so the real domain stores plug in behind `ErasableSource` and these tests
 * use in-memory fakes. The invariants it must never break: retained data is never touched (hard rule
 * #6), and nothing that could not be actioned is hidden (P-08).
 */

const REQUEST: DataSubjectRequest = {
  requestId: 'DSR-1',
  tenantId: 't-sre',
  customerRef: 'CUST-42',
  kind: 'erasure',
  raisedAt: '2026-09-01T00:00:00.000Z',
  verifiedBy: 'clerk-1',
  verifiedAt: '2026-09-02T00:00:00.000Z',
  state: 'verified',
  dueBy: '2026-10-01T00:00:00.000Z',
};

/** An erasable category (no statute) → the plan will say `erase`. */
const marketingProfile: DataCategory = { category: 'marketing_profile', recordCount: 3 };
/** A statute-bound but minimisable category → the plan will say `minimise`. */
const invoices: DataCategory = {
  category: 'invoices',
  recordCount: 8,
  retentionBasis: 'tax_invoice',
  retainUntil: '2034-03-31',
  minimisable: true,
};
/** Audit evidence — kept in full, never touched → the plan will say `retain`. */
const auditTrail: DataCategory = {
  category: 'audit_trail',
  recordCount: 5,
  retentionBasis: 'audit_evidence',
  minimisable: false,
};

/** An in-memory store for one category — the fake standing in for a real domain store. */
function memorySource(category: string, heldFor: Record<string, number>): ErasableSource & {
  held(ref: string): number;
  sawRef: string | undefined;
} {
  const store = new Map<string, number>(Object.entries(heldFor));
  const state = { sawRef: undefined as string | undefined };
  return {
    category,
    get sawRef() {
      return state.sawRef;
    },
    erase(ref: string): SourceResult {
      state.sawRef = ref;
      const n = store.get(ref) ?? 0;
      store.delete(ref);
      return { recordsAffected: n };
    },
    minimise(ref: string): SourceResult {
      state.sawRef = ref;
      const n = store.get(ref) ?? 0;
      return { recordsAffected: n, note: `${n} record(s) redacted` };
    },
    held(ref: string): number {
      return store.get(ref) ?? 0;
    },
  };
}

/** A store that must NEVER be called — used to prove the executor leaves a category alone. */
function tripwireSource(category: string): ErasableSource {
  return {
    category,
    erase() {
      throw new Error(`tripwire: erase("${category}") must not be called`);
    },
    minimise() {
      throw new Error(`tripwire: minimise("${category}") must not be called`);
    },
  };
}

const AT = '2026-09-10T09:00:00.000Z';

describe('executeErasurePlan (M16-FR-03 / M20-FR-04)', () => {
  it('erases an erasable category through its source and reports what was removed', async () => {
    const plan = planErasure({ request: REQUEST, categories: [marketingProfile], at: AT });
    const source = memorySource('marketing_profile', { 'CUST-42': 3 });

    const report = await executeErasurePlan({ plan, sources: [source], at: AT });

    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatchObject({ category: 'marketing_profile', outcome: 'erased', recordsAffected: 3 });
    expect(report.totals.erased).toBe(3);
    expect(report.complete).toBe(true);
    expect(report.exceptions).toHaveLength(0);
    expect(source.held('CUST-42')).toBe(0); // actually gone from the store
    expect(source.sawRef).toBe('CUST-42'); // the store was told WHOSE data to erase
  });

  it('minimises a statute-bound-but-minimisable category through its source', async () => {
    const plan = planErasure({ request: REQUEST, categories: [invoices], at: AT });
    const source = memorySource('invoices', { 'CUST-42': 8 });

    const report = await executeErasurePlan({ plan, sources: [source], at: AT });

    expect(report.lines[0]).toMatchObject({ category: 'invoices', outcome: 'minimised', recordsAffected: 8 });
    expect(report.lines[0]?.note).toContain('redacted');
    expect(report.totals.minimised).toBe(8);
    expect(source.held('CUST-42')).toBe(8); // the record itself is KEPT, only redacted
    expect(report.complete).toBe(true);
  });

  it('NEVER touches a retained category — even when a store is registered for it (hard rule #6)', async () => {
    const plan = planErasure({ request: REQUEST, categories: [auditTrail], at: AT });
    // A tripwire that throws if the executor ever calls it. If the retain branch is wrong, this test
    // fails with the tripwire message instead of passing.
    const report = await executeErasurePlan({ plan, sources: [tripwireSource('audit_trail')], at: AT });

    expect(report.lines[0]).toMatchObject({
      category: 'audit_trail',
      outcome: 'retained',
      recordsAffected: 0,
      retentionBasis: 'audit_evidence',
    });
    expect(report.totals.retained).toBe(5);
    expect(report.exceptions).toHaveLength(0);
    expect(report.complete).toBe(true); // retained categories never block completion
  });

  it('surfaces a category with no registered source as a visible exception (P-08)', async () => {
    const plan = planErasure({ request: REQUEST, categories: [marketingProfile], at: AT });

    const report = await executeErasurePlan({ plan, sources: [], at: AT });

    expect(report.lines[0]).toMatchObject({ category: 'marketing_profile', outcome: 'no_source', recordsAffected: 0 });
    expect(report.lines[0]?.note).toContain('No registered source');
    expect(report.totals.noSource).toBe(1);
    expect(report.exceptions).toHaveLength(1);
    expect(report.complete).toBe(false); // a silent skip would falsely claim the data was erased
  });

  it('surfaces a source that raises as a failure, and still actions the other categories', async () => {
    const plan = planErasure({ request: REQUEST, categories: [marketingProfile, invoices], at: AT });
    const failing: ErasableSource = {
      category: 'marketing_profile',
      erase() {
        throw new Error('store unreachable');
      },
      minimise() {
        throw new Error('store unreachable');
      },
    };
    const ok = memorySource('invoices', { 'CUST-42': 8 });

    const report = await executeErasurePlan({ plan, sources: [failing, ok], at: AT });

    const marketing = report.lines.find((l) => l.category === 'marketing_profile');
    const inv = report.lines.find((l) => l.category === 'invoices');
    expect(marketing).toMatchObject({ outcome: 'failed', recordsAffected: 0 });
    expect(marketing?.note).toContain('store unreachable');
    expect(inv).toMatchObject({ outcome: 'minimised', recordsAffected: 8 }); // the other store still ran
    expect(report.totals.failed).toBe(1);
    expect(report.exceptions).toHaveLength(1);
    expect(report.complete).toBe(false);
  });

  it('reports a full mixed plan honestly — order preserved, totals summed, exceptions collected', async () => {
    const plan = planErasure({
      request: REQUEST,
      categories: [marketingProfile, invoices, auditTrail],
      at: AT,
    });
    // A source for marketing and audit, but NONE for invoices → invoices becomes a no_source exception.
    const report = await executeErasurePlan({
      plan,
      sources: [memorySource('marketing_profile', { 'CUST-42': 3 }), tripwireSource('audit_trail')],
      at: AT,
    });

    expect(report.lines.map((l) => l.category)).toEqual(['marketing_profile', 'invoices', 'audit_trail']);
    expect(report.lines.map((l) => l.outcome)).toEqual(['erased', 'no_source', 'retained']);
    expect(report.totals).toMatchObject({ erased: 3, minimised: 0, retained: 5, failed: 0, noSource: 1 });
    expect(report.exceptions.map((e) => e.category)).toEqual(['invoices']);
    expect(report.complete).toBe(false);
    expect(report.requestId).toBe('DSR-1');
    expect(report.customerRef).toBe('CUST-42');
    expect(report.executedAt).toBe(AT);
  });

  it('awaits an asynchronous source (a real store does I/O)', async () => {
    const plan = planErasure({ request: REQUEST, categories: [marketingProfile], at: AT });
    const asyncSource: ErasableSource = {
      category: 'marketing_profile',
      async erase(): Promise<SourceResult> {
        await Promise.resolve();
        return { recordsAffected: 2, note: 'async erase' };
      },
      minimise(): SourceResult {
        return { recordsAffected: 0 };
      },
    };

    const report = await executeErasurePlan({ plan, sources: [asyncSource], at: AT });

    expect(report.lines[0]).toMatchObject({ outcome: 'erased', recordsAffected: 2, note: 'async erase' });
    expect(report.complete).toBe(true);
  });

  it('an empty plan is complete with nothing to do', async () => {
    const plan = planErasure({ request: REQUEST, categories: [], at: AT });

    const report = await executeErasurePlan({ plan, sources: [], at: AT });

    expect(report.lines).toHaveLength(0);
    expect(report.totals).toMatchObject({ erased: 0, minimised: 0, retained: 0, failed: 0, noSource: 0 });
    expect(report.exceptions).toHaveLength(0);
    expect(report.complete).toBe(true);
  });
});
