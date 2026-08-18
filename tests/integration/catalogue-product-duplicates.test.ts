import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M03-FR-04: the product duplicate-DETECTION review list on the live API. Duplicate products rot a
// catalogue — the same item entered twice splits the stock, orders both and reports two half-truths. This
// returns suspected duplicate pairs with their signal, confidence and evidence; a shared barcode is
// near-certain, everything else is a labelled suspicion. It DETECTS, never merges (the merge is a separate
// §28-gated write path). Stateless: the caller supplies the records to compare.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const check = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/catalogue/products/duplicates', userId, tenantId: A, idempotencyKey: key, body });

interface Pair { productIds: [string, string]; signal: string; confidence: string; evidence: string }
interface Report { pairs: Pair[]; pairCount: number; nearCertainCount: number; likelyCount: number; possibleCount: number }

describe('product duplicate detection (M03-FR-04)', () => {
  it('flags a shared barcode as near-certain and same name+brand+pack as likely, with evidence', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const products = [
      { productId: 'p1', name: 'Aashirvaad Atta 5kg', brand: 'Aashirvaad', barcodes: ['8901030'], packSize: '5 kg' },
      { productId: 'p2', name: 'AASHIRVAAD ATTA 5 KG', brand: 'Aashirvaad', barcodes: ['8901030'], packSize: '5KG' }, // shared barcode
      { productId: 'p3', name: 'Tata Salt 1kg', brand: 'Tata', barcodes: ['8902000'], packSize: '1 kg' },
      { productId: 'p4', name: 'Tata Salt 1 kg', brand: 'Tata', packSize: '1kg' }, // same name+brand+pack, no barcode
    ];
    const body = (await check(h, 'u-owner', { products }, 'dup-1')).body as Report;
    const byIds = (a: string, b: string) => body.pairs.find((p) => p.productIds.includes(a) && p.productIds.includes(b));
    expect(byIds('p1', 'p2')).toMatchObject({ signal: 'shared_barcode', confidence: 'near_certain' });
    expect(byIds('p1', 'p2')!.evidence).toContain('8901030');
    expect(byIds('p3', 'p4')).toMatchObject({ signal: 'same_name_and_brand', confidence: 'likely' });
    expect(body.nearCertainCount).toBe(1);
    expect(body.likelyCount).toBe(1);
  });

  it('returns an empty review list when nothing collides — and never merges anything', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const products = [
      { productId: 'p1', name: 'Aashirvaad Atta 5kg', brand: 'Aashirvaad', barcodes: ['8901030'] },
      { productId: 'p2', name: 'Tata Salt 1kg', brand: 'Tata', barcodes: ['8902000'] },
    ];
    const body = (await check(h, 'u-owner', { products }, 'dup-empty')).body as Report;
    expect(body.pairs).toEqual([]);
    expect(body.pairCount).toBe(0);
  });

  it('refuses a malformed request and gates on catalogue.pack.read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // an accountant does NOT hold catalogue.pack.read
    // Missing products[].
    expect((await check(h, 'u-owner', { similarityThresholdBp: 7500 }, 'dup-nobody')).status).toBe(400);
    // A candidate with no name.
    const bad = await check(h, 'u-owner', { products: [{ productId: 'p1' }] }, 'dup-noname');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_duplicate_check');
    // A non-positive threshold.
    expect((await check(h, 'u-owner', { products: [{ productId: 'p1', name: 'X' }], similarityThresholdBp: 0 }, 'dup-thr')).status).toBe(400);
    // RBAC: the accountant is refused.
    expect((await check(h, 'u-acct', { products: [{ productId: 'p1', name: 'X' }] }, 'dup-rbac')).status).toBe(403);
  });
});
