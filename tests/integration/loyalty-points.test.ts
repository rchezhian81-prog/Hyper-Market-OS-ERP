import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Loyalty points, end to end through the real API (M17-FR-01, API-06). Points are MONEY-LIKE: the
// balance is projected from append-only movements (never stored), a burn can never take it below
// zero, and the cloud is the authoritative balance across every lane and channel (P-02). This proves
// the wired loyalty surface against the real pipeline and real per-tenant RBAC — the endpoint that,
// until now, answered "not known" for every customer because nothing fed it.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const move = (h: ApiHarness, tenantId: string, userId: string, customerId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/customers/${customerId}/points`, userId, tenantId, idempotencyKey: `pm-${body['movementId']}`, body });

const balance = (h: ApiHarness, tenantId: string, userId: string, customerId: string) =>
  h.request({ method: 'GET', path: `/v1/customers/${customerId}/points`, userId, tenantId });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Bal { pointsBalance?: number; known: boolean }
interface Move { balance: number; delta: number }

describe('loyalty points are money-like: projected, never negative, one truth (M17-FR-01, API-06)', () => {
  it('a customer with no movement is UNKNOWN, not zero', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await balance(h, A, 'u-owner', 'C1')).body as Bal).toMatchObject({ known: false });
  });

  it('earns, burns, and projects the balance from the movements', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect(((await move(h, A, 'u-owner', 'C1', { movementId: 'm1', kind: 'earn', points: 100 })).body as Move).balance).toBe(100);
    expect(((await move(h, A, 'u-owner', 'C1', { movementId: 'm2', kind: 'burn', points: 30 })).body as Move).balance).toBe(70);

    expect((await balance(h, A, 'u-owner', 'C1')).body as Bal).toMatchObject({ pointsBalance: 70, known: true });
  });

  it('never lets a burn take the balance below zero', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', 'C1', { movementId: 'm1', kind: 'earn', points: 50 });

    const over = await move(h, A, 'u-owner', 'C1', { movementId: 'm2', kind: 'burn', points: 80 });
    expect(over.status).toBe(422);
    expect(codeOf(over)).toBe('insufficient_points');
    // The failed burn moved nothing.
    expect((await balance(h, A, 'u-owner', 'C1')).body as Bal).toMatchObject({ pointsBalance: 50 });
  });

  it('reverses a burn as a compensating credit (e.g. a returned sale)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', 'C1', { movementId: 'm1', kind: 'earn', points: 100 });
    await move(h, A, 'u-owner', 'C1', { movementId: 'm2', kind: 'burn', points: 40 });

    expect(((await move(h, A, 'u-owner', 'C1', { movementId: 'm3', kind: 'reversal', points: 40 })).body as Move).balance).toBe(100);
  });

  it('is idempotent on the movement id — a retry does not double the points', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // Same earn, resent under a different transport key: both succeed, one movement.
    await h.request({ method: 'POST', path: '/v1/customers/C1/points', userId: 'u-owner', tenantId: A, idempotencyKey: 'k1', body: { movementId: 'm1', kind: 'earn', points: 100 } });
    await h.request({ method: 'POST', path: '/v1/customers/C1/points', userId: 'u-owner', tenantId: A, idempotencyKey: 'k2', body: { movementId: 'm1', kind: 'earn', points: 100 } });

    expect((await balance(h, A, 'u-owner', 'C1')).body as Bal).toMatchObject({ pointsBalance: 100 }); // not 200
  });

  it('refuses a non-positive or unreadable movement', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect(codeOf(await move(h, A, 'u-owner', 'C1', { movementId: 'z', kind: 'earn', points: 0 }))).toBe('points_not_positive');
    expect(codeOf(await move(h, A, 'u-owner', 'C1', { movementId: 'z2', kind: 'earn', points: -5 }))).toBe('points_not_positive');
    expect((await move(h, A, 'u-owner', 'C1', { movementId: 'z3', points: 5 })).status).toBe(400); // no kind
  });

  it('is authorized and per-tenant/per-customer isolated', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // an accountant holds no loyalty permission
    await move(h, A, 'u-owner', 'C1', { movementId: 'm1', kind: 'earn', points: 100 });

    expect((await move(h, A, 'u-acct', 'C1', { movementId: 'mx', kind: 'earn', points: 10 })).status).toBe(403);

    // C2 is a different customer; A's C1 points did not leak to it.
    expect((await balance(h, A, 'u-owner', 'C2')).body as Bal).toMatchObject({ known: false });

    // Tenant B's C1 is a different customer in a different tenant.
    await h.seedOwner(B, 'u-owner-b');
    expect((await balance(h, B, 'u-owner-b', 'C1')).body as Bal).toMatchObject({ known: false });
  });
});
