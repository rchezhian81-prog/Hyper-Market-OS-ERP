import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { TEST_PACK_KEY } from '../support/api-harness';
import { notCanonical } from '../../services/platform/src/store-computer-identity';
import { storeOfLocationResolver } from '../../services/api/src/adapters';

/**
 * **Verifier r17 C-2 — canonical store ids, and known stores, on every write.** In memory and on real PostgreSQL through
 * the production API. The r17 probes (zz-v17-canon, zz-v17-boxscope) made "ghost" stores out of a store name with an
 * invisible character pasted from a chat or a spreadsheet, and out of an id head office never registered:
 *
 *   (a) EVERY Unicode control, format, invisible, variation-selector and filler character (by Unicode class, not a list),
 *       any space but the plain one, and a full-width look-alike → 400 `store_field_not_readable`, nothing recorded;
 *   (b) EVERY body key that names a store, a branch or a location — `toStoreId`, `locationIds[]`, `branchScope[]`, nested
 *       in lines at any depth — by one schema rule, not a key list;
 *   (c) a role's branch scope, a fixed asset, an asset's transfer and a display contract must name a store head office
 *       KNOWS (its org tree / a store with settings) → else 422 `unknown_store`; and a bad scope already on the ledger
 *       never counts as a store (OB-82's "known stores" cannot be inflated).
 */

const OWNER = 'u-owner';
const S1 = 'store-1'; const S2 = 'store-2';
interface Reply { readonly status: number; readonly body: unknown }
type Call = (method: 'GET' | 'POST', path: string, body?: unknown, user?: string) => Promise<Reply>;
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;

// The characters the r17 probes got through, and their Unicode classes' neighbours.
const GHOSTS: readonly [string, string][] = [
  ['soft hyphen U+00AD', `${S1}­`], ['combining grapheme joiner U+034F', `${S1}͏`], ['function application U+2061', `${S1}⁡`],
  ['variation selector-16 U+FE0F', `${S1}️`], ['Hangul filler U+3164', `${S1}ㅤ`], ['half-width Hangul filler U+FFA0', `${S1}ﾠ`],
  ['Hangul choseong filler U+115F', `${S1}ᅟ`], ['Hangul jungseong filler U+1160', `${S1}ᅠ`], ['zero-width space U+200B', `${S1}​`],
  ['Mongolian vowel separator U+180E', `${S1}᠎`], ['variation selector-17 U+E0100', `${S1}\u{e0100}`], ['right-to-left mark U+200F', `${S1}‏`],
  ['no-break space inside', 'store 1'], ['ideographic space', `${S1}　`], ['full-width s', 'ｓtore-1'], ['tag character U+E0041', `${S1}\u{e0041}`],
  ['padding', ` ${S1} `],
];

async function setUp(call: Call): Promise<void> {
  expect((await call('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' })).status).toBeLessThan(300);
  for (const s of [S1, S2]) expect((await call('POST', `/v1/org/nodes/${s}`, { kind: 'branch', name: s, parentId: 'C1', companyId: 'C1' })).status).toBeLessThan(300);
}

async function invisibleCharactersNeverMakeAStore(call: Call): Promise<void> {
  const move = (locationId: string, id: string) => call('POST', '/v1/inventory/movements', {
    movementId: id, productId: 'P-GHOST', locationId, kind: 'received', quantityMinor: 1, unitCostMinor: 100, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: OWNER,
  });
  for (const [what, ghost] of GHOSTS) {
    const r = await move(ghost, `mv-${randomUUID()}`);
    expect(r.status, what).toBe(400);
    expect(codeOf(r), what).toBe('store_field_not_readable');
  }
  expect((await move(S1, 'mv-real')).status).toBeLessThan(300);
  const rows = ((await call('GET', '/v1/inventory/availability')).body as { rows: { locationId: string; productId: string }[] }).rows.filter((x) => x.productId === 'P-GHOST');
  expect(rows.map((x) => x.locationId)).toEqual([S1]); // one place: no ghost copy of store-1
}

async function everyStoreNamingKeyIsChecked(call: Call): Promise<void> {
  const asset = (id: string, storeId: string) => call('POST', `/v1/finance/fixed-assets/${id}`, { name: 'Chest freezer', category: 'freezer', storeId, costMinor: 120_000, salvageMinor: 0, usefulLifeMonths: 12, inServiceDate: '2026-07-15' });
  // (b) asset storeId / transfer toStoreId: an invisible character is unreadable (400), never trimmed into a place.
  expect(codeOf(await asset('FA-G1', `${S1}­`))).toBe('store_field_not_readable');
  expect((await asset('FA-1', S1)).status).toBe(201);
  expect(codeOf(await call('POST', '/v1/finance/fixed-assets/FA-1/transfer', { toStoreId: `${S2}​`, on: '2026-08-01', reason: 'moved' }))).toBe('store_field_not_readable');
  // display contract locationIds[] and a nested key, at any depth.
  const contract = (locationIds: unknown[], storeId = S1) => ({ storeId, supplierId: 'sup-1', description: 'end-cap', fundingAmount: { minor: 50_000, currency: 'INR' }, startsOn: '2026-01-01', endsOn: '2026-12-31', locationIds });
  for (const bad of [[` ${S1} `], ['END-1​'], ['END-1', 'END­2'], [7]]) {
    const r = await call('POST', '/v1/merchandising/display-contracts/dc-g', contract(bad));
    expect(r.status, JSON.stringify(bad)).toBe(400);
    expect(codeOf(r)).toBe('store_field_not_readable');
  }
  const nested = await call('POST', '/v1/inventory/movements', { movementId: 'mv-nested', productId: 'P-GHOST', locationId: S1, kind: 'received', quantityMinor: 1, unitCostMinor: 100, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: OWNER, extra: { lines: [{ homeStoreId: `${S2}⁠` }] } });
  expect(codeOf(nested)).toBe('store_field_not_readable');
  // (b) a role's branchScope[]: an invisible character or padding is unreadable.
  for (const scope of [[` ${S1} `], [`${S1}​`], [`${S1}­`], [`${S1}ㅤ`]]) {
    const r = await call('POST', '/v1/identity/grants', { grantId: `g-${randomUUID()}`, userId: 'u-box-g', roleId: 'store_computer', branchScope: scope, reason: 'pasted' });
    expect(r.status, JSON.stringify(scope)).toBe(400);
    expect(codeOf(r)).toBe('store_field_not_readable');
  }
}

async function onlyKnownStores(call: Call): Promise<void> {
  const asset = (id: string, storeId: string) => call('POST', `/v1/finance/fixed-assets/${id}`, { name: 'Billing PC', category: 'billing_pc', storeId, costMinor: 50_000, salvageMinor: 0, usefulLifeMonths: 36, inServiceDate: '2026-07-01' });
  // (c) an asset at a store head office never registered: 422 by name; nothing on the register.
  const ghostAsset = await asset('FA-77', 'store-77');
  expect(ghostAsset.status).toBe(422);
  expect(codeOf(ghostAsset)).toBe('unknown_store');
  expect((ghostAsset.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/store-77/);
  expect((await asset('FA-2', S1)).status).toBe(201);
  const ghostMove = await call('POST', '/v1/finance/fixed-assets/FA-2/transfer', { toStoreId: 'store-88', on: '2026-08-01', reason: 'moved' });
  expect(codeOf(ghostMove)).toBe('unknown_store');
  expect((await call('POST', '/v1/finance/fixed-assets/FA-2/transfer', { toStoreId: S2, on: '2026-08-01', reason: 'moved' })).status).toBe(201);
  const register = ((await call('GET', '/v1/finance/fixed-assets')).body as { assets: { assetId: string; storeId: string }[] }).assets;
  expect(register.find((a) => a.assetId === 'FA-77')).toBeUndefined();
  expect(register.find((a) => a.assetId === 'FA-2')?.storeId).toBe(S2);
  // Replay: the same asset again is the same one (idempotent), never a second.
  expect((await asset('FA-2', S1)).body).toMatchObject({ alreadyAdded: true });
  // (c) a display contract at an unknown store.
  const dc = await call('POST', '/v1/merchandising/display-contracts/dc-99', { storeId: 'store-99', supplierId: 'sup-1', description: 'end-cap', fundingAmount: { minor: 50_000, currency: 'INR' }, startsOn: '2026-01-01', endsOn: '2026-12-31', locationIds: ['END-1'] });
  expect(codeOf(dc)).toBe('unknown_store');
  // (c) a role's scope names only stores head office knows; a known one is asked as before.
  const ghostGrant = await call('POST', '/v1/identity/grants', { grantId: 'g-99', userId: 'u-box-99', roleId: 'store_computer', branchScope: ['store-99'], reason: 'typo' });
  expect(ghostGrant.status).toBe(422);
  expect(codeOf(ghostGrant)).toBe('unknown_store');
  const mgrGhost = await call('POST', '/v1/identity/grants', { grantId: 'g-mgr-99', userId: 'u-mgr-99', roleId: 'store_manager', branchScope: [S1, 'store-99'], reason: 'typo' });
  expect(codeOf(mgrGhost)).toBe('unknown_store');
  expect((await call('POST', '/v1/identity/grants', { grantId: 'g-ok', userId: 'u-box-ok', roleId: 'store_computer', branchScope: [S2], reason: 'store 2 box' })).status).toBe(202);
  const pending = ((await call('GET', '/v1/identity/grants/pending')).body as { requests?: { grantId: string }[] } | null)?.requests ?? [];
  expect(pending.map((p) => p.grantId)).toContain('g-ok');
  expect(pending.map((p) => p.grantId)).not.toContain('g-99');
  expect(pending.map((p) => p.grantId)).not.toContain('g-mgr-99');
}

function cloudFor(h: ApiHarness, tenant: string): Call {
  return (method, path, body, user = OWNER) => h.request({ method, path, userId: user, tenantId: tenant, ...(body === undefined ? {} : { body, idempotencyKey: `k-${randomUUID()}` }) });
}

describe('verifier r17 C-2 — a ghost store is never recorded (real API, in memory)', () => {
  const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0c17';
  let h: ApiHarness;
  let call: Call;
  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(tenant, OWNER);
    call = cloudFor(h, tenant);
    await setUp(call);
  });
  it('(a) every invisible, format, filler, look-alike or padded store id is refused 400 — stock never lands at a ghost place', async () => { await invisibleCharactersNeverMakeAStore(call); });
  it('(b) every key that names a store or location — toStoreId, locationIds[], branchScope[], nested at any depth — is checked by one rule', async () => { await everyStoreNamingKeyIsChecked(call); });
  it('(c) a role scope, an asset, its transfer and a display contract name only stores head office knows — else 422 unknown_store', async () => { await onlyKnownStores(call); });
  it('(c) a bad scope already on the ledger (from before this rule) never counts as a store — OB-82\'s store count cannot be inflated', async () => {
    const before = (await storeOfLocationResolver({ store: h.store, now: () => new Date().toISOString() }, tenant)).knownStores;
    await h.provisionRole(tenant, 'u-box-legacy', 'store_computer', [`${S1}​`]); // laid on the ledger directly
    const after = (await storeOfLocationResolver({ store: h.store, now: () => new Date().toISOString() }, tenant)).knownStores;
    expect([...after].sort()).toEqual([...before].sort());
    expect([...after].some((s) => notCanonical(s))).toBe(false);
  });
  it('the shared rule itself: every class is caught, plain ids and Tamil names are not', () => {
    for (const [what, ghost] of GHOSTS) expect(notCanonical(ghost), what).toBe(true);
    for (const fine of ['store-1', 'S1', 'S1-BACK', 'A1-1', 'END-1', 'lane.7_b', 'கடை-1', 'store 1']) expect(notCanonical(fine), fine).toBe(false);
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('verifier r17 C-2 — the same on real PostgreSQL, through the production API over HTTP', () => {
  let real: RealCloud;
  let call: Call;
  beforeAll(async () => {
    real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: TEST_PACK_KEY });
    call = (method, path, body, user = OWNER) => real.request({ method, path, userId: user, ...(body === undefined ? {} : { body, idempotencyKey: `k-${randomUUID()}` }) });
    await setUp(call);
  }, 120_000);
  afterAll(async () => { await real?.stop(); });
  it('(a) invisible characters never make a store (PostgreSQL)', async () => { await invisibleCharactersNeverMakeAStore(call); }, 60_000);
  it('(b) every store-naming key is checked (PostgreSQL)', async () => { await everyStoreNamingKeyIsChecked(call); }, 60_000);
  it('(c) only known stores (PostgreSQL)', async () => { await onlyKnownStores(call); }, 60_000);
  it('after an API restart the register holds only the real stores\' assets (PostgreSQL)', async () => {
    const tenantId = real.tenantId;
    await real.stop();
    real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: TEST_PACK_KEY });
    const register = ((await call('GET', '/v1/finance/fixed-assets')).body as { assets: { assetId: string; storeId: string }[] }).assets;
    expect(register.every((a) => a.storeId === S1 || a.storeId === S2)).toBe(true);
  }, 120_000);
});
