import { describe, it, expect } from 'vitest';
import {
  approveMapping, mapValue, assessCoverage, type MappingEntry, type MappingTable,
} from '../../packages/migration/src/mapping';

// MG-03 — the step where a migration quietly acquires a tax bill.

const entry = (over: Partial<MappingEntry> = {}): MappingEntry => ({
  domain: 'tax_code', legacyValue: 'T5', targetValue: 'GST_5', rationale: 'as recorded on the invoice', ...over,
});

const draft = (entries: readonly MappingEntry[]): MappingTable => ({
  mappingId: 'map-1', tenantId: 't-sre', version: 1, status: 'draft', entries,
});

const approved = (entries: readonly MappingEntry[]): MappingTable =>
  approveMapping({ table: draft(entries), approvedBy: 'u-ca', now: '2026-08-05T09:00:00Z' }).table!;

describe('a mapping table is a set of accounting decisions, not a config file', () => {
  it('approves a table with a rationale on every entry', () => {
    const r = approveMapping({ table: draft([entry(), entry({ legacyValue: 'T12', targetValue: 'GST_12' })]), approvedBy: 'u-ca', now: '2026-08-05T09:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.table?.status).toBe('approved');
    expect(r.table?.approvedBy).toBe('u-ca');
  });

  it('refuses an entry with no rationale — the question at an assessment is WHY', () => {
    const r = approveMapping({ table: draft([entry({ rationale: '   ' })]), approvedBy: 'u-ca', now: '2026-08-05T09:00:00Z' });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('no_rationale');
    expect(r.conflicts).toEqual(['tax_code:T5']);
  });

  it('REFUSES one legacy value mapping to two targets, and names the conflict', () => {
    const r = approveMapping({
      table: draft([entry(), entry({ targetValue: 'GST_12' })]),
      approvedBy: 'u-ca', now: '2026-08-05T09:00:00Z',
    });
    expect(r.refusedBecause).toBe('one_legacy_value_two_targets');
    expect(r.conflicts).toEqual(['tax_code:T5 → GST_12 / GST_5']);
    expect(r.detail).toContain('makes that disagreement permanent');
  });

  it('ALLOWS many legacy values to one target — that is normal, not a conflict', () => {
    const r = approveMapping({
      table: draft([entry(), entry({ legacyValue: 'T05', rationale: 'the same rate, typed with a leading zero' })]),
      approvedBy: 'u-ca', now: '2026-08-05T09:00:00Z',
    });
    expect(r.ok).toBe(true);
  });

  it('refuses an unnamed approver, an empty table and a re-approval', () => {
    expect(approveMapping({ table: draft([entry()]), approvedBy: ' ', now: 'n' }).refusedBecause).toBe('no_approver');
    expect(approveMapping({ table: draft([]), approvedBy: 'u-ca', now: 'n' }).refusedBecause).toBe('empty_table');
    expect(approveMapping({ table: approved([entry()]), approvedBy: 'u-ca', now: 'n' }).refusedBecause).toBe('already_approved');
  });
});

describe('an unmapped value is an EXCEPTION, never a default', () => {
  it('maps an approved value', () => {
    const r = mapValue({ table: approved([entry()]), domain: 'tax_code', legacyValue: 'T5' });
    expect(r).toMatchObject({ mapped: true, targetValue: 'GST_5' });
  });

  it('refuses an unmapped value rather than defaulting it', () => {
    const r = mapValue({ table: approved([entry()]), domain: 'tax_code', legacyValue: 'TX' });
    expect(r.mapped).toBe(false);
    expect(r.targetValue).toBeUndefined();
    expect(r.detail).toContain('defaulting it is how nine products become zero-rated');
  });

  it('offers NO fallback parameter — a default must be written in the open', () => {
    // The signature is the control. A caller who wants `?? 'T0'` has to write it themselves,
    // where a reviewer can see it, rather than passing it as a third argument that reads like
    // a convenience.
    expect(mapValue.length).toBe(1);
    const call = mapValue as unknown as (x: unknown) => { mapped: boolean };
    expect(call({ table: approved([entry()]), domain: 'tax_code', legacyValue: 'TX' }).mapped).toBe(false);
  });

  it('will not map against a DRAFT table', () => {
    const r = mapValue({ table: draft([entry()]), domain: 'tax_code', legacyValue: 'T5' });
    expect(r.mapped).toBe(false);
    expect(r.detail).toContain('a draft mapping is a proposal');
  });

  it('does not leak a mapping across domains', () => {
    const table = approved([entry({ domain: 'uom', legacyValue: 'KG', targetValue: 'kg', rationale: 'weighed' })]);
    expect(mapValue({ table, domain: 'uom', legacyValue: 'KG' }).mapped).toBe(true);
    expect(mapValue({ table, domain: 'tax_code', legacyValue: 'KG' }).mapped).toBe(false);
  });
});

describe('coverage is measured against the SOURCE, not the table', () => {
  const table = approved([
    entry(),
    entry({ legacyValue: 'T12', targetValue: 'GST_12' }),
    entry({ domain: 'uom', legacyValue: 'EA', targetValue: 'each', rationale: 'unit sale' }),
  ]);

  it('reports full coverage when every observed value maps', () => {
    const r = assessCoverage({
      tenantId: 't-sre', table,
      observed: [
        { domain: 'tax_code', value: 'T5', rows: 900 },
        { domain: 'tax_code', value: 'T12', rows: 400 },
        { domain: 'uom', value: 'EA', rows: 1_300 },
      ],
    });
    expect(r.fullyCovered).toBe(true);
    expect(r.totalAffectedRows).toBe(0);
  });

  it('reports the ROW COUNT behind an uncovered value — the size of the problem, not its variety', () => {
    const r = assessCoverage({
      tenantId: 't-sre', table,
      observed: [
        { domain: 'tax_code', value: 'T5', rows: 900 },
        { domain: 'tax_code', value: 'TX', rows: 9 },
        { domain: 'uom', value: 'KG', rows: 140 },
      ],
    });
    expect(r.fullyCovered).toBe(false);
    expect(r.totalAffectedRows).toBe(149);
    expect(r.byDomain.find((d) => d.domain === 'tax_code')?.uncovered).toEqual(['TX']);
    expect(r.byDomain.find((d) => d.domain === 'uom')?.uncovered).toEqual(['KG']);
    expect(r.detail).toContain('each one is an exception, not a default');
  });

  it('a table with a hundred entries is not coverage if the source uses one it lacks', () => {
    const big = approved(Array.from({ length: 100 }, (_, i) => entry({ legacyValue: `Z${i}`, targetValue: `GST_${i}` })));
    const r = assessCoverage({ tenantId: 't-sre', table: big, observed: [{ domain: 'tax_code', value: 'TX', rows: 9 }] });
    expect(r.fullyCovered).toBe(false);
    expect(r.byDomain[0]?.covered).toBe(0);
  });
});
