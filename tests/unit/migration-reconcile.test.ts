import { describe, it, expect } from 'vitest';
import {
  recordControlTotal, assessReconciliation, signControlTotal, buildOpeningEvents,
  type ControlTotal,
} from '../../packages/migration/src/reconcile';
import * as reconcile from '../../packages/migration/src/reconcile';

// MG-06 / MG-08 — QG-07. No cutover without SIGNED control totals.

const total = (over: Partial<ControlTotal> = {}): ControlTotal => ({
  totalId: 'ct-stock', tenantId: 't-sre', kind: 'stock', name: 'Stock value', unit: 'minor_currency',
  legacyValue: 84_120_000, loadedValue: 84_120_000,
  legacyDerivation: 'SUM(value) over the sealed legacy stock extract',
  loadedDerivation: 'SUM(value) projected from loaded stock events',
  ...over,
});

const sign = (totals: readonly ControlTotal[], totalId: string, role = 'store_manager'): readonly ControlTotal[] =>
  signControlTotal({
    totals, totalId, signedBy: 'u-checker', signerRole: role, loadOperator: 'u-operator',
    statement: 'checked against the legacy report', now: '2026-08-07T09:00:00Z',
  }).totals;

describe('a total computed the same way twice reconciles nothing', () => {
  it('records a total whose two sides are derived independently', () => {
    const r = recordControlTotal({ totals: [], total: total() });
    expect(r.ok).toBe(true);
    expect(r.totals).toHaveLength(1);
  });

  it('REFUSES the self-comparison — the one mistake nobody notices, because the report is green', () => {
    const r = recordControlTotal({
      totals: [],
      total: total({ loadedDerivation: 'sum(VALUE)  over the sealed  legacy stock extract' }),
    });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('same_derivation_both_sides');
    expect(r.detail).toContain('nobody notices because the report is green');
  });

  it('refuses a total that will not say where either side came from', () => {
    expect(recordControlTotal({ totals: [], total: total({ legacyDerivation: '  ' }) }).refusedBecause).toBe('no_derivation');
    expect(recordControlTotal({ totals: [], total: total({ loadedDerivation: '' }) }).refusedBecause).toBe('no_derivation');
  });

  it('refuses a duplicate id — a re-run supersedes, so the earlier figure stays readable', () => {
    const once = recordControlTotal({ totals: [], total: total() }).totals;
    expect(recordControlTotal({ totals: once, total: total() }).refusedBecause).toBe('duplicate_total');
  });
});

describe('a difference is explained and valued, or it is open', () => {
  it('reconciles an exact match', () => {
    const r = assessReconciliation({ tenantId: 't-sre', totals: [total()] });
    expect(r.assessments[0]?.status).toBe('reconciled');
  });

  it('EXPLAINS a difference that approved exclusions account for exactly', () => {
    const r = assessReconciliation({
      tenantId: 't-sre',
      totals: [total({
        loadedValue: 84_120_000 - 1_240_000, approvedExclusionValue: 1_240_000,
        explanation: 'pre-2020 documents excluded by owner decision EXC-001',
      })],
    });
    expect(r.assessments[0]?.status).toBe('explained');
    expect(r.assessments[0]?.detail).toContain('accounted for exactly by approved exclusions');
  });

  it('leaves a total OPEN when the explanation only ROUGHLY accounts for it', () => {
    const r = assessReconciliation({
      tenantId: 't-sre',
      totals: [total({
        loadedValue: 84_120_000 - 1_250_000, approvedExclusionValue: 1_240_000,
        explanation: 'pre-2020 documents excluded',
      })],
    });
    expect(r.assessments[0]?.status).toBe('open');
    expect(r.assessments[0]?.detail).toContain('where a real error hides behind an approved one');
  });

  it('rejects "small variance" — a difference with no explanation is open', () => {
    const r = assessReconciliation({ tenantId: 't-sre', totals: [total({ loadedValue: 84_119_900 })] });
    expect(r.assessments[0]?.status).toBe('open');
    expect(r.assessments[0]?.detail).toContain('"small variance" is not an explanation');
  });

  it('will not pass QG-07 on an EMPTY report — the easiest report to produce', () => {
    const r = assessReconciliation({ tenantId: 't-sre', totals: [] });
    expect(r.qg07Passed).toBe(false);
    expect(r.detail).toContain('an empty report is the easiest one to produce');
  });

  it('blocks QG-07 while any total is unsigned, even when every figure matches', () => {
    const r = assessReconciliation({ tenantId: 't-sre', totals: [total()] });
    expect(r.open).toHaveLength(0);
    expect(r.unsigned).toHaveLength(1);
    expect(r.qg07Passed).toBe(false);
  });
});

describe('the person who ran the load does not sign the totals', () => {
  const totals = [total()];

  it('signs a reconciled total', () => {
    const r = signControlTotal({
      totals, totalId: 'ct-stock', signedBy: 'u-checker', signerRole: 'store_manager',
      loadOperator: 'u-operator', statement: 'agreed to the legacy stock report', now: '2026-08-07T09:00:00Z',
    });
    expect(r.ok).toBe(true);
    expect(r.totals[0]?.signature?.signedBy).toBe('u-checker');
  });

  it('REFUSES the loader signing their own load (§28)', () => {
    const r = signControlTotal({
      totals, totalId: 'ct-stock', signedBy: 'u-operator', signerRole: 'store_manager',
      loadOperator: 'u-operator', statement: 'looks right', now: '2026-08-07T09:00:00Z',
    });
    expect(r.refusedBecause).toBe('signer_ran_the_load');
    expect(r.detail).toContain('they already believe it worked');
  });

  it('requires the CA for financial and tax totals, however senior the other signer', () => {
    const taxTotals = [total({ totalId: 'ct-tax', kind: 'tax', name: 'Output tax' })];
    const refused = signControlTotal({
      totals: taxTotals, totalId: 'ct-tax', signedBy: 'u-owner', signerRole: 'owner',
      loadOperator: 'u-operator', statement: 'fine', now: '2026-08-07T09:00:00Z',
    });
    expect(refused.refusedBecause).toBe('finance_or_tax_needs_ca');

    const accepted = signControlTotal({
      totals: taxTotals, totalId: 'ct-tax', signedBy: 'u-ca', signerRole: 'chartered_accountant',
      loadOperator: 'u-operator', statement: 'agreed to the GSTR-3B summary', now: '2026-08-07T09:00:00Z',
    });
    expect(accepted.ok).toBe(true);
  });

  it('permits a store manager to sign a stock total — only finance and tax are the CA\'s', () => {
    expect(sign([total()], 'ct-stock')[0]?.signature?.signerRole).toBe('store_manager');
  });

  it('REFUSES to sign an OPEN total — there is no provisional signature', () => {
    const r = signControlTotal({
      totals: [total({ loadedValue: 84_119_900 })], totalId: 'ct-stock', signedBy: 'u-checker',
      signerRole: 'store_manager', loadOperator: 'u-operator',
      statement: 'close enough, it is late', now: '2026-08-07T23:40:00Z',
    });
    expect(r.refusedBecause).toBe('total_is_open');
    expect(r.detail).toContain('the last place a wrong opening balance can still be stopped');
  });

  it('refuses a second signature and an unknown total', () => {
    const signed = sign([total()], 'ct-stock');
    expect(signControlTotal({ totals: signed, totalId: 'ct-stock', signedBy: 'u-other', signerRole: 'owner', loadOperator: 'u-operator', statement: 'x', now: 'n' }).refusedBecause).toBe('already_signed');
    expect(signControlTotal({ totals: signed, totalId: 'nope', signedBy: 'u-other', signerRole: 'owner', loadOperator: 'u-operator', statement: 'x', now: 'n' }).refusedBecause).toBe('unknown_total');
  });

  it('passes QG-07 only when every total is both closed AND signed', () => {
    const all = [total(), total({ totalId: 'ct-tax', kind: 'tax', name: 'Output tax', legacyValue: 4_206_000, loadedValue: 4_206_000 })];
    const partly = sign(all, 'ct-stock');
    expect(assessReconciliation({ tenantId: 't-sre', totals: partly }).qg07Passed).toBe(false);

    const fully = signControlTotal({
      totals: partly, totalId: 'ct-tax', signedBy: 'u-ca', signerRole: 'chartered_accountant',
      loadOperator: 'u-operator', statement: 'agreed', now: '2026-08-07T09:30:00Z',
    }).totals;
    const r = assessReconciliation({ tenantId: 't-sre', totals: fully });
    expect(r.qg07Passed).toBe(true);
    expect(r.detail).toContain('QG-07 passed');
  });
});

describe('opening balances are EVENTS, never balances (hard rule #2)', () => {
  const signedTotals = sign([total()], 'ct-stock');
  const positions = [
    { kind: 'stock' as const, subjectId: 'P00001', quantity: 40, valueMinor: 120_000, fromTotalId: 'ct-stock' },
    { kind: 'stock' as const, subjectId: 'P00002', quantity: 12, valueMinor: 48_000, fromTotalId: 'ct-stock' },
  ];

  it('builds append-only opening events once QG-07 has passed', () => {
    const r = buildOpeningEvents({ tenantId: 't-sre', totals: signedTotals, positions, now: '2026-08-08T05:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.events).toHaveLength(2);
    expect(r.events.every((e) => e.appendOnly === true)).toBe(true);
    expect(r.detail).toContain('not a single balance written directly');
  });

  it('REFUSES to open the ledger before QG-07 — a day-one correction is a permanent scar', () => {
    const r = buildOpeningEvents({ tenantId: 't-sre', totals: [total()], positions, now: '2026-08-08T05:00:00Z' });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('qg07_not_passed');
    expect(r.detail).toContain('a compensating event on day one is a permanent scar on the ledger');
  });

  it('refuses an opening figure that cites an unsigned total', () => {
    const r = buildOpeningEvents({
      tenantId: 't-sre', totals: signedTotals,
      positions: [...positions, { kind: 'loyalty_points' as const, subjectId: 'C1', points: 400, fromTotalId: 'ct-loyalty' }],
      now: '2026-08-08T05:00:00Z',
    });
    expect(r.refusedBecause).toBe('unsigned_source_total');
    expect(r.detail).toContain('ct-loyalty');
  });

  it('refuses an empty opening state — a silent one', () => {
    expect(buildOpeningEvents({ tenantId: 't-sre', totals: signedTotals, positions: [], now: 'n' }).refusedBecause).toBe('no_events');
  });

  it('every opening event traces back to the signature it came from', () => {
    const r = buildOpeningEvents({ tenantId: 't-sre', totals: signedTotals, positions, now: '2026-08-08T05:00:00Z' });
    for (const e of r.events) {
      const source = signedTotals.find((t) => t.totalId === e.fromTotalId);
      expect(source?.signature).toBeDefined();
    }
  });

  it('exposes no function that writes a balance directly', () => {
    const names = Object.keys(reconcile);
    for (const forbidden of ['setOpeningBalance', 'writeBalance', 'updateBalance', 'overrideTotal', 'forceSign', 'provisionalSign']) {
      expect(names).not.toContain(forbidden);
    }
  });
});
