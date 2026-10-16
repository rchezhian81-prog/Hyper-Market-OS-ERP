import { describe, it, expect } from 'vitest';
import { loadCodeEntries, scan, sample, type Rule } from './lib/scan.js';
import { readCardTokenReference, CARD_TENDER_PERMITTED_FIELDS } from '../../packages/tender/src/card-token';
import { checkLegacyCardPurge, type LegacyRecord } from '../../packages/tender/src/legacy-card-purge';
import { generateLegacyDataset } from '../../packages/migration/src/synthetic';
import { PERMITTED_PAYMENT_RETENTION } from '../../packages/integration/src/adapters';

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
  {
    // C10 (v2.1): argued for here, as the note above asks. To refuse a legacy extract whose columns ARE the card number,
    // the security code or the card expiry, the check has to know those column headers by name. It is the code that keeps
    // card data OUT of a migration — it holds no value, and the third test below holds it to that like the redactor.
    file: 'packages/tender/src/legacy-card-purge.ts',
    reason:
      'the legacy-card-purge check (C10) — it names card-data column headers so a legacy extract carrying them is refused before the load',
  },
];

describe('guardrail: no raw card data (hard rule #3)', () => {
  it('the codebase stores no card number, CVV or expiry', () => {
    const allowed = new Set(ALLOWLIST.map((a) => a.file));
    const findings = scan(loadCodeEntries(), RULES).filter((f) => !allowed.has(f.file));
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it('the exemption list stays tiny and every entry is justified', () => {
    // Growth here is the thing to notice. Two entries today (the second argued for above, C10); a third must be argued for.
    expect(ALLOWLIST).toHaveLength(2);
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

// C10 (v2.1 addendum · M12): the tender surface stores ONLY a network-token reference plus the last four digits and the
// network — never the card number, the security code or the expiry — and a legacy-card-purge check passes.
describe('guardrail: a card tender keeps only the token reference, the last four and the network (C10)', () => {
  it('the permitted card fields are exactly three, and none of them is card data', () => {
    expect([...CARD_TENDER_PERMITTED_FIELDS]).toEqual(['tokenRef', 'last4', 'network']);
    // The payment adapters' retention allowlist agrees: a token, the last four and the network — never more of the card.
    for (const f of ['provider_token', 'last4', 'network_name']) expect(PERMITTED_PAYMENT_RETENTION).toContain(f);
  });

  it('never keeps a full number, a security code or an expiry, whatever the field is called', () => {
    const pan = ['5555', '5555', '5555', '4444'].join('');
    for (const extra of [{ number: pan }, { securityCode: '123' }, { validThru: '12/29' }, { first6: '555555' }, { track: 'x' }]) {
      const r = readCardTokenReference({ tokenRef: 'ntok_1', last4: '4444', network: 'mastercard', ...extra });
      expect(r.ok, JSON.stringify(Object.keys(extra))).toBe(false);
    }
    expect(readCardTokenReference({ tokenRef: `ntok_${pan}`, last4: '4444', network: 'mastercard' }).ok).toBe(false);
  });

  it('the legacy-card-purge check passes on the legacy data this repository rehearses with', () => {
    const ds = generateLegacyDataset();
    const records: LegacyRecord[] = (['products', 'stock', 'customers', 'suppliers', 'documents', 'lines'] as const)
      .flatMap((k) => (ds[k] as readonly object[]).map((row, i) => ({ source: `synthetic.${k}`, rowRef: String(i), fields: row as Record<string, unknown> })));
    const r = checkLegacyCardPurge(records);
    expect(r.findings).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('the purge check\'s tripwire fires on a known-bad legacy row', () => {
    const pan = ['4111', '1111', '1111', '1111'].join('');
    const r = checkLegacyCardPurge([{ source: 'bad', rowRef: '1', fields: { remarks: pan, cvc: '000' } }]);
    expect(r.passed).toBe(false);
    expect(r.findings.length).toBe(2);
  });
});
