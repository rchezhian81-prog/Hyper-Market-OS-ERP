import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadCodeEntries, sample, type Entry } from './lib/scan.js';
import { PII_FIELD_INVENTORY, SEALED_FIELDS } from '../../services/api/src/r2-data-adapters';
import { assessPiiSafeguards, assessSecurityLogRetention, realmSecurityLogs } from '../../packages/customer/src/pii-safeguards';
import * as payrollMask from '../../packages/payroll/src/mask';
import * as opsLogging from '../../packages/ops/src/logging';

// C7 (v2.1 addendum · M02/M34/M35) — the NEVER claims:
//   • a personal-data field never arrives in the code unprotected and unnoticed: every field whose NAME says it holds a
//     person's details must be declared in `PII_FIELD_INVENTORY` with how it is protected (sealed / masked / never kept /
//     held by the identity server), and a declaration that is not true fails;
//   • security logs are never kept less than a year: the identity server's sign-in and administrator events are on, kept
//     ≥ 365 days, and the audit trail can be neither updated nor deleted.

/** Field names that hold a person's details. Matched as a declared field (`name:` / `name?:`), in TypeScript source. */
const PII_FIELD = /(?:^\s*|[;{]\s*)(?:readonly\s+)?(phone|mobile|email|address|dateOfBirth|dob|aadhaar|bankAccount|accountNumber|ifsc|uan|fullName|phoneNumber|mobileNumber|mobileLast4|contact|contactPhone|contactEmail|deliveryAddress|addressLine1|pincode|customerName|guardianName)\??\s*:\s*[^,;{(]*?(string|\{)/g;

/** The shippable TypeScript where a record's shape is declared. Browser shells hold forms, not stored records. */
const inScope = (e: Entry): boolean => /^(packages|services|edge)\//.test(e.file) && e.file.endsWith('.ts');

function personalFields(entries: readonly Entry[]): { file: string; field: string; line: number }[] {
  const out: { file: string; field: string; line: number }[] = [];
  for (const e of entries.filter(inScope)) {
    e.content.split(/\r?\n/).forEach((text, i) => {
      if (/^\s*(\/\/|\*)/.test(text)) return;
      for (const m of text.matchAll(PII_FIELD)) out.push({ file: e.file, field: m[1]!, line: i + 1 });
    });
  }
  return out;
}

describe('guardrail: every personal-data field is declared with its protection (C7)', () => {
  const found = personalFields(loadCodeEntries());
  const declared = new Set(PII_FIELD_INVENTORY.map((d) => `${d.file}:${d.field}`));

  it('finds the personal-data fields in the source', () => {
    expect(found.length).toBeGreaterThan(10);
  });

  it('every one is declared — a new one cannot arrive unnoticed', () => {
    const undeclared = found.filter((f) => !declared.has(`${f.file}:${f.field}`)).map((f) => `${f.file}:${f.line} ${f.field}`);
    expect(undeclared, `declare these in PII_FIELD_INVENTORY (services/api/src/r2-data-adapters.ts) with how they are protected:\n${undeclared.join('\n')}`).toEqual([]);
  });

  it('no declaration is stale or false', () => {
    const live = new Set(found.map((f) => `${f.file}:${f.field}`));
    expect(PII_FIELD_INVENTORY.filter((d) => !live.has(`${d.file}:${d.field}`)).map((d) => `${d.file}:${d.field}`)).toEqual([]);
    const maskers = [...Object.keys(payrollMask), ...Object.keys(opsLogging)].filter((k) => k.startsWith('mask'));
    const r = assessPiiSafeguards({ declarations: PII_FIELD_INVENTORY, sealingPolicy: SEALED_FIELDS, maskers });
    expect(r.findings.filter((f) => f.flag !== 'unprotected')).toEqual([]);
  });

  it('an unprotected field never passes silently: each names the owner decision it waits on, and the list does not grow', () => {
    const open = PII_FIELD_INVENTORY.filter((d) => d.protection === 'unprotected');
    expect(open.every((d) => (d.awaitingDecision ?? '').length > 10)).toBe(true);
    expect(open.every((d) => d.whose === 'supplier_contact')).toBe(true);
    expect(open).toHaveLength(6);
  });

  it('the tripwire fires on a known-bad sample', () => {
    const bad = sample('services/orders/src/new-thing.ts', 'export interface Courier {\n  readonly phone: string;\n  readonly address?: string;\n}');
    expect(personalFields([bad]).map((f) => f.field)).toEqual(['phone', 'address']);
  });
});

describe('guardrail: security logs are never kept less than a year (C7)', () => {
  it('the identity server keeps sign-in and administrator events ≥ 365 days; the audit trail is never updated or deleted', () => {
    const realm = JSON.parse(readFileSync('infra/keycloak/realm-sre-store.json', 'utf8')) as Record<string, unknown>;
    const audit = readFileSync('db/migrations/0008_audit_log.sql', 'utf8');
    const auditKept = /BEFORE UPDATE ON audit_log/.test(audit) && /BEFORE DELETE ON audit_log/.test(audit);
    expect(auditKept).toBe(true);
    const r = assessSecurityLogRetention([...realmSecurityLogs('sre-store', realm), { logId: 'audit_log', kind: 'audit_trail', enabled: auditKept, retentionDays: 'forever' }]);
    expect(r.findings, r.detail).toEqual([]);
  });

  it('the tripwire fires on a realm with events off or kept a month', () => {
    expect(assessSecurityLogRetention(realmSecurityLogs('bad', { eventsEnabled: false })).compliant).toBe(false);
    expect(assessSecurityLogRetention([...realmSecurityLogs('bad', { eventsEnabled: true, eventsExpiration: 2_592_000, adminEventsEnabled: true }), { logId: 'a', kind: 'audit_trail', enabled: true, retentionDays: 'forever' }]).compliant).toBe(false);
  });
});
