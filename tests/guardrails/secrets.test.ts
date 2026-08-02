import { describe, it, expect } from 'vitest';
import { loadCodeEntries, scan, sample, type Rule } from './lib/scan.js';

// Hard rule #4 (CLAUDE.md): no secrets in code, config, images or logs. This is
// the in-suite guardrail; scripts/secret-scan.mjs additionally scans the WHOLE
// repository (docs and config included) in the pre-commit hook and in CI.

const RULES: Rule[] = [
  { rule: 'Private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { rule: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'Credential in connection URL', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s/:@'"]+:[^\s/:@'"]+@/ },
];

describe('guardrail: no committed secrets (hard rule #4)', () => {
  it('the codebase contains no secrets matched by these rules', () => {
    const findings = scan(loadCodeEntries(), RULES);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it('the tripwire fires on known-bad samples', () => {
    // Built at runtime so no line in this file ever looks like a real secret.
    const fakeAws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const fakeUrl = 'postgres://' + 'u' + ':' + 'p' + '@db.internal:5432/app';
    const bad = sample('services/orders/src/config.ts', `const a = "${fakeAws}";\nconst b = "${fakeUrl}";`);
    const findings = scan([bad], RULES);
    expect(findings.map((f) => f.rule)).toContain('AWS access key id');
    expect(findings.map((f) => f.rule)).toContain('Credential in connection URL');
  });
});
