import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { onHandByProduct, openCatalogueStock } from '../../apps/web-erp/src/catalogue-stock';
import { replacedBy, type RelabelTask } from '../../services/pricing/src/relabel-tasks';
import { relabelItemWords, relabelWords } from '../../apps/web-erp/src/relabel-session';
import { STORE_PULL_BASE_MS, STORE_PULL_MAX_MS, storePullMaxMinutes } from '../../packages/sync/src/pull-timing';
import { nextInterval } from '../../edge/store-edge/src/main';
import { cataloguePayload, tillPricesOf, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { readPack } from '../../edge/store-edge/src/store-pack';

/**
 * Fix batch 4b (OB-800 THE PLAN) — the pure parts behind D-018, D-026 and D-054. Each screen is proved in a real browser
 * too (tests/e2e/fix-batch4b-…); these pin the rules.
 */

describe('D-018: how many we have, read once from head office for the Products list', () => {
  it('sums every place of an item and skips a row that is not readable — never a guessed 0', () => {
    const sums = onHandByProduct([
      { productId: 'OIL', onHandMinor: 4 }, { productId: 'OIL', onHandMinor: 6 }, { productId: 'RICE', onHandMinor: 2_500 },
      { productId: '', onHandMinor: 9 }, { productId: 'BAD', onHandMinor: 1.5 }, { productId: 'NONE' },
    ]);
    expect([...sums.entries()]).toEqual([['OIL', 10], ['RICE', 2_500]]);
    expect(sums.has('BAD')).toBe(false);
  });

  it('reads head office once, keeps the figures and when they were projected', async () => {
    const asked: string[] = [];
    const fetchFn = (async (url: string) => { asked.push(url); return new Response(JSON.stringify({ rows: [{ productId: 'OIL', locationId: 'S1', onHandMinor: 12 }], asAt: '2026-11-16T05:00:00.000Z' }), { status: 200 }); }) as unknown as typeof fetch;
    const stock = openCatalogueStock(fetchFn);
    expect(stock.state()).toBe('not_loaded');
    expect(await stock.load()).toBe('loaded');
    await stock.load();
    expect(asked).toEqual(['/v1/inventory/availability']);
    expect([stock.onHand('OIL'), stock.onHand('MILK'), stock.asAt()]).toEqual([12, undefined, '2026-11-16T05:00:00.000Z']);
  });

  it('a refusal says head office\'s own words; a lost link says so; neither shows figures', async () => {
    const refused = openCatalogueStock((async () => new Response(JSON.stringify({ error: { code: 'forbidden', whatHappened: 'Your role may not read stock.' } }), { status: 403 })) as unknown as typeof fetch);
    expect(await refused.load()).toBe('refused');
    expect([refused.why(), refused.onHand('OIL')]).toEqual(['Your role may not read stock.', undefined]);
    const lost = openCatalogueStock((async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(await lost.load()).toBe('lost_link');
    expect(lost.why()).toMatch(/cannot be reached/);
  });
});

describe('D-018: the store computer tells the Products page the price each item is charged at the tills', () => {
  const at = '2026-11-16T09:00:00.000Z';
  const masterOf = (productId: string) => ({ productId, tenantId: 't', sku: productId, name: productId, primaryCategoryId: null, baseUom: 'ea', taxClass: '0401', lifecycle: 'active' });
  const pack = readPack({
    version: 1, lossPreventionRules: [],
    policies: { tradingDayCutoff: '00:00', storeId: 'S1', branchId: 'S1' },
    pricingPolicy: { userId: 'u-mgr', approvers: ['u-owner'], marginFloorBps: 2_000 },
    products: [{ productId: 'OIL', name: 'Oil', categoryId: 'g', unitPriceMinor: 16_500, uom: 'ea', taxBps: 500, status: 'active', recallBlock: false, barcodes: ['890OIL'], availableMinor: 1 }],
    productMaster: [masterOf('OIL'), masterOf('MILK')],
  }, at);
  const input = { pack, now: at, tradingDay: '2026-11-16' } as unknown as ScreenInput;

  it('each item on the tills with its price, stamped with when the store computer got the catalogue', () => {
    const till = tillPricesOf(input);
    expect(till?.byProduct).toEqual({ OIL: 16_500 });
    expect(typeof till?.asAt).toBe('string');
    expect(cataloguePayload(input)!['tillPrices']).toEqual(till);
  });
});

describe('D-026: a label task names its item, and one a newer price replaced is not left open', () => {
  const task = (over: Partial<RelabelTask>): RelabelTask => ({
    taskId: 't', branchId: 'S1', productId: 'BISC', locationId: 'A1', priceMinor: 3_000, dueAt: '2026-11-10T00:00:00.000Z',
    because: 'price_change', sourceRef: 'r', raisedAt: '2026-11-10T00:00:00.000Z', ...over,
  });
  const old30 = task({ taskId: 'old-30' });
  const new32 = task({ taskId: 'new-32', priceMinor: 3_200, dueAt: '2026-11-15T00:00:00.000Z', raisedAt: '2026-11-15T00:00:00.000Z' });
  const later35 = task({ taskId: 'later-35', priceMinor: 3_500, dueAt: '2026-12-01T00:00:00.000Z', raisedAt: '2026-11-15T01:00:00.000Z' });
  const otherStore = task({ taskId: 'other', branchId: 'S2', priceMinor: 3_200, dueAt: '2026-11-15T00:00:00.000Z' });
  const now = '2026-11-16T00:00:00.000Z';

  it('a newer price in force for the same item at the same store replaces the older task', () => {
    expect(replacedBy(old30, [old30, new32, later35, otherStore], now)?.taskId).toBe('new-32');
  });
  it('a price not yet in force replaces nothing; nor does another store\'s; the newest is never replaced', () => {
    expect(replacedBy(new32, [old30, new32, later35], now)).toBeUndefined();
    expect(replacedBy(old30, [old30, otherStore], now)).toBeUndefined();
    expect(replacedBy(old30, [old30, later35], now)).toBeUndefined();
    expect(replacedBy(old30, [old30, new32, later35], '2026-12-02T00:00:00.000Z')?.taskId).toBe('later-35');
  });
  it('a price set later from the start of today replaces one set earlier today (the later decision is the price); the same figure replaces nothing', () => {
    const changeAt18 = task({ taskId: 'change-18', priceMinor: 1_800, dueAt: '2026-11-16T04:00:00.000Z', raisedAt: '2026-11-16T04:00:00.000Z' });
    const entryAt17 = task({ taskId: 'entry-17', priceMinor: 1_700, dueAt: '2026-11-15T18:30:00.000Z', raisedAt: '2026-11-16T05:00:00.000Z', because: 'price_list_entry' });
    expect(replacedBy(changeAt18, [changeAt18, entryAt17], '2026-11-16T06:00:00.000Z')?.taskId).toBe('entry-17');
    expect(replacedBy(entryAt17, [changeAt18, entryAt17], '2026-11-16T06:00:00.000Z')).toBeUndefined();
    const again18 = task({ taskId: 'again-18', priceMinor: 1_800, dueAt: '2026-11-16T05:00:00.000Z', raisedAt: '2026-11-16T05:00:00.000Z' });
    expect(replacedBy(changeAt18, [changeAt18, again18], '2026-11-16T06:00:00.000Z')).toBeUndefined();
  });
  it('the item by its name; its code only when head office holds no name', () => {
    expect(relabelItemWords('en', { productId: 'BISC', productName: 'Marie biscuits 200 g' })).toBe('Marie biscuits 200 g');
    expect(relabelItemWords('en', { productId: 'BISC' })).toBe('Product BISC');
    expect(relabelItemWords('ta', { productId: 'BISC', productName: '  ' })).toBe('பொருள் BISC');
    for (const k of ['replaced', 'replacedNoLabel']) expect(relabelWords('ta', k)).not.toBe(relabelWords('en', k));
  });
});

describe('D-054: how soon the tills take a pack just sent — the store computer\'s own timing, said in one place', () => {
  it('the store computer\'s loop runs on the shared figures, and the page says the ceiling in minutes', () => {
    expect([STORE_PULL_BASE_MS, STORE_PULL_MAX_MS, storePullMaxMinutes()]).toEqual([15_000, 300_000, 5]);
    expect(nextInterval(0)).toBe(STORE_PULL_BASE_MS);
    expect(nextInterval(50)).toBe(STORE_PULL_MAX_MS);
    const main = readFileSync('edge/store-edge/src/main.ts', 'utf8');
    expect(main).toMatch(/const BASE_INTERVAL_MS = STORE_PULL_BASE_MS;/);
    expect(main).toMatch(/const MAX_INTERVAL_MS = STORE_PULL_MAX_MS;/);
    const page = readFileSync('apps/web-erp/web/price-lists.js', 'utf8');
    expect(page).not.toMatch(/on its next pull/);
    expect(page).toMatch(/m: window\.sreStorePull\?\.maxMinutes/);
  });
});
