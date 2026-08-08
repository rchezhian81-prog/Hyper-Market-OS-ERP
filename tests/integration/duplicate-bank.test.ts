import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Duplicate bank-account detection, end to end through the real API (M15-FR-03, API-05). A
// mandatory fraud control: if two DISTINCT holders (suppliers) share one bank account, that is
// flagged and payment is BLOCKED PENDING REVIEW — a real supplier's real address saying "the
// account changed" is how invoice-redirection fraud drains a payment run. It runs over the
// ALREADY-CAPTURED bank details (each supplier's CURRENT account, folded from the append-only
// bank-change ledger), not data the caller supplies. Detect-and-hold, released by a person, never
// silently reversed (hard rule #5). Per-tenant (§35). Account refs are masked/tokenised (PRV).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// A bank change that passes M06 verification: called back on a number we already held, approved by
// a second person. The caller (owner) holds purchase.supplier.bank; requestedBy/approvedBy are the
// people named on the change, not the caller.
const setBank = (h: ApiHarness, tenant: string, user: string, supplierId: string, account: string, seq: string) =>
  h.request({
    method: 'POST', path: `/v1/purchase/suppliers/${supplierId}/bank-details`,
    userId: user, tenantId: tenant, idempotencyKey: `bank-${tenant}-${supplierId}-${seq}`,
    body: {
      newAccount: account, requestedVia: 'letter',
      calledBackOn: '+91-800-1', numberWeAlreadyHeld: '+91-800-1',
      requestedBy: 'u-buyer', approvedBy: 'u-approver', requestedAt: `2026-08-0${seq}T10:00:00.000Z`,
    },
  });

interface Flag { accountRef: string; holders: { holderId: string; holderType: string }[] }
interface DupBody { flags: Flag[]; blocked: string[] }
const dupBank = async (h: ApiHarness, tenant: string, user: string): Promise<DupBody> =>
  (await h.request({ method: 'GET', path: '/v1/fraud-signals/duplicate-bank', userId: user, tenantId: tenant })).body as DupBody;

describe('duplicate bank-account detection, end to end (M15-FR-03, API-05)', () => {
  it('flags one account shared by two distinct suppliers and blocks both, pending review', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // Two suppliers, two different accounts — nothing to flag.
    expect((await setBank(h, A, 'u-owner', 'SUP-1', 'ACCT-MASK-1111', '1')).status).toBe(200);
    expect((await setBank(h, A, 'u-owner', 'SUP-2', 'ACCT-MASK-2222', '2')).status).toBe(200);
    const clean = await dupBank(h, A, 'u-owner');
    expect(clean.flags).toEqual([]);
    expect(clean.blocked).toEqual([]);

    // A third supplier turns up on the SAME account as the first — the classic redirection.
    expect((await setBank(h, A, 'u-owner', 'SUP-3', 'ACCT-MASK-1111', '3')).status).toBe(200);
    const flagged = await dupBank(h, A, 'u-owner');
    expect(flagged.flags).toHaveLength(1);
    expect(flagged.flags[0]!.accountRef).toBe('ACCT-MASK-1111');
    expect(flagged.flags[0]!.holders.map((x) => x.holderId)).toEqual(['SUP-1', 'SUP-3']);
    expect(flagged.blocked).toEqual(['SUP-1', 'SUP-3']); // both held until a person reviews
  });

  it('uses each supplier\'s CURRENT account — a move away clears the flag (append-only, latest wins)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setBank(h, A, 'u-owner', 'SUP-1', 'ACCT-MASK-1111', '1');
    await setBank(h, A, 'u-owner', 'SUP-3', 'ACCT-MASK-1111', '3');
    expect((await dupBank(h, A, 'u-owner')).blocked).toEqual(['SUP-1', 'SUP-3']);

    // SUP-3 moves to its own account — the shared-account fact is gone, the block clears.
    await setBank(h, A, 'u-owner', 'SUP-3', 'ACCT-MASK-9999', '5');
    const after = await dupBank(h, A, 'u-owner');
    expect(after.flags).toEqual([]);
    expect(after.blocked).toEqual([]);
  });

  it('is per-tenant and authorized: another tenant is unaffected and a cashier cannot read it', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await setBank(h, A, 'u-owner', 'SUP-1', 'ACCT-MASK-1111', '1');
    await setBank(h, A, 'u-owner', 'SUP-3', 'ACCT-MASK-1111', '3');

    // Tenant B shares the same account number across its own two suppliers — its OWN flag, and A's
    // detection never sees B's holders (§35).
    await h.seedOwner(B, 'u-owner-b');
    await setBank(h, B, 'u-owner-b', 'SUP-1', 'ACCT-MASK-1111', '1');
    expect((await dupBank(h, B, 'u-owner-b')).flags).toEqual([]); // B has only one supplier on it
    expect((await dupBank(h, A, 'u-owner')).blocked).toEqual(['SUP-1', 'SUP-3']); // A unchanged

    // A cashier holds no loss-prevention read.
    expect((await h.request({ method: 'GET', path: '/v1/fraud-signals/duplicate-bank', userId: 'u-cash', tenantId: A })).status).toBe(403);
  });
});
