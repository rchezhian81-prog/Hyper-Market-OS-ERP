import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';

/**
 * W3 (D01-FR-05 · B16 · OB-140 "A" · P-08): head office's tobacco standing is judged against the warning-picture register it
 * holds NOW. A tobacco product never confirmed carries no copy of the register on its own record, so it used to read "no
 * warning picture on record" even after the owner had recorded one — the wrong reason on the Product details page. It must
 * read "never confirmed", and once a named person confirms its packs, "confirmed".
 */

const TOBACCO = { categoryId: 'tobacco', name: 'Tobacco', parentId: null, regulated: ['age_restricted'] };
const CIGARETTES = { sku: 'CIG10', name: 'Cigarettes 10s (demo)', baseUom: 'ea', primaryCategoryId: 'tobacco', taxClass: '24022010', lifecycle: 'draft', safety: { minimumAge: 18, tobacco: true, packMinimumMinor: 1 } };

describe('a tobacco product never confirmed says so once a picture is on record (D01-FR-05)', () => {
  it('no picture → "no_picture_notified"; picture recorded → "never_confirmed"; confirmed → sellable', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-meena', 'store_manager');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner') =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    expect((await req('POST', '/v1/catalogue/tax-classes/24022010/rates/2017-07-01', { rateBps: 2_800 })).status).toBeLessThan(300);
    expect((await req('POST', '/v1/catalogue/products/p-cig/publish', { product: CIGARETTES, categories: [TOBACCO] })).status).toBeLessThan(300);
    const standing = async () => ((await req('GET', '/v1/catalogue/tobacco-warning')).body as { products: { productId: string; sellable: boolean; standing: string }[] }).products[0];

    expect(await standing()).toMatchObject({ productId: 'p-cig', sellable: false, standing: 'no_picture_notified' });
    expect((await req('POST', '/v1/catalogue/tobacco-warning-pictures/P-2020', { effectiveFrom: '2020-01-01', notifiedOn: '2019-10-01', reference: 'G.S.R. 2019 (demo)', evidenceRef: 'DOC-gsr-2019' })).status).toBe(201);
    expect(await standing()).toMatchObject({ productId: 'p-cig', sellable: false, standing: 'never_confirmed' });
    expect((await req('POST', '/v1/catalogue/products/p-cig/tobacco-warning-confirmation', { imageId: 'P-2020', evidenceRef: 'PHOTO-pack-front' }, 'u-meena')).status).toBe(201);
    expect(await standing()).toMatchObject({ productId: 'p-cig', sellable: true, standing: 'confirmed' });
  });
});
