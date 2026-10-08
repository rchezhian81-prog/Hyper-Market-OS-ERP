import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sealedDecision } from '../support/store-seal';
import { SUBJECT_AUTHORITY, DECISION_FLAGS } from '../../services/identity/src/approval-decisions';

/**
 * **Head office keeps a register of approvals decided at the store, re-verifying the DECIDER — never the relay
 * (SP-2a · F11 · M02-FR-03 · §28 · hard rules #4/#5/#10, API-01).**
 *
 * The store box relays a manager's decision under its own sync credential (`approvals.decision.sync`). This drives
 * the real surface: the fact is recorded; the decider's authority is looked up from THEIR grants and every breach
 * is a flag on the record, never a silent apply or a silent drop; the same decision again is 200 (one record); a
 * DIFFERENT decision for the same request is 422 and nothing is saved; the register reads back with its flags;
 * and a credential without the sync permission is refused. Synthetic data throughout (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-09-30T10:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const decision = (over: Record<string, unknown> = {}) => ({
  id: 'a1', subjectType: 'refund', subjectRef: 'sale-99', requestedBy: 'u-cashier', branchId: 'store-1',
  value: { minor: 20_000, currency: 'INR' }, status: 'approved', decidedBy: 'u-mgr', reason: 'within_policy', decidedAt: AT,
  storeId: 'store-1', source: 'manager-screen', ...over,
});

/** As a current store computer relays it: sealed for the decider it saw signed in (`sealed: false` = an unsealed body). */
const relay = (h: ApiHarness, body: Record<string, unknown>, key: string, opts: { user?: string; tenant?: string; id?: string; sealed?: boolean } = {}) =>
  h.request({
    method: 'POST', path: `/v1/approvals/decisions/${opts.id ?? String(body['id'])}/synced`,
    userId: opts.user ?? 'u-box', tenantId: opts.tenant ?? A, idempotencyKey: key,
    body: opts.sealed === false ? body : sealedDecision(opts.tenant ?? A, 'ApprovalDecided', body),
  });

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds pos.return.approve, price.change.approve, …
  await h.provisionRole(A, 'u-box', 'cashier');       // the store box's sync identity: approvals.decision.sync
  await h.provisionRole(A, 'u-cashier', 'cashier');   // a maker; no approval authority
  return h;
}

describe('a decision relayed from the store is recorded, with the decider re-verified (§28)', () => {
  it('records a clean decision by a manager who holds the authority — 202, no flags — and it reads back', async () => {
    const h = await seeded();
    const res = await relay(h, decision(), 'k-a1');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ requestId: 'a1', recorded: true, status: 'approved', decidedBy: 'u-mgr', flags: [] });

    const list = await h.request({ method: 'GET', path: '/v1/approvals/decisions', userId: 'u-owner', tenantId: A });
    expect(list.status).toBe(200);
    const body = list.body as { decisions: { requestId: string; decidedBy: string; relayedBy: string; flags: string[]; source: string }[]; flagged: number };
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0]).toMatchObject({ requestId: 'a1', decidedBy: 'u-mgr', relayedBy: 'u-box', source: 'manager-screen', flags: [] });
    expect(body.flagged).toBe(0);
  });

  it('flags — never rejects — a self-approval, a decider with no authority for the subject, and an unknown decider', async () => {
    const h = await seeded();
    const self = await relay(h, decision({ id: 'a2', requestedBy: 'u-mgr', decidedBy: 'u-mgr' }), 'k-a2');
    expect(self.status).toBe(202);
    expect((self.body as { flags: string[] }).flags).toEqual(['self_approval']);

    const lacks = await relay(h, decision({ id: 'a3', decidedBy: 'u-cashier', requestedBy: 'u-buyer' }), 'k-a3');
    expect(lacks.status).toBe(202);
    expect((lacks.body as { flags: string[] }).flags).toEqual(['decider_lacks_authority']);

    const unknown = await relay(h, decision({ id: 'a4', decidedBy: 'u-nobody' }), 'k-a4');
    expect(unknown.status).toBe(202);
    expect((unknown.body as { flags: string[] }).flags).toEqual(['decider_unknown']);

    // A decision no store computer vouched for (2b-vi-c-3): recorded and flagged, not applied.
    const unsealed = await relay(h, decision({ id: 'a6' }), 'k-a6', { sealed: false });
    expect(unsealed.status).toBe(202);
    expect((unsealed.body as { flags: string[] }).flags).toEqual(['decider_not_verified_at_store']);

    const odd = await relay(h, decision({ id: 'a5', subjectType: 'something_new' }), 'k-a5');
    expect(odd.status).toBe(202);
    expect((odd.body as { flags: string[] }).flags).toEqual(['authority_unverified']);

    const flagged = await h.request({ method: 'GET', path: '/v1/approvals/decisions', userId: 'u-owner', tenantId: A, query: { flagged: 'true' } });
    expect((flagged.body as { decisions: { requestId: string }[] }).decisions.map((d) => d.requestId).sort()).toEqual(['a2', 'a3', 'a4', 'a5', 'a6']);
    for (const f of (flagged.body as { decisions: { flags: string[] }[] }).decisions.flatMap((d) => d.flags)) {
      expect(DECISION_FLAGS).toContain(f);
    }
  });

  it('the authority table names a real permission per subject the manager screen offers', () => {
    for (const subject of ['refund', 'price_change', 'purchase_order', 'stock_adjustment', 'write_off', 'day_reopen']) {
      expect(SUBJECT_AUTHORITY[subject]).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    }
  });

  it('is idempotent per request: the same decision again — same key or a fresh one — is one record; a DIFFERENT decision is 422 and nothing is saved', async () => {
    const h = await seeded();
    expect((await relay(h, decision(), 'k-a1')).status).toBe(202);
    // The kernel's replay of the same key.
    const replay = await relay(h, decision(), 'k-a1');
    expect(replay.status).toBe(202);
    // A re-mint under a fresh key (a device that re-keyed) — the route's own check: already recorded, 200.
    const again = await relay(h, decision(), 'k-a1-again');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ requestId: 'a1', recorded: true, alreadyRecorded: true, status: 'approved' });
    // A conflicting decision for the same request: refused, permanently, with the record named.
    const conflict = await relay(h, decision({ status: 'rejected', decidedBy: 'u-owner', reason: 'against_policy' }), 'k-a1-conflict');
    expect(conflict.status).toBe(422);
    expect(codeOf(conflict)).toBe('decision_conflicts_with_record');
    const list = await h.request({ method: 'GET', path: '/v1/approvals/decisions', userId: 'u-owner', tenantId: A });
    const rows = (list.body as { decisions: { requestId: string; status: string }[] }).decisions;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: 'a1', status: 'approved' });
  });

  it('refuses a body that is not a decided request (400, nothing saved) and a path id that does not match', async () => {
    const h = await seeded();
    const bad = await relay(h, { id: 'a9', subjectType: 'refund' }, 'k-bad');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_synced_decision');
    const mismatch = await relay(h, decision({ id: 'a1' }), 'k-mismatch', { id: 'a2' });
    expect(mismatch.status).toBe(400);
    const list = await h.request({ method: 'GET', path: '/v1/approvals/decisions', userId: 'u-owner', tenantId: A });
    expect((list.body as { decisions: unknown[] }).decisions).toHaveLength(0);
  });

  it('is denied to a credential without the sync permission, and to another tenant\'s register', async () => {
    const h = await seeded();
    await h.provisionRole(A, 'u-customer', 'customer');
    const denied = await relay(h, decision(), 'k-denied', { user: 'u-customer' });
    expect(denied.status).toBe(403);
    // Tenant isolation: tenant B has no such box identity; nothing crosses.
    const other = await relay(h, decision(), 'k-other', { tenant: B });
    expect([401, 403]).toContain(other.status);
    const list = await h.request({ method: 'GET', path: '/v1/approvals/decisions', userId: 'u-owner', tenantId: A });
    expect((list.body as { decisions: unknown[] }).decisions).toHaveLength(0);
  });

  it('the register read needs approvals.delegation.read — a cashier cannot read it', async () => {
    const h = await seeded();
    const res = await h.request({ method: 'GET', path: '/v1/approvals/decisions', userId: 'u-cashier', tenantId: A });
    expect(res.status).toBe(403);
  });
});
