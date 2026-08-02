import { describe, it, expect } from 'vitest';
import { loadCodeEntries, scan, sample, type Rule } from './lib/scan.js';

// Hard rule #2 (CLAUDE.md) / roadmap §4.2, §31.1: ledgers are append-only.
// Balances are projected from events; corrections are compensating events.
// This guardrail trips on any UPDATE/DELETE — SQL or ORM — aimed at a ledger,
// movement, journal, audit or dead-letter table.

const LEDGER = 'ledger|movement|journal|audit|dead[_-]?letter';

const RULES: Rule[] = [
  {
    rule: 'SQL UPDATE/DELETE on an append-only table',
    re: new RegExp(`\\b(?:UPDATE|DELETE)\\b[^;\\n]*\\b\\w*(?:${LEDGER})\\w*\\b`, 'i'),
  },
  {
    rule: 'ORM mutation on an append-only table',
    re: new RegExp(`\\b\\w*(?:${LEDGER})\\w*\\b\\s*\\.\\s*(?:update|updateMany|delete|deleteMany|destroy|remove)\\s*\\(`, 'i'),
  },
];

describe('guardrail: ledgers are append-only (hard rule #2)', () => {
  it('the codebase never updates or deletes an append-only table', () => {
    const findings = scan(loadCodeEntries(), RULES);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it('the tripwire fires on known-bad samples', () => {
    const badSql = sample('db/migrations/010_fix.sql', 'UPDATE inventory_movements SET quantity = 0 WHERE id = 42;');
    const badOrm = sample('services/inventory/src/repo.ts', 'await prisma.stockLedger.delete({ where: { id } });');
    const findings = scan([badSql, badOrm], RULES);
    expect(findings.map((f) => f.rule)).toContain('SQL UPDATE/DELETE on an append-only table');
    expect(findings.map((f) => f.rule)).toContain('ORM mutation on an append-only table');
  });
});
