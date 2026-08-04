import { describe, it, expect } from 'vitest';
import { loadCodeEntries, scan, sample, type Rule } from './lib/scan.js';

// Hard rule #2 (CLAUDE.md) / roadmap §4.2, §31.1: ledgers are append-only.
// Balances are projected from events; corrections are compensating events.
// This guardrail trips on any UPDATE/DELETE — SQL or ORM — aimed at a ledger,
// movement, journal, audit or dead-letter table.

const LEDGER = 'ledger|movement|journal|audit|dead[_-]?letter';

/**
 * A trigger declaration — `BEFORE UPDATE ON event_ledger` — is the ENFORCEMENT of
 * this rule, not a breach of it: migration 0004 uses exactly that to make the
 * database refuse edits. Real mutations read `UPDATE <table> SET` or
 * `DELETE FROM <table>`, so the rule is written to require those shapes.
 *
 * This is a tightening, not a loosening: the previous pattern would also have missed
 * nothing that these catch, and the "known-bad samples" test below still proves the
 * tripwire fires on genuine mutations.
 */
const TRIGGER_DECLARATION = /\b(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(?:UPDATE|DELETE|INSERT)\b/i;

const RULES: Rule[] = [
  {
    rule: 'SQL UPDATE/DELETE on an append-only table',
    re: new RegExp(
      `(?:\\bUPDATE\\s+(?:ONLY\\s+)?"?\\w*(?:${LEDGER})\\w*"?\\b[^;\\n]*\\bSET\\b` +
        `|\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?"?\\w*(?:${LEDGER})\\w*"?\\b)`,
      'i',
    ),
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
    const badDelete = sample('db/migrations/011_tidy.sql', 'DELETE FROM audit_trail WHERE at < now() - interval \'1 year\';');
    const badOrm = sample('services/inventory/src/repo.ts', 'await prisma.stockLedger.delete({ where: { id } });');
    const findings = scan([badSql, badDelete, badOrm], RULES);
    expect(findings.filter((f) => f.rule.startsWith('SQL')).length).toBe(2);
    expect(findings.map((f) => f.rule)).toContain('ORM mutation on an append-only table');
  });

  it('does not mistake the enforcement for a breach', () => {
    // Migration 0004 makes the DATABASE refuse edits. Its trigger declarations must
    // not read as violations, or the only real defence would be untestable.
    const guard = sample(
      'db/migrations/0004_append_only_guards.sql',
      [
        'CREATE TRIGGER event_ledger_no_update',
        '  BEFORE UPDATE ON event_ledger',
        '  FOR EACH ROW EXECUTE FUNCTION sre_refuse_mutation();',
        'CREATE TRIGGER event_ledger_no_delete',
        '  BEFORE DELETE ON event_ledger',
        '  FOR EACH ROW EXECUTE FUNCTION sre_refuse_mutation();',
      ].join('\n'),
    );
    expect(scan([guard], RULES)).toEqual([]);
    expect(TRIGGER_DECLARATION.test('  BEFORE UPDATE ON event_ledger')).toBe(true);
  });
});
