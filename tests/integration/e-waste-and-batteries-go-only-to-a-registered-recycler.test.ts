import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { backings, openDatabase, closeDatabase, caller, codeOf, whatOf } from '../support/r4-lane1';

/**
 * **R4 · B21 · B22 · OB-212 — e-waste and batteries go only to a registered recycler (the real API, in memory and on real
 * PostgreSQL, with a cold restart).** A customer's used battery or old phone is a take-back — never a sale return — held
 * in the take-back location and never in saleable stock; it leaves only on a handover to a recycler with a recorded
 * registration number ("recycler not registered" otherwise; "not saleable: take-back stock" for any other way out); the
 * shop's own old till goes the same way; a disposed fixed asset with no handover is an exception; take-back stock on hand
 * is taken back less handed over and a count that differs is an exception; the brand-owner answers read "not confirmed".
 */

beforeAll(openDatabase);
afterAll(closeDatabase);

type View = {
  stock: { stockKey: string; onHandGrams: number; saleable: boolean; location: string }[];
  exceptions: { stock: { stockKey: string; differenceGrams: number }[]; assets: { assetId: string }[]; count: number };
  brandOwner: { key: string; status: string }[];
  handovers: { handoverId: string; registrationNumber: string }[];
};

describe.each(backings())('e-waste and batteries go only to a registered recycler — on $name (B21 · B22)', ({ harness, restart }) => {
  it('take-back is never saleable; a handover needs a registered recycler; stock = in − out; disposed assets need a handover', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    const { req, ok } = caller(() => h, T);
    const asMgr = (method: 'GET' | 'POST', path: string, b?: unknown) => req(method, path, b, 'u-mgr');

    // Two disposed fixed assets at the shop: an old till (electronic) and a steel rack.
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail (test)' }), 'company');
    await ok(req('POST', '/v1/org/nodes/br-1', { kind: 'branch', name: 'br-1', parentId: 'C1', companyId: 'C1' }), 'branch');
    for (const [id, name, category] of [['FA-TILL', 'Till 3', 'IT equipment'], ['FA-RACK', 'Display rack', 'Furniture']] as const) {
      await ok(req('POST', `/v1/finance/fixed-assets/${id}`, { name, category, storeId: 'br-1', costMinor: 5_000_000, salvageMinor: 0, usefulLifeMonths: 60, inServiceDate: '2025-04-01' }), `asset ${id}`);
      await ok(req('POST', `/v1/finance/fixed-assets/${id}/dispose`, { on: '2030-04-10', proceedsMinor: 0, reason: 'end of life' }), `dispose ${id}`);
    }
    await ok(asMgr('POST', '/v1/compliance/epr/recyclers/r-ok', { name: 'Green Recyclers (test)', registrationNumber: 'TNPCB-EW-TEST-0001' }), 'recycler ok');
    await ok(asMgr('POST', '/v1/compliance/epr/recyclers/r-none', { name: 'Street collector (test)' }), 'recycler unregistered');

    // ── Take-backs: recorded as take-backs, never sale returns; nothing reaches the stock ledger ─────────────────────
    const ledgerBefore = (await h.store.readStream(T, 'inventory')).length;
    const takeBack = (id: string, b: unknown) => asMgr('POST', `/v1/compliance/epr/take-backs/${id}`, b);
    expect(codeOf(await takeBack('tb-x', { kind: 'battery', description: 'car battery', weightGrams: 1500 }))).toBe('not_readable_as_a_take_back'); // no type
    expect(codeOf(await takeBack('tb-x', { kind: 'battery', description: 'x', weightGrams: 10, batteryType: 'alkaline', saleId: 'S-1', refundMinor: 500 }))).toBe('a_take_back_is_not_a_sale_return');
    const tb1 = (await ok(takeBack('tb-1', { kind: 'battery', description: 'used inverter battery', weightGrams: 1_500, batteryType: 'Lead-acid', customerRef: 'walk-in', on: '2030-05-01' }), 'tb-1')).body as { location: string; saleable: boolean };
    expect(tb1).toMatchObject({ location: 'epr-take-back', saleable: false });
    await ok(takeBack('tb-2', { kind: 'battery', description: 'phone battery', weightGrams: 300, batteryType: 'lithium-ion', on: '2030-05-01' }), 'tb-2');
    await ok(takeBack('tb-3', { kind: 'e_waste', description: 'old mobile phone', weightGrams: 2_000, on: '2030-05-01' }), 'tb-3');
    expect((await takeBack('tb-3', { kind: 'e_waste', description: 'something else', weightGrams: 9, on: '2030-05-01' })).status).toBe(409);
    expect((await h.store.readStream(T, 'inventory')).length).toBe(ledgerBefore);
    expect((await req('POST', '/v1/compliance/epr/take-backs/tb-9', { kind: 'e_waste', description: 'x', weightGrams: 1 }, 'u-till')).status).toBe(403);

    // ── Take-back stock leaves only to a registered recycler ─────────────────────────────────────────────────────
    const out = (id: string, to: unknown, lines: unknown, kind = 'battery') => asMgr('POST', `/v1/compliance/epr/take-back-stock/${id}/out`, { to, kind, lines, note: `HN-${id}`, on: '2030-05-02' });
    const LEAD = [{ description: 'lead-acid', weightGrams: 1_200, batteryType: 'lead-acid' }];
    for (const kind of ['sale', 'shelf', 'transfer']) {
      const r = await out(`o-${kind}`, { kind }, LEAD);
      expect(r.status).toBe(422);
      expect(codeOf(r)).toBe('not_saleable_take_back_stock');
      expect(whatOf(r)).toMatch(/^not saleable: take-back stock/);
    }
    const unregistered = await out('o-1', { kind: 'recycler', recyclerId: 'r-none' }, LEAD);
    expect(codeOf(unregistered)).toBe('recycler_not_registered');
    expect(whatOf(unregistered)).toBe('recycler not registered: Street collector (test) has no registration number recorded');
    expect(codeOf(await out('o-2', { kind: 'recycler', recyclerId: 'r-ghost' }, LEAD))).toBe('recycler_not_registered');
    const handed = (await ok(out('o-3', { kind: 'recycler', recyclerId: 'r-ok' }, LEAD), 'hand over')).body as { handover: { registrationNumber: string } };
    expect(handed.handover.registrationNumber).toBe('TNPCB-EW-TEST-0001');
    expect(codeOf(await out('o-4', { kind: 'recycler', recyclerId: 'r-ok' }, [{ description: 'more', weightGrams: 301, batteryType: 'lead-acid' }]))).toBe('more_than_take_back_stock');

    // ── The shop's own old till: refused to the unregistered recycler, recorded to the registered one ──────────────
    const shop = (id: string, recyclerId: string) => asMgr('POST', `/v1/compliance/epr/handovers/${id}`, { kind: 'e_waste', recyclerId, lines: [{ description: 'Till 3', weightGrams: 9_500, assetId: 'FA-TILL' }], note: 'HN-TILL', on: '2030-05-03' });
    expect(codeOf(await shop('h-till-0', 'r-none'))).toBe('recycler_not_registered');
    await ok(shop('h-till', 'r-ok'), 'till handover');

    const view = async (): Promise<View> => (await ok(asMgr('GET', '/v1/compliance/epr/take-back'), 'view')).body as View;
    const v1 = await view();
    expect(v1.stock.map((s) => [s.stockKey, s.onHandGrams, s.saleable, s.location])).toEqual([
      ['battery:lead-acid', 300, false, 'epr-take-back'], ['battery:lithium-ion', 300, false, 'epr-take-back'], ['e_waste', 2_000, false, 'epr-take-back'],
    ]);
    expect(v1.exceptions.assets.map((a) => a.assetId)).toEqual(['FA-RACK']); // the till has its handover
    expect(v1.brandOwner.map((b) => [b.key, b.status])).toEqual([['eWasteBrandOwner', 'not_confirmed'], ['batteryBrandOwner', 'not_confirmed']]);
    expect(v1.handovers.map((x) => x.handoverId).sort()).toEqual(['h-till', 'o-3']); // refused ones were never recorded

    // A person records the rack was not electrical; an unknown asset is refused.
    expect((await asMgr('POST', '/v1/compliance/epr/assets/FA-NONE/not-e-waste', { reason: 'x' })).status).toBe(404);
    await ok(asMgr('POST', '/v1/compliance/epr/assets/FA-RACK/not-e-waste', { reason: 'steel rack, no electrics' }), 'not e-waste');

    // The bin is counted: 250 g of lead-acid against 300 g on the register — an exception.
    const counted = (await ok(asMgr('POST', '/v1/compliance/epr/take-back-stock/counts/c-1', { kind: 'battery', batteryType: 'lead-acid', countedGrams: 250, on: '2030-05-04' }), 'count')).body as { exceptions: { stock: { differenceGrams: number }[] } };
    expect(counted.exceptions.stock).toEqual([expect.objectContaining({ stockKey: 'battery:lead-acid', differenceGrams: -50 })]);

    // ── A COLD RESTART: the register, the exceptions and the answers come back from the store ─────────────────────
    h = restart(h);
    const v2 = await view();
    expect(v2.stock).toEqual(v1.stock);
    expect(v2.exceptions.assets).toEqual([]);
    expect(v2.exceptions.stock).toEqual([expect.objectContaining({ stockKey: 'battery:lead-acid', countedGrams: 250, onHandGrams: 300 })]);
    expect((await req('GET', '/v1/compliance/epr/take-back', undefined, 'u-till')).status).toBe(403);
    await ok(req('POST', '/v1/compliance/epr/settings/battery-brand-owner', { value: 'no — the shop sells no own-brand batteries', confirmation: 'CA (test) ref B-1' }), 'battery answer');
    expect((await view()).brandOwner.find((b) => b.key === 'batteryBrandOwner')!.status).toBe('confirmed');
  });
});
