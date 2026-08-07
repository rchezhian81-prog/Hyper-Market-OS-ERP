import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Till cash movements, end to end through the real API (M14-FR-01, API-05). Float, loans, pickups and
// safe drops are append-only; the drawer balance and the current custodian are PROJECTED from them,
// never stored (hard rule #2). Two rules hold on the cloud, where every till's whole chain is visible:
// ONE custodian per till at a time, and no overdraw. Proves the wired till-cash surface against the
// real pipeline and real per-tenant RBAC — the authoritative custody chain the lane alone cannot be.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = '2026-08-07';

const move = (h: ApiHarness, tenantId: string, userId: string, tillId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/tills/${tillId}/cash-movements`, userId, tenantId, idempotencyKey: `cm-${body['movementId']}`, body });

const cash = (h: ApiHarness, tenantId: string, userId: string, tillId: string) =>
  h.request({ method: 'GET', path: `/v1/tills/${tillId}/cash`, userId, tenantId });

const mv = (movementId: string, kind: string, amountMinor: number, custodianId = 'cashier-1') => ({ movementId, kind, amountMinor, custodianId, tradingDay: DAY });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Cash { custodian: string | null; balanceMinor: number }
interface Move { balanceMinor: number; custodian: string | null }

describe('till cash is one custodian, no overdraw, projected (M14-FR-01, API-05)', () => {
  it('issues a float, tracks the balance and the custodian, and closes custody on return', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect(((await move(h, A, 'u-owner', 'T1', mv('m1', 'float_issue', 50_000))).body as Move)).toMatchObject({ balanceMinor: 50_000, custodian: 'cashier-1' });
    expect(((await move(h, A, 'u-owner', 'T1', mv('m2', 'loan', 20_000))).body as Move).balanceMinor).toBe(70_000);
    expect(((await move(h, A, 'u-owner', 'T1', mv('m3', 'pickup', 30_000))).body as Move).balanceMinor).toBe(40_000);
    expect((await cash(h, A, 'u-owner', 'T1')).body as Cash).toMatchObject({ custodian: 'cashier-1', balanceMinor: 40_000 });

    // Returning the float closes the custody — the till is free again.
    expect(((await move(h, A, 'u-owner', 'T1', mv('m4', 'float_return', 40_000))).body as Move)).toMatchObject({ balanceMinor: 0, custodian: null });
    expect((await cash(h, A, 'u-owner', 'T1')).body as Cash).toMatchObject({ custodian: null, balanceMinor: 0 });
    // A free till can be issued again — to a different cashier.
    expect((await move(h, A, 'u-owner', 'T1', mv('m5', 'float_issue', 30_000, 'cashier-2'))).status).toBe(201);
  });

  it('refuses issuing a till that is already held', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', 'T1', mv('m1', 'float_issue', 50_000));
    const clash = await move(h, A, 'u-owner', 'T1', mv('m2', 'float_issue', 10_000, 'cashier-2'));
    expect(clash.status).toBe(422);
    expect(codeOf(clash)).toBe('till_already_assigned');
  });

  it('refuses a movement on a till not held by the named custodian, and any overdraw', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', 'T1', mv('m1', 'float_issue', 50_000)); // held by cashier-1

    expect(codeOf(await move(h, A, 'u-owner', 'T1', mv('m2', 'pickup', 10_000, 'cashier-9')))).toBe('till_not_held_by_this_custodian');
    // Taking out more than the drawer holds is refused.
    const over = await move(h, A, 'u-owner', 'T1', mv('m3', 'pickup', 60_000));
    expect(over.status).toBe(422);
    expect(codeOf(over)).toBe('insufficient_till_cash');
    // The drawer is untouched by the refusals.
    expect(((await cash(h, A, 'u-owner', 'T1')).body as Cash).balanceMinor).toBe(50_000);
  });

  it('is idempotent on the movement id — a retry does not move the drawer twice', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', 'T1', mv('m1', 'float_issue', 50_000));

    // Same pickup id resent under different transport keys — both succeed, one effect.
    await h.request({ method: 'POST', path: '/v1/tills/T1/cash-movements', userId: 'u-owner', tenantId: A, idempotencyKey: 'k1', body: mv('p1', 'pickup', 20_000) });
    await h.request({ method: 'POST', path: '/v1/tills/T1/cash-movements', userId: 'u-owner', tenantId: A, idempotencyKey: 'k2', body: mv('p1', 'pickup', 20_000) });
    expect(((await cash(h, A, 'u-owner', 'T1')).body as Cash).balanceMinor).toBe(30_000); // 50k − 20k once, not 10k
  });

  it('is authorized and per-tenant, and refuses a malformed movement', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // an accountant does not handle till cash
    await move(h, A, 'u-owner', 'T1', mv('m1', 'float_issue', 50_000));

    expect((await move(h, A, 'u-acct', 'T1', mv('mx', 'pickup', 1_000))).status).toBe(403);
    expect((await move(h, A, 'u-owner', 'T1', { movementId: 'mz', kind: 'pickup', custodianId: 'cashier-1', tradingDay: DAY })).status).toBe(400); // no amount

    // Tenant B's till T1 is a different, empty drawer.
    await h.seedOwner(B, 'u-owner-b');
    expect((await cash(h, B, 'u-owner-b', 'T1')).body as Cash).toMatchObject({ custodian: null, balanceMinor: 0 });
  });
});
