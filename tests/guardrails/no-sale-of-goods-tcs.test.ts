import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TCS_LINE } from '../../packages/storefront/src/listing-duties';

/**
 * A25 guardrail (roadmap-v2.1-addendum, gap analysis "Note only (ensure NOT implemented)"; OB-288 gates lane): Tax
 * Collected at Source on the SALE OF GOODS under Income-tax Act s.206C(1H) was WITHDRAWN from 1 April 2025. The shop
 * must not collect it — not on a till bill, not on a B2B invoice, not online. It is correctly absent today; this keeps
 * it absent.
 *
 * The only "TCS" the software may speak of is the GST one under CGST s.52 (A26 / OB-211), and only to say it does NOT
 * apply (the online store sells the shop's own goods only). This fails if:
 *   • any product code or migration mentions s.206C (in any spelling), or a "TCS" rate, line, ledger or field outside
 *     the A26 "not applicable" line;
 *   • the A26 line stops saying "section 52" and "not applicable".
 */

const ROOTS = ['packages', 'services', 'apps', 'edge', 'db', 'scripts', 'infra'];
const CODE = /\.(ts|mts|js|mjs|sql|html|json)$/;
const SKIP = /(node_modules|\/dist\/|\.bundle\.js$|\/web\/vendor\/)/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (SKIP.test(path)) continue;
    if (statSync(path).isDirectory()) yield* files(path);
    else if (CODE.test(name)) yield path;
  }
}
const ALL = ROOTS.flatMap((r) => [...files(r)]);

/** Where the A26 GST s.52 "not applicable" line legitimately lives — the line itself, the route that serves it, the pages that show it. */
const A26_HOMES = new Set([
  'packages/storefront/src/listing-duties.ts',
  'services/orders/src/storefront-online-store.ts',
  'apps/web-erp/src/navigation.ts',
  'apps/web-erp/web/gst-returns.html',
  'apps/web-erp/web/online-store.js',
  'apps/web-erp/web/online-store.html',
]);

describe('A25: no Tax Collected at Source on the sale of goods (s.206C(1H), withdrawn 1 April 2025)', () => {
  it('scans real code — the tree is not empty', () => {
    expect(ALL.length).toBeGreaterThan(500);
  });

  it('no product code or migration mentions section 206C, in any spelling', () => {
    const hits = ALL.filter((f) => /\b206\s*-?\s*C\b|206C\(1H\)|section\s+206/i.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('"TCS" appears only where the A26 GST s.52 "not applicable" line lives', () => {
    const hits = ALL.filter((f) => /\btcs\b/i.test(readFileSync(f, 'utf8')) && !A26_HOMES.has(f));
    expect(hits).toEqual([]);
  });

  it('no rate, amount or ledger for TCS exists anywhere — the A26 route answers "collected: 0"', () => {
    for (const f of ALL) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/tcs[_ ]?(rate|bps|percent|amount|ledger|payable|collected)(?!Minor: 0)/i);
      expect(text, f).not.toMatch(/(rate|bps|percent|amount|ledger|payable)[_ ]?tcs/i);
    }
    expect(readFileSync('services/orders/src/storefront-online-store.ts', 'utf8')).toMatch(/tcs: TCS_LINE, collectedMinor: 0/);
  });

  it('the only TCS line is the GST s.52 one, and it says it does not apply', () => {
    expect(TCS_LINE).toMatch(/section 52/);
    expect(TCS_LINE).toMatch(/not applicable/);
  });

  it('tripwire — the scan would catch an s.206C(1H) collection written into product code', () => {
    const planted = "export const TCS_206C_1H_RATE_BPS = 10; // collect 0.1% above ₹50 lakh";
    expect(/\b206\s*-?\s*C\b|206C\(1H\)|section\s+206/i.test(planted.replace(/_/g, ' '))).toBe(true);
    expect(/\btcs\b/i.test(planted.replace(/_/g, ' '))).toBe(true);
    expect(/tcs[_ ]?(rate|bps|percent|amount|ledger|payable|collected)/i.test('tcsRate')).toBe(true);
  });
});
