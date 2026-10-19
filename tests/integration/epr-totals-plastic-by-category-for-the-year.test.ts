import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { makeEvent } from '../../packages/contracts/src/event';
import { backings, openDatabase, closeDatabase, caller, codeOf } from '../support/r4-lane1';

/**
 * **R4 · B20 · OB-212 — the plastic EPR register totals the year's own-brand plastic per category (the real API, in
 * memory and on real PostgreSQL, with a cold restart).** Own-brand products carry their packaging category and plastic
 * per unit; the year's units come from the stock ledger's receipts and production outputs; the totals are per category to
 * the gram with a sortable CSV for the CPCB portal and nothing is filed; a product with no declaration is an exception,
 * never zero; the registration number and exemption are "not confirmed" until confirmed. Synthetic data.
 *
 * Time-independent: every movement carries its own date. A receipt at 23:30 IST on 31 March 2031 (18:00 UTC) belongs to
 * 2030-31; one at 00:30 IST on 1 April 2031 (19:00 UTC on 31 March) to the next year. The production output is appended
 * to the stock ledger exactly as a quality release posts it ('produced'), with a fixed date.
 */

beforeAll(openDatabase);
afterAll(closeDatabase);

const STORE = 'store-01';
type Ret = { categories: { category: string; units: number; totalGrams: number }[]; exceptions: { productId: string; kind: string; detail: string }[]; incomplete: boolean; csv: string; filing: string; settings: { key: string; status: string }[] };

describe.each(backings())('plastic EPR totals by category for the year — on $name (B20)', ({ harness, restart }) => {
  it('own-brand declarations × units received and produced → grams per category; a missing declaration is an exception', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    await h.provisionRole(T, 'u-ca', 'chartered_accountant');
    const c = caller(() => h, T);
    const { req, ok } = c;

    // ── Declarations ──────────────────────────────────────────────────────────────────────────────────────────────
    const declare = (p: string, b: unknown, who = 'u-mgr') => req('POST', `/v1/compliance/epr/own-brand/${p}`, b, who);
    expect((await declare('P-JAR', { ownBrand: true }, 'u-till')).status).toBe(403);
    await ok(declare('P-JAR', { ownBrand: true, packaging: [{ category: 'I', weightPerUnitMg: 12_500, description: 'jar' }, { category: 'II', weightPerUnitMg: 1_200, description: 'film' }] }), 'jar');
    await ok(declare('P-SACHET', { ownBrand: true, packaging: [{ category: 'II', weightPerUnitMg: 2_500 }] }), 'sachet');
    const bare = (await ok(declare('P-NODECL', { ownBrand: true }), 'no declaration')).body as { packagingDeclared: boolean };
    expect(bare.packagingDeclared).toBe(false);
    await ok(declare('P-BRANDX', { ownBrand: false }), 'not own brand');
    expect(codeOf(await declare('P-BAD', { ownBrand: true, packaging: [{ category: 'V', weightPerUnitMg: 1 }] }))).toBe('not_readable_as_an_own_brand_declaration');
    expect(codeOf(await declare('P-BAD', { ownBrand: true, packaging: [{ category: 'I', weightPerUnitMg: 2.5 }] }))).toBe('not_readable_as_an_own_brand_declaration');

    // ── The stock ledger: receipts through the movements route, a production output as the release posts it ─────────
    const receive = (movementId: string, productId: string, qty: number, occurredAt: string) =>
      ok(req('POST', '/v1/inventory/movements', { movementId, productId, locationId: STORE, kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt, enteredBy: 'u-owner', unitCostMinor: 100 }), movementId);
    await receive('rx-1', 'P-JAR', 100, '2030-04-10T05:00:00.000Z');
    await receive('rx-2', 'P-JAR', 30, '2030-03-31T05:00:00.000Z'); // 2029-30
    await receive('rx-3', 'P-JAR', 20, '2031-03-31T18:00:00.000Z'); // 23:30 IST on 31 March → 2030-31
    await receive('rx-4', 'P-JAR', 50, '2031-03-31T19:00:00.000Z'); // 00:30 IST on 1 April → 2031-32
    await receive('rx-5', 'P-SACHET', 1_000, '2030-06-01T05:00:00.000Z');
    await receive('rx-6', 'P-NODECL', 40, '2030-06-01T05:00:00.000Z');
    await receive('rx-7', 'P-BRANDX', 999, '2030-06-01T05:00:00.000Z');
    await h.store.append(T, 'inventory', makeEvent({
      id: 'prod-out-1', type: 'InventoryMoved', occurredAt: '2030-07-01T05:00:00.000Z', idempotencyKey: `prod-out-1-${T}`, source: 'api/production',
      payload: { movementId: 'prod-out-1', productId: 'P-SACHET', locationId: STORE, kind: 'produced', quantityMinor: 200, uom: 'ea', occurredAt: '2030-07-01T05:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 100 },
    }));

    const read = async (): Promise<Ret> => (await ok(req('GET', '/v1/compliance/epr/plastic/2030-31', undefined, 'u-mgr'), 'plastic')).body as Ret;
    const first = await read();
    const cat = (r: Ret, k: string) => r.categories.find((x) => x.category === k)!;
    expect(cat(first, 'I')).toMatchObject({ units: 120, totalGrams: 1_500 }); // (100 + 20) × 12.5 g
    expect(cat(first, 'II')).toMatchObject({ units: 1_320, totalGrams: 3_144 }); // 120 × 1.2 g + 1,200 × 2.5 g
    expect(first.exceptions).toEqual([expect.objectContaining({ productId: 'P-NODECL', kind: 'packaging_declaration_missing' })]);
    expect(first.incomplete).toBe(true);
    expect(first.filing).toBe('not_filed_by_the_system');
    expect(first.csv.split('\n')[0]).toBe('financial_year,category,product_id,plastic_per_unit_g,units_received,units_produced,units_put_on_market,plastic_g');
    expect(first.csv).toContain('2030-31,II,P-SACHET,2.500,1000,200,1200,3000.000');
    expect(first.settings.map((s) => [s.key, s.status])).toEqual([['plasticRegistration', 'not_confirmed'], ['plasticExemption', 'not_confirmed']]);
    expect((await req('GET', '/v1/compliance/epr/plastic/2030-31', undefined, 'u-till')).status).toBe(403);
    expect(codeOf(await req('GET', '/v1/compliance/epr/plastic/2030-32'))).toBe('epr_input_invalid');

    // ── Settings: a store manager cannot set them; without a confirmation they stay "not confirmed" ─────────────────
    expect((await req('POST', '/v1/compliance/epr/settings/plastic-registration', { value: 'X' }, 'u-mgr')).status).toBe(403);
    await ok(req('POST', '/v1/compliance/epr/settings/plastic-registration', { value: 'PWM-TEST-0001' }, 'u-owner'), 'reg unconfirmed');
    expect(((await read()).settings.find((s) => s.key === 'plasticRegistration'))!.status).toBe('not_confirmed');
    await ok(req('POST', '/v1/compliance/epr/settings/plastic-registration', { value: 'PWM-TEST-0001', confirmation: 'EPR consultant (test) ref E-7' }, 'u-ca'), 'reg confirmed');

    // ── A COLD RESTART: the same figures from the store; then the missing declaration is filled ────────────────────
    h = restart(h);
    const again = await read();
    expect(again.categories).toEqual(first.categories);
    expect(again.settings.find((s) => s.key === 'plasticRegistration')!.status).toBe('confirmed');
    await ok(declare('P-NODECL', { ownBrand: true, packaging: [{ category: 'III', weightPerUnitMg: 3_000 }] }), 'declared now');
    const filled = await read();
    expect(filled.exceptions).toEqual([]);
    expect(filled.incomplete).toBe(false);
    expect(cat(filled, 'III')).toMatchObject({ units: 40, totalGrams: 120 });
    // The earlier, bare declaration is kept — a later one replaces it on read, never by an edit.
    const decls = (await ok(req('GET', '/v1/compliance/epr/own-brand'), 'declarations')).body as { declarations: { productId: string; packaging: unknown[] }[] };
    expect(decls.declarations.find((d) => d.productId === 'P-NODECL')!.packaging).toHaveLength(1);
    const raw = await h.store.readStream(T, 'compliance\u001fepr', { type: 'OwnBrandDeclared' });
    expect(raw.filter((e) => (e.event.payload as { productId: string }).productId === 'P-NODECL')).toHaveLength(2);
  });
});
