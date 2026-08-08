import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// B2B salesperson commission — recorded exactly by the engine, read as a running total, never a stored
// balance (M22-FR-03, API-09), end to end through the real API and real RBAC. The server
// computes the payout from the declared base and rate (the caller never states the amount, so a fitted
// figure cannot be slipped in); a cap is applied after an exact half-up round; the total earned is
// PROJECTED by summing the accruals (hard rule #2), and a re-sent accrual collapses rather than earning
// twice. Recording is a finance act; a manager may read what the floor has earned; a cashier neither.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const accrue = (h: ApiHarness, tenantId: string, userId: string, salespersonId: string, accrualId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/b2b/commissions/${salespersonId}/accruals/${accrualId}`, userId, tenantId, idempotencyKey: key ?? `acc-${accrualId}`, body });
const owed = (h: ApiHarness, tenantId: string, userId: string, salespersonId: string) =>
  h.request({ method: 'GET', path: `/v1/b2b/commissions/${salespersonId}`, userId, tenantId });

interface Owed { salespersonId: string; currency: string; totalCommissionMinor: number; totalBaseMinor: number; count: number; accruals: { accrualId: string; commissionMinor: number }[] }

describe('b2b commission: computed exactly, capped, projected, and a re-send does not earn twice (M22-FR-03)', () => {
  it('records commission computed by the engine, rounds half-up, and applies the cap', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // 5% of 10,00,000 = 50,000 exactly.
    expect((await accrue(h, A, 'u-owner', 'SP1', 'a1', { baseMinor: 1_000_000, rateBps: 500 })).body).toMatchObject({ commissionMinor: 50_000 });
    // 1.5% of 100 = 1.5 → half-up → 2 (the exact-money engine, not a float).
    expect((await accrue(h, A, 'u-owner', 'SP1', 'a2', { baseMinor: 100, rateBps: 150 })).body).toMatchObject({ commissionMinor: 2 });
    // 10% of 10,00,000 = 1,00,000, but capped at 60,000 — the cap bites after the round.
    expect((await accrue(h, A, 'u-owner', 'SP1', 'a3', { baseMinor: 1_000_000, rateBps: 1000, capMinor: 60_000 })).body).toMatchObject({ commissionMinor: 60_000 });

    const r = (await owed(h, A, 'u-owner', 'SP1')).body as Owed;
    expect(r.totalCommissionMinor).toBe(110_002);  // 50,000 + 2 + 60,000
    expect(r.totalBaseMinor).toBe(2_000_100);
    expect(r.count).toBe(3);
  });

  it('projects the running total and collapses a re-sent accrual (append-only, never twice)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    await accrue(h, A, 'u-owner', 'SP2', 'a1', { baseMinor: 500_000, rateBps: 400 });      // 20,000
    // The SAME accrual id, a DIFFERENT transport key so it reaches the handler again — the store append
    // is idempotent on the accrual id, so it collapses and the total is not doubled.
    await accrue(h, A, 'u-owner', 'SP2', 'a1', { baseMinor: 500_000, rateBps: 400 }, 'acc-a1-resend');

    const r = (await owed(h, A, 'u-owner', 'SP2')).body as Owed;
    expect(r.totalCommissionMinor).toBe(20_000);
    expect(r.count).toBe(1);
  });

  it('is authorized (record vs read split), per-tenant, and refuses unknown/malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant');       // records AND reads
    await h.provisionRole(A, 'u-mgr', 'store_manager');     // reads, does NOT record
    await h.provisionRole(A, 'u-cash', 'cashier');          // neither

    expect((await accrue(h, A, 'u-acct', 'SP3', 'a1', { baseMinor: 100_000, rateBps: 500 })).status).toBe(201);
    expect((await accrue(h, A, 'u-mgr', 'SP3', 'a2', { baseMinor: 1, rateBps: 500 })).status).toBe(403);
    expect((await accrue(h, A, 'u-cash', 'SP3', 'a3', { baseMinor: 1, rateBps: 500 })).status).toBe(403);
    expect((await owed(h, A, 'u-mgr', 'SP3')).status).toBe(200);   // a manager may read
    expect((await owed(h, A, 'u-cash', 'SP3')).status).toBe(403);

    // Unknown salesperson has no accruals → 404.
    expect((await owed(h, A, 'u-owner', 'GHOST')).status).toBe(404);
    // A rate outside 0–10000 bps and a negative base are refused, nothing recorded.
    expect((await accrue(h, A, 'u-owner', 'SP3', 'a-bad-rate', { baseMinor: 100, rateBps: 20_000 })).status).toBe(400);
    expect((await accrue(h, A, 'u-owner', 'SP3', 'a-bad-base', { baseMinor: -1, rateBps: 500 })).status).toBe(400);

    // Another tenant sees nothing of A's salesperson.
    await h.seedOwner(B, 'u-owner-b');
    expect((await owed(h, B, 'u-owner-b', 'SP3')).status).toBe(404);
  });
});
