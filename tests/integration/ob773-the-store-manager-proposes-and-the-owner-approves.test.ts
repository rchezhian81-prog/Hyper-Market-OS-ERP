import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { decide } from '../support/approval-request';
import { STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **OB-773 (owner, 15 Nov 2026, choice 3 B · audit C-8): "The store manager may make changes, and you (the owner) approve
 * them."** On head office's real routes, permission checks and approval engine:
 *   • the store manager PROPOSES an item change (details, HSN, MRP), a barcode, a GST rate; nothing changes yet;
 *   • the OWNER approves on his Approvals inbox (he sees the before and the after) and head office makes exactly that change
 *     through the ordinary catalogue route, recorded with the approval id; or he refuses with a reason and nothing changes;
 *   • the manager never approves his own, still gets 403 on a direct save, and the accountant or a cashier cannot propose;
 *   • the route's own checks still run (a published item's HSN still waits for Finance; an item saved meanwhile is never
 *     overwritten); a decision re-sent is answered once, the change made once.
 * Synthetic data only.
 */

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const SALT = { sku: 'SKU-SALT', name: 'Synthetic Salt 1kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'active', mrpHistory: [{ value: { minor: 2_800, currency: 'INR' }, effectiveFrom: '2026-01-01' }] };
interface Row { requestId: string; kind: string; status: string; subjectRef: string; decisionReason?: string; details: { changes: { field: string; before: string; after: string }[] }; catalogueChange?: { applied: boolean; approvalId: string; code?: string; reason?: string } }

async function setUp(): Promise<{ h: ApiHarness; T: string; req: (method: 'GET' | 'POST', path: string, body?: unknown, userId?: string) => Promise<Res>; ok: (p: Promise<Res>, what: string) => Promise<Res>; trail: (action: string) => Promise<{ action: string; actorId: string; objectId: string; before: Record<string, string> | null; after: Record<string, string> | null; approvalId?: string; reason?: string }[]>; propose: (body: Record<string, unknown>, userId?: string) => Promise<Res>; inbox: (userId: string) => Promise<{ waitingForMe: Row[]; mine: Row[] }>; product: (id: string) => Promise<{ product: Record<string, unknown>; version: number }> }> {
  const h = apiHarness();
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-mgr2', 'store_manager');
  await h.provisionRole(T, 'u-acct', 'accountant');
  await h.provisionRole(T, 'u-cash', 'cashier');
  const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  const trail = async (action: string) => (await h.store.readStream(T, streamName(STREAM.audit, 'domain-trail'), { type: 'AuditRecordSealed' }))
    .map((e) => e.event.payload as { action: string; actorId: string; objectId: string; before: Record<string, string> | null; after: Record<string, string> | null; approvalId?: string; reason?: string })
    .filter((r) => r.action === action);
  const propose = (body: Record<string, unknown>, userId = 'u-mgr') => req('POST', '/v1/catalogue/changes', body, userId);
  const inbox = async (userId: string) => (await req('GET', '/v1/approvals/requests', undefined, userId)).body as { waitingForMe: Row[]; mine: Row[] };
  const product = async (id: string) => (await req('GET', `/v1/catalogue/products/${id}`)).body as { product: Record<string, unknown>; version: number };
  await ok(req('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null }), 'category');
  await ok(req('POST', '/v1/catalogue/tax-classes/25010020/rates/2017-07-01', { rateBps: 500 }), 'tax');
  await ok(req('POST', '/v1/catalogue/products/SALT/publish', { product: SALT }), 'publish SALT');
  return { h, T, req, ok, trail, propose, inbox, product };
}

describe('OB-773: the store manager proposes a catalogue change; it is made only when the owner approves', () => {
  it('an item change: nothing changes on the manager\'s word; the owner sees the before and after, approves, and head office makes it with the approval id; a re-sent decision makes it once', async () => {
    const { T, h, req, trail, propose, inbox, product } = await setUp();
    const before = await product('SALT');
    const proposed = { ...SALT, manufacturer: 'Synthetic Salt Works', brand: 'Synthetic', mrpHistory: [...SALT.mrpHistory, { value: { minor: 3_000, currency: 'INR' }, effectiveFrom: '2026-12-01' }] };
    const sent = await propose({ change: 'product', productId: 'SALT', product: proposed, expectedVersion: before.version, reason: 'pack reprint shows the maker and the new MRP (synthetic)' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toMatchObject({ kind: 'catalogue_change', status: 'waiting', nothingChangedYet: true, detail: expect.stringMatching(/Nothing has changed yet/) });
    const requestId = (sent.body as { requestId: string }).requestId;

    // Nothing changed yet.
    expect((await product('SALT')).version).toBe(before.version);
    expect((await product('SALT')).product).toMatchObject({ taxClass: '25010020' });

    // The owner sees it with the before and the after; the manager sees it waiting under what he asked for.
    const row = (await inbox('u-owner')).waitingForMe.find((r) => r.requestId === requestId);
    expect(row?.details.changes).toEqual(expect.arrayContaining([
      { field: 'manufacturer', before: '', after: 'Synthetic Salt Works' },
      { field: 'brand', before: '', after: 'Synthetic' },
      { field: 'mrpHistory', before: '₹28.00 from 2026-01-01', after: '₹28.00 from 2026-01-01; ₹30.00 from 2026-12-01' },
    ]));
    expect((await inbox('u-mgr')).mine.find((r) => r.requestId === requestId)?.status).toBe('waiting');
    expect((await inbox('u-mgr')).waitingForMe).toEqual([]);

    // The owner approves: made at once, as his own act, naming the approval.
    const approved = await decide(h, T, 'u-owner', requestId, 'approved', 'checked the pack (synthetic)');
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body).toMatchObject({ decision: 'approved', catalogueChange: { applied: true, approvalId: requestId, proposedBy: 'u-mgr', approvedBy: 'u-owner' } });
    const after = await product('SALT');
    expect(after.version).toBe(before.version + 1);
    expect(after.product).toMatchObject({ manufacturer: 'Synthetic Salt Works', brand: 'Synthetic', taxClass: '25010020' });
    expect((after.product['mrpHistory'] as unknown[]).length).toBe(2);
    const sealed = await trail('catalogue.change.apply');
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatchObject({ actorId: 'u-owner', objectId: 'SALT', approvalId: requestId, before: { manufacturer: '', brand: '' }, after: { manufacturer: 'Synthetic Salt Works', brand: 'Synthetic', proposedBy: 'u-mgr', approvedBy: 'u-owner' } });
    expect((await trail('catalogue.change.propose'))[0]).toMatchObject({ actorId: 'u-mgr', approvalId: requestId });

    // The manager's list says it was approved and made.
    const mine = (await inbox('u-mgr')).mine.find((r) => r.requestId === requestId);
    expect(mine).toMatchObject({ status: 'used', catalogueChange: { applied: true } });

    // The same decision re-sent: answered once, the change made once.
    const again = await decide(h, T, 'u-owner', requestId, 'approved', 'checked the pack (synthetic)');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyDecided: true, catalogueChange: { applied: true, approvalId: requestId } });
    expect((await product('SALT')).version).toBe(before.version + 1);
    expect(await trail('catalogue.change.apply')).toHaveLength(1);
    // A different decision afterwards is refused by the engine (a decision is final).
    expect((await decide(h, T, 'u-owner', requestId, 'rejected', 'changed my mind')).status).toBe(409);
    void req;
  });

  it('the manager cannot approve his own, nor can another manager; the owner refuses with a reason and nothing changes', async () => {
    const { T, h, trail, propose, inbox, product } = await setUp();
    const before = await product('SALT');
    const sent = await propose({ change: 'product', productId: 'SALT', product: { ...SALT, name: 'Synthetic Salt 1 kg (iodised)' }, expectedVersion: before.version, reason: 'name on the pack (synthetic)' });
    const requestId = (sent.body as { requestId: string }).requestId;
    const own = await decide(h, T, 'u-mgr', requestId);
    expect(own.status).toBe(403);
    expect(codeOf(own)).toBe('not_permitted_for_this_approval');
    expect((await decide(h, T, 'u-mgr2', requestId)).status).toBe(403);
    expect((await inbox('u-mgr2')).waitingForMe).toEqual([]);

    const refused = await decide(h, T, 'u-owner', requestId, 'rejected', 'the pack in the store still says 1kg (synthetic)');
    expect(refused.status).toBe(201);
    expect(refused.body).toMatchObject({ decision: 'rejected', catalogueChange: { applied: false, refused: true } });
    expect((await product('SALT')).version).toBe(before.version);
    expect((await product('SALT')).product['name']).toBe(SALT.name);
    expect((await inbox('u-mgr')).mine.find((r) => r.requestId === requestId)).toMatchObject({ status: 'rejected', decisionReason: 'the pack in the store still says 1kg (synthetic)' });
    expect((await trail('catalogue.change.refuse'))[0]).toMatchObject({ actorId: 'u-owner', approvalId: requestId, reason: 'the pack in the store still says 1kg (synthetic)' });
    expect(await trail('catalogue.change.apply')).toEqual([]);
  });

  it('the manager still gets 403 on a direct save, barcode, GST rate and pack publish; the accountant and a cashier cannot propose; the engine\'s own ask is not a back door', async () => {
    const { req, propose, product } = await setUp();
    expect((await req('POST', '/v1/catalogue/products/SALT/publish', { product: { ...SALT, name: 'x' } }, 'u-mgr')).status).toBe(403);
    expect((await req('POST', '/v1/catalogue/products/SALT/barcodes/8901234567890', { kind: 'ean' }, 'u-mgr')).status).toBe(403);
    expect((await req('POST', '/v1/catalogue/tax-classes/25010020/rates/2027-01-01', { rateBps: 1_200 }, 'u-mgr')).status).toBe(403);
    expect((await req('POST', '/v1/catalogue/pack', {}, 'u-mgr')).status).toBe(403);
    const v = (await product('SALT')).version;
    for (const who of ['u-acct', 'u-cash']) {
      expect((await propose({ change: 'product', productId: 'SALT', product: { ...SALT, name: 'x' }, expectedVersion: v, reason: 'synthetic' }, who)).status).toBe(403);
    }
    const sideDoor = await req('POST', '/v1/approvals/requests', { kind: 'catalogue_change', subjectRef: 'product:SALT', details: { change: 'product', productId: 'SALT', product: { ...SALT, name: 'x' } }, valueMinor: null, summary: 'x', reason: 'x' }, 'u-mgr');
    expect(sideDoor.status).toBe(422);
    expect(codeOf(sideDoor)).toBe('use_the_catalogue_change_route');
    // A proposal without a reason, unreadable, or that changes nothing is refused before anything is asked.
    expect((await propose({ change: 'product', productId: 'SALT', product: SALT, expectedVersion: v })).status).toBe(400);
    expect((await propose({ change: 'colour', productId: 'SALT', reason: 'x' })).status).toBe(400);
    expect(codeOf(await propose({ change: 'product', productId: 'SALT', product: SALT, expectedVersion: v, reason: 'x' }))).toBe('nothing_to_change');
    // A proposal on a version the manager did not open is refused now, by name.
    expect(codeOf(await propose({ change: 'product', productId: 'SALT', product: { ...SALT, name: 'x' }, expectedVersion: v - 1, reason: 'x' }))).toBe('product_changed_meanwhile');
  });

  it('a barcode proposal works end to end; a GS1 code with a wrong check digit is approved but NOT made, with the route\'s reason', async () => {
    const { T, h, propose, inbox, req } = await setUp();
    const sent = await propose({ change: 'barcode', productId: 'SALT', code: '8901234567890', kind: 'ean', reason: 'barcode on the new pack (synthetic)' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const requestId = (sent.body as { requestId: string }).requestId;
    expect((await req('GET', '/v1/catalogue/barcodes/8901234567890')).status).toBe(404);
    expect((await inbox('u-owner')).waitingForMe.find((r) => r.requestId === requestId)?.details.changes).toContainEqual({ field: 'newBarcode', before: '', after: '8901234567890 (ean)' });
    const made = await decide(h, T, 'u-owner', requestId);
    expect(made.body, JSON.stringify(made.body)).toMatchObject({ catalogueChange: { applied: true } });
    expect((await req('GET', '/v1/catalogue/barcodes/8901234567890')).body).toMatchObject({ barcode: { productId: 'SALT', kind: 'ean' } });

    const bad = await propose({ change: 'barcode', productId: 'SALT', code: '8901234567895', kind: 'ean', reason: 'typed off the pack (synthetic)' });
    const badId = (bad.body as { requestId: string }).requestId;
    const decided = await decide(h, T, 'u-owner', badId);
    expect(decided.status).toBe(201);
    expect(decided.body).toMatchObject({ catalogueChange: { applied: false, code: 'barcode_check_digit_wrong' } });
    expect((await req('GET', '/v1/catalogue/barcodes/8901234567895')).status).toBe(404);
    expect((await inbox('u-mgr')).mine.find((r) => r.requestId === badId)).toMatchObject({ status: 'used', catalogueChange: { applied: false } });
  });

  it('a GST rate and a new item with its HSN work end to end; a change that also needs Finance still waits for Finance (the route\'s own rule), and nothing changes', async () => {
    const { T, h, propose, req, product } = await setUp();
    // A first GST rate for a new HSN class.
    const rate = await propose({ change: 'tax_rate', hsnCode: '04051000', effectiveFrom: '2026-12-01', rateBps: 1_200, reason: 'butter comes in from next month (synthetic)' });
    expect(rate.status, JSON.stringify(rate.body)).toBe(201);
    expect((await req('GET', '/v1/catalogue/tax-classes/04051000/rates')).body).toMatchObject({ count: 0 });
    const rateOut = await decide(h, T, 'u-owner', (rate.body as { requestId: string }).requestId);
    expect(rateOut.body, JSON.stringify(rateOut.body)).toMatchObject({ catalogueChange: { applied: true } });
    expect((await req('GET', '/v1/catalogue/tax-classes/04051000/rate', undefined, 'u-owner')).status).toBe(400); // needs ?on
    expect((await h.request({ method: 'GET', path: '/v1/catalogue/tax-classes/04051000/rate', userId: 'u-owner', tenantId: T, query: { on: '2026-12-02' } })).body).toMatchObject({ rate: { rateBps: 1_200 } });

    // A new item, with its HSN, proposed by the manager and added on the owner's approval.
    expect((await req('GET', '/v1/catalogue/products/BUTTER')).status).toBe(404);
    const butter = { ...SALT, sku: 'SKU-BUTTER', name: 'Synthetic Butter 100g', taxClass: '04051000', lifecycle: 'active' };
    const hsn = await propose({ change: 'product', productId: 'BUTTER', product: butter, expectedVersion: 0, reason: 'new line from the dairy (synthetic)' });
    expect(hsn.status, JSON.stringify(hsn.body)).toBe(201);
    expect((await req('GET', '/v1/catalogue/products/BUTTER')).status).toBe(404);
    const hsnOut = await decide(h, T, 'u-owner', (hsn.body as { requestId: string }).requestId);
    expect(hsnOut.body, JSON.stringify(hsnOut.body)).toMatchObject({ catalogueChange: { applied: true } });
    expect((await product('BUTTER')).product['taxClass']).toBe('04051000');

    // A published item's HSN, and a rate on a class that already has one, still need Finance (OB-347, M03 §28): approved by
    // the owner, NOT made — said with the route's reason — and nothing changes.
    const sv = (await product('SALT')).version;
    const pub = await propose({ change: 'product', productId: 'SALT', product: { ...SALT, taxClass: '25010090' }, expectedVersion: sv, reason: 'reclassified (synthetic)' });
    const pubOut = await decide(h, T, 'u-owner', (pub.body as { requestId: string }).requestId);
    expect(pubOut.body).toMatchObject({ catalogueChange: { applied: false, code: 'tax_class_change_needs_finance_approval' } });
    expect((await product('SALT')).product['taxClass']).toBe('25010020');
    const change = await propose({ change: 'tax_rate', hsnCode: '25010020', effectiveFrom: '2027-04-01', rateBps: 0, reason: 'salt exempted (synthetic)' });
    expect((await decide(h, T, 'u-owner', (change.body as { requestId: string }).requestId)).body).toMatchObject({ catalogueChange: { applied: false, code: 'tax_change_needs_finance_approval' } });
    expect((await req('GET', '/v1/catalogue/tax-classes/25010020/rates')).body).toMatchObject({ count: 1 });
  });

  it('an item saved by someone else after the manager opened it is never overwritten: approved, NOT made, said by name', async () => {
    const { T, h, propose, req, product } = await setUp();
    const v = (await product('SALT')).version;
    const sent = await propose({ change: 'product', productId: 'SALT', product: { ...SALT, brand: 'Synthetic brand' }, expectedVersion: v, reason: 'brand on the pack (synthetic)' });
    await req('POST', '/v1/catalogue/products/SALT/publish', { product: { ...SALT, manufacturer: 'Owner\'s own edit' } });
    const out = await decide(h, T, 'u-owner', (sent.body as { requestId: string }).requestId);
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({ catalogueChange: { applied: false, code: 'product_changed_meanwhile' } });
    expect((await product('SALT')).product).toMatchObject({ manufacturer: 'Owner\'s own edit' });
    expect((await product('SALT')).product['brand']).toBeUndefined();
  });

  it('a label-facts change on an item on sale is proposed and made through the safety save, version-checked', async () => {
    const { T, h, propose, product } = await setUp();
    const v = (await product('SALT')).version;
    const sent = await propose({ change: 'product_safety', productId: 'SALT', safety: { allergens: [], countryOfOrigin: 'India', storageConditions: 'Keep dry' }, expectedVersion: v, reason: 'read off the pack (synthetic)' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect((await product('SALT')).product['safety']).toBeUndefined();
    expect((await decide(h, T, 'u-owner', (sent.body as { requestId: string }).requestId)).body).toMatchObject({ catalogueChange: { applied: true } });
    expect((await product('SALT')).product['safety']).toMatchObject({ storageConditions: 'Keep dry', countryOfOrigin: 'India' });
  });
});
