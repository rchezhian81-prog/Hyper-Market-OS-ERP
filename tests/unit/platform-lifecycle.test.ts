import { describe, it, expect } from 'vitest';
import {
  buildTenantExport,
  closeTenant,
  assessCompatibility,
  type ExportDomain,
  type RetentionObligation,
  type ContractChange,
} from '../../packages/platform/src/lifecycle';

// M36-FR-03 acceptance: "a tenant's full data exports; closure revokes access and retains
// legally-required records; an upgrade does not break an existing tenant."

const DECLARED = ['sales', 'stock', 'customers', 'suppliers', 'finance', 'audit'];

const domain = (
  name: string,
  over: Partial<ExportDomain & { tenantId: string }> = {},
): ExportDomain & { tenantId?: string } => ({
  domain: name, rows: 100, format: 'jsonl', checksum: `sha256:${name}`, bytes: 10_000, ...over,
});

const allDomains = DECLARED.map((d) => domain(d));

function exportOf(over: Partial<Parameters<typeof buildTenantExport>[0]> = {}) {
  return buildTenantExport({
    exportId: 'x-1', tenantId: 't-sre', requestedBy: 'u-owner',
    domains: allDomains, declaredDomains: DECLARED, at: '2026-08-04T09:00:00Z', ...over,
  });
}

describe('an export is complete or it is not an export (M36-FR-03)', () => {
  it('produces every declared domain, checksummed and portable', () => {
    const result = exportOf();
    expect(result.complete).toBe(true);
    expect(result.domains).toHaveLength(6);
    expect(result.totalRows).toBe(600);
  });

  it('FAILS when a domain is absent rather than shipping a smaller file', () => {
    const result = exportOf({ domains: allDomains.filter((d) => d.domain !== 'finance') });
    expect(result.complete).toBe(false);
    expect(result.outcome).toBe('missing_domains');
    expect(result.missing).toEqual(['finance']);
    // The intended pressure: the exporter is not allowed to fall behind the product.
    expect(result.detail).toContain('the customer finds out months later');
  });

  it('accepts a domain that legitimately has zero rows, as long as it is PRESENT', () => {
    const result = exportOf({
      domains: allDomains.map((d) => (d.domain === 'suppliers' ? { ...d, rows: 0 } : d)),
    });
    expect(result.complete).toBe(true);
    expect(result.domains.find((d) => d.domain === 'suppliers')?.rows).toBe(0);
  });

  it('refuses the whole export if any file holds another tenant\'s data', () => {
    const result = exportOf({
      domains: [...allDomains, domain('sales', { tenantId: 't-other' })],
    });
    expect(result.outcome).toBe('wrong_tenant');
    expect(result.domains).toEqual([]);
  });

  it('refuses an unverifiable file', () => {
    const result = exportOf({
      domains: allDomains.map((d) => (d.domain === 'stock' ? { ...d, checksum: '' } : d)),
    });
    expect(result.outcome).toBe('empty_domain');
    expect(result.detail).toContain('a file, not evidence');
  });

  it('will not call itself complete with nothing to check against', () => {
    expect(exportOf({ declaredDomains: [] }).outcome).toBe('no_manifest');
  });
});

const obligation = (over: Partial<RetentionObligation>): RetentionObligation => ({
  obligationId: 'o-1', tenantId: 't-sre', what: 'sales and tax records',
  law: 'Income Tax Act 1961 s.44AA', keepUntil: '2034-03-31', ...over,
});

describe('closure revokes access and respects the law (M36-FR-03)', () => {
  const close = (over: Partial<Parameters<typeof closeTenant>[0]> = {}) =>
    closeTenant({
      tenantId: 't-sre', state: 'active', obligations: [obligation({})],
      exportTaken: exportOf(), approvedBy: 'u-platform-admin', today: '2026-08-04', ...over,
    });

  it('closes, revokes access, and NAMES what is retained and why', () => {
    const result = close();
    expect(result.closed).toBe(true);
    expect(result.accessRevoked).toBe(true);
    expect(result.retained.map((r) => r.what)).toContain('sales and tax records');
    expect(result.detail).toContain('Income Tax Act 1961');
  });

  it('ALWAYS retains audit evidence, whatever anybody asks (hard rule #6)', () => {
    const result = close({ obligations: [] });
    expect(result.retained).toHaveLength(1);
    expect(result.retained[0]?.what).toBe('audit evidence');
    expect(result.retained[0]?.untilDate).toBe('indefinitely');
  });

  it('refuses to close before the tenant has taken its data', () => {
    const result = close({ exportTaken: undefined });
    expect(result.closed).toBe(false);
    expect(result.outcome).toBe('export_not_taken');
    expect(result.detail).toContain('the last easy moment');
  });

  it('refuses an INCOMPLETE export as proof the tenant has their data', () => {
    const partial = exportOf({ domains: allDomains.slice(0, 3) });
    expect(close({ exportTaken: partial }).outcome).toBe('export_not_taken');
  });

  it('needs a named approver — closing ends a business relationship', () => {
    expect(close({ approvedBy: undefined }).outcome).toBe('not_approved');
    expect(close({ approvedBy: '  ' }).outcome).toBe('not_approved');
  });

  it('ignores an obligation that has already run out', () => {
    const result = close({ obligations: [obligation({ keepUntil: '2020-03-31' })] });
    expect(result.retained.map((r) => r.what)).toEqual(['audit evidence']);
  });

  it('is idempotent on an already-closed tenant', () => {
    expect(close({ state: 'closed' }).outcome).toBe('already_closed');
  });
});

const change = (over: Partial<ContractChange>): ContractChange => ({
  contract: 'API-06 orders', fromVersion: 'v1', toVersion: 'v2',
  removed: [], added: [], ...over,
});

describe('an upgrade that breaks a live tenant is not an upgrade (M36-FR-03)', () => {
  const usage = [
    { tenantId: 't-sre', uses: ['orders.list', 'orders.legacyStatus'] },
    { tenantId: 't-kumar', uses: ['orders.list'] },
  ];

  it('passes a purely additive change', () => {
    const result = assessCompatibility({
      change: change({ added: ['orders.slot'] }), liveUsage: usage, today: '2026-08-04',
    });
    expect(result.verdict).toBe('additive');
    expect(result.safeToDeploy).toBe(true);
  });

  it('REFUSES a removal with no deprecation announced, and NAMES who still calls it', () => {
    const result = assessCompatibility({
      change: change({ removed: ['orders.legacyStatus'] }), liveUsage: usage, today: '2026-08-04',
    });
    expect(result.verdict).toBe('breaking');
    expect(result.safeToDeploy).toBe(false);
    // Named, not counted: "3 tenants affected" gets deployed on a Friday.
    expect(result.tenantsAffected).toEqual(['t-sre']);
  });

  it('treats an ANNOUNCED but unelapsed deprecation as still breaking', () => {
    const result = assessCompatibility({
      change: change({ removed: ['orders.legacyStatus'], deprecatedOn: '2026-06-01' }),
      liveUsage: usage, today: '2026-08-04',
    });
    expect(result.verdict).toBe('deprecation_pending');
    expect(result.detail).toContain('the announcement is not the mitigation');
  });

  it('still refuses after the window when somebody is STILL calling it', () => {
    const result = assessCompatibility({
      change: change({ removed: ['orders.legacyStatus'], deprecatedOn: '2025-06-01' }),
      liveUsage: usage, today: '2026-08-04',
    });
    expect(result.verdict).toBe('breaking');
    expect(result.detail).toContain('takes their integration down today');
  });

  it('allows it once the window has elapsed and nobody calls it', () => {
    const result = assessCompatibility({
      change: change({ removed: ['orders.legacyStatus'], deprecatedOn: '2025-06-01' }),
      liveUsage: [{ tenantId: 't-kumar', uses: ['orders.list'] }], today: '2026-08-04',
    });
    expect(result.verdict).toBe('compatible');
    expect(result.safeToDeploy).toBe(true);
  });

  it('treats making an optional field REQUIRED as breaking — it looks additive on a diff', () => {
    const result = assessCompatibility({
      change: change({ added: ['orders.slot'], nowRequired: ['orders.list'] }),
      liveUsage: usage, today: '2026-08-04',
    });
    expect(result.verdict).toBe('breaking');
    expect(result.tenantsAffected).toEqual(['t-kumar', 't-sre']);
  });
});
