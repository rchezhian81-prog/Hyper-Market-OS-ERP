import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import type { HttpRequest } from '../../services/kernel/src/index';
// @ts-expect-error — plain .mjs operator script, imported for its pure token builder.
import { buildStoreToken } from '../../scripts/issue-store-token.mjs';
import { verifyToken } from '../../services/identity/src/token';
import { storeReferencesIn, judgeBoxRequest, storeComputerGrantRefusal } from '../../services/platform/src/store-computer-identity';

/**
 * **OB-54 "A" (owner, 11 Oct 2026, in writing): each store computer's credential is LOCKED to its own store.**
 *
 * Two stores, SA and SB, each with a back store under it, and two boxes: u-box-a (granted for SA only, credential naming
 * SA) and u-box-b (SB). Proven on the real API — in memory, and on real PostgreSQL through the production assembly with
 * two real store computers relaying over HTTP:
 *
 *   • GRANT TIME — a tenant-wide or multi-store store_computer grant is refused when it is asked for (422), so no box can
 *     ever hold one; a grant for one store is the only kind made.
 *   • THE CREDENTIAL — the operator script puts the store in the signed token; a box credential naming no store, or a
 *     store its grant does not name, is refused on every route.
 *   • EVERY RECORD — box A's own sale is banked (and a replay is the same one answer); box A sending a sale, a return, a
 *     day close, a transfer movement, phone/screen work, held versions, a sync report or a setup pull for SB — the store
 *     named at the top, in a line, in a path or in a query — is refused by name and nothing is recorded.
 *   • VISIBLE — every refusal is kept on head office's own record (`GET /v1/store-computers/refusals`), once per distinct
 *     request, and the refused record stays on the box as a dead letter naming why; a person's sign-in is untouched.
 */

const KEY = ['ob54', 'store', 'lock', 'pack', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner'; const ASKER = 'u-hr';
const BOX_A = 'u-box-a'; const BOX_B = 'u-box-b';
const SA = 'SA'; const SB = 'SB'; const WA = 'SA-BACK'; const WB = 'SB-BACK';
const AT = new Date(Date.now() - 60_000).toISOString();

interface Reply { readonly status: number; readonly body: unknown }
interface Api {
  readonly tenant: string;
  raw(method: HttpRequest['method'], path: string, token: string | undefined, body?: unknown, key?: string, query?: Record<string, string>): Promise<Reply>;
}
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const tokenOf = (api: Api, user: string, store?: string): string => TEST_IDP.issue({ sub: user, tenantId: api.tenant, ...(store === undefined ? {} : { branchId: store }) });
const as = (api: Api, user: string, store?: string) => ({
  get: (path: string, query?: Record<string, string>) => api.raw('GET', path, tokenOf(api, user, store), undefined, undefined, query),
  post: (path: string, body: unknown, key = `k-${randomUUID()}`) => api.raw('POST', path, tokenOf(api, user, store), body, key),
});

const sale = (saleId: string, locationId: string, over: Record<string, unknown> = {}) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId, cashierId: 'u-cash', tradingDay: AT.slice(0, 10), committedAt: AT,
  totalMinor: 2_500, currency: 'INR', packVersion: 0,
  lines: [{ productId: 'MILK', quantityMinor: 1, uom: 'ea', unitPriceMinor: 2_500, lineTotalMinor: 2_500 }],
  tenders: [{ kind: 'cash', amountMinor: 2_500 }], ...over,
});

/** The two stores at head office: company → SA (back store WA) and SB (back store WB). */
async function twoStores(api: Api): Promise<void> {
  const owner = as(api, OWNER);
  for (const [id, body] of [
    ['C-OB54', { kind: 'company', name: 'Synthetic Retail' }],
    [SA, { kind: 'branch', name: 'Store A', parentId: 'C-OB54', companyId: 'C-OB54' }],
    [SB, { kind: 'branch', name: 'Store B', parentId: 'C-OB54', companyId: 'C-OB54' }],
    [WA, { kind: 'warehouse', name: 'Back store A', parentId: SA, companyId: 'C-OB54' }],
    [WB, { kind: 'warehouse', name: 'Back store B', parentId: SB, companyId: 'C-OB54' }],
  ] as const) {
    const r = await owner.post(`/v1/org/nodes/${id}`, body, `org-${id}`);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  }
}

/** A role asked for by one person and approved by another (two acts, §28). */
async function askAndApprove(api: Api, grantId: string, userId: string, roleId: string, branchScope: readonly string[] | 'all'): Promise<{ asked: Reply; approved?: Reply }> {
  const asked = await as(api, ASKER).post('/v1/identity/grants', { grantId, userId, roleId, branchScope, reason: 'OB-54 proof' }, `${grantId}-ask`);
  if (asked.status !== 202) return { asked };
  return { asked, approved: await as(api, OWNER).post(`/v1/identity/grants/${grantId}/approve`, {}, `${grantId}-approve`) };
}

async function grantTimeAndSetup(api: Api): Promise<void> {
  // A tenant-wide store computer grant is refused when it is ASKED for — nobody is even asked to approve it.
  const wide = await askAndApprove(api, 'g-wide', BOX_A, 'store_computer', 'all');
  expect(wide.asked.status).toBe(422);
  expect(codeOf(wide.asked)).toBe('store_computer_grant_must_name_one_store');
  // …and so is one naming two stores: one box, one store.
  const two = await askAndApprove(api, 'g-two', BOX_A, 'store_computer', [SA, SB]);
  expect(two.asked.status).toBe(422);
  expect(codeOf(two.asked)).toBe('store_computer_grant_must_name_one_store');
  // A person's role may still be tenant-wide — the rule is the store computer's alone.
  expect((await askAndApprove(api, 'g-acct', 'u-acct', 'accountant', 'all')).approved?.status).toBe(201);
  // One store each: granted.
  expect((await askAndApprove(api, 'g-box-a', BOX_A, 'store_computer', [SA])).approved?.status).toBe(201);
  expect((await askAndApprove(api, 'g-box-b', BOX_B, 'store_computer', [SB])).approved?.status).toBe(201);
  expect((await askAndApprove(api, 'g-mgr-a', 'u-mgr-a', 'store_manager', [SA])).approved?.status).toBe(201);
  await twoStores(api);
}

async function everyRecordIsJudged(api: Api): Promise<void> {
  const boxA = as(api, BOX_A, SA);
  const owner = as(api, OWNER);
  const refusalsBefore = ((await owner.get('/v1/store-computers/refusals')).body as { refusals: unknown[] }).refusals.length;

  // Box A's OWN sale is banked; the same sale re-sent under its key is the same one answer (idempotent replay).
  const own = await boxA.post('/v1/sales', sale('OB54-A1', SA), 'sale-a1');
  expect(own.status, JSON.stringify(own.body)).toBe(202);
  const again = await boxA.post('/v1/sales', sale('OB54-A1', SA), 'sale-a1');
  expect(again.status).toBe(202);
  expect(again.body).toEqual(own.body);
  // …and a sale from its own BACK STORE (placed under SA by the hierarchy) is its own store too.
  expect((await boxA.post('/v1/sales', sale('OB54-A2', WA), 'sale-a2')).status).toBe(202);

  // Box A speaking for SB — every kind of record, wherever the store is named — is refused by name; nothing recorded.
  const forB: readonly [string, HttpRequest['method'], string, unknown, Record<string, string>?][] = [
    ['a sale at SB', 'POST', '/v1/sales', sale('OB54-B1', SB)],
    ['a sale whose LINE is at SB\'s back store', 'POST', '/v1/sales', sale('OB54-B2', SA, { lines: [{ productId: 'MILK', quantityMinor: 1, uom: 'ea', unitPriceMinor: 2_500, lineTotalMinor: 2_500, locationId: WB }] })],
    ['a return at SB', 'POST', '/v1/sales/OB54-A1/returns/synced', { returnId: 'RT-B1', originalSaleId: 'OB54-A1', locationId: SB, lines: [] }],
    ['a no-receipt return at SB', 'POST', '/v1/returns/no-receipt/synced', { returnId: 'RT-B2', noReceipt: true, originalSaleId: null, locationId: SB }],
    ['SB\'s day close', 'POST', '/v1/pos/day-close/dc-b1/synced', { dayCloseId: 'dc-b1', storeId: SB, tradingDay: AT.slice(0, 10), closedBy: 'u-mgr-a' }],
    ['a transfer (indent issue) out of SB\'s back store', 'POST', '/v1/floor/indents/in-b1/issues/is-b1/synced', { indentId: 'in-b1', issueId: 'is-b1', fromLocationId: WB, toLocationId: SB, lines: [{ productId: 'MILK', quantityMinor: 1 }] }],
    ['a transfer (indent) asked from SA\'s floor to SB\'s back store', 'POST', '/v1/floor/indents/in-b2/synced', { indentId: 'in-b2', fromLocationId: WB, toLocationId: SA, lines: [] }],
    ['a handheld put-away at SB', 'POST', '/v1/warehouse/movements/wm-b1/synced', { commandId: 'wm-b1', kind: 'put_away', storeId: WB, productId: 'MILK' }],
    ['a manager-screen decision at SB', 'POST', '/v1/approvals/decisions/ap-b1/synced', { id: 'ap-b1', branchId: SB, status: 'approved', decidedBy: 'u-mgr-a' }],
    ['a checklist done at SB', 'POST', '/v1/hr/workforce/checklists/cl-b1/synced', { checklistId: 'cl-b1', branchId: SB }],
    ['what SB holds', 'POST', `/v1/store-packs/${SB}/held`, { catalogueVersion: null, storePackVersion: null, unsentItems: 0 }],
    ['SB\'s sync report', 'POST', `/v1/stores/${SB}/sync-watermarks`, { observedAt: AT, domains: [{ domain: 'sales', completeThrough: AT, unsent: 0, deadLettered: 0 }] }],
    ['SB\'s setup', 'GET', `/v1/store-packs/${SB}`, undefined],
    ['SB\'s picking work', 'GET', '/v1/fulfilment/assignments', undefined, { storeId: SB }],
  ];
  for (const [what, method, path, body, query] of forB) {
    const r = await api.raw(method, path, tokenOf(api, BOX_A, SA), body, method === 'GET' ? undefined : `forb-${path}-${JSON.stringify(body).length}`, query);
    expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(403);
    expect(codeOf(r), what).toBe('store_computer_record_names_another_store');
    expect((r.body as { error: { wasItSaved: string } }).error.wasItSaved).toBe('not_saved');
  }
  // Nothing of SB's was recorded: the sale is not on file, SB's own box still reports for SB.
  expect((await owner.get('/v1/sales/OB54-B1')).status).toBe(404);
  expect((await owner.get('/v1/sales/OB54-B2')).status).toBe(404);
  const boxB = as(api, BOX_B, SB);
  expect((await boxB.post(`/v1/stores/${SB}/sync-watermarks`, { observedAt: AT, domains: [{ domain: 'sales', completeThrough: AT, unsent: 0, deadLettered: 0 }] })).status).toBe(200);
  expect((await boxB.post('/v1/sales', sale('OB54-B3', SB))).status).toBe(202);
  // …and box B is refused for SA the same way (the rule is symmetric, not a special case of box A).
  expect(codeOf(await boxB.post('/v1/sales', sale('OB54-A9', SA)))).toBe('store_computer_record_names_another_store');

  // The credential: with its grant naming one store, a credential naming NO store, or ANOTHER store, never gets in — the
  // grant does not cover it, so it is refused before the record is read (a legacy tenant-wide grant: the next test).
  const noStore = await as(api, BOX_A).post('/v1/sales', sale('OB54-A3', SA));
  expect(noStore.status).toBe(403);
  expect((await as(api, BOX_A, SB).post('/v1/sales', sale('OB54-B4', SB))).status).toBe(403);
  expect((await owner.get('/v1/sales/OB54-B4')).status).toBe(404);
  expect((await owner.get('/v1/sales/OB54-A3')).status).toBe(404);

  // A PERSON is not a store computer: the owner records a movement at SB's back store exactly as before.
  expect((await owner.post('/v1/inventory/movements', { movementId: 'own-wb-1', productId: 'MILK', locationId: WB, kind: 'received', quantityMinor: 5, unitCostMinor: 2_000, uom: 'ea', occurredAt: AT, enteredBy: OWNER })).status).toBeLessThan(300);

  // VISIBLE at head office: each distinct refused request is kept once, naming the box, its store, what was named, and where.
  const resend = await boxA.post('/v1/sales', sale('OB54-B1', SB));
  expect(codeOf(resend)).toBe('store_computer_record_names_another_store');
  const refusals = ((await owner.get('/v1/store-computers/refusals')).body as { refusals: { userId: string; credentialStore: string | null; reason: string; namedStore?: string; field?: string; path: string }[] }).refusals;
  const mine = refusals.slice(refusalsBefore);
  expect(mine.filter((r) => r.userId === BOX_A && r.reason === 'record_names_another_store')).toHaveLength(forB.length); // the re-send is the same one
  expect(mine).toContainEqual(expect.objectContaining({ userId: BOX_A, credentialStore: SA, namedStore: SB, field: 'body.locationId', path: '/v1/sales' }));
  expect(mine).toContainEqual(expect.objectContaining({ userId: BOX_A, namedStore: SB, field: 'body.lines[0].locationId' }));
  expect(mine).toContainEqual(expect.objectContaining({ userId: BOX_A, namedStore: SB, field: 'path.storeId', path: '/v1/stores/:storeId/sync-watermarks' }));
  expect(mine).toContainEqual(expect.objectContaining({ userId: BOX_A, namedStore: SB, field: 'query.storeId' }));
  expect(mine).toContainEqual(expect.objectContaining({ userId: BOX_B, credentialStore: SB, namedStore: SA }));
  // The record is the owner's and operations' to read — not a box's.
  expect((await boxA.get('/v1/store-computers/refusals')).status).toBe(403);
}

describe('OB-54 — the rule itself', () => {
  it('finds every store a request names — path, query, the top of the body and every line — and nothing else', () => {
    expect(storeReferencesIn({
      params: { storeId: 'S1', id: 'x' }, query: { storeId: 'S2', productId: 'p' },
      body: { saleId: 's', locationId: 'L1', lines: [{ locationId: 'L2', productId: 'p' }, { batch: { warehouseId: 'W3' } }], toLocationId: 'L4', counterpartStoreId: 'ELSEWHERE' },
    })).toEqual([
      { field: 'path.storeId', value: 'S1' }, { field: 'query.storeId', value: 'S2' }, { field: 'body.locationId', value: 'L1' },
      { field: 'body.lines[0].locationId', value: 'L2' }, { field: 'body.lines[1].batch.warehouseId', value: 'W3' }, { field: 'body.toLocationId', value: 'L4' },
    ]);
  });
  it('refuses another KNOWN store, by its place in the hierarchy; an unplaced code is refused as unknown (round 10); the credential must name a granted store', () => {
    const storeOf = (v: string): string => ({ 'SA-BACK': 'SA', 'SB-BACK': 'SB' } as Record<string, string>)[v] ?? v;
    const knownStores = new Set(['SA', 'SB']);
    const judge = (credentialStore: string | null, refs: { field: string; value: string }[], grantedStores = ['SA']) =>
      judgeBoxRequest({ credentialStore, grantedStores, references: refs, storeOf, knownStores });
    expect(judge('SA', [{ field: 'body.locationId', value: 'SA-BACK' }])).toEqual({ ok: true });
    // Round 10: a code head office cannot place in any known store is refused by name — never guessed into the box's store.
    expect(judge('SA', [{ field: 'body.locationId', value: 'SA-BACK' }, { field: 'body.lines[0].locationId', value: 'shelf-7' }])).toMatchObject({ ok: false, reason: 'record_names_unknown_store', namedStore: 'shelf-7', field: 'body.lines[0].locationId' });
    expect(judge('SA', [{ field: 'body.lines[0].locationId', value: 'SB-BACK' }])).toMatchObject({ ok: false, reason: 'record_names_another_store', namedStore: 'SB', field: 'body.lines[0].locationId' });
    expect(judge(null, [])).toMatchObject({ ok: false, reason: 'credential_names_no_store' });
    expect(judge('SB', [])).toMatchObject({ ok: false, reason: 'credential_store_not_granted' });
    expect(judge('SA', [], [])).toMatchObject({ ok: false, reason: 'credential_store_not_granted' }); // a tenant-wide grant names no store
    expect(storeComputerGrantRefusal('store_computer', 'all')).toMatch(/tenant-wide/);
    expect(storeComputerGrantRefusal('store_computer', ['SA', 'SB'])).toMatch(/exactly one store/);
    expect(storeComputerGrantRefusal('store_computer', ['SA'])).toBeUndefined();
    expect(storeComputerGrantRefusal('accountant', 'all')).toBeUndefined();
  });
  it('the operator script puts the store in the signed credential, and the real verifier reads it back as the store', () => {
    const policy = TEST_IDP.policy();
    const now = Date.now();
    const v = verifyToken(buildStoreToken({ sub: BOX_A, tenantId: 't-ob54', storeId: SA, ttlSeconds: 3_600 }, policy, now), policy, now);
    expect(v).toMatchObject({ ok: true, principal: { userId: BOX_A, tenantId: 't-ob54', branchId: SA } });
    // Without a store (the backup job, `--no-store`) the token is exactly what it was before OB-54.
    expect(verifyToken(buildStoreToken({ sub: 'svc-backup', tenantId: 't-ob54', ttlSeconds: 3_600 }, policy, now), policy, now).principal?.branchId).toBeNull();
  });
});

describe('OB-54 — each store computer is locked to its own store (real API, in memory)', () => {
  const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0b54';
  let h: ApiHarness;
  let api: Api;
  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(tenant, OWNER);
    await h.provisionRole(tenant, ASKER, 'store_manager');
    api = { tenant, raw: (method, path, token, body, key, query) => h.raw({ method, path, token, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) }) };
  });
  it('grant time: a tenant-wide or two-store store computer grant is refused; one store each is granted', async () => { await grantTimeAndSetup(api); });
  it('every record box A relays is checked against SA: its own are banked (once); SB\'s are refused by name, recorded nowhere, and listed', async () => { await everyRecordIsJudged(api); });
  it('a tenant-wide store computer grant left on a ledger from before OB-54 speaks for NO store: refused whatever its credential says, and listed', async () => {
    await h.provisionRole(tenant, 'u-box-old', 'store_computer'); // laid on the ledger directly, as a pre-OB-54 seed did
    const bare = await as(api, 'u-box-old').post('/v1/sales', sale('OLD-1', SA));
    expect(bare.status).toBe(403);
    expect(codeOf(bare)).toBe('store_computer_credential_names_no_store');
    const named = await as(api, 'u-box-old', SA).post('/v1/sales', sale('OLD-2', SA));
    expect(named.status).toBe(403);
    expect(codeOf(named)).toBe('store_computer_credential_store_not_granted');
    expect((await as(api, OWNER).get('/v1/sales/OLD-1')).status).toBe(404);
    const refusals = ((await as(api, OWNER).get('/v1/store-computers/refusals')).body as { refusals: { userId: string; reason: string; credentialStore: string | null }[] }).refusals;
    expect(refusals.filter((r) => r.userId === 'u-box-old').map((r) => [r.reason, r.credentialStore]))
      .toEqual([['credential_names_no_store', null], ['credential_store_not_granted', SA]]);
  });
});

// ── On real PostgreSQL, through the production API assembly, with two real store computers ───────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

describeOrSkip('OB-54 — on real PostgreSQL: two stores, two boxes; box A cannot relay or report for store B', () => {
  let cloud: RealCloud;
  let api: Api;
  const dirs: string[] = [];
  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    api = {
      tenant: cloud.tenantId,
      raw: async (method, path, token, body, key, query) => {
        const qs = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
        const res = await fetch(`${cloud.baseUrl}${path}${qs}`, {
          method,
          headers: {
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(key === undefined ? {} : { 'idempotency-key': key }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await res.text();
        return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
      },
    };
  }, 120_000);
  afterAll(async () => {
    await cloud?.stop();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('grant time: a tenant-wide or two-store store computer grant is refused; one store each is granted', async () => { await grantTimeAndSetup(api); });
  it('every record box A relays is checked against SA: its own are banked (once); SB\'s are refused by name, recorded nowhere, and listed', async () => { await everyRecordIsJudged(api); });

  const boxProcess = async (user: string, credentialStore: string, packStore: string): Promise<EdgeProcess> => {
    const dir = await mkdtemp(join(tmpdir(), `sre-ob54-${user}-`));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({ version: 1, policies: { storeId: packStore, branchId: packStore, tradingDayCutoff: '02:00' } }), 'utf8');
    return (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: user, tenantId: cloud.tenantId, branchId: credentialStore }),
    }, () => {}))!;
  };
  const tillSale = (id: string) => JSON.stringify({
    id, number: `R-${id}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: AT.slice(0, 10), committedAt: AT, total: 2_500, currency: 'INR',
    lines: [{ productId: 'MILK', quantityMinor: 1, uom: 'ea', unitPriceMinor: 2_500, lineTotalMinor: 2_500 }],
    tenders: [{ kind: 'cash', amount: { minor: 2_500, currency: 'INR' } }],
  });

  it('the real boxes: each relays its own store\'s sale; box A set up with SB\'s store file is refused — a visible dead letter on the box naming why, and on head office\'s list', async () => {
    const owner = as(api, OWNER);
    const a = await boxProcess(BOX_A, SA, SA);
    const b = await boxProcess(BOX_B, SB, SB);
    try {
      expect((await a.node.commit('BOX-A-1', tillSale('BOX-A-1'))).committed).toBe(true);
      expect((await b.node.commit('BOX-B-1', tillSale('BOX-B-1'))).committed).toBe(true);
      expect(await a.syncOnce!()).toMatchObject({ sent: 1, dead: 0 });
      expect(await b.syncOnce!()).toMatchObject({ sent: 1, dead: 0 });
    } finally { await a.stop(); await b.stop(); }
    expect((await owner.get('/v1/sales/BOX-A-1')).status).toBe(200);
    expect((await owner.get('/v1/sales/BOX-B-1')).status).toBe(200);

    // Box A's credential (SA) with a store file naming SB: the till stamps SB, and head office refuses it by name.
    const wrong = await boxProcess(BOX_A, SA, SB);
    try {
      expect((await wrong.node.commit('BOX-A-WRONG', tillSale('BOX-A-WRONG'))).committed).toBe(true); // the till still trades (hard rule #1)
      expect(await wrong.syncOnce!()).toMatchObject({ dead: 1 });
      expect(wrong.outbox.deadLetters()[0]?.reason).toMatch(/403.*store_computer_record_names_another_store/);
    } finally { await wrong.stop(); }
    expect((await owner.get('/v1/sales/BOX-A-WRONG')).status).toBe(404);
    const refusals = ((await owner.get('/v1/store-computers/refusals')).body as { refusals: { userId: string; namedStore?: string; path: string }[] }).refusals;
    expect(refusals.filter((r) => r.userId === BOX_A && r.namedStore === SB && r.path === '/v1/sales').length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
