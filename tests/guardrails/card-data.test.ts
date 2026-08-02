import { describe, it, expect } from 'vitest';
import { loadCodeEntries, scan, sample, type Rule } from './lib/scan.js';

// Hard rule #3 (CLAUDE.md) / roadmap §35: never store a card number, CVV or
// expiry date. Provider tokens only. This guardrail trips if the codebase ever
// introduces a field that would hold raw card data.

const RULES: Rule[] = [
  { rule: 'Raw card number field', re: /\b(card[_-]?number|cardnumber|primary[_-]?account[_-]?number|pan[_-]?number)\b/i },
  { rule: 'Card verification value (CVV/CVC)', re: /\b(cvv2?|cvc2?|card[_-]?verification(?:[_-]?value)?)\b/i },
  { rule: 'Card expiry field', re: /\b(card[_-]?exp(?:iry|iration)?|card[_-]?exp[_-]?(?:month|year))\b/i },
];

describe('guardrail: no raw card data (hard rule #3)', () => {
  it('the codebase stores no card number, CVV or expiry', () => {
    const findings = scan(loadCodeEntries(), RULES);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it('the tripwire fires on a known-bad sample', () => {
    const bad = sample(
      'apps/pos/src/checkout.ts',
      [
        'interface StoredCard {',
        '  cardNumber: string;',
        '  cvv: string;',
        '  cardExpiry: string;',
        '}',
      ].join('\n'),
    );
    const findings = scan([bad], RULES);
    expect(findings.length).toBeGreaterThanOrEqual(3);
  });
});
