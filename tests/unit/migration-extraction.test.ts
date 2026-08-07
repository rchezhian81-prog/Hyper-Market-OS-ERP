import { describe, it, expect } from 'vitest';
import {
  assessRoute, planVerification, assessExtractionReadiness,
  METHOD_FIDELITY, VERIFIES, EXTERNAL_SOURCE_NOTE,
  type ExtractionRoute, type ExternalSource,
} from '../../packages/migration/src/extraction';
import * as extraction from '../../packages/migration/src/extraction';

// Self-extraction — owner decision of 7 August 2026: the incumbent vendor will not help, so we
// get our own data out ourselves. MG-01, MG-02, MG-06.

const route = (over: Partial<ExtractionRoute> = {}): ExtractionRoute => ({
  domain: 'stock', method: 'direct_database_read',
  description: 'SQL Server: dbo.StockBalance joined to dbo.ItemMaster',
  rowCount: 41_200, cannotYield: [], repeatable: true, ...over,
});

const ALL_EXTERNAL: readonly ExternalSource[] = [
  'bank_statement', 'filed_gst_return', 'supplier_statement', 'physical_count',
  'payment_settlement', 'ca_prepared_accounts', 'customer_confirmation',
];

describe('a route is judged on what it structurally loses, not on how it feels', () => {
  it('accepts a direct database read as the complete route', () => {
    const r = assessRoute(route());
    expect(r.usable).toBe(true);
    expect(r.risks).toEqual([]);
    expect(r.detail).toContain('the only route that yields history');
  });

  it('names what an EXPORT-TO-EXCEL cannot give, rather than discovering it later', () => {
    const r = assessRoute(route({ method: 'built_in_export', cannotYield: ['batch code', 'expiry date'] }));
    expect(r.usable).toBe(true);
    expect(r.risks).toContain('no_history');
    expect(r.risks).toContain('known_gaps');
    expect(r.detail).toContain('hidden columns silently truncate it');
  });

  it('treats a PRINTED REPORT as aggregated — parsing cannot recover what was never printed', () => {
    const r = assessRoute(route({ method: 'printed_report' }));
    expect(r.risks).toContain('aggregated_only');
    expect(r.detail).toContain('never the ones it did not');
  });

  it('REFUSES re-keying as a migration source — it cannot be re-run', () => {
    // Not snobbery about manual work. A route nobody can repeat cannot be trialled (MG-05),
    // cannot be delta'd (MG-09), and cannot be redone when the first load turns out wrong.
    const r = assessRoute(route({ method: 'manual_rekey', repeatable: false }));
    expect(r.usable).toBe(false);
    expect(r.detail).toContain('cannot be re-run');
  });

  it('refuses a route claiming repeatability that its method cannot support', () => {
    expect(assessRoute(route({ method: 'manual_rekey', repeatable: true })).usable).toBe(false);
  });

  it('flags an uncounted route — an estimate cannot be a control total (MG-01)', () => {
    expect(assessRoute(route({ rowCount: undefined })).risks).toContain('volume_unknown');
  });

  it('ranks the methods by what they lose, and the ranking is total', () => {
    const ranks = Object.values(METHOD_FIDELITY).map((f) => f.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(METHOD_FIDELITY.direct_database_read.rank).toBeLessThan(METHOD_FIDELITY.printed_report.rank);
    expect(METHOD_FIDELITY.manual_rekey.repeatableByNature).toBe(false);
  });
});

describe('the verification must come from OUTSIDE the incumbent system', () => {
  const routes: readonly ExtractionRoute[] = [
    route({ domain: 'stock' }),
    route({ domain: 'sales' }),
    route({ domain: 'tax' }),
    route({ domain: 'suppliers' }),
  ];

  it('accepts a plan where every domain is checked against outside evidence', () => {
    const r = planVerification({ routes, available: ALL_EXTERNAL });
    expect(r.sound).toBe(true);
    expect(r.unverifiable).toEqual([]);
    // The claim worth making: this is STRONGER than a vendor export, not a poorer substitute.
    expect(r.detail).toContain('a vendor file is one system\'s account of itself');
  });

  it('REFUSES a domain with no outside evidence available — the whole point', () => {
    // Without a vendor export there is nothing to cross-check the incumbent against except the
    // incumbent. A stock figure off the stock report, agreed against the valuation report,
    // reconciles perfectly and proves only internal consistency.
    const r = planVerification({ routes: [route({ domain: 'stock' })], available: [] });
    expect(r.sound).toBe(false);
    expect(r.refusals[0]?.refusal).toBe('verified_by_the_same_system');
    expect(r.refusals[0]?.detail).toContain('just as consistent about a wrong number');
    expect(r.refusals[0]?.detail).toContain('physical_count');
  });

  it('names WHICH outside evidence to go and get, so the refusal is actionable', () => {
    const r = planVerification({ routes: [route({ domain: 'tax' })], available: ['bank_statement'] });
    expect(r.sound).toBe(false);
    // A bank statement does not verify a tax total. The refusal says what does.
    expect(r.refusals[0]?.detail).toContain('filed_gst_return');
  });

  it('verifies stock ONLY by a physical count — the only truth about stock that exists', () => {
    expect(VERIFIES.stock).toEqual(['physical_count']);
    const r = planVerification({ routes: [route({ domain: 'stock' })], available: ['physical_count'] });
    expect(r.sound).toBe(true);
    expect(r.plans[0]?.detail).toContain('everything else is a record of it');
  });

  it('gives every external source a reason it is independent, not just a name', () => {
    for (const [source, note] of Object.entries(EXTERNAL_SOURCE_NOTE)) {
      expect(note.length, source).toBeGreaterThan(25);
    }
    expect(EXTERNAL_SOURCE_NOTE.filed_gst_return).toContain('cannot be adjusted to make a total agree');
    expect(EXTERNAL_SOURCE_NOTE.supplier_statement).toContain('because they want paying');
  });

  it('names no source that comes from the incumbent system', () => {
    // If an "external" source were ever the ERP's own report, the whole control collapses.
    const sources = Object.keys(EXTERNAL_SOURCE_NOTE);
    for (const forbidden of ['erp_report', 'legacy_export', 'vendor_file', 'system_report']) {
      expect(sources).not.toContain(forbidden);
    }
  });

  it('lets a partially-evidenced migration proceed, but says so plainly', () => {
    const r = planVerification({ routes, available: ['physical_count', 'bank_statement'] });
    expect(r.sound).toBe(false);
    expect(r.unverifiable).toContain('suppliers');
    // Not a block. A statement the owner has to be given in writing.
    expect(r.detail).toContain('the owner must be told so in writing');
  });
});

describe('readiness names every blocker at once', () => {
  const routes = (['products', 'barcodes', 'prices', 'stock', 'batches', 'suppliers',
    'purchases', 'customers', 'loyalty', 'sales', 'tax', 'ledgers'] as const)
    .map((domain) => route({ domain }));

  it('is ready when every domain has a repeatable route, outside evidence and a preserved copy', () => {
    const r = assessExtractionReadiness({ routes, available: ALL_EXTERNAL, preservationCopyTaken: true });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.detail).toContain('no vendor cooperation required');
    expect(r.ownerAction).toContain('the old system keeps running throughout');
  });

  it('names the domains with no route at all', () => {
    const r = assessExtractionReadiness({
      routes: [route({ domain: 'stock' })], available: ALL_EXTERNAL, preservationCopyTaken: true,
    });
    expect(r.blockers).toContain('domain_not_covered');
    expect(r.missingDomains).toContain('loyalty');
    expect(r.missingDomains).toContain('tax');
  });

  it('blocks on a missing preservation copy (MG-02)', () => {
    const r = assessExtractionReadiness({ routes, available: ALL_EXTERNAL, preservationCopyTaken: false });
    expect(r.blockers).toContain('no_preservation_copy');
    expect(r.detail).toContain('must not also be the only thing that has it');
  });

  it('reports FOUR blockers at once rather than one per attempt', () => {
    const r = assessExtractionReadiness({
      routes: [route({ domain: 'stock', method: 'manual_rekey', repeatable: false })],
      available: [], preservationCopyTaken: false,
    });
    expect([...r.blockers].sort()).toEqual([
      'domain_not_covered', 'no_independent_verification', 'no_preservation_copy', 'unusable_route',
    ]);
  });

  it('tells the owner which part is genuinely theirs, and which is ours', () => {
    const needsEvidence = assessExtractionReadiness({
      routes, available: [], preservationCopyTaken: true,
    });
    expect(needsEvidence.ownerAction).toContain('none of them involves the old vendor');

    const oursToFix = assessExtractionReadiness({
      routes: [route({ domain: 'stock' })], available: ALL_EXTERNAL, preservationCopyTaken: true,
    });
    expect(oursToFix.ownerAction).toContain('ours to close first');
  });

  it('keeps the shop trading whichever way readiness goes (P-01)', () => {
    const trading: true = assessExtractionReadiness({
      routes: [], available: [], preservationCopyTaken: false,
    }).shopKeepsTrading;
    expect(trading).toBe(true);
  });
});

describe('this module extracts nothing and touches nothing', () => {
  it('exposes no function that reads, connects to or modifies the incumbent system', () => {
    // It plans and it judges. The reading is done by a person following the runbook, on their
    // own machine — there is no code here that connects to anything, by design.
    const names = Object.keys(extraction);
    for (const forbidden of [
      'connectToLegacy', 'readLegacyDatabase', 'runExtraction', 'dumpDatabase',
      'crackLicence', 'bypassProtection', 'decompile',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
