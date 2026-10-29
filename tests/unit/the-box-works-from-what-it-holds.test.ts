import { describe, it, expect } from 'vitest';
import { counterLabelFor, readCounterLabelRequest, transferWork, productionWork, foodSafetyWork, useByOf } from '../../edge/store-edge/src/store-work';
import { readPack } from '../../edge/store-edge/src/store-pack';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { CatalogueCache } from '../../packages/catalogue/src/catalogue';
import type { SignedPack } from '../../services/catalogue/src/pack';
import { readProductionFeed, readFoodSafetyFeed, readTransfersFeed, readWorkFeed, pullWorkFeed, type WorkFeed, type WorkFeedSource } from '../../edge/sync-agent/src/store-work-feeds';

// OB-288 lane 2 · P2 — what the store box tells its screens from head office's last word (with how old it is, never an
// empty list for "not told"), and the COUNTER LABEL it renders with the cable out (M11-FR-03): batch and use-by are the
// run's, name and price are the catalogue's, the barcode carries the weight by the shop's own rule so the till scans what
// the label says, the label is lawful for the department, and food past its use-by is never labelled.

const NOW = '2026-10-23T08:00:00.000Z';
const feedOf = (name: WorkFeed['name'], body: Record<string, unknown>, asAt = '2026-10-23T07:00:00.000Z') => ({ feed: { name, asAt, body }, receivedAt: asAt });
const production = feedOf('production', {
  runs: [
    { runId: 'r-cake', departmentId: 'cafe', outputProductId: 'CAKE', outputBatchId: 'CAKE-1', expiresAt: '2026-10-25T06:00:00.000Z', at: '2026-10-23T06:00:00.000Z' },
    { runId: 'r-old', departmentId: 'cafe', outputProductId: 'CAKE', outputBatchId: 'CAKE-0', expiresAt: '2026-10-22T06:00:00.000Z' },
    { runId: 'r-meat', departmentId: 'meat_fish', outputProductId: 'MINCE', outputBatchId: 'MINCE-1', expiresAt: '2026-10-24T06:00:00.000Z' },
  ],
  recipes: [{ recipeId: 'rc-cake', departmentId: 'cafe', outputProductId: 'CAKE', outputUom: 'ea', shelfLifeHours: 48 }, { recipeId: 'rc-mince', departmentId: 'meat_fish', outputProductId: 'MINCE', outputUom: 'kg', shelfLifeHours: 24 }],
  enabledDepartments: ['cafe', 'meat_fish'],
});
const catalogue = (): SignedPack => ({
  signature: 'x', publishedBy: 'u-owner', publishedAt: NOW,
  snapshot: {
    tenantId: 'T', version: 3, builtAt: NOW, scope: { tenantId: 'T', storeId: 'S1' },
    products: [
      { productId: 'CAKE', sku: 'CAKE', name: 'Plum cake', baseUom: 'ea', unitPriceMinor: 12_000, taxBps: 500, status: 'active' },
      { productId: 'MINCE', sku: 'MINCE', name: 'Mutton mince', baseUom: 'kg', unitPriceMinor: 80_000, taxBps: 0, status: 'active' },
    ],
    barcodes: [{ code: '8901234567890', productId: 'CAKE', kind: 'standard' }, { code: '123456', productId: 'MINCE', kind: 'weight_embedded' }],
    embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
  },
} as unknown as SignedPack);
const input = (over: Partial<ScreenInput> = {}): ScreenInput => ({
  pack: readPack({ version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1' } }, NOW),
  sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-10-23',
  workFeeds: { production }, cataloguePack: catalogue(), ...over,
});

describe('the counter label, rendered on the box (M11-FR-03 offline)', () => {
  it('prints a cafe run from head office\'s board with the catalogue\'s name and price, the run\'s batch and use-by, and its own barcode', () => {
    const l = counterLabelFor(input(), { runId: 'r-cake', netQuantity: '450 g', packerDetails: 'SRE Hyper Market, Tamil Nadu', allergens: ['cereals_gluten', 'eggs'], vegClass: 'non_veg' });
    expect(l).toMatchObject({ ok: true, batchId: 'CAKE-1', useBy: '2026-10-25T06:00:00.000Z', productName: 'Plum cake', priceMinor: 12_000, barcode: '8901234567890', from: 'head_office_board' });
    // B9 · B3 · B24: the mark and the eight-group allergens in words, the unit sale price, and the print sizes it was judged at.
    expect(l.ok && l.lines).toEqual(expect.arrayContaining(['[▲] NON-VEG', 'Plum cake', 'Batch CAKE-1', 'USE BY 2026-10-25 11:30' /* OB-607: 06:00 UTC on the shop's clock */, 'Contains: Cereals containing gluten, Eggs', 'INR 120.00', 'Unit price ₹266.67 per kg']));
    expect(l).toMatchObject({ vegClass: 'non_veg', unitPrice: { unitPriceMinor: 266_67, per: 'kg' }, print: { templateId: 'counter-58x40', minHeightMm: 1, letterHeightMm: 2 } });
  });

  it('OB-607: prints the USE BY on the shop\'s clock in the zone of the signed pack — offline, never the UTC clock of the run', () => {
    const inDubai = input({ pack: readPack({ version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1', timeZone: 'Asia/Dubai' } }, NOW) });
    const l = counterLabelFor(inDubai, { runId: 'r-cake', netQuantity: '450 g', packerDetails: 'SRE Hyper Market, Tamil Nadu', allergens: ['cereals_gluten', 'eggs'], vegClass: 'non_veg' });
    expect(l.ok && l.lines).toContain('USE BY 2026-10-25 10:00');
    expect(l).toMatchObject({ useBy: '2026-10-25T06:00:00.000Z' }); // what is kept is the instant, unchanged
  });

  it('prices a weighed pack at the price per kilo × its weight, with the weight in a barcode the till itself reads back', () => {
    const l = counterLabelFor(input(), { runId: 'r-meat', weightGrams: 450, packerDetails: 'SRE Hyper Market', allergens: [], vegClass: 'non_veg' });
    expect(l).toMatchObject({ ok: true, priceMinor: 36_000, barcode: expect.stringMatching(/^212345600450\d$/), unitPrice: { unitPriceMinor: 800_00, per: 'kg' } });
    expect(l.ok && l.lines).toContain('Allergens: none of the 8 major groups');
    // One definition, both directions: the till decodes the label's barcode to the same product and weight.
    const till = new CatalogueCache(catalogue().snapshot);
    const scan = till.scan((l as { barcode: string }).barcode);
    expect(scan).toMatchObject({ product: { productId: 'MINCE' }, barcodeKind: 'weight_embedded', quantityMinor: 450 });
  });

  it('labels a run captured on this box before head office has it, its use-by worked out from the recipe like head office does', () => {
    const captured = { runId: 'r-new', recipeId: 'rc-cake', outputBatchId: 'CAKE-9', actualOutputMinor: 4, producedBy: 'u-cook', at: '2026-10-23T07:30:00.000Z' };
    const l = counterLabelFor(input({ boxCapturedRuns: [captured] }), { runId: 'r-new', netQuantity: '1 piece', packerDetails: 'SRE', allergens: [], vegClass: 'veg' });
    expect(l).toMatchObject({ ok: true, batchId: 'CAKE-9', useBy: useByOf('2026-10-23T07:30:00.000Z', 48), from: 'captured_here' });
    expect(useByOf('2026-10-23T07:30:00.000Z', 48)).toBe('2026-10-25T07:30:00.000Z');
  });

  it('refuses by name — nothing printed — what it cannot vouch for', () => {
    const codeOf = (r: ReturnType<typeof counterLabelFor>): string => (r.ok ? 'printed' : r.refusedBecause);
    expect(codeOf(counterLabelFor(input({ workFeeds: {} }), { runId: 'r-cake' }))).toBe('production_not_known_here');
    expect(codeOf(counterLabelFor(input(), { runId: 'ghost' }))).toBe('run_not_known_here');
    expect(codeOf(counterLabelFor(input({ boxCapturedRuns: [{ runId: 'r-x', recipeId: 'rc-ghost', outputBatchId: 'X', actualOutputMinor: 1, producedBy: 'u', at: NOW }] }), { runId: 'r-x' }))).toBe('recipe_not_known_here');
    expect(codeOf(counterLabelFor(input({ workFeeds: { production: feedOf('production', { ...production.feed.body, enabledDepartments: ['cafe'] }) } }), { runId: 'r-meat', weightGrams: 10 }))).toBe('department_not_operated');
    const noCatalogue = input();
    delete (noCatalogue as { cataloguePack?: unknown }).cataloguePack;
    expect(codeOf(counterLabelFor(noCatalogue, { runId: 'r-cake', netQuantity: '1', packerDetails: 'SRE', allergens: [] }))).toBe('product_not_on_the_pack');
    expect(codeOf(counterLabelFor(input(), { runId: 'r-meat', packerDetails: 'SRE', allergens: [] }))).toBe('weight_needed');
    // A cafe label without its allergen declaration, or without its packer, is unlawful (Legal Metrology / FSSAI).
    expect(codeOf(counterLabelFor(input(), { runId: 'r-cake', netQuantity: '1 piece', packerDetails: 'SRE', vegClass: 'veg' }))).toBe('incomplete_label');
    expect(codeOf(counterLabelFor(input(), { runId: 'r-cake', netQuantity: '1 piece', allergens: [], vegClass: 'veg' }))).toBe('incomplete_label');
    // B9: no veg / non-veg mark, or a word that is not one of the eight groups — refused, nothing printed.
    const noMark = counterLabelFor(input(), { runId: 'r-cake', netQuantity: '1 piece', packerDetails: 'SRE', allergens: [] });
    expect(noMark).toMatchObject({ ok: false, refusedBecause: 'incomplete_label', detail: expect.stringContaining('veg or non-veg mark') });
    const freeText = counterLabelFor(input(), { runId: 'r-cake', netQuantity: '1 piece', packerDetails: 'SRE', allergens: ['wheat'], vegClass: 'veg' });
    expect(freeText).toMatchObject({ ok: false, refusedBecause: 'incomplete_label', detail: expect.stringContaining('"wheat"') });
    // B3: a net quantity the price per unit cannot be worked out from is refused, never printed without it.
    expect(counterLabelFor(input(), { runId: 'r-cake', netQuantity: 'one slab', packerDetails: 'SRE', allergens: [], vegClass: 'veg' })).toMatchObject({ ok: false, detail: expect.stringContaining('price per unit') });
    // B24: a printer template whose numerals are below the panel's minimum height fails — nothing printed.
    const tiny = counterLabelFor(input(), { runId: 'r-cake', netQuantity: '1 piece', packerDetails: 'SRE', allergens: [], vegClass: 'veg', template: { templateId: 'tiny', principalPanelAreaCm2: 150, letterHeightMm: 2, numeralHeightMm: 1.5 } });
    expect(tiny).toMatchObject({ ok: false, refusedBecause: 'label_print_too_small', detail: expect.stringContaining('below the 2 mm minimum') });
    // Food past its use-by is never labelled.
    expect(codeOf(counterLabelFor(input(), { runId: 'r-old', netQuantity: '1 piece', packerDetails: 'SRE', allergens: [], vegClass: 'veg' }))).toBe('already_expired');
    // A weighed pack with no barcode rule on the catalogue could not be scanned at the till.
    const noRule = catalogue();
    (noRule.snapshot as { embeddedRules?: unknown }).embeddedRules = [];
    expect(codeOf(counterLabelFor(input({ cataloguePack: noRule }), { runId: 'r-meat', weightGrams: 450, packerDetails: 'SRE', allergens: [], vegClass: 'non_veg' }))).toBe('no_scale_barcode_rule');
  });

  it('reads the counter\'s request strictly', () => {
    expect(readCounterLabelRequest({ runId: 'r-1', weightGrams: 450, allergens: ['milk'], vegClass: 'veg' })).toEqual({ runId: 'r-1', weightGrams: 450, allergens: ['milk'], vegClass: 'veg' });
    for (const bad of [null, {}, { runId: '' }, { runId: 'r', weightGrams: 0 }, { runId: 'r', weightGrams: 1.5 }, { runId: 'r', allergens: 'milk' }, { runId: 'r', priceMinor: 1, netQuantity: 4 }, { runId: 'r', vegClass: 'egg' }, { runId: 'r', template: { templateId: 't', principalPanelAreaCm2: 0, letterHeightMm: 2, numeralHeightMm: 2 } }]) {
      expect(readCounterLabelRequest(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('what each screen is told — head office\'s last word, how old, and never "nothing" for "not told"', () => {
  it('the production board, the food-safety checks and the transfers say how old they are; absent is null, not empty', () => {
    expect(productionWork(input())).toMatchObject({ board: { asAt: '2026-10-23T07:00:00.000Z', ageMinutes: 60, enabledDepartments: ['cafe', 'meat_fish'] }, capturedHere: [] });
    expect(productionWork(input({ workFeeds: {} }))).toEqual({ board: null, capturedHere: [] });
    expect(foodSafetyWork(input())).toEqual({ foodSafety: null });
    expect(transferWork(input())).toEqual({ transfers: null });
  });

  it('a handheld is offered only THIS store\'s end of a transfer: send what leaves it, count in what is on the road to it', () => {
    const row = (transferId: string, state: string, fromStoreId: string, toStoreId: string) => ({ transfer: { transferId, state, fromLocationId: `${fromStoreId}-BACK`, toLocationId: toStoreId, lines: [{ productId: 'RICE', batchId: null, quantityMinor: 10, uom: 'EA' }] }, fromStoreId, toStoreId });
    const transfers = feedOf('transfers', { transfers: [row('t-out', 'proposed', 'S1', 'S2'), row('t-in', 'in_transit', 'S2', 'S1'), row('t-theirs', 'proposed', 'S2', 'S1'), row('t-gone', 'in_transit', 'S1', 'S2'), row('t-done', 'received', 'S2', 'S1')] });
    const work = transferWork(input({ workFeeds: { transfers } })) as { transfers: { toSend: { transferId: string }[]; toCountIn: { transferId: string; lines: unknown[] }[]; storeId: string } };
    expect(work.transfers.storeId).toBe('S1');
    expect(work.transfers.toSend.map((t) => t.transferId)).toEqual(['t-out']);
    expect(work.transfers.toCountIn.map((t) => t.transferId)).toEqual(['t-in']);
    expect(work.transfers.toCountIn[0]?.lines).toEqual([{ productId: 'RICE', batchId: null, quantityMinor: 10, uom: 'EA' }]);
  });
});

describe('the work feeds the box pulls (§31 · P-08)', () => {
  it('read head office\'s answers strictly, and read back what was held', () => {
    const runs = { asAt: NOW, runs: production.feed.body['runs'] };
    const recipes = { recipes: production.feed.body['recipes'], enabledDepartments: ['cafe'] };
    const f = readProductionFeed(runs, recipes)!;
    expect(f).toMatchObject({ name: 'production', asAt: NOW });
    expect(readWorkFeed(f)).toEqual(f);
    expect(readProductionFeed(runs, { recipes: [{ recipeId: 'x' }], enabledDepartments: [] })).toBeUndefined();
    expect(readProductionFeed({ runs: [] }, recipes)).toBeUndefined();
    expect(readFoodSafetyFeed({ slots: [], checks: [{ checkId: 'c', kind: 'temperature', branchId: 'S1', items: [] }] }, NOW)).toMatchObject({ name: 'food-safety', asAt: NOW });
    expect(readFoodSafetyFeed({ slots: [{ checkId: 'c' }], checks: [] }, NOW)).toBeUndefined();
    expect(readTransfersFeed({ asAt: NOW, transfers: [{ transfer: { transferId: 't', state: 'proposed', fromLocationId: 'a', toLocationId: 'b', lines: [] } }] })).toMatchObject({ name: 'transfers' });
    expect(readTransfersFeed({ asAt: NOW, transfers: [{ transfer: { transferId: 't' } }] })).toBeUndefined();
    expect(readWorkFeed({ name: 'other', asAt: NOW, body: {} })).toBeUndefined();
  });

  it('keep what is held when head office is unreachable or answers with something older; take a newer one', async () => {
    let held: WorkFeed | undefined;
    const take = (f: WorkFeed): void => { held = f; };
    const source = (r: Awaited<ReturnType<WorkFeedSource['fetch']>>): WorkFeedSource => ({ name: 'transfers', fetch: async () => r });
    const newer: WorkFeed = { name: 'transfers', asAt: '2026-10-23T07:00:00.000Z', body: { transfers: [] } };
    expect((await pullWorkFeed({ source: source({ status: 'unreachable', reason: 'down' }), held: () => held, take, now: NOW })).status).toBe('offline');
    expect((await pullWorkFeed({ source: source({ status: 'fetched', feed: newer }), held: () => held, take, now: NOW })).status).toBe('updated');
    expect((await pullWorkFeed({ source: source({ status: 'fetched', feed: newer }), held: () => held, take, now: NOW })).status).toBe('unchanged');
    const older: WorkFeed = { ...newer, asAt: '2026-10-23T06:00:00.000Z', body: { transfers: [{ x: 1 }] } };
    const kept = await pullWorkFeed({ source: source({ status: 'fetched', feed: older }), held: () => held, take, now: NOW });
    expect([kept.status, kept.ageMinutes]).toEqual(['kept', 60]);
    expect(held).toEqual(newer);
  });
});
