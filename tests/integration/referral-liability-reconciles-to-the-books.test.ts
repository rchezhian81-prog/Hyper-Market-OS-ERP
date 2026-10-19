import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **M17-FR-02 / D07-FR-04 (R4, signed OB-227 · OB-221): referral rewards earned but not yet paid are a liability on the
 * books; coupons are not.** "Each payout or expiry reduces the liability by a compensating entry, never an edit. The
 * liability on the books equals the register to the paisa; a difference is an exception. A coupon still cannot be
 * redeemed twice or after expiry." On the real API, in memory and on real PostgreSQL, with a cold restart.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const pg = () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface Liability { register: { outstandingMinor: number; referrals: { referralId: string; outstandingMinor: number; state: string }[] }; account: string | null; booksMinor: number | null; differenceMinor: number | null; reconciles: boolean; exception: { code: string } | null; unposted: unknown[]; coupons: { liability: boolean } }

const MAP = {
  rules: [
    { kind: 'referral:earned', legs: [{ account: 'referral_reward_expense', side: 'debit', component: 'amount' }, { account: 'referral_reward_liability', side: 'credit', component: 'amount' }] },
    { kind: 'referral:paid', legs: [{ account: 'referral_reward_liability', side: 'debit', component: 'amount' }, { account: 'cash', side: 'credit', component: 'amount' }] },
    { kind: 'referral:expired', legs: [{ account: 'referral_reward_liability', side: 'debit', component: 'amount' }, { account: 'referral_reward_expense', side: 'credit', component: 'amount' }] },
  ],
};

describe.each(backings)('referral rewards are a liability that reconciles to the books — on $name (M17-FR-02 · OB-221)', ({ harness, restart }) => {
  it('earned → on the books; a payout and an expiry are compensating entries; a difference is an exception; coupons are not a liability', async () => {
    let h = harness();
    const T = randomUUID();
    if (h.store instanceof SqlEventStore) await h.store.registerTenant(T, 'test/provision');
    await h.seedOwner(T, 'u-owner');
    await h.enableFeature(T, 'loyalty');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const liability = async (): Promise<Liability> => (await ok(req('GET', '/v1/finance/referral-liability'), 'liability')).body as Liability;

    // Before any mapping: the books carry no referral liability yet — said, never a zero that "reconciles".
    const referral = (id: string, referrer: string, referred: string, rewardMinor: number) => req('POST', `/v1/loyalty/referrals/${id}`, { referrerRef: referrer, referredRef: referred, referredPurchases: [{ netMinor: 60_000, at: '2026-10-01T10:00:00Z' }], qualifyingSpendMinor: 50_000, rewardMinor });
    expect((await ok(referral('R1', 'M-anu', 'M-bala', 5_000), 'R1')).status).toBe(201);
    expect((await ok(referral('R2', 'M-chitra', 'M-devi', 3_000), 'R2')).status).toBe(201);
    expect(((await ok(referral('R3', 'M-anu', 'M-anu', 9_000), 'R3 self')).body as { payable: boolean }).payable).toBe(false);
    let l = await liability();
    expect(l.register.outstandingMinor).toBe(8_000);
    expect(l.booksMinor).toBeNull();
    expect(l.reconciles).toBe(false);
    expect(l.exception?.code).toBe('referral_liability_not_mapped');
    expect(l.coupons.liability).toBe(false);
    expect(codeOf(await req('POST', '/v1/finance/referral-liability/post', {}))).toBe('posting_map_not_defined');

    await ok(req('PUT', '/v1/finance/posting-map', MAP), 'map');
    l = await liability();
    expect(l.account).toBe('referral_reward_liability');
    expect(l.booksMinor).toBe(0);
    expect(l.differenceMinor).toBe(-8_000);
    expect(l.exception?.code).toBe('referral_liability_difference');
    expect(l.unposted).toHaveLength(2);

    const posted1 = (await ok(req('POST', '/v1/finance/referral-liability/post', {}), 'post 1')).body as { posted: { entryId: string; lines: { accountCode: string; creditMinor: number }[] }[] };
    expect(posted1.posted.map((j) => j.entryId).sort()).toEqual(['referral:earned:R1', 'referral:earned:R2']);
    l = await liability();
    expect([l.booksMinor, l.differenceMinor, l.reconciles, l.exception]).toEqual([8_000, 0, true, null]);

    // A payout: a new fact on the register; the books still carry it until posted → the difference is an exception.
    expect(codeOf(await req('POST', '/v1/loyalty/referrals/R1/payout', { how: 'cash', reference: '4111 1111 1111 1111' }))).toBe('reference_looks_like_card_data');
    expect(codeOf(await req('POST', '/v1/loyalty/referrals/R1/payout', { how: 'cheque', reference: 'X' }))).toBe('not_readable_as_a_referral_payout');
    expect((await req('POST', '/v1/loyalty/referrals/R1/payout', { how: 'cash', reference: 'RCPT-1' }, 'u-cash')).status).toBe(403);
    await ok(req('POST', '/v1/loyalty/referrals/R1/payout', { how: 'cash', reference: 'RCPT-1' }), 'payout R1');
    l = await liability();
    expect(l.register.outstandingMinor).toBe(3_000);
    expect([l.booksMinor, l.differenceMinor, l.reconciles]).toEqual([8_000, 5_000, false]);
    expect(l.exception?.code).toBe('referral_liability_difference');
    expect(codeOf(await req('POST', '/v1/loyalty/referrals/R1/payout', { how: 'cash', reference: 'RCPT-2' }))).toBe('referral_nothing_outstanding');
    expect((await req('POST', '/v1/loyalty/referrals/R9/payout', { how: 'cash', reference: 'RCPT-3' })).status).toBe(404);
    expect(codeOf(await req('POST', '/v1/loyalty/referrals/R2/expire', {}))).toBe('expiry_needs_a_reason');
    await ok(req('POST', '/v1/loyalty/referrals/R2/expire', { reason: 'not claimed within the scheme period' }), 'expire R2');
    expect(codeOf(await req('POST', '/v1/loyalty/referrals/R2/payout', { how: 'cash', reference: 'RCPT-4' }))).toBe('referral_nothing_outstanding');

    // Cold restart: the register and the books are what happened.
    h = restart(h);
    const posted2 = (await ok(req('POST', '/v1/finance/referral-liability/post', {}), 'post 2')).body as { posted: { entryId: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[] };
    expect(posted2.posted.map((j) => j.entryId).sort()).toEqual(['referral:expired:R2', 'referral:paid:R1']);
    // Compensating entries: each DEBITS the liability; the earning entries are untouched.
    for (const j of posted2.posted) expect(j.lines.find((x) => x.accountCode === 'referral_reward_liability')?.debitMinor).toBeGreaterThan(0);
    l = await liability();
    expect([l.register.outstandingMinor, l.booksMinor, l.differenceMinor, l.reconciles, l.exception]).toEqual([0, 0, 0, true, null]);
    expect(l.register.referrals.map((r) => [r.referralId, r.state])).toEqual([['R1', 'paid'], ['R2', 'expired']]);
    // A re-run posts nothing (each movement posts once).
    expect(((await ok(req('POST', '/v1/finance/referral-liability/post', {}), 'post 3')).body as { posted: unknown[] }).posted).toEqual([]);
    expect((await req('GET', '/v1/finance/referral-liability', undefined, 'u-cash')).status).toBe(403);

    // Coupons: not on the liability, and still single-use and refused after expiry.
    await ok(req('POST', '/v1/loyalty/coupons/ONE-USE', { kind: 'amount_off', valueMinor: 2_000, validUntil: '2099-12-31', maxRedemptions: 1, maxPerCustomer: 1 }), 'coupon');
    await ok(req('POST', '/v1/loyalty/coupons/ONE-USE/redemptions/red-1', { saleId: 'S-1', basketMinor: 10_000 }), 'redeem once');
    expect(codeOf(await req('POST', '/v1/loyalty/coupons/ONE-USE/redemptions/red-2', { saleId: 'S-2', basketMinor: 10_000 }))).toBe('coupon_limit_reached');
    await ok(req('POST', '/v1/loyalty/coupons/OLD', { kind: 'amount_off', valueMinor: 2_000, validUntil: '2020-01-01', maxRedemptions: 5, maxPerCustomer: 5 }), 'old coupon');
    expect(codeOf(await req('POST', '/v1/loyalty/coupons/OLD/redemptions/red-3', { saleId: 'S-3', basketMinor: 10_000 }))).toBe('coupon_expired');
    l = await liability();
    expect([l.register.outstandingMinor, l.booksMinor, l.reconciles]).toEqual([0, 0, true]);
  }, 120_000);
});
