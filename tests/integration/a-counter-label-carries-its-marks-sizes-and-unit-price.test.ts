import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import type { ApiHarness } from '../support/api-harness';

/**
 * **Round 6 · B9 · B24 · B3 (roadmap v2.1 addendum, M03/M11) — the REAL counter label (`POST /v1/production/runs/:runId/label`).**
 *
 *   B9   food made in the store carries the veg / non-veg mark and an allergen declaration from the EIGHT FSSAI groups; a
 *        missing mark, a silent declaration, or a word that is not a group BLOCKS the label (`incomplete_label`, nothing printed);
 *   B24  the label template has a panel area and character heights, and a render too small for its panel FAILS
 *        (`label_print_too_small`) — the counter's standard 58 × 40 mm template is judged and said on every label;
 *   B3   the label shows the unit sale price (₹ per kg / litre / piece) worked out from the price and the net quantity.
 * The run is committed, then the box restarts cold, and the label is judged on head office's stored run. In memory and on
 * real PostgreSQL. Synthetic data only.
 */

const A = randomUUID(); // a fresh shop per run — the PostgreSQL database outlives the run
const backings = r3OpsBackings();
const GOOD = { productName: 'Synthetic coffee cake', netQuantity: '180 g', packerDetails: 'SRE Hyper Market, Tamil Nadu', priceMinor: 120_00, allergens: ['cereals_gluten', 'milk', 'eggs'], vegClass: 'non_veg' };

describe.each(backings)('a counter label carries its veg mark, its eight-group allergens, legal sizes and the unit price — on $name', ({ harness, restart }) => {
  it('prints a lawful label; refuses each gap by name; refuses a too-small template; a cashier may not print', async () => {
    let h: ApiHarness = harness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    const { req, ok, code } = tenantClient(() => h, A);
    await ok(req('POST', '/v1/production/departments/cafe', {}), 'cafe enabled');
    for (const [p, q] of [['FLOUR', 500], ['SUGAR', 300]] as const) {
      await ok(req('POST', '/v1/inventory/movements', { movementId: `mv-${p}`, productId: p, locationId: 'KITCHEN', kind: 'received', quantityMinor: q, uom: 'g', occurredAt: '2026-10-27T00:00:00.000Z', enteredBy: 'u-owner' }), `stock ${p}`);
    }
    await ok(req('POST', '/v1/production/recipes/r-cake', {
      departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 1, outputUom: 'ea',
      inputs: [{ productId: 'FLOUR', quantityMinor: 100, uom: 'g' }, { productId: 'SUGAR', quantityMinor: 50, uom: 'g' }],
      shelfLifeHours: 48, expectedYieldBp: 10_000, yieldToleranceBp: 500,
    }), 'recipe');
    await ok(req('POST', '/v1/production/runs/run-L', { recipeId: 'r-cake', batches: 1, actualOutputMinor: 1, outputBatchId: 'CAKE-L1', locationId: 'KITCHEN' }), 'run');

    h = restart(h); // ── COLD RESTART: the label is judged on the stored run ─────────────────────────────────────────────
    const label = (body: unknown, userId = 'u-owner') => req('POST', '/v1/production/runs/run-L/label', body, userId);

    const printed = await label(GOOD);
    expect(printed.status, JSON.stringify(printed.body)).toBe(200);
    const body = printed.body as { lines: string[]; batchId: string; unitPrice: unknown; print: unknown; vegClass: string };
    expect(body.batchId).toBe('CAKE-L1');
    expect(body.lines[0]).toBe('[▲] NON-VEG');
    expect(body.lines).toEqual(expect.arrayContaining(['Contains: Cereals containing gluten, Milk, Eggs', 'Unit price ₹666.67 per kg', 'Net 180 g']));
    expect(body).toMatchObject({ vegClass: 'non_veg', unitPrice: { unitPriceMinor: 666_67, per: 'kg' }, print: { templateId: 'counter-58x40', principalPanelAreaCm2: 23.2, minHeightMm: 1, letterHeightMm: 2, numeralHeightMm: 2 } });
    // "None of the eight" is a declaration; a litre pack is priced per litre.
    const none = await label({ ...GOOD, allergens: [], vegClass: 'veg', netQuantity: '500 ml', priceMinor: 60_00 });
    expect((none.body as { lines: string[] }).lines).toEqual(expect.arrayContaining(['[●] VEG', 'Allergens: none of the 8 major groups', 'Unit price ₹120.00 per litre']));

    // B9: no veg mark; a silent allergen declaration; a free-text allergen — each refused, by name, nothing printed.
    const noMark = { ...GOOD, vegClass: undefined };
    const r1 = await label(noMark);
    expect([r1.status, code(r1)]).toEqual([422, 'incomplete_label']);
    expect(JSON.stringify(r1.body)).toContain('veg or non-veg mark');
    const silent = { ...GOOD, allergens: undefined };
    expect(code(await label(silent))).toBe('incomplete_label');
    const r3 = await label({ ...GOOD, allergens: ['wheat'] });
    expect(code(r3)).toBe('incomplete_label');
    expect(JSON.stringify(r3.body)).toContain('\\"wheat\\" is not one of the recognised major allergen groups');
    expect(code(await label({ ...GOOD, vegClass: 'eggetarian' }))).toBe('not_readable_as_a_label');

    // B3: a net quantity the price per unit cannot be worked out from — refused, never printed without the unit price.
    const r4 = await label({ ...GOOD, netQuantity: 'one slice' });
    expect(code(r4)).toBe('incomplete_label');
    expect(JSON.stringify(r4.body)).toContain('price per unit');

    // B24: a printer template whose numerals are below the minimum for its panel (150 cm² → 2 mm) fails; a lawful one prints.
    const small = await label({ ...GOOD, template: { templateId: 'shelf-100x150', principalPanelAreaCm2: 150, letterHeightMm: 2, numeralHeightMm: 1.5 } });
    expect([small.status, code(small)]).toEqual([422, 'label_print_too_small']);
    expect(JSON.stringify(small.body)).toContain('1.5 mm is below the 2 mm minimum for a 150 cm² panel');
    const big = await label({ ...GOOD, template: { templateId: 'shelf-100x150', principalPanelAreaCm2: 150, letterHeightMm: 2, numeralHeightMm: 2 } });
    expect(big.status).toBe(200);
    expect((big.body as { unitPrice: { exempt: boolean } }).unitPrice.exempt).toBe(false); // a > 100 cm² panel must show it
    expect(code(await label({ ...GOOD, template: { templateId: 'x', principalPanelAreaCm2: -1, letterHeightMm: 2, numeralHeightMm: 2 } }))).toBe('not_readable_as_a_label');

    // 403: a cashier holds no production.recipe.manage.
    expect((await label(GOOD, 'u-cash')).status).toBe(403);
  });
});
