import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { returnsAdapter } from '../../services/api/src/adapters';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

// Returns and refunds, end to end through the real API (M13-FR-01/FR-03, M21, API-05). A refund is
// where money leaves the till, so the cloud is the authoritative guard: it sees every return against
// a bill at once, where a single lane sees only its own log. This proves the wired returns surface
// against the real pipeline and real per-tenant RBAC — the cloud register is now FED, so the same
// receipt cannot be refunded twice (hard rule #2: corrections are compensating events, never a
// second bite), a refund can never exceed what was paid, and a material refund needs a second person
// (§28). A card refund is reported PENDING, never assumed settled (M13-FR-04).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-08-07T10:00:00.000Z';

// A bill: 3 units of P1 at ₹50, paid ₹150 in cash.
const sale = (over: Record<string, unknown> = {}) => ({
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-08-07', committedAt: AT, totalMinor: 15000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amountMinor: 15000 }],
  ...over,
});

const bank = (h: ApiHarness, tenantId: string, userId: string, body = sale()) =>
  h.request({ method: 'POST', path: '/v1/sales', userId, tenantId, idempotencyKey: `bank-${(body as { saleId: string }).saleId}`, body });

const ret = (h: ApiHarness, tenantId: string, userId: string, saleId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/sales/${saleId}/returns`, userId, tenantId, idempotencyKey: `ret-${body['returnId']}`, body });

// A return of `qty` units of P1, refunding `refundMinor`, resold. The refund threshold defaults to 0
// (every refund is material and needs a §28 approver), so `req` carries a genuine approver — `u-mgr`, a
// store_manager who holds `pos.return.approve` and differs from the caller (`u-owner`). `processedBy` and
// the threshold are NOT body fields any more: the processor is the authenticated caller and the threshold
// is the tenant's policy. Tests that assert a non-approval refusal override `approvedBy`.
const line = (qty = 1) => ({ productId: 'P1', uom: 'each', quantityMinor: qty, disposition: 'resell' as const });
const req = (over: Record<string, unknown>) => ({
  returnId: 'RT1', reasonCode: 'customer_changed_mind',
  lines: [line(1)], refundMinor: 5000, refundTender: 'cash', approvedBy: 'u-mgr', ...over,
});

// Seed the tenant with an owner (the refund processor) and a store_manager `u-mgr` who holds
// `pos.return.approve` — a genuine, different second person for every material refund.
async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  return h;
}

interface Body { returnId?: string; refundStatus?: string; restockedLines?: number; remaining?: { productId: string; returnableMinor: number }[] }
/** The error code lives at `body.error.code` — the kernel wraps every refusal in an `error` envelope. */
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe('a refund is guarded where the whole history lives (M13/M21, API-05)', () => {
  it('refunds a receipted return and shows what is left on the bill', async () => {
    const h = await cast();
    expect((await bank(h, A, 'u-owner')).status).toBe(202);

    const res = await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT1', lines: [line(1)], refundMinor: 5000 }));
    expect(res.status).toBe(201);
    const body = res.body as Body;
    expect(body.refundStatus).toBe('settled'); // cash settles at the desk
    expect(body.restockedLines).toBe(1); // resold → back on the shelf
    expect(body.remaining?.find((r) => r.productId === 'P1')?.returnableMinor).toBe(2); // 3 sold − 1 back
  });

  it('enforces at-most-once against the whole history — the guard the cloud was not feeding', async () => {
    const h = await cast();
    await bank(h, A, 'u-owner');

    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT1', lines: [line(2)], refundMinor: 10000 }))).status).toBe(201);
    // Only 1 of the 3 is left; asking 2 back is refused as over-returned, not silently paid.
    const over = await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT2', lines: [line(2)], refundMinor: 5000 }));
    expect(over.status).toBe(422);
    expect(codeOf(over)).toBe('more_than_was_sold');
    // The last one is fine.
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT3', lines: [line(1)], refundMinor: 5000 }))).status).toBe(201);
  });

  it('never refunds more money than the bill was paid (M13-FR-03)', async () => {
    const h = await cast();
    await bank(h, A, 'u-owner');

    // One unit back, but a refund of ₹200 against a ₹150 bill — refused before any approval question.
    const res = await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT1', lines: [line(1)], refundMinor: 20000 }));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('refund_exceeds_what_is_left');
  });

  it('every refund needs a genuinely-authorised second person (§28, default threshold 0)', async () => {
    const h = await cast();
    await h.provisionRole(A, 'u-cash', 'cashier'); // holds pos.return.record but NOT pos.return.approve
    await bank(h, A, 'u-owner');

    // At the default 0 threshold every refund is material. No approver → refused.
    expect(codeOf(await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RM1', approvedBy: undefined })))).toBe('needs_a_second_person');
    // The processor cannot approve their own refund (the caller u-owner IS processedBy).
    expect(codeOf(await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RM2', approvedBy: 'u-owner' })))).toBe('approved_by_the_person_processing_it');
    // A named approver who does NOT hold pos.return.approve does not count — a cashier, or a made-up name.
    expect(codeOf(await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RM3', approvedBy: 'u-cash' })))).toBe('approver_may_not_approve');
    expect(codeOf(await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RM4', approvedBy: 'u-nobody' })))).toBe('approver_may_not_approve');
    // A genuine supervisor (store_manager), different from the processor → allowed.
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RM5', approvedBy: 'u-mgr' }))).status).toBe(201);
  });

  it('the refund threshold is the tenant policy — default 0, owner-settable, not the caller\'s to declare', async () => {
    const h = await cast();
    await h.provisionRole(A, 'u-cash', 'cashier');
    await bank(h, A, 'u-owner');

    const getT = (u: string) => h.request({ method: 'GET', path: '/v1/pos/refund-threshold', userId: u, tenantId: A });
    const setT = (u: string, body: unknown, key: string) => h.request({ method: 'POST', path: '/v1/pos/refund-threshold', userId: u, tenantId: A, idempotencyKey: key, body });

    // The default is readable and 0 — every refund needs an approver.
    expect((await getT('u-owner')).body).toMatchObject({ thresholdMinor: 0, isDefault: true });
    // Only the owner may set it — a cashier and even a store_manager cannot.
    expect((await setT('u-cash', { thresholdMinor: 10000 }, 't-cash')).status).toBe(403);
    expect((await setT('u-mgr', { thresholdMinor: 10000 }, 't-mgr')).status).toBe(403);
    // The owner raises it to ₹100.
    expect((await setT('u-owner', { thresholdMinor: 10000 }, 't-ok')).status).toBe(200);
    expect((await getT('u-owner')).body).toMatchObject({ thresholdMinor: 10000, isDefault: false });
    // A ₹50 refund is now BELOW the ₹100 threshold → immaterial, no approver needed (was material at 0).
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RTB', refundMinor: 5000, approvedBy: undefined }))).status).toBe(201);
  });

  it('reports a card refund as pending, never assumed settled (M13-FR-04)', async () => {
    const h = await cast();
    await bank(h, A, 'u-owner');

    const res = await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT1', lines: [line(1)], refundMinor: 5000, refundTender: 'card' }));
    expect(res.status).toBe(201);
    expect((res.body as Body).refundStatus).toBe('pending');
  });

  it('refuses a product that was not on the bill, and a bill it never banked', async () => {
    const h = await cast();
    await bank(h, A, 'u-owner');

    const ghost = await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RG1', lines: [{ productId: 'P-GHOST', uom: 'each', quantityMinor: 1, disposition: 'resell' }] }));
    expect(ghost.status).toBe(422);
    expect(codeOf(ghost)).toBe('product_not_on_this_bill');

    // A return against a sale this system never saw is a 404, not a guess.
    expect((await ret(h, A, 'u-owner', 'S-NONE', req({ returnId: 'RN1' }))).status).toBe(404);
  });

  it('is idempotent on the return id — a retry does not double-count the goods', async () => {
    const h = await cast();
    await bank(h, A, 'u-owner');

    // The till resends what it could not confirm: same return id, twice. Both succeed, one refund.
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RX', lines: [line(2)], refundMinor: 10000 }))).status).toBe(201);
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RX', lines: [line(2)], refundMinor: 10000 }))).status).toBe(201);

    // If the retry had counted twice, 4 of 3 would be returned and nothing would be left. Instead 1 is.
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RY', lines: [line(1)], refundMinor: 5000 }))).status).toBe(201);
    const over = await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RZ', lines: [line(1)], refundMinor: 5000 }));
    expect(over.status).toBe(422);
    expect(codeOf(over)).toBe('more_than_was_sold');
  });

  it('is authorized and per-tenant: a role without the permission is refused, and one tenant\'s sale is invisible to another', async () => {
    const h = await cast();
    await h.provisionRole(A, 'u-acct', 'accountant'); // an accountant holds no POS return permission
    await bank(h, A, 'u-owner');

    expect((await ret(h, A, 'u-acct', 'S1', req({ returnId: 'RA1' }))).status).toBe(403);

    // Tenant B never banked S1, so B returning against it finds nothing — A's sale did not leak.
    await h.seedOwner(B, 'u-owner-b');
    expect((await ret(h, B, 'u-owner-b', 'S1', req({ returnId: 'RB1' }))).status).toBe(404);
  });

  it('refuses an empty or unreadable return without moving money', async () => {
    const h = await cast();
    await bank(h, A, 'u-owner');

    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RE1', lines: [] }))).status).toBe(422); // no lines
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RE2', reasonCode: '' }))).status).toBe(422); // no reason
    // A structurally-broken payload (no refund amount) is a 400 before any assessment.
    expect((await h.request({ method: 'POST', path: '/v1/sales/S1/returns', userId: 'u-owner', tenantId: A, idempotencyKey: 'ret-RE3', body: { returnId: 'RE3', reasonCode: 'x', lines: [line(1)], refundTender: 'cash' } })).status).toBe(400);
  });
});

// ── The register the guard runs against is now LEGIBLE, not only enforced (M21, API-05) ──────────
//
// The POST above enforces the at-most-once and refund-cap rules; these two GETs let a person SEE the
// same register: what may still come back on a bill, and — one rung up, for loss not for the desk —
// where more has come back than went out. Both fold the whole cloud history of the bill; both move no
// money. The RBAC split mirrors the stored-value pooled-balance vs double-spend split exactly.

interface Returnable {
  readonly saleId: string; readonly number: string; readonly totalMinor: number;
  readonly refundedMinor: number; readonly refundableMinor: number;
  readonly returnable: readonly { productId: string; uom: string; soldMinor: number; alreadyReturnedMinor: number; returnableMinor: number }[];
}
interface OverReturns {
  readonly saleId: string; readonly anyFound: boolean;
  readonly overReturned: readonly { productId: string; soldMinor: number; returnedMinor: number }[];
}

const getReturnable = (h: ApiHarness, tenant: string, userId: string, saleId: string) =>
  h.request({ method: 'GET', path: `/v1/sales/${saleId}/returnable`, userId, tenantId: tenant });
const getOverReturns = (h: ApiHarness, tenant: string, userId: string, saleId: string) =>
  h.request({ method: 'GET', path: `/v1/sales/${saleId}/over-returns`, userId, tenantId: tenant });

/** A return that arrives already recorded — another branch's box synced up, or a migrated history row.
 *  It bypasses THIS lane's guard exactly as a real synced `ReturnRecorded` event does (the branch that
 *  took it ran its own guard against its own log), so it is how an over-return legitimately exists. */
const syncForeignReturn = (h: ApiHarness, tenant: string, saleId: string, over: { returnId: string; qty: number; refundMinor?: number }) =>
  returnsAdapter({ store: h.store, now: () => AT }).recordReturn(tenant, saleId, {
    returnId: over.returnId, number: over.returnId, originalSaleId: saleId, processedBy: 'u-branch2',
    processedAt: AT, reasonCode: 'migrated', refundMinor: over.refundMinor ?? 0, refundTender: 'cash',
    refundStatus: 'settled', lines: [{ productId: 'P1', uom: 'each', quantityMinor: over.qty, disposition: 'resell' }],
  });

describe('the return register is legible, not only enforced (M21, API-05)', () => {
  it('reads what may still come back on a bill and how much money is left to refund', async () => {
    const h = await cast();
    await bank(h, A, 'u-owner'); // 3 units of P1, paid ₹150
    // One unit back, ₹50 refunded — a partial return, so the bill is not exhausted.
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT1', lines: [line(1)], refundMinor: 5000 }))).status).toBe(201);

    const res = await getReturnable(h, A, 'u-owner', 'S1');
    expect(res.status).toBe(200);
    const body = res.body as Returnable;
    const p1 = body.returnable.find((l) => l.productId === 'P1')!;
    expect(p1.soldMinor).toBe(3);
    expect(p1.alreadyReturnedMinor).toBe(1);
    expect(p1.returnableMinor).toBe(2);          // 3 sold − 1 back
    expect(body.refundedMinor).toBe(5000);
    expect(body.refundableMinor).toBe(10000);    // ₹150 − ₹50 already refunded
  });

  it('surfaces a bill over-returned by history the front door forbids — a loss surface gated above the desk (P-04)', async () => {
    const h = await cast();
    await h.provisionRole(A, 'u-cash', 'cashier');
    await bank(h, A, 'u-owner'); // 3 units sold

    // A clean bill: nothing has over-returned.
    expect((await getOverReturns(h, A, 'u-owner', 'S1')).body as OverReturns).toMatchObject({ anyFound: false, overReturned: [] });

    // 5 come back against 3 sold, from another branch's synced log — money gone twice, impossible
    // through this guard yet real in the ledger. The read names it rather than clamping it away.
    await syncForeignReturn(h, A, 'S1', { returnId: 'RT-MIGRATED', qty: 5 });
    const over = (await getOverReturns(h, A, 'u-owner', 'S1')).body as OverReturns;
    expect(over.anyFound).toBe(true);
    expect(over.overReturned).toEqual([{ productId: 'P1', soldMinor: 3, returnedMinor: 5 }]);

    // Least privilege: a cashier reads what is returnable at the desk…
    expect((await getReturnable(h, A, 'u-cash', 'S1')).status).toBe(200);
    // …but is refused the over-refund loss report — it is gated on lp.case.read, which a cashier
    // does not hold. The refusal is the permission, before the fold even runs.
    expect((await getOverReturns(h, A, 'u-cash', 'S1')).status).toBe(403);
  });

  it('answers a bill it never banked with a 404, and never crosses tenants (§35)', async () => {
    const h = await cast();
    await h.seedOwner(B, 'u-owner-b');
    await bank(h, A, 'u-owner');

    // An unknown bill is a 404, not a guessed empty answer.
    expect((await getReturnable(h, A, 'u-owner', 'S-NONE')).status).toBe(404);
    // Tenant A's sale is invisible to tenant B on both reads — B's owner is authorized but the bill
    // is not on B's ledger, so it is a 404, never a leak.
    expect((await getReturnable(h, B, 'u-owner-b', 'S1')).status).toBe(404);
    expect((await getOverReturns(h, B, 'u-owner-b', 'S1')).status).toBe(404);
  });
});

// The same reads end to end against real PostgreSQL — proving the register fold, the money cap and the
// RBAC gate hold on the actual database, not only the in-memory reference. Skips (never passes quietly)
// without DATABASE_URL; runs in the "Stage gate suites" CI job.
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `r${Date.now().toString(36)}`;
// A unique tenant per run — an append-only database keeps what earlier runs put in it (§35).
const E2E_TENANT = `d${Date.now().toString(16).slice(-7)}-dddd-4ddd-8ddd-${'d'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('the return register is legible end to end on real PostgreSQL (M21, API-05)', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(sql, readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await client.end(); });

  it('reads returnable + refundable and surfaces an over-return, with RBAC, on real PostgreSQL', async () => {
    const sql = pgClient(client);
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await h.seedOwner(E2E_TENANT, 'u-owner');
    await h.provisionRole(E2E_TENANT, 'u-mgr', 'store_manager'); // holds pos.return.approve (the refund approver)
    await h.provisionRole(E2E_TENANT, 'u-cash', 'cashier');

    const S = `${RUN}-S1`;
    expect((await bank(h, E2E_TENANT, 'u-owner', sale({ saleId: S }))).status).toBe(202);
    expect((await ret(h, E2E_TENANT, 'u-owner', S, req({ returnId: `${RUN}-RT1`, lines: [line(1)], refundMinor: 5000 }))).status).toBe(201);

    const returnable = (await getReturnable(h, E2E_TENANT, 'u-owner', S)).body as Returnable;
    expect(returnable.returnable.find((l) => l.productId === 'P1')?.returnableMinor).toBe(2);
    expect(returnable.refundableMinor).toBe(10000);

    // A migrated / cross-branch return of 5, folded from the real returns stream on top of the 1
    // already returned above (RT1): 6 back against 3 sold — money gone twice, surfaced not clamped.
    await syncForeignReturn(h, E2E_TENANT, S, { returnId: `${RUN}-RTM`, qty: 5 });
    const over = (await getOverReturns(h, E2E_TENANT, 'u-owner', S)).body as OverReturns;
    expect(over.anyFound).toBe(true);
    expect(over.overReturned).toEqual([{ productId: 'P1', soldMinor: 3, returnedMinor: 6 }]); // 1 (RT1) + 5 (RTM)

    // Least privilege holds against the real database too: a cashier is refused the loss surface.
    expect((await getOverReturns(h, E2E_TENANT, 'u-cash', S)).status).toBe(403);
  });
});
