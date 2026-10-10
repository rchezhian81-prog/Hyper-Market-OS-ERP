import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { bootShop, forgetfulBasket, type ShopData } from '../../apps/customer-app/src/browser-entry';
import { httpShopTransport } from '../../apps/customer-app/src/shop-transport';
import type { StorefrontProduct } from '../../packages/storefront/src/browse';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore, MemoryIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **The customer's privacy centre saves on the shop, in the customer's own session (audit FUL-06 · M16-FR-02/03 ·
 * M20-FR-04).**
 *
 * The audit switched a consent and raised a request in the app: both said "done", and a fresh boot showed the old
 * consent and no request anywhere. Here the REAL app model (`bootShop` + `httpShopTransport`) talks to the REAL API
 * kernel (token, RBAC, idempotency, event store): a consent change is saved on the customer's own ledger and READ BACK
 * by a fresh boot; a withdrawal excludes that customer from the very next campaign the staff plan; a raised request
 * lands in the DPO's queue under the signed-in customer (never an id in the body); one customer never sees another's;
 * a customer cannot open the DPO queue; and with no road to the shop nothing is claimed. Then the same on real
 * PostgreSQL, across a restart (a new process over the same database).
 */

let T = 'ab000000-0000-4000-8000-000000000f06';
const OWNER = 'u-owner'; const C1 = 'cust-f06-1'; const C2 = 'cust-f06-2';
const MILK: StorefrontProduct = {
  productId: 'MILK', name: 'Aavin Milk 1L', categoryId: 'dairy', unitPriceMinor: 60_00, uom: 'each',
  barcodes: ['8901234567891'], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1,
};
const data = (over: Partial<ShopData> = {}): ShopData => ({
  tenantId: T, products: [MILK], packVersion: 1, locationId: 'L1',
  consentPurposes: [{ purpose: 'transactional', channel: 'sms', required: true }, { purpose: 'marketing', channel: 'sms' }],
  ...over,
});

/** The app's `fetch`, wired straight into the real API kernel — what a same-origin reverse proxy does. */
function fetchInto(h: ApiHarness, log: string[] = []) {
  return (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers['authorization'] ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const method = (init?.method ?? 'GET') as 'GET' | 'POST';
    const key = headers['idempotency-key'];
    log.push(`${method} ${String(url)}`);
    const res = await h.raw({
      method, path: String(url), ...(token === undefined ? {} : { token }),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
      ...(key === undefined ? {} : { idempotencyKey: key }),
    });
    return new Response(JSON.stringify(res.body ?? null), { status: res.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
}

const tokenFor = (sub: string) => TEST_IDP.issue({ sub, tenantId: T, amr: ['otp'] });
let ids = 0;
function appFor(h: ApiHarness, customer: string, log?: string[]) {
  const shop = bootShop(data({ customerRef: customer }), forgetfulBasket(), () => `DSR-F06-${customer}-${(ids += 1)}`, httpShopTransport({ fetch: fetchInto(h, log) }))!;
  shop.signedIn(tokenFor(customer));
  return shop;
}

async function cast(h: ApiHarness): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, C1, 'customer');
  await h.provisionRole(T, C2, 'customer');
  // Head office's approved marketing template (PF-10 / PA-08): drafted by one owner, approved by another.
  await h.provisionOwner(T, 'u-owner-2');
  await h.request({ method: 'POST', path: '/v1/notifications/templates/tpl-1', userId: OWNER, tenantId: T, idempotencyKey: 'tpl-1-draft', body: { purpose: 'marketing', channel: 'sms', body: 'Fresh offers this week at SRE.' } });
  const ok = await h.request({ method: 'POST', path: '/v1/notifications/templates/tpl-1/approval', userId: 'u-owner-2', tenantId: T, idempotencyKey: 'tpl-1-approve', body: { version: 1 } });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
}

const planCampaign = (h: ApiHarness, campaignId: string) => h.request({
  method: 'POST', path: `/v1/service/campaigns/${campaignId}/plan`, userId: OWNER, tenantId: T, idempotencyKey: `plan-${campaignId}`,
  body: { purpose: 'marketing', channel: 'sms', templateId: 'tpl-1', templateApproved: true, containsPromotion: true, audience: [C1, C2] },
});
const dpoQueue = (h: ApiHarness) => h.request({ method: 'GET', path: '/v1/privacy/data-requests', userId: OWNER, tenantId: T });

/** The whole journey, against whatever store the harness holds. `restart` builds a NEW harness over the same store. */
async function journey(h: ApiHarness, restart: () => ApiHarness): Promise<void> {
  const log: string[] = [];
  const app = appFor(h, C1, log);
  const app2 = appFor(h, C2);

  // Both customers say yes to marketing SMS — saved on the shop, the switch moves only after the read-back.
  const on = await app.setConsent('marketing', 'sms', true);
  expect(on, JSON.stringify(on)).toMatchObject({ ok: true, granted: true });
  expect(log).toEqual(['POST /v1/me/privacy/consent', 'GET /v1/me/privacy']);
  expect((await app2.setConsent('marketing', 'sms', true)).ok).toBe(true);
  expect(app.consent().find((c) => c.purpose === 'marketing')?.granted).toBe(true);

  // A FRESH boot (a new tab, nothing carried over) reads what the SHOP holds — the audit's reset is gone.
  const fresh = appFor(h, C1);
  expect(fresh.consent().find((c) => c.purpose === 'marketing')?.granted).toBe(false); // nothing known before the read
  expect((await fresh.loadPrivacy()).ok).toBe(true);
  expect(fresh.consent().find((c) => c.purpose === 'marketing')?.granted).toBe(true);

  // The campaign before the withdrawal reaches both.
  const before = await planCampaign(h, 'camp-f06-a');
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  expect((before.body as { sendTo: string[] }).sendTo.sort()).toEqual([C1, C2]);

  // C1 withdraws in the app — and the very next campaign excludes C1 (M16-FR-02 acceptance).
  const off = await fresh.setConsent('marketing', 'sms', false);
  expect(off).toMatchObject({ ok: true, granted: false });
  expect(fresh.consent().find((c) => c.purpose === 'marketing')?.granted).toBe(false);
  const after = await planCampaign(h, 'camp-f06-b');
  expect((after.body as { sendTo: string[] }).sendTo).toEqual([C2]);
  expect((after.body as { excludedCount: number }).excludedCount).toBe(1);

  // The ledger keeps both facts, with the customer's own session as evidence (history retained, PRV).
  const ledger = await h.request({ method: 'GET', path: `/v1/customers/${C1}/consent`, userId: OWNER, tenantId: T });
  const records = (ledger.body as { records: { given: boolean; evidence: string }[] }).records;
  expect(records.map((r) => r.given)).toEqual([true, false]);
  expect(records.every((r) => r.evidence.includes(`signed in as ${C1}`))).toBe(true);

  // C1 raises an erasure request in the app — it lands in the DPO queue, under C1, raised and unverified.
  const raised = await fresh.raise('erasure', '2026-10-10T10:00:00.000Z');
  expect(raised.ok, JSON.stringify(raised)).toBe(true);
  if (!raised.ok) return;
  expect(raised.tellTheCustomer).toMatch(/invoices and tax records/);
  const queue = (await dpoQueue(h)).body as { queue: { requestId: string; customerRef: string; kind: string; state: string }[] };
  expect(queue.queue).toEqual([expect.objectContaining({ requestId: raised.request.requestId, customerRef: C1, kind: 'erasure', state: 'raised' })]);

  // A retry of the same raise (the answer was lost) is the same request — never two.
  const again = await h.raw({ method: 'POST', path: `/v1/me/privacy/requests/${raised.request.requestId}`, token: tokenFor(C1), idempotencyKey: 'retry-new-key', body: { kind: 'erasure' } });
  expect(again.status).toBe(200);
  expect((again.body as { alreadyRaised: boolean }).alreadyRaised).toBe(true);
  expect(((await dpoQueue(h)).body as { count: number }).count).toBe(1);

  // C2 cannot take over C1's reference, and does not learn whose it is; C2's position shows nothing of C1's.
  const stolen = await h.raw({ method: 'POST', path: `/v1/me/privacy/requests/${raised.request.requestId}`, token: tokenFor(C2), idempotencyKey: 'steal', body: { kind: 'erasure' } });
  expect(stolen.status).toBe(409);
  expect(JSON.stringify(stolen.body)).not.toContain(C1);
  // A body that names another customer is ignored — the session decides who.
  const sneaky = await h.raw({ method: 'POST', path: '/v1/me/privacy/consent', token: tokenFor(C2), idempotencyKey: 'sneaky', body: { purpose: 'marketing', channel: 'email', given: true, customerId: C1 } });
  expect(sneaky.status).toBe(201);
  const c1Email = ((await h.request({ method: 'GET', path: `/v1/customers/${C1}/consent`, userId: OWNER, tenantId: T })).body as { records: { channel: string }[] }).records;
  expect(c1Email.some((r) => r.channel === 'email')).toBe(false);
  const c2View = (await h.raw({ method: 'GET', path: '/v1/me/privacy', token: tokenFor(C2) })).body as { customerRef: string; requests: unknown[] };
  expect(c2View).toMatchObject({ customerRef: C2, requests: [] });

  // A customer cannot open the DPO queue, nor another customer's consent.
  expect((await h.raw({ method: 'GET', path: '/v1/privacy/data-requests', token: tokenFor(C1) })).status).toBe(403);
  expect((await h.raw({ method: 'GET', path: `/v1/customers/${C2}/consent`, token: tokenFor(C1) })).status).toBe(403);
  // Staff cannot use the customer's own route (it is the customer's session, not a staff tool).
  expect((await h.request({ method: 'GET', path: '/v1/me/privacy', userId: OWNER, tenantId: T })).status).toBe(403);

  // Transactional messages cannot be switched off — refused by the shop too, nothing written.
  const required = await h.raw({ method: 'POST', path: '/v1/me/privacy/consent', token: tokenFor(C1), idempotencyKey: 'req-off', body: { purpose: 'transactional', channel: 'sms', given: false } });
  expect(required.status).toBe(409);

  // RESTART: a new process over the same store — the consent and the request are still there, as saved.
  const h2 = restart();
  const reborn = appFor(h2, C1);
  expect((await reborn.loadPrivacy()).ok).toBe(true);
  expect(reborn.consent().find((c) => c.purpose === 'marketing')?.granted).toBe(false);
  expect(reborn.myRequests()).toEqual([expect.objectContaining({ requestId: raised.request.requestId, kind: 'erasure', state: 'raised' })]);
  expect((((await dpoQueue(h2)).body) as { count: number }).count).toBe(1);
  const third = await planCampaign(h2, 'camp-f06-c');
  expect((third.body as { sendTo: string[] }).sendTo).toEqual([C2]);
}

describe('the customer privacy centre saves on the shop (FUL-06)', () => {
  it('saves, reads back, excludes from the next campaign, reaches the DPO queue — in memory, across a restart', async () => {
    const h = apiHarness();
    await cast(h);
    await journey(h, () => apiHarness({ store: h.store, idempotency: new MemoryIdempotencyStore() }));
  });

  it('with no road to the shop, nothing is saved and nothing is claimed', async () => {
    const h = apiHarness();
    await cast(h);
    const app = bootShop(data({ customerRef: C1 }), forgetfulBasket(), () => 'DSR-OFFLINE-1',
      httpShopTransport({ fetch: fetchInto(h), isOnline: () => false }))!;
    app.signedIn(tokenFor(C1));
    expect(await app.setConsent('marketing', 'sms', true)).toMatchObject({ ok: false, refusal: 'not_saved_no_connection' });
    expect(app.consent().find((c) => c.purpose === 'marketing')?.granted).toBe(false);
    expect(await app.raise('access', '2026-10-10T10:00:00.000Z')).toMatchObject({ ok: false, refusal: 'not_saved_no_connection' });
    expect(((await dpoQueue(h)).body as { count: number }).count).toBe(0);
    // A signed-out session is told to sign in; the shop answers 401 on a bad token and the app says so.
    const out = bootShop(data({ customerRef: C1 }), forgetfulBasket(), () => 'DSR-X-1', httpShopTransport({ fetch: fetchInto(h) }))!;
    out.signedIn('not-a-token');
    expect(await out.setConsent('marketing', 'sms', true)).toMatchObject({ ok: false, refusal: 'signed_out' });
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('the customer privacy centre saves on the shop — real PostgreSQL, across a restart (FUL-06)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('the same journey on PostgreSQL; the restart is a new store + idempotency over the same database', async () => {
    const sql = pgPoolClient(pool);
    const fresh = (): { store: EventStore; idempotency: SqlIdempotencyStore } => ({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    const h = apiHarness(fresh());
    T = randomUUID(); // a fresh synthetic tenant per run
    await cast(h);
    await journey(h, () => apiHarness(fresh()));
  });
});
