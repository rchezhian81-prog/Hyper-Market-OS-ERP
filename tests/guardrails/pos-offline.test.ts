import { describe, it, expect } from 'vitest';
import { loadCodeEntries, scan, sample, type Rule } from './lib/scan.js';

// Hard rule #1 (CLAUDE.md) / roadmap P-01, §4.2: a core POS sale never depends
// on a network call. The sale commits locally first, then syncs idempotently.
// This guardrail trips if a POS sale/checkout/tender path makes a direct network
// call. The store-edge sync agent is allowed to use the network, so it is not
// scanned here — only the POS sale path is.

const RULES: Rule[] = [
  {
    rule: 'Network call in the POS sale path',
    re: /\b(?:fetch|axios|XMLHttpRequest|WebSocket|EventSource)\s*\(|https?\.(?:request|get)\s*\(/,
  },
];

// Only apply the rule to POS files that look like part of the sale/checkout path.
const inPosSalePath = (file: string): boolean =>
  file.startsWith('apps/pos/') && /(sale|checkout|tender|receipt|commit|bill)/i.test(file);

describe('guardrail: POS sale never depends on the network (hard rule #1)', () => {
  it('no POS sale-path file makes a direct network call', () => {
    const findings = scan(loadCodeEntries(), RULES, inPosSalePath);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it('the tripwire fires on a known-bad sample', () => {
    const bad = sample(
      'apps/pos/src/checkout.ts',
      'async function commitSale(s: Sale) {\n  await fetch("/api/sales", { method: "POST" });\n}',
    );
    const findings = scan([bad], RULES, inPosSalePath);
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });
});
