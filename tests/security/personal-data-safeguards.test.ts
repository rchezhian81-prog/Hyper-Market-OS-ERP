import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assessPiiSafeguards, assessSecurityLogRetention, realmSecurityLogs } from '../../packages/customer/src/pii-safeguards';
import { PII_FIELD_INVENTORY, SEALED_FIELDS } from '../../services/api/src/r2-data-adapters';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import * as payrollMask from '../../packages/payroll/src/mask';
import * as opsLogging from '../../packages/ops/src/logging';
import { apiHarness } from '../support/api-harness';

// C7 (v2.1 addendum · M02/M34/M35 · DPDP s.8(5)) — reasonable security safeguards, asserted beside the role checks:
//   • every personal-data field in the code is sealed under its subject's key, masked wherever shown, never kept, or held
//     by the identity server; the supplier contact details are business data by the owner's decision OB-153 "A", cited;
//   • security logs (sign-in events, administrator events, the tamper-evident audit trail) are kept ≥ 1 year;
//   • the people who may read who processes personal data, and the audit trail, are the privacy and audit roles — not a
//     cashier — and the API refuses the cashier.

const maskers = [...Object.keys(payrollMask), ...Object.keys(opsLogging)].filter((k) => k.startsWith('mask'));

describe('personal-data fields are encrypted or masked (C7)', () => {
  const report = assessPiiSafeguards({ declarations: PII_FIELD_INVENTORY, sealingPolicy: SEALED_FIELDS, maskers });

  it('no declaration is false: every "sealed" field is sealed by the policy that runs, every "masked" one has its masker', () => {
    expect(report.findings).toEqual([]);
    expect(report.byProtection.sealed_per_subject).toBeGreaterThan(0);
    expect(report.byProtection.masked_on_read).toBe(3);
  });

  it('OB-153 "A": the supplier contact details are business data by the owner\'s decision, and the C7 check passes', () => {
    const business = PII_FIELD_INVENTORY.filter((d) => d.protection === 'business_data_by_owner_decision');
    expect(business.map((d) => `${d.file}:${d.field}`)).toEqual([
      'services/purchase/src/supplier-master.ts:phone',
      'services/purchase/src/supplier-master.ts:email',
      'services/purchase/src/supplier-master.ts:address',
      'services/purchase/src/data-export.ts:phone',
      'services/purchase/src/data-export.ts:email',
      'services/purchase/src/data-export.ts:address',
    ]);
    expect(business.every((d) => d.whose === 'supplier_contact' && d.ownerDecision === 'OB-153')).toBe(true);
    expect(report.byProtection.unprotected).toBe(0);
    expect(report.byProtection.business_data_by_owner_decision).toBe(6);
    expect(report.compliant).toBe(true);
    expect(report.detail).toContain('business data by a recorded owner decision (6)');
  });

  it('each field is declared once, and the customer\'s own words in the ledger are sealed by the running policy', () => {
    const keys = PII_FIELD_INVENTORY.map((d) => `${d.file}:${d.field}`);
    expect(new Set(keys).size).toBe(keys.length);
    // The free-text personal fields (a complaint, a message, a driver's note) are sealed whatever they are called.
    const sealed = (type: string, field: string) => (SEALED_FIELDS[type] ?? []).some((r) => r.fields.includes(field));
    for (const [type, field] of [['ServiceCaseRecorded', 'summary'], ['NotificationQueue', 'text'], ['DeliveryAttempted', 'notes'], ['LoyaltyMember', 'mobileLast4']] as const) {
      expect(sealed(type, field), `${type}.${field}`).toBe(true);
    }
  });
});

describe('security logs are kept at least one year (C7)', () => {
  const realm = JSON.parse(readFileSync('infra/keycloak/realm-sre-store.json', 'utf8')) as Record<string, unknown>;
  const auditSql = readFileSync('db/migrations/0008_audit_log.sql', 'utf8');
  const ledgerSql = readFileSync('db/migrations/0004_append_only_guards.sql', 'utf8');

  it('sign-in and administrator events are on at the identity server, kept 366 days', () => {
    expect(realm['eventsEnabled']).toBe(true);
    expect(realm['adminEventsEnabled']).toBe(true);
    expect(realm['eventsExpiration']).toBe(366 * 86_400);
    // The details of an administrator event can carry a person's details; they are not stored.
    expect(realm['adminEventsDetailsEnabled']).toBe(false);
  });

  it('the audit trail can be neither changed nor deleted — kept for ever', () => {
    expect(auditSql).toMatch(/CREATE TRIGGER audit_log_no_update\s+BEFORE UPDATE ON audit_log/);
    expect(auditSql).toMatch(/CREATE TRIGGER audit_log_no_delete\s+BEFORE DELETE ON audit_log/);
    expect(ledgerSql.toLowerCase()).toContain('delete');
  });

  it('assessed together: compliant', () => {
    const r = assessSecurityLogRetention([...realmSecurityLogs('sre-store', realm), { logId: 'audit_log', kind: 'audit_trail', enabled: true, retentionDays: 'forever' }]);
    expect(r.findings).toEqual([]);
    expect(r.compliant).toBe(true);
  });
});

describe('alongside the role checks: who may see who processes personal data, and the audit trail (C6 · C7 · P-04)', () => {
  const holders = (permission: string): string[] => ROLE_CATALOGUE.filter((r) => r.permissions.includes(permission as never)).map((r) => r.id).sort();

  it('the processor register is the privacy authority\'s; the audit trail the audit roles\'; never the cashier\'s', () => {
    expect(holders('privacy.request.manage')).toEqual(['owner', 'store_manager']);
    expect(holders('privacy.request.manage')).not.toContain('cashier');
    expect(holders('audit.retention.read')).not.toContain('cashier');
    expect(holders('migration.cleaning.read')).not.toContain('cashier');
  });

  it('the API refuses a cashier the register, the legacy-card check and the audit trail', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const as = (userId: string, method: 'GET' | 'POST', path: string, body?: unknown) => h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body, idempotencyKey: randomUUID() }) });
    expect((await as('u-cash', 'GET', '/v1/privacy/processor-contracts')).status).toBe(403);
    expect((await as('u-cash', 'POST', '/v1/migration/legacy-card-purge/check', { records: [{ source: 's', rowRef: '1', fields: {} }] })).status).toBe(403);
    expect((await as('u-cash', 'GET', '/v1/audit/legal-holds')).status).toBe(403);
    expect((await as('u-owner', 'GET', '/v1/privacy/processor-contracts')).status).toBe(200);
  });
});
