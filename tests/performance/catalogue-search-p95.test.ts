import { describe, it, expect, beforeAll } from 'vitest';
import { makeEvent } from '../../packages/contracts/src/event';
import { searchCatalogue, type StorefrontProduct } from '../../packages/storefront/src/browse';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { TARGETS, againstBudget, type Sample } from './harness';

/**
 * §32 "Catalogue search — p95 ≤1 s at audited catalogue scale — load test" (NFR-02 · QG-05; OB-288 gates lane).
 *
 * The audited SKU count is a Stage-1 store fact (AVR-04) that is not measured yet, so this runs at the stand-in scale
 * the audit names: **50,000 synthetic SKUs**. Two searches are measured, because the shop has two:
 *
 *   1. head office's product master read, `GET /v1/catalogue/products`, through the REAL authenticated API surface
 *      (token check, tenant access, the adapter fold) — the read the catalogue screen searches;
 *   2. the customer app's search (`searchCatalogue`): barcode, exact name, prefix, Tamil name, a customer's synonym,
 *      a one-letter typo and a word that matches nothing (the slowest: every product is tried, fuzzily).
 *
 * Each is asserted against the §32 budget itself — p95 ≤ 1,000 ms — on this machine. That proves the code does not
 * blow the budget at this scale; it does NOT certify the target: §32 says "audited catalogue scale", and the customer
 * search runs on the customer's phone, which is slower than CI (the harness's `certifiedHardwareGate` names both).
 */

const N = 50_000;
const TENANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER = 'u-owner';
const WORDS = ['rice', 'atta', 'dal', 'oil', 'sugar', 'salt', 'tea', 'coffee', 'milk', 'curd', 'ghee', 'soap', 'paste', 'biscuit', 'noodles', 'masala', 'chilli', 'turmeric', 'jaggery', 'rava'];
const BRANDS = ['Aachi', 'Sakthi', 'Annapoorna', 'Cauvery', 'Nilgiris', 'Kaveri', 'Thanjai', 'Madurai', 'Kovai', 'Salem'];
const TA = ['அரிசி', 'ஆட்டா', 'பருப்பு', 'எண்ணெய்', 'சர்க்கரை', 'உப்பு', 'தேநீர்', 'காபி', 'பால்', 'தயிர்'];
const nameOf = (i: number): string => `${BRANDS[i % BRANDS.length]} ${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${i}g`;
const barcodeOf = (i: number): string => `890${String(i).padStart(10, '0')}`;

const report = (s: Sample): string => `${s.label}: p50 ${s.p50Ms.toFixed(1)} ms · p95 ${s.p95Ms.toFixed(1)} ms · max ${s.maxMs.toFixed(1)} ms over ${s.runs} runs`;

/** Time an async operation `runs` times after a warm-up; percentiles as the harness computes them. */
async function measureAsync(label: string, runs: number, op: (i: number) => Promise<void>, warmup = 3): Promise<Sample> {
  for (let i = 0; i < warmup; i += 1) await op(i);
  const t: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = process.hrtime.bigint();
    await op(i);
    t.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const sorted = [...t].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))]!;
  return { label, runs, p50Ms: at(50), p95Ms: at(95), p99Ms: at(99), maxMs: at(100), meanMs: t.reduce((a, b) => a + b, 0) / t.length };
}

describe(`catalogue search at ${N.toLocaleString('en-IN')} synthetic SKUs — p95 ≤ ${TARGETS.catalogueSearchMs} ms (§32)`, () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(TENANT, OWNER);
    // One product published through the real route gives the stored record's exact shape …
    const first = await h.request({
      method: 'POST', path: '/v1/catalogue/products/P-0/publish', userId: OWNER, tenantId: TENANT, idempotencyKey: 'pub-0',
      body: { product: { sku: 'SKU-0', name: nameOf(0), baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '0401', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] },
    });
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    const stream = streamName(STREAM.catalogue, 'products');
    const [stored] = await h.store.readStream(TENANT, stream, { type: 'ProductPublished' });
    const shape = stored!.event.payload as Record<string, unknown>;
    // … and the other 49,999 are that record with their own id, SKU and name, appended as the route appends them.
    for (let i = 1; i < N; i += 1) {
      await h.store.append(TENANT, stream, makeEvent({
        id: `product-P-${i}-seed`, type: 'ProductPublished', occurredAt: '2026-10-01T06:00:00.000Z',
        idempotencyKey: `product-${TENANT}-P-${i}-seed`, source: 'test/perf',
        payload: { ...shape, productId: `P-${i}`, sku: `SKU-${i}`, name: nameOf(i) },
      }));
    }
  }, 600_000);

  it('head office\'s product master read, through the real API, at 50,000 SKUs', async () => {
    const res = await h.request({ method: 'GET', path: '/v1/catalogue/products', userId: OWNER, tenantId: TENANT });
    expect(res.status).toBe(200);
    expect((res.body as { count: number }).count).toBe(N); // the whole catalogue, not a page of it
    const sample = await measureAsync('GET /v1/catalogue/products @50k', 20, async () => {
      const r = await h.request({ method: 'GET', path: '/v1/catalogue/products', userId: OWNER, tenantId: TENANT });
      if (r.status !== 200) throw new Error(`refused: ${r.status}`);
      // What a browser receives is the JSON text — serialising 50,000 products is part of the cost.
      JSON.stringify(r.body);
    });
    console.log(report(sample));
    const budget = againstBudget({ label: sample.label, targetMs: TARGETS.catalogueSearchMs, sample, headroom: 1 });
    expect(budget.certifiesTheTarget).toBe(false);
    expect(sample.p95Ms, budget.detail).toBeLessThanOrEqual(TARGETS.catalogueSearchMs);
  }, 300_000);

  it('the customer app\'s search — barcode, exact, prefix, Tamil, synonym, typo and a miss — at 50,000 SKUs', () => {
    const products: StorefrontProduct[] = Array.from({ length: N }, (_, i) => ({
      productId: `P-${i}`, name: nameOf(i), nameTa: `${TA[i % TA.length]} ${i}`, brand: BRANDS[i % BRANDS.length]!, categoryId: 'grocery',
      unitPriceMinor: 1_000 + (i % 5_000), uom: 'each', barcodes: [barcodeOf(i)], status: i % 50 === 0 ? 'discontinued' : 'active',
      availableMinor: i % 7, availabilityAgeMinutes: 5, synonyms: i % 3 === 0 ? ['kitchen staple', `pantry ${WORDS[i % WORDS.length]}`] : [],
    }));
    const queries = [
      barcodeOf(31_337), // barcode — found first, by exact code
      nameOf(12_345).toLowerCase(), // the exact name
      'aachi ri', // a prefix of two words
      'அரிசி', // the Tamil name
      'pantry jaggery', // a customer's synonym
      'turmerc', // a typo (one letter missing)
      'zzqx', // nothing matches — every product is tried, fuzzily: the worst case
    ];
    // Each query found what it should (a fast search that finds nothing is not a search).
    expect(searchCatalogue({ query: queries[0]!, products })[0]?.match).toBe('barcode');
    expect(searchCatalogue({ query: queries[1]!, products })[0]?.product.productId).toBe('P-12345');
    expect(searchCatalogue({ query: queries[2]!, products }).length).toBeGreaterThan(0);
    expect(searchCatalogue({ query: queries[3]!, products }).length).toBeGreaterThan(0);
    expect(searchCatalogue({ query: queries[4]!, products }).length).toBeGreaterThan(0);
    expect(searchCatalogue({ query: queries[5]!, products }).some((x) => x.match === 'fuzzy')).toBe(true);
    expect(searchCatalogue({ query: queries[6]!, products })).toEqual([]);

    for (const [k, query] of queries.entries()) {
      const timings: number[] = [];
      for (let i = 0; i < 3; i += 1) searchCatalogue({ query, products }); // warm-up
      for (let i = 0; i < 15; i += 1) {
        const started = process.hrtime.bigint();
        searchCatalogue({ query, products });
        timings.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      const sorted = timings.sort((a, b) => a - b);
      const sample: Sample = {
        label: `customer search #${k + 1} "${query.slice(0, 20)}" @50k`, runs: sorted.length,
        p50Ms: sorted[Math.floor(sorted.length / 2)]!, p95Ms: sorted[Math.ceil(0.95 * sorted.length) - 1]!, p99Ms: sorted.at(-1)!, maxMs: sorted.at(-1)!,
        meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      };
      console.log(report(sample));
      expect(sample.p95Ms, `${sample.label} — over the §32 1-second budget`).toBeLessThanOrEqual(TARGETS.catalogueSearchMs);
    }
  }, 300_000);
});
