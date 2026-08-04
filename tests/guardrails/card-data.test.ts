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

/**
 * The single narrow exemption, and why it exists.
 *
 * `packages/ops/src/logging.ts` holds the **denylist of field names that must be
 * redacted before anything is logged**. To redact a field called `cvv`, the word has
 * to appear in the denylist — so the scanner sees it. That is the exact opposite of
 * storing card data: it is the code that stops card data escaping.
 *
 * The exemption is deliberately expressed HERE, in the guardrail, and not as a magic
 * comment in the source. Adding another one means editing this file, which is a
 * visible, reviewable act — and `the exemption list stays tiny` below fails the build
 * if the list ever grows without someone meaning it to.
 */
const ALLOWLIST: readonly { readonly file: string; readonly reason: string }[] = [
  {
    file: 'packages/ops/src/logging.ts',
    reason:
      'the log-redaction denylist — these names appear so their values are removed, never stored',
  },
];

describe('guardrail: no raw card data (hard rule #3)', () => {
  it('the codebase stores no card number, CVV or expiry', () => {
    const allowed = new Set(ALLOWLIST.map((a) => a.file));
    const findings = scan(loadCodeEntries(), RULES).filter((f) => !allowed.has(f.file));
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it('the exemption list stays tiny and every entry is justified', () => {
    // Growth here is the thing to notice. One entry today; a second must be argued for.
    expect(ALLOWLIST).toHaveLength(1);
    expect(ALLOWLIST.every((a) => a.reason.length > 30)).toBe(true);
  });

  it('the exempted file redacts card data — it never declares a field to hold it', () => {
    // The exemption covers naming a field to strip, not keeping one. If the redactor
    // ever grows a place to PUT a card number, this fails.
    const entries = loadCodeEntries().filter((e) =>
      ALLOWLIST.some((a) => a.file === e.file),
    );
    expect(entries.length).toBe(ALLOWLIST.length);
    const declarations = entries.flatMap((entry) =>
      entry.content
        .split(/\r?\n/)
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) =>
          /\b(readonly\s+|let\s+|const\s+|var\s+)?(cvv2?|cvc2?|card[_-]?number|pan)\s*[:=]\s*(string|number|['"`])/i.test(
            line,
          ),
        )
        .map(({ n }) => `${entry.file}:${n}`),
    );
    expect(declarations, declarations.join(', ')).toEqual([]);
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
