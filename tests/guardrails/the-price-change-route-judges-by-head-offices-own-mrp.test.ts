import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * D-019 · P-04: head office's price-change route judges a price by head office's OWN MRP — never only by the figure a
 * request sends. The route takes the lower of the two; with none on record it needs a second person. This guardrail keeps
 * the production composition wired: every place `POST /v1/prices/changes` is built for the running system passes the
 * product master's MRP in force today, and the route itself uses it. A later edit that drops either line fails here before
 * a request can lift the legal ceiling again. (Behaviour: tests/integration/d019-a-sent-mrp-cannot-lift-head-offices-ceiling.)
 */

const read = (p: string): string => readFileSync(p, 'utf8');

describe('the price-change route judges a price by head office’s own MRP', () => {
  it('the route takes the lower of the recorded and the sent MRP, and refuses an unrecorded one without a second person', () => {
    const route = read('services/pricing/src/index.ts');
    expect(route).toMatch(/const mrpMinor = onRecord === undefined \? b\.mrpMinor! : Math\.min\(b\.mrpMinor!, onRecord\.mrpMinor\);/);
    expect(route).toMatch(/mrp: money\(mrpMinor, currency\)/);
    expect(route).not.toMatch(/mrp: money\(b\.mrpMinor!, currency\)/);
    expect(route).toMatch(/if \(deps\.mrpOnRecordFor !== undefined && onRecord === undefined && approval === undefined\) \{\n\s+throw apiError\(422, \{\n\s+code: 'mrp_not_on_record_needs_second_person'/);
  });

  it('both production compositions of the route pass head office’s MRP in force today', () => {
    expect(read('services/api/src/main.ts')).toMatch(/mrpOnRecordFor: mrpOnRecordFor\(\{ store, now, calendar: shopCalendar \}\)/);
    expect(read('services/api/src/p1-identity-adapters.ts')).toMatch(/swapIn\(surface, pricingRoutes\(\{[\s\S]*?mrpOnRecordFor: mrpOnRecordFor\(/);
  });

  it('the MRP on record is the one in force on the shop’s today, from the product master', () => {
    const reader = read('services/api/src/w1-products-prices-adapters.ts');
    const fn = reader.slice(reader.indexOf('export function mrpOnRecordFor'));
    expect(fn).toMatch(/const today = await clock\.today\(tenantId, input\.now\(\)\);/);
    expect(fn).toMatch(/filter\(\(x\) => x\.day <= today\)/);
  });
});
