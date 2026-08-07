import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Gift cards and store credit, end to end through the real API (M17-FR-03, API-06). A gift card is the
// shop's money held on the customer's behalf: the balance is PROJECTED from append-only movements
// (never stored — hard rule #2), a redemption can never overdraw it, an expired card cannot be spent,
// and an offline lane is capped rather than trusted. This proves the wired stored-value surface
// against the real pipeline and real per-tenant RBAC — another engine nothing fed until now.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const issue = (h: ApiHarness, tenantId: string, userId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: '/v1/stored-value/instruments', userId, tenantId, idempotencyKey: key ?? `iss-${body['instrumentId']}`, body });

const gift = (h: ApiHarness, tenantId: string, id: string, over: Record<string, unknown> = {}, key?: string) =>
  issue(h, tenantId, 'u-owner', { instrumentId: id, kind: 'gift_card', ownerRef: 'H1', faceValueMinor: 100_000, ...over }, key);

const redeem = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/stored-value/instruments/${id}/redeem`, userId, tenantId, idempotencyKey: key ?? `red-${body['movementId']}`, body });

const getBal = (h: ApiHarness, tenantId: string, userId: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/stored-value/instruments/${id}`, userId, tenantId });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Bal { balanceMinor: number }

describe('gift cards are a liability, projected and never overdrawn (M17-FR-03, API-06)', () => {
  it('issues with an opening value and projects the balance', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect(((await gift(h, A, 'GC-1')).body as Bal).balanceMinor).toBe(100_000);
    expect(((await getBal(h, A, 'u-owner', 'GC-1')).body as Bal).balanceMinor).toBe(100_000);
  });

  it('redeems within the balance and reflects it', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await gift(h, A, 'GC-1');
    expect(((await redeem(h, A, 'u-owner', 'GC-1', { movementId: 'r1', amountMinor: 30_000, channel: 'store' })).body as Bal).balanceMinor).toBe(70_000);
    expect(((await getBal(h, A, 'u-owner', 'GC-1')).body as Bal).balanceMinor).toBe(70_000);
  });

  it('never lets a card be overdrawn', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await gift(h, A, 'GC-1');
    const over = await redeem(h, A, 'u-owner', 'GC-1', { movementId: 'r1', amountMinor: 150_000, channel: 'store' });
    expect(over.status).toBe(422);
    expect(codeOf(over)).toBe('insufficient_balance');
    expect(((await getBal(h, A, 'u-owner', 'GC-1')).body as Bal).balanceMinor).toBe(100_000); // untouched
  });

  it('refuses an expired card and an over-the-cap offline redemption', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await gift(h, A, 'GC-EXP', { expiresOn: '2020-01-01' });
    expect(codeOf(await redeem(h, A, 'u-owner', 'GC-EXP', { movementId: 'r1', amountMinor: 1_000, channel: 'store' }))).toBe('expired');

    await gift(h, A, 'GC-OFF');
    // Offline, a lane can take at most ₹500 (50000) from a card without checking; ₹600 must wait.
    expect(codeOf(await redeem(h, A, 'u-owner', 'GC-OFF', { movementId: 'r1', amountMinor: 60_000, channel: 'store', capturedOffline: true }))).toBe('offline_cap_exceeded');
  });

  it('is idempotent on the movement id — a re-sent redemption is not a second spend', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await gift(h, A, 'GC-1');

    expect((await redeem(h, A, 'u-owner', 'GC-1', { movementId: 'r1', amountMinor: 30_000, channel: 'store' }, 'k1')).status).toBe(200);
    // Same movement id, new transport key: the money already moved once — answered idempotently.
    const again = await redeem(h, A, 'u-owner', 'GC-1', { movementId: 'r1', amountMinor: 30_000, channel: 'store' }, 'k2');
    expect(again.status).toBe(200);
    expect((again.body as { alreadyApplied?: boolean }).alreadyApplied).toBe(true);

    // A genuinely new redemption then leaves 40000, proving r1 was applied exactly once.
    expect(((await redeem(h, A, 'u-owner', 'GC-1', { movementId: 'r2', amountMinor: 30_000, channel: 'store' })).body as Bal).balanceMinor).toBe(40_000);
  });

  it('refuses a duplicate instrument, an unknown card, and a malformed request', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await gift(h, A, 'GC-1')).status).toBe(201);
    // A genuine RE-ISSUE (a new request, not a transport retry) is refused by the business guard.
    expect(codeOf(await gift(h, A, 'GC-1', {}, 'iss-GC-1-again'))).toBe('already_issued'); // issuing twice would create money the shop never took
    expect((await redeem(h, A, 'u-owner', 'GC-NONE', { movementId: 'r1', amountMinor: 100, channel: 'store' })).status).toBe(404);
    expect((await issue(h, A, 'u-owner', { instrumentId: 'GC-2', kind: 'gift_card', ownerRef: 'H1', faceValueMinor: 0 })).status).toBe(400); // non-positive
  });

  it('is authorized and per-tenant', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // an accountant holds no stored-value permission
    await gift(h, A, 'GC-1');

    expect((await issue(h, A, 'u-acct', { instrumentId: 'GC-X', kind: 'gift_card', ownerRef: 'H1', faceValueMinor: 5_000 })).status).toBe(403);

    // Tenant B never issued GC-1: its lookup is a 404, A's card did not leak.
    await h.seedOwner(B, 'u-owner-b');
    expect((await getBal(h, B, 'u-owner-b', 'GC-1')).status).toBe(404);
  });
});
