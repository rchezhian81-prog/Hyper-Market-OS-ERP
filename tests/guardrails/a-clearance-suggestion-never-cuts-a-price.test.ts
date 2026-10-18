import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { clearanceMarkdownRoutes } from '../../services/pricing/src/clearance-markdowns';

/**
 * D-16 (R3, OB-189): "A clearance product produces price-cut suggestions that a person must approve; nothing is cut
 * automatically" — and "can't be put on a purchase order or reordered automatically, even if the store's range doesn't say
 * so". No override exists for either.
 */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('D-16 guardrails', () => {
  it('the clearance suggestions surface is read-only: one GET, no write port in its deps', () => {
    const noop = async () => { throw new Error('not called'); };
    const routes = clearanceMarkdownRoutes({ now: () => '2030-01-01T00:00:00.000Z', clearanceProducts: noop, batchesAtStore: noop, soldAtStore: noop, shelfPriceMinor: noop, assertStoreInScope: noop });
    expect(routes.map((r) => r.method)).toEqual(['GET']);
    const code = strip(readFileSync('services/pricing/src/clearance-markdowns.ts', 'utf8'));
    for (const forbidden of ['recordPriceChange', 'recordEntry', '.append(', 'PriceListEntryPublished', 'PriceChanged']) expect(code).not.toContain(forbidden);
  });

  it('the purchase-order lifecycle refusal has no override, approval or flag that lets it through', () => {
    const code = strip(readFileSync('services/purchase/src/purchase-orders.ts', 'utf8'));
    const at = code.indexOf('if (deps.masterLifecycle !== undefined)');
    expect(at).toBeGreaterThan(0);
    const block = code.slice(at, code.indexOf('if (deps.rangeStatus !== undefined)', at));
    expect(block).toContain("throw apiError(422");
    for (const bypass of ['override', 'approval', 'force', "b['", 'ctx.query']) expect(block, bypass).not.toContain(bypass);
  });

  it('the replenishment lifecycle filter reads no request field', () => {
    const code = strip(readFileSync('services/inventory/src/replenishment.ts', 'utf8'));
    const at = code.indexOf('const stoppedByLifecycle');
    const block = code.slice(at, code.indexOf('const stockFacts', at));
    for (const bypass of ['override', 'force', 'ctx.query', 'b.items']) expect(block, bypass).not.toContain(bypass);
    expect(block).toContain("lifecycle === 'discontinued' || lifecycle === 'clearance'");
  });
});
