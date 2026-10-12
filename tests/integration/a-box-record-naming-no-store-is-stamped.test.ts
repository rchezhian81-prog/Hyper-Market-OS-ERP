import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import type { HttpRequest } from '../../services/kernel/src/index';
import { storeStampFor, classifyReferences } from '../../services/platform/src/store-computer-identity';

/**
 * **OB-54 round 10 (hard rule #10): a record a store computer relays that names NO store is stamped with the store its
 * signed credential names — by head office, server-side, and recorded as stamped. A store code head office cannot place
 * in any store it knows is refused by name and listed.**
 *
 * Before: a sale, return or day close relayed with no store field was placed later by a guess — the sale's pack, the
 * lane, or "no branch named" (outside every manager's scope). Now, on the real API (in memory, and on real PostgreSQL
 * through the production assembly over HTTP):
 *
 *   • box A (credential SA) relays a sale, a receipted return, a no-receipt return, its day close and a receiving scan
 *     from the phone, each with NO store field — every one is accepted and lands at SA: the sale's own record, the
 *     owner's sales report scoped to SA (bills AND returns), the day-close register, the receiving-scan register;
 *     a report scoped to SB holds none of it;
 *   • each is on head office's stamp list (`GET /v1/store-computers/stamps`) with the field it was stamped at, once —
 *     the same sale replayed under its key is the same one answer and no second stamp;
 *   • a record whose store code is in no known store (sale, return, phone scan) is refused 403
 *     `store_computer_record_names_unknown_store`, nothing is recorded, and it is on the refusal list;
 */

const OWNER = 'u-owner'; const ASKER = 'u-hr';
const BOX_A = 'u-box-a'; const BOX_B = 'u-box-b';
const SA = 'SA'; const SB = 'SB'; const WA = 'SA-BACK';
const AT = new Date(Date.now() - 60_000).toISOString();
const DAY = AT.slice(0, 10);

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

/** A sale exactly as a box relays one — but naming no store anywhere. */
const sale = (saleId: string, over: Record<string, unknown> = {}) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: DAY, committedAt: AT,
  totalMinor: 2_500, currency: 'INR', packVersion: 0,
  lines: [{ productId: 'MILK', quantityMinor: 1, uom: 'ea', unitPriceMinor: 2_500, lineTotalMinor: 2_500 }],
  tenders: [{ kind: 'cash', amountMinor: 2_500 }], ...over,
});
const ret = (returnId: string, over: Record<string, unknown> = {}) => ({
  returnId, processedBy: 'u-cash', reasonCode: 'damaged', refundMinor: 500, refundTender: 'cash', refundStatus: 'settled',
  processedAt: AT, lines: [{ productId: 'MILK', quantityMinor: 1 }], ...over,
});
const scan = (commandId: string, over: Record<string, unknown> = {}) => ({
  commandId, grnId: 'GRN-R10', productId: 'MILK', quantityMinor: 6, uom: 'ea', receivedBy: 'u-mgr-a', source: 'handheld', at: AT, ...over,
});

async function setup(api: Api): Promise<void> {
  const owner = as(api, OWNER);
  // The records here are dated by the test machine's clock (UTC); the shop is set to UTC so head office's trading day
  // agrees at every hour (the India day differs from 18:30 to 24:00 UTC).
  const tz = await api.raw('PUT', '/v1/platform/setup/locale.time_zone', TEST_IDP.issue({ sub: OWNER, tenantId: api.tenant }), { value: 'UTC' }, 'tz');
  expect(tz.status).toBe(200);
  for (const [id, body] of [
    ['C-R10', { kind: 'company', name: 'Synthetic Retail' }],
    [SA, { kind: 'branch', name: 'Store A', parentId: 'C-R10', companyId: 'C-R10' }],
    [SB, { kind: 'branch', name: 'Store B', parentId: 'C-R10', companyId: 'C-R10' }],
    [WA, { kind: 'warehouse', name: 'Back store A', parentId: SA, companyId: 'C-R10' }],
  ] as const) {
    const r = await owner.post(`/v1/org/nodes/${id}`, body, `org-${id}`);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  }
  for (const [grantId, userId, roleId, scope] of [
    ['g-box-a', BOX_A, 'store_computer', [SA]], ['g-box-b', BOX_B, 'store_computer', [SB]], ['g-mgr-a', 'u-mgr-a', 'store_manager', [SA]],
  ] as const) {
    const asked = await as(api, ASKER).post('/v1/identity/grants', { grantId, userId, roleId, branchScope: scope, reason: 'OB-54 round 10 proof' }, `${grantId}-ask`);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect((await as(api, OWNER).post(`/v1/identity/grants/${grantId}/approve`, {}, `${grantId}-approve`)).status).toBe(201);
  }
}

interface Stamp { readonly userId: string; readonly store: string; readonly field: string | null; readonly path: string }
const stampsOf = async (api: Api): Promise<readonly Stamp[]> => ((await as(api, OWNER).get('/v1/store-computers/stamps')).body as { stamps: Stamp[] }).stamps;
const figureOf = (r: Reply, name: string): number | undefined =>
  ((r.body as { figures?: { name: string; valueMinor?: number }[] }).figures ?? []).find((f) => f.name === name)?.valueMinor;

async function recordsNamingNoStoreLandAtTheCredentialsStore(api: Api): Promise<void> {
  const boxA = as(api, BOX_A, SA);
  const owner = as(api, OWNER);

  // A sale with no store: accepted, and its own record now names SA — head office wrote it, not the box.
  const first = await boxA.post('/v1/sales', sale('R10-S1'), 'r10-s1');
  expect(first.status, JSON.stringify(first.body)).toBe(202);
  const replay = await boxA.post('/v1/sales', sale('R10-S1'), 'r10-s1');
  expect(replay.status).toBe(202);
  expect(replay.body).toEqual(first.body);
  expect((await owner.get('/v1/sales/R10-S1')).status).toBe(200);

  // A return against a bill head office has not seen, and a no-receipt return — both with no store.
  expect((await boxA.post('/v1/sales/R10-UNSEEN/returns/synced', ret('R10-RT1'), 'r10-rt1')).status).toBeLessThan(300);
  expect((await boxA.post('/v1/returns/no-receipt/synced', ret('R10-RT2', { noReceipt: true, originalSaleId: null }), 'r10-rt2')).status).toBeLessThan(300);
  // The day close, with no store.
  const dc = await boxA.post('/v1/pos/day-close/r10-dc1/synced', { dayCloseId: 'r10-dc1', tradingDay: DAY, closedBy: 'u-mgr-a', closedAt: AT }, 'r10-dc1');
  expect(dc.status, JSON.stringify(dc.body)).toBe(202);
  // Phone work: a receiving scan from the handheld, with no store.
  const sc = await boxA.post('/v1/inventory/receiving-scans/r10-sc1/synced', scan('r10-sc1'), 'r10-sc1');
  expect(sc.status, JSON.stringify(sc.body)).toBeLessThan(300);

  // Each lands under SA: the owner's sales report scoped to SA has the bill AND both returns; scoped to SB, nothing.
  const atA = await owner.get('/v1/reports/sales_by_day', { day: DAY, scope: SA });
  expect(atA.status, JSON.stringify(atA.body)).toBe(200);
  expect(((atA.body as { rows: { saleId: string }[] }).rows).map((r) => r.saleId)).toContain('R10-S1');
  expect(figureOf(atA, 'Returns')).toBe(2);
  const atB = await owner.get('/v1/reports/sales_by_day', { day: DAY, scope: SB });
  expect(((atB.body as { rows: { saleId: string }[] }).rows).map((r) => r.saleId)).not.toContain('R10-S1');
  expect(figureOf(atB, 'Returns') ?? 0).toBe(0);
  // The day-close register says SA closed; the receiving scan is at SA, and SA's manager sees it.
  const closes = (await owner.get('/v1/pos/day-close')).body as { dayCloses?: { dayCloseId: string; storeId: string }[] };
  expect(JSON.stringify(closes)).toContain('"dayCloseId":"r10-dc1"');
  const dcRec = (Object.values(closes as Record<string, unknown>).find(Array.isArray) as { dayCloseId: string; storeId: string }[]).find((c) => c.dayCloseId === 'r10-dc1');
  expect(dcRec?.storeId).toBe(SA);
  const scans = (await as(api, 'u-mgr-a', SA).get('/v1/inventory/receiving-scans', { grnId: 'GRN-R10' })).body as { scans: { commandId: string; storeId: string }[] };
  expect(scans.scans.find((s) => s.commandId === 'r10-sc1')?.storeId).toBe(SA);

  // Every one is on head office's stamp list, at the field it was stamped — once (the replay stamped nothing more).
  const mine = (await stampsOf(api)).filter((s) => s.userId === BOX_A);
  expect(mine.map((s) => [s.path, s.field, s.store]).sort()).toEqual([
    ['/v1/inventory/receiving-scans/:commandId/synced', 'storeId', SA],
    ['/v1/pos/day-close/:dayCloseId/synced', 'storeId', SA],
    ['/v1/returns/no-receipt/synced', 'locationId', SA],
    ['/v1/sales', 'locationId', SA],
    ['/v1/sales/:saleId/returns/synced', 'locationId', SA],
  ].sort());

  // A record that names its own store is not stamped.
  expect((await boxA.post('/v1/sales', sale('R10-S2', { locationId: WA }))).status).toBe(202);
  expect((await stampsOf(api)).filter((s) => s.userId === BOX_A)).toHaveLength(5);

  // A store code head office cannot place in ANY known store: refused by name, nothing recorded, listed.
  const unknown: readonly [string, string, unknown][] = [
    ['a sale at an unknown store', '/v1/sales', sale('R10-X1', { locationId: 'S-NOWHERE' })],
    ['a return at an unknown store', '/v1/returns/no-receipt/synced', ret('R10-X2', { noReceipt: true, originalSaleId: null, locationId: 'S-NOWHERE' })],
    ['a phone scan at an unknown store', '/v1/inventory/receiving-scans/r10-x3/synced', scan('r10-x3', { storeId: 'S-NOWHERE' })],
  ];
  for (const [what, path, body] of unknown) {
    const r = await boxA.post(path, body);
    expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(403);
    expect(codeOf(r), what).toBe('store_computer_record_names_unknown_store');
  }
  expect((await owner.get('/v1/sales/R10-X1')).status).toBe(404);
  const refusals = ((await owner.get('/v1/store-computers/refusals')).body as { refusals: { userId: string; reason: string; namedStore?: string }[] }).refusals;
  expect(refusals.filter((r) => r.userId === BOX_A && r.reason === 'record_names_unknown_store' && r.namedStore === 'S-NOWHERE')).toHaveLength(3);
  expect((await stampsOf(api)).filter((s) => s.userId === BOX_A)).toHaveLength(5);
}

describe('OB-54 round 10 — the stamp rule itself', () => {
  it('stamps the credential\'s store at the family\'s own field when it is empty; never overwrites; a copy, never the box\'s body', () => {
    const body = { saleId: 's1', lines: [] };
    const out = storeStampFor({ method: 'POST', routePath: '/v1/sales', body, credentialStore: SA, references: [] });
    expect(out).toEqual({ kind: 'stamped', field: 'locationId', body: { saleId: 's1', lines: [], locationId: SA } });
    expect(body).toEqual({ saleId: 's1', lines: [] }); // the box's own request (and its idempotency hash) untouched
    expect(storeStampFor({ method: 'POST', routePath: '/v1/sales', body: { locationId: WA }, credentialStore: SA, references: [{ field: 'body.locationId', value: WA }] })).toEqual({ kind: 'none' });
    expect(storeStampFor({ method: 'POST', routePath: '/v1/warehouse/movements/:commandId/synced', body: { command: { kind: 'pick' } }, credentialStore: SA, references: [] }))
      .toMatchObject({ kind: 'stamped', field: 'command.storeId', body: { command: { kind: 'pick', storeId: SA } } });
    // A route with no store field: attributed to the store, the body left exactly as sealed.
    expect(storeStampFor({ method: 'POST', routePath: '/v1/approvals/decisions/:id/synced', body: { id: 'a' }, credentialStore: SA, references: [] })).toEqual({ kind: 'attributed' });
    expect(storeStampFor({ method: 'GET', routePath: '/v1/sales', body: undefined, credentialStore: SA, references: [] })).toEqual({ kind: 'none' });
    // A family's own store field names a STORE (an unknown code there is refused); a shelf or bin field names a location.
    expect(classifyReferences('/v1/sales', [{ field: 'body.locationId', value: 'X' }, { field: 'body.lines[0].locationId', value: 'Y' }, { field: 'body.storeId', value: 'Z' }]).map((r) => r.names))
      .toEqual(['store', 'location', 'store']);
    expect(classifyReferences('/v1/merchandising/shelf-counts/:countId/synced', [{ field: 'body.locationId', value: 'loc1' }]).map((r) => r.names)).toEqual(['location']);
  });
});

describe('OB-54 round 10 — a box record naming no store lands at the credential\'s store (real API, in memory)', () => {
  const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0b10';
  let h: ApiHarness;
  let api: Api;
  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(tenant, OWNER);
    await h.provisionRole(tenant, ASKER, 'store_manager');
    api = { tenant, raw: (method, path, token, body, key, query) => h.raw({ method, path, token, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) }) };
    await setup(api);
  });
  it('sales, returns, the day close and phone work with no store land at SA, stamped and listed; an unknown store code is refused and listed', async () => {
    await recordsNamingNoStoreLandAtTheCredentialsStore(api);
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

describeOrSkip('OB-54 round 10 — on real PostgreSQL through the production API assembly', () => {
  let cloud: RealCloud;
  let api: Api;
  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: ['r10', 'stamp', 'pack', 'key'].join('-').padEnd(48, '0') });
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
    await setup(api);
  }, 120_000);
  afterAll(async () => { await cloud?.stop(); });
  it('sales, returns, the day close and phone work with no store land at SA, stamped and listed; an unknown store code is refused and listed', async () => {
    await recordsNamingNoStoreLandAtTheCredentialsStore(api);
  }, 120_000);
});
