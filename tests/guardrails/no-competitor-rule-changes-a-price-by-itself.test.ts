import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * D-18 (R4, OB-216 · hard rule #5 · P-05): "Nothing changes a price until a person approves it through the existing price
 * approval; no AI makes or commits the change." The claim is structural, so it is pinned on the source:
 *
 *   • the rule engine is pure — it imports only the price guard and money, and writes nothing;
 *   • the drafts route only reads: it calls no writer, names no price route, and the only thing the module can record is
 *     the owner's own rule (gap and age), never a price;
 *   • its adapter appends to the competitor-rule stream only — never to a price list or a price change;
 *   • no AI module reaches the drafts or the engine.
 */
const code = (p: string): string => readFileSync(p, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
const ENGINE = code('packages/pricing/src/competitor-rule.ts');
const ROUTES = code('services/pricing/src/competitor-drafts.ts');
const ADAPTERS = code('services/api/src/r4-supply-lp-adapters.ts');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('no competitor rule changes a price by itself (D-18)', () => {
  it('the engine is pure: it imports only the price guard and money, and has no I/O', () => {
    const imports = [...ENGINE.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../../contracts/src/money', '../../price-guard/src/price-guard']);
    expect(ENGINE).not.toMatch(/fetch\(|\.append\(|recordPriceChange|recordEntry/);
  });

  it('the drafts read calls no writer, and the module names no price route and no price writer', () => {
    const drafts = ROUTES.slice(ROUTES.indexOf("path: '/v1/prices/competitor-drafts'"));
    expect(drafts).not.toMatch(/deps\.record/);
    expect(drafts).toMatch(/advisoryOnly: true, pricesChanged: false/);
    expect(ROUTES).not.toMatch(/recordPriceChange|recordEntry|path: '\/v1\/prices\/changes'|path: '\/v1\/prices\/list/);
    // The only routes are the two rule routes and the read; the read is a GET.
    const paths = [...ROUTES.matchAll(/method: '(GET|POST)', path: '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(paths).toEqual(['GET /v1/prices/competitor-rule', 'POST /v1/prices/competitor-rule', 'GET /v1/prices/competitor-drafts']);
    // The one thing it may record is the owner's rule — the gap and the age, never a price.
    expect(ROUTES).toMatch(/readonly recordRule: \(tenantId: string, rule: StoredCompetitorRule\) => Promise<void>;/);
  });

  it('the adapter appends to the competitor-rule stream only', () => {
    const from = ADAPTERS.indexOf('export function competitorDraftAdapter');
    const adapter = ADAPTERS.slice(from, ADAPTERS.indexOf('\nexport function ', from + 1));
    const appends = [...adapter.matchAll(/store\.append(?:Batch)?\(t, ([A-Z_]+)/g)].map((m) => m[1]);
    expect(appends).toEqual(['COMPETITOR_RULE']);
    expect(adapter).not.toMatch(/recordPriceChange|recordEntry|pricingAdapter/);
  });

  it('no AI module reaches the drafts or the engine', () => {
    for (const f of [...filesUnder('packages/ai/src'), ...filesUnder('services/ai')]) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/competitor-rule|competitor-drafts|draftFromCompetitors/);
    }
  });
});
