import { describe, it, expect } from 'vitest';
import { loadCodeEntries, scan, sample, type Rule } from './lib/scan.js';

// Hard rule #4 (CLAUDE.md) / roadmap §18: no shared or generic login accounts.
// Every user is named; production requires at least two named administrators.
// This guardrail trips on shared/generic account patterns and default
// admin/admin credentials.

const RULES: Rule[] = [
  { rule: 'Shared/generic account', re: /\b(?:shared|generic|common)[_-]?(?:login|account|user|username|credential|password)\b/i },
  { rule: 'Default admin credential', re: /\b(?:username|user|login)\b\s*[:=]\s*['"]admin['"]|\b(?:password|pwd)\b\s*[:=]\s*['"]admin['"]/i },
];

describe('guardrail: no shared or generic logins (hard rule #4 / §18)', () => {
  it('the codebase contains no shared-account or default-credential patterns', () => {
    const findings = scan(loadCodeEntries(), RULES);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it('the tripwire fires on known-bad samples', () => {
    const badShared = sample('services/auth/src/seed.ts', 'const sharedLogin = { username: "store", role: "cashier" };');
    const badAdmin = sample('services/auth/src/seed.ts', 'const u = { username: "admin", password: "admin" };');
    const findings = scan([badShared, badAdmin], RULES);
    expect(findings.map((f) => f.rule)).toContain('Shared/generic account');
    expect(findings.map((f) => f.rule)).toContain('Default admin credential');
  });
});
