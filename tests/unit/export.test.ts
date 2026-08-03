import { describe, it, expect } from 'vitest';
import { exportDomain, REDACTED, EXPORT_SENSITIVE, type ExportSpec } from '../../packages/export/src/index';
import { AccessControl, AccessDeniedError, type Role, type RoleAssignment } from '../../packages/rbac/src/index';
import { parseDelimited } from '../../packages/import/src/index';

// Your data is yours (NFR-12 / OD-09): every authorised domain exports to an open
// format — but permission, branch scope and PII redaction are enforced (M30-FR-02).

const AT = '2026-08-02T18:00:00Z';

const SPEC: ExportSpec = {
  domain: 'customer',
  requires: 'customer.export',
  branchColumn: 'branch_id',
  columns: [
    { name: 'customer_id', type: 'text', description: 'Internal id' },
    { name: 'branch_id', type: 'text' },
    { name: 'name', type: 'text', sensitive: true, description: 'Personal data' },
    { name: 'phone', type: 'text', sensitive: true },
    { name: 'lifetime_value_minor', type: 'money_minor' },
  ],
};

const ROWS = [
  { customer_id: 'c1', branch_id: 'b1', name: 'Ravi Kumar', phone: '9876543210', lifetime_value_minor: '250000' },
  { customer_id: 'c2', branch_id: 'b1', name: 'Priya, S.', phone: '9876500000', lifetime_value_minor: '90000' },
  { customer_id: 'c3', branch_id: 'b2', name: 'Other Branch', phone: '9000000000', lifetime_value_minor: '10000' },
];

const ROLES: Role[] = [
  { id: 'analyst', name: 'Analyst', permissions: ['customer.export'] },
  { id: 'dpo', name: 'Data officer', permissions: ['customer.export', EXPORT_SENSITIVE] },
  { id: 'cashier', name: 'Cashier', permissions: ['sales.view'] },
];
const ASSIGNMENTS: RoleAssignment[] = [
  { userId: 'analyst-1', roleId: 'analyst', branchScope: ['b1'] },
  { userId: 'dpo-1', roleId: 'dpo', branchScope: 'all' },
  { userId: 'cashier-1', roleId: 'cashier', branchScope: ['b1'] },
];
const access = new AccessControl(ROLES, ASSIGNMENTS);

describe('exportDomain', () => {
  it('refuses a user without the domain export permission (default-deny)', () => {
    expect(() =>
      exportDomain(SPEC, ROWS, access, { userId: 'cashier-1', branchId: 'b1', at: AT }),
    ).toThrow(AccessDeniedError);
  });

  it('exports only the user’s branch — never another branch’s rows (§28)', () => {
    const result = exportDomain(SPEC, ROWS, access, { userId: 'analyst-1', branchId: 'b1', at: AT });
    expect(result.audit.rowCount).toBe(2); // c3 is in b2 and is excluded
    expect(result.csv).not.toContain('Other Branch');
  });

  it('redacts personal data for a user without the sensitive permission (PRV)', () => {
    const result = exportDomain(SPEC, ROWS, access, { userId: 'analyst-1', branchId: 'b1', at: AT });
    expect(result.csv).not.toContain('Ravi Kumar');
    expect(result.csv).not.toContain('9876543210');
    expect(result.csv).toContain(REDACTED);
    // Redacted, not dropped — the column still exists, so the file's shape is honest.
    expect(result.csv.split('\n')[0]).toContain('name');
    expect(result.audit.redactedColumns).toEqual(['name', 'phone']);
  });

  it('gives the data officer the real values, with nothing redacted', () => {
    const result = exportDomain(SPEC, ROWS, access, { userId: 'dpo-1', branchId: null, at: AT });
    expect(result.csv).toContain('Ravi Kumar');
    expect(result.audit.redactedColumns).toEqual([]);
    expect(result.audit.rowCount).toBe(3); // company-wide scope
  });

  it('ships a machine-readable schema so the file is self-describing (NFR-12)', () => {
    const result = exportDomain(SPEC, ROWS, access, { userId: 'dpo-1', branchId: null, at: AT });
    expect(result.schema.domain).toBe('customer');
    expect(result.schema.columns[0]).toEqual({ name: 'customer_id', type: 'text', description: 'Internal id' });
    expect(result.schema.columns.map((c) => c.name)).toEqual([
      'customer_id',
      'branch_id',
      'name',
      'phone',
      'lifetime_value_minor',
    ]);
  });

  it('logs who exported what, when, and how many rows (M30-FR-02)', () => {
    const result = exportDomain(SPEC, ROWS, access, { userId: 'analyst-1', branchId: 'b1', at: AT });
    expect(result.audit).toEqual({
      userId: 'analyst-1',
      domain: 'customer',
      branchId: 'b1',
      at: AT,
      rowCount: 2,
      redactedColumns: ['name', 'phone'],
    });
  });

  it('produces valid CSV that reads straight back — proving no lock-in (NFR-12 / OD-09)', () => {
    const result = exportDomain(SPEC, ROWS, access, { userId: 'dpo-1', branchId: null, at: AT });
    // The acid test: our own importer parses our own export, losslessly.
    const reparsed = parseDelimited(result.csv);
    expect(reparsed.headers).toEqual([
      'customer_id',
      'branch_id',
      'name',
      'phone',
      'lifetime_value_minor',
    ]);
    expect(reparsed.rows).toHaveLength(3);
    expect(reparsed.rows[0]).toEqual(ROWS[0]);
    // A value containing a comma survives the round trip intact.
    expect(reparsed.rows[1]?.name).toBe('Priya, S.');
  });

  it('exports an empty result as a header-only file, not an error', () => {
    const result = exportDomain(SPEC, [], access, { userId: 'analyst-1', branchId: 'b1', at: AT });
    expect(result.audit.rowCount).toBe(0);
    expect(result.csv.trim()).toBe('customer_id,branch_id,name,phone,lifetime_value_minor');
  });
});
