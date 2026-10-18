import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dsdCheckInRoutes } from '../../services/inventory/src/dsd-checkin';

/**
 * D-11 (R3, OB-141 "A"): no cash at the DSD door — no route, field or screen pays a driver; the delivery closes only with
 * the signed delivery note and is settled later as a supplier bill. No override exists.
 */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');

describe('D-11 guardrail: no cash at the door', () => {
  it('the check-in record\'s only settlement is a supplier bill later', () => {
    const src = strip(readFileSync('services/inventory/src/dsd-checkin.ts', 'utf8'));
    expect(src).toContain("readonly settlement: 'supplier_bill_later';");
    expect(src).not.toMatch(/settlement:\s*'cash'|cashPaid|payDriver|tenders?:/);
  });

  it('no DSD route is a payment route', () => {
    const noop = async () => undefined as never;
    const routes = dsdCheckInRoutes({ now: () => '', routeSheet: noop, routeSheets: noop, recordRouteSheet: noop, order: noop, supplierActive: noop, checkIn: noop, checkIns: noop, recordCheckIn: noop, appendMovement: noop, permissionsOfUser: noop });
    for (const r of routes) {
      expect(r.path).not.toMatch(/pay|cash|tender|settle/i);
      expect(r.permission).not.toMatch(/cash|payment|tender/);
    }
  });

  it('the handheld\'s door check-in has no money field and never sends one', () => {
    const session = strip(readFileSync('apps/warehouse-app/src/dsd-door.ts', 'utf8'));
    expect(session).not.toMatch(/\b(cash|tender|payment)[A-Za-z]*\s*[:=]/i); // no money field or variable
    expect(session).not.toMatch(/amountMinor|paidMinor/);
    const html = strip(readFileSync('apps/warehouse-app/web/index.html', 'utf8'));
    const sheet = html.slice(html.indexOf('id="dsd"'), html.indexOf('id="banner"'));
    expect(sheet).not.toMatch(/id="dsd-(cash|pay|tender|amount)/);
  });

  it('the refusal is in the shared engine and has no bypass', () => {
    const engine = strip(readFileSync('packages/receiving/src/dsd-checkin.ts', 'utf8'));
    const at = engine.indexOf('export function signDeliveryNote');
    const fn = engine.slice(at);
    expect(fn).toContain("'no_cash_at_the_door'");
    expect(fn).toContain("'delivery_note_not_signed'");
    for (const bypass of ['override', 'allowCash', 'force']) expect(fn).not.toContain(bypass);
  });
});
