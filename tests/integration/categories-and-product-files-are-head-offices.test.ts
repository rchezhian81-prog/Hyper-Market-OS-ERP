import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedRequestId } from '../support/approval-request';

/**
 * **SF-06-b — head office keeps its own category list, every product is judged against it, and a product file loads real
 * products (Wave 4 · OB-24 "A" · OB-23 "C" · M03-FR-01/03 · M30-FR-01/03/04 · §28 · hard rules #2 #10).**
 *
 * The audit reproduced it: a product file answered "committed, 1 row applied" and the product master held nothing; and
 * every product publish was judged against the categories the SENDER wrote, so "grocery" could be a food category on one
 * publish and not on the next. Real API, real permissions, head office's maker-checker engine:
 *   • the owner defines a category directly; a manager's proposal needs the owner's approval in the owner's own session;
 *     a parent must exist and a chain never loops; a change is a new version;
 *   • a publish that describes a held category differently is refused; one the list lacks is defined only by the owner,
 *     and the answer says so; a manager cannot slip a category in through a publish;
 *   • a product file is judged by the product engine against the list (allergens, origin, net quantity, SKU, category),
 *     loads real products in one save with the job, and is undone by discontinuing them — refused once one has a barcode.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const post = (h: ApiHarness, path: string, userId: string, body: unknown, key = `k-${Math.random()}`) => h.request({ method: 'POST', path, userId, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId = 'u-owner') => h.request({ method: 'GET', path, userId, tenantId: A });

const GROCERY = { name: 'Grocery', parentId: null };
const STAPLES = { name: 'Staples', parentId: 'grocery', regulated: ['food', 'packed'] };
const HOME = { name: 'Home care', parentId: null };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                    // defines categories; publishes products
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // proposes categories; imports; approves another person's import
  await h.provisionRole(A, 'u-cash', 'cashier');      // neither
  return h;
}
const categories = async (h: ApiHarness) => ((await get(h, '/v1/catalogue/categories')).body as { categories: { categoryId: string; approvedBy: string; version: number; regulated?: string[] }[] }).categories;

describe('SF-06-b — head office\'s own category list', () => {
  it('the owner defines directly; a manager proposes and the OWNER approves in their own session; a cashier cannot', async () => {
    const h = await cast();
    expect((await post(h, '/v1/catalogue/categories/grocery', 'u-owner', GROCERY)).status).toBe(201);
    // A manager without approval: refused, nothing saved.
    expect(codeOf(await post(h, '/v1/catalogue/categories/home', 'u-mgr', HOME))).toBe('no_approval');
    // With the owner's approval of exactly this definition: saved, the owner named as the approver.
    const approvalId = await approvedRequestId(h, A, 'u-mgr', 'u-owner', { kind: 'category_define', subjectRef: 'home', details: { categoryId: 'home', ...HOME } });
    expect((await post(h, '/v1/catalogue/categories/home', 'u-mgr', { ...HOME, approvalId })).status).toBe(201);
    // A manager cannot approve their own (nor another manager's) — only the owner holds the approval.
    await expect(approvedRequestId(h, A, 'u-mgr', 'u-mgr', { kind: 'category_define', subjectRef: 'x', details: { categoryId: 'x', name: 'X', parentId: null } })).rejects.toThrow();
    expect((await post(h, '/v1/catalogue/categories/x', 'u-cash', { name: 'X', parentId: null })).status).toBe(403);
    expect((await categories(h)).map((c) => [c.categoryId, c.approvedBy])).toEqual([['grocery', 'u-owner'], ['home', 'u-owner']]);
  });

  it('a parent must exist and a chain never loops; a change is a new version, the same definition again changes nothing', async () => {
    const h = await cast();
    expect(codeOf(await post(h, '/v1/catalogue/categories/staples', 'u-owner', STAPLES))).toBe('category_structure_invalid');
    expect((await post(h, '/v1/catalogue/categories/grocery', 'u-owner', GROCERY)).status).toBe(201);
    expect((await post(h, '/v1/catalogue/categories/staples', 'u-owner', STAPLES)).status).toBe(201);
    expect(codeOf(await post(h, '/v1/catalogue/categories/grocery', 'u-owner', { name: 'Grocery', parentId: 'staples' }))).toBe('category_structure_invalid');
    expect((await post(h, '/v1/catalogue/categories/staples', 'u-owner', STAPLES)).body).toMatchObject({ changed: false });
    expect((await post(h, '/v1/catalogue/categories/staples', 'u-owner', { ...STAPLES, name: 'Staples & grains' })).body).toMatchObject({ changed: true, category: { version: 2 } });
    expect(codeOf(await post(h, '/v1/catalogue/categories/bad', 'u-owner', { name: 'Bad', parentId: null, regulated: ['fireworks'] }))).toBe('not_readable_as_a_category');
  });

  it('every product publish is judged against the list: a category described differently is refused; a missing one is defined only by the owner, and said', async () => {
    const h = await cast();
    await post(h, '/v1/catalogue/categories/grocery', 'u-owner', GROCERY);
    await post(h, '/v1/catalogue/categories/staples', 'u-owner', STAPLES);
    const rice = { sku: 'RICE5', name: 'Rice 5kg', baseUom: 'each', primaryCategoryId: 'staples', taxClass: '1006', lifecycle: 'draft' };
    // THE OLD HOLE: the sender says staples is not regulated — the food rules would not have run. Refused now.
    const lying = await post(h, '/v1/catalogue/products/p-rice/publish', 'u-owner', { product: rice, categories: [{ categoryId: 'staples', name: 'Staples', parentId: 'grocery' }, { categoryId: 'grocery', ...GROCERY }] });
    expect(codeOf(lying)).toBe('category_differs_from_head_office');
    // No categories sent: the list is read — and the food rules apply (no allergens, no origin, no net quantity → refused).
    const bare = await post(h, '/v1/catalogue/products/p-rice/publish', 'u-owner', { product: rice });
    expect(codeOf(bare)).toBe('product_not_publishable');
    expect(JSON.stringify(bare.body)).toMatch(/allergen/);
    const full = { ...rice, safety: { allergens: [], countryOfOrigin: 'India', netQuantity: '5 kg', packerDetails: 'Synthetic Mills, Madurai' } };
    expect((await post(h, '/v1/catalogue/products/p-rice/publish', 'u-owner', { product: full })).status).toBe(201);
    // A category the list lacks, sent by the owner: defined by that publish, and the answer says so.
    const soap = { sku: 'SOAP', name: 'Soap', baseUom: 'each', primaryCategoryId: 'home', taxClass: '3401', lifecycle: 'draft' };
    const defined = await post(h, '/v1/catalogue/products/p-soap/publish', 'u-owner', { product: soap, categories: [{ categoryId: 'home', ...HOME }] });
    expect(defined.status).toBe(201);
    expect(defined.body).toMatchObject({ categoriesDefined: ['home'] });
    expect((await categories(h)).map((c) => c.categoryId)).toContain('home');
    // A product naming a category nobody defined (and none sent): refused by the engine — the category is unknown.
    expect((await post(h, '/v1/catalogue/products/p-x/publish', 'u-owner', { product: { ...soap, sku: 'X', primaryCategoryId: 'nowhere' } })).status).toBe(422);
  });
});

const PRODUCT_HEADER = 'productId,sku,name,baseUom,primaryCategoryId,taxClass,brand,allergens,countryOfOrigin,netQuantity,packerDetails,minimumAge';
const csv = (...rows: string[]) => [PRODUCT_HEADER, ...rows].join('\n');
const RICE_ROW = 'p-rice,RICE5,Rice 5kg,each,staples,1006,,none,India,5 kg,Synthetic Mills,';
const SOAP_ROW = 'p-soap,SOAP,Soap,each,home,3401,,,,,,';

async function withList(): Promise<ApiHarness> {
  const h = await cast();
  await post(h, '/v1/catalogue/categories/grocery', 'u-owner', GROCERY);
  await post(h, '/v1/catalogue/categories/staples', 'u-owner', STAPLES);
  await post(h, '/v1/catalogue/categories/home', 'u-owner', HOME);
  return h;
}
const validate = (h: ApiHarness, text: string, userId = 'u-owner') => post(h, '/v1/import/validate', userId, { templateId: 'product-v1', text });
async function load(h: ApiHarness, jobId: string, text: string) {
  const contentFingerprint = ((await validate(h, text)).body as { contentFingerprint: string }).contentFingerprint;
  const approvalId = await approvedRequestId(h, A, 'u-owner', 'u-mgr', { kind: 'data_import_commit', subjectRef: jobId, details: { jobId, contentFingerprint } });
  return post(h, '/v1/import/commit', 'u-owner', { jobId, templateId: 'product-v1', text, approvalId });
}

describe('SF-06-b — a product file loads real products', () => {
  it('THE AUDIT\'S CASE: an approved product file puts the products in the product master — in one save with the job', async () => {
    const h = await withList();
    const res = await load(h, 'J-P1', csv(RICE_ROW, SOAP_ROW));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ committed: true, rowsApplied: 2, effects: [{ kind: 'product', ref: 'p-rice' }, { kind: 'product', ref: 'p-soap' }] });
    const rice = (await get(h, '/v1/catalogue/products/p-rice')).body as { product: { lifecycle: string; safety: { allergens: string[]; countryOfOrigin: string } } };
    expect(rice.product).toMatchObject({ lifecycle: 'new', safety: { allergens: [], countryOfOrigin: 'India' } });
    expect((await get(h, '/v1/catalogue/products')).body).toMatchObject({ count: 2 });
  });

  it('every rule is a row error by line — the product engine\'s, against head office\'s list — and a bad file loads nothing', async () => {
    const h = await withList();
    await load(h, 'J-P1', csv(SOAP_ROW));
    const text = csv(
      'p-rice,RICE5,Rice 5kg,each,staples,1006,,,India,5 kg,Synthetic Mills,', // food: no allergen declaration
      'p-oil,RICE5,Oil 1L,each,staples,1507,,none,India,1 L,Synthetic Mills,',  // the same SKU as line 2
      'p-soap,SOAP2,Soap again,each,home,3401,,,,,,',                            // already in the product master
      'p-x,X1,X,each,nowhere,1,,,,,,',                                           // not on head office's list
      'p-beer,BEER,Beer,each,home,2203,,,,,,eighteen',                           // the age is not a whole number
    );
    const v = (await validate(h, text)).body as { preview: { errors: { line: number; column: string }[]; commitReady: boolean } };
    expect(v.preview.errors.map((e) => `${e.line}:${e.column}`)).toEqual(expect.arrayContaining(['2:allergens', '3:sku', '4:productId', '5:primaryCategoryId', '6:minimumAge']));
    expect(v.preview.commitReady).toBe(false);
    expect((await get(h, '/v1/catalogue/products')).body).toMatchObject({ count: 1 });
  });

  it('a manager may not load products (publishing is the owner\'s); the template is listed', async () => {
    const h = await withList();
    const res = await post(h, '/v1/import/commit', 'u-mgr', { jobId: 'J-M', templateId: 'product-v1', text: csv(SOAP_ROW), approvalId: 'whatever' });
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('import_target_not_permitted');
    expect(((await get(h, '/v1/import/templates')).body as { templates: { id: string }[] }).templates.map((t) => t.id)).toEqual(['supplier-invoice-v1', 'product-v1']);
  });

  it('ROLLBACK: the products are discontinued (a new version — kept as evidence); refused once a product has a barcode', async () => {
    const h = await withList();
    expect((await load(h, 'J-1', csv(SOAP_ROW))).status).toBe(200);
    expect((await load(h, 'J-2', csv(RICE_ROW))).status).toBe(200);
    const undo1 = await approvedRequestId(h, A, 'u-owner', 'u-mgr', { kind: 'data_import_rollback', subjectRef: 'J-1', details: { jobId: 'J-1' } });
    expect((await post(h, '/v1/import/commits/J-1/rollback', 'u-owner', { reason: 'wrong file', approvalId: undo1 })).status).toBe(200);
    expect(((await get(h, '/v1/catalogue/products/p-soap')).body as { product: { lifecycle: string } }).product.lifecycle).toBe('discontinued');

    // p-rice gets a barcode — it is in use, so its load cannot be undone.
    expect((await post(h, '/v1/catalogue/products/p-rice/barcodes/8901234567890', 'u-owner', { kind: 'ean' })).status).toBeLessThan(300);
    const undo2 = await approvedRequestId(h, A, 'u-owner', 'u-mgr', { kind: 'data_import_rollback', subjectRef: 'J-2', details: { jobId: 'J-2' } });
    const blocked = await post(h, '/v1/import/commits/J-2/rollback', 'u-owner', { reason: 'late', approvalId: undo2 });
    expect(codeOf(blocked)).toBe('import_effect_in_use');
    expect(((await get(h, '/v1/catalogue/products/p-rice')).body as { product: { lifecycle: string } }).product.lifecycle).toBe('new');
  });
});
