import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// B2B credit control, end to end through the real API (M22-FR-01, API-09). A business customer has a
// credit limit and a running AR balance (invoices raised, payments received, projected — never
// stored). An order that would push the balance past the limit is BLOCKED pending a separate approver
// (§28) — never a silent override; an expired contract blocks per policy. Proves the wired B2B credit
// surface against the real pipeline and real per-tenant RBAC — another engine nothing fed.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const setAccount = (h: ApiHarness, tenantId: string, userId: string, customerId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/b2b/accounts/${customerId}`, userId, tenantId, idempotencyKey: key ?? `acc-${customerId}`, body });

const receivable = (h: ApiHarness, tenantId: string, userId: string, customerId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/b2b/accounts/${customerId}/receivables`, userId, tenantId, idempotencyKey: `ar-${body['movementId']}`, body });

const creditCheck = (h: ApiHarness, tenantId: string, userId: string, customerId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/b2b/accounts/${customerId}/credit-check`, userId, tenantId, idempotencyKey: key ?? `cc-${body['orderId']}`, body });

const getAccount = (h: ApiHarness, tenantId: string, userId: string, customerId: string) =>
  h.request({ method: 'GET', path: `/v1/b2b/accounts/${customerId}`, userId, tenantId });

interface Acct { creditLimitMinor: number; outstandingMinor: number; availableCreditMinor: number }
interface Decision { verdict: string; allowed: boolean; requiresApproval: boolean; availableCreditMinor: number }

describe('B2B orders are checked against a credit limit and contract (M22-FR-01, API-09)', () => {
  it('projects the outstanding balance from invoices and payments', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await setAccount(h, A, 'u-owner', 'ACME', { creditLimitMinor: 100_000 })).status).toBe(201);

    await receivable(h, A, 'u-owner', 'ACME', { movementId: 'i1', kind: 'invoice', amountMinor: 30_000 });
    await receivable(h, A, 'u-owner', 'ACME', { movementId: 'p1', kind: 'payment', amountMinor: 10_000 });

    expect((await getAccount(h, A, 'u-owner', 'ACME')).body as Acct).toMatchObject({ creditLimitMinor: 100_000, outstandingMinor: 20_000, availableCreditMinor: 80_000 });
  });

  it('allows an order within the limit', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setAccount(h, A, 'u-owner', 'ACME', { creditLimitMinor: 100_000 });
    await receivable(h, A, 'u-owner', 'ACME', { movementId: 'i1', kind: 'invoice', amountMinor: 20_000 });

    const r = (await creditCheck(h, A, 'u-owner', 'ACME', { orderId: 'O1', orderValueMinor: 50_000 })).body as Decision;
    expect(r).toMatchObject({ verdict: 'ok', allowed: true, requiresApproval: false });
  });

  it('blocks an over-limit order pending a separate approver (§28)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setAccount(h, A, 'u-owner', 'ACME', { creditLimitMinor: 100_000 });
    await receivable(h, A, 'u-owner', 'ACME', { movementId: 'i1', kind: 'invoice', amountMinor: 20_000 });

    // 20000 + 90000 = 110000 > 100000 → over limit.
    const noApproval = (await creditCheck(h, A, 'u-owner', 'ACME', { orderId: 'O2', orderValueMinor: 90_000 })).body as Decision;
    expect(noApproval).toMatchObject({ verdict: 'over_limit', allowed: false, requiresApproval: true });

    // The order-taker cannot approve their own over-limit order.
    const selfApproved = (await creditCheck(h, A, 'u-owner', 'ACME', { orderId: 'O2', orderValueMinor: 90_000, approvedBy: 'u-owner' }, 'cc-O2-self')).body as Decision;
    expect(selfApproved.allowed).toBe(false);

    // A different person can authorise it.
    const approved = (await creditCheck(h, A, 'u-owner', 'ACME', { orderId: 'O2', orderValueMinor: 90_000, approvedBy: 'u-credit-mgr' }, 'cc-O2-ok')).body as Decision;
    expect(approved).toMatchObject({ verdict: 'over_limit', allowed: true });
  });

  it('blocks an expired contract by default, releasable with approval', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setAccount(h, A, 'u-owner', 'ACME', { creditLimitMinor: 100_000 });

    const blocked = (await creditCheck(h, A, 'u-owner', 'ACME', { orderId: 'O3', orderValueMinor: 1_000, contractExpired: true })).body as Decision;
    expect(blocked).toMatchObject({ verdict: 'contract_expired', allowed: false });
    const released = (await creditCheck(h, A, 'u-owner', 'ACME', { orderId: 'O3', orderValueMinor: 1_000, contractExpired: true, approvedBy: 'u-credit-mgr' }, 'cc-O3-ok')).body as Decision;
    expect(released.allowed).toBe(true);
  });

  it('applies the latest credit limit when it changes', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setAccount(h, A, 'u-owner', 'ACME', { creditLimitMinor: 100_000 }, 'acc-1');
    await setAccount(h, A, 'u-owner', 'ACME', { creditLimitMinor: 150_000 }, 'acc-2'); // raised
    expect(((await getAccount(h, A, 'u-owner', 'ACME')).body as Acct).creditLimitMinor).toBe(150_000);
  });

  it('is authorized and per-tenant, and 404s an unknown account', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not run B2B credit
    await setAccount(h, A, 'u-owner', 'ACME', { creditLimitMinor: 100_000 });

    expect((await setAccount(h, A, 'u-cash', 'NEW', { creditLimitMinor: 50_000 })).status).toBe(403);
    expect((await creditCheck(h, A, 'u-cash', 'ACME', { orderId: 'OX', orderValueMinor: 100 })).status).toBe(403);
    // A customer with no account has no credit terms — a check is a 404, not a guess.
    expect((await creditCheck(h, A, 'u-owner', 'GHOST', { orderId: 'OY', orderValueMinor: 100 })).status).toBe(404);

    // Tenant B has no account for ACME.
    await h.seedOwner(B, 'u-owner-b');
    expect((await getAccount(h, B, 'u-owner-b', 'ACME')).status).toBe(404);
  });
});
