import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedRequestId, askForApproval, decide } from '../support/approval-request';
import { approvalRequestsAdapter, STREAM, ROLE_REVOKED } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **Head office's maker-checker engine, end to end (ADR-0024 · Wave 2b-vi-a · audit PA-03 · M02-FR-03 · M06-FR-01 ·
 * M30-FR-01 · §28 · hard rule #10).**
 *
 * The audit's finding, through the real router, token auth, per-tenant RBAC and the append-only store: a supplier's bank
 * account and a bulk import each took their second person as a NAME typed into the body — "role lookup proves that name
 * has authority, not that the person approved this action." Here the typed name is refused; the maker asks in their own
 * session for exactly what they will do; a different person who holds the authority approves it in theirs; the action
 * names that approval and is refused unless it is exactly what was approved — and, on real PostgreSQL, two checkers or
 * two actions at the same moment never produce two decisions or two changes.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const change = (account: string, requestedAt = '2026-10-01T08:00:00.000Z') =>
  ({ newAccount: account, requestedVia: 'letter', calledBackOn: '+91-800-1', numberWeAlreadyHeld: '+91-800-1', requestedAt });
const bankAsk = (supplierId: string, c: ReturnType<typeof change>) =>
  ({ kind: 'supplier_bank_change', subjectRef: supplierId, details: { ...c, supplierId }, summary: `Pay ${supplierId} into ${c.newAccount}` });
const changeBank = (h: ApiHarness, tenantId: string, userId: string, supplierId: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/suppliers/${supplierId}/bank-details`, userId, tenantId, idempotencyKey: key, body });
const bankChanges = async (h: ApiHarness, tenantId: string, supplierId: string) =>
  (await h.store.readStream(tenantId, STREAM.purchase))
    .filter((e) => e.event.type === 'SupplierBankChanged' && (e.event.payload as { supplierId: string }).supplierId === supplierId)
    .map((e) => e.event.payload as { newAccount: string; requestedBy: string; approvedBy: string });

const template = {
  id: 'product-v1', domain: 'product',
  columns: [{ name: 'sku', type: 'text', required: true }, { name: 'name', type: 'text', required: true }, { name: 'qty', type: 'integer', required: true }],
  keyColumns: ['sku'],
};
const FILE = 'sku,name,qty\nA1,Rice 5kg,10\nA2,Toor Dal,5';
const contentOf = async (h: ApiHarness, tenantId: string, userId: string, text: string): Promise<string> =>
  ((await h.request({ method: 'POST', path: '/v1/import/validate', userId, tenantId, idempotencyKey: `v-${text.length}-${userId}`, body: { template, text } })).body as { contentFingerprint: string }).contentFingerprint;
const commit = (h: ApiHarness, tenantId: string, userId: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: '/v1/import/commit', userId, tenantId, idempotencyKey: key, body: { template, text: FILE, ...body } });
const commits = async (h: ApiHarness, tenantId: string) =>
  ((await h.request({ method: 'GET', path: '/v1/import/commits', userId: 'u-owner', tenantId })).body as { jobs: { jobId: string; uploadedBy: string; approvedBy: string }[] }).jobs;

async function cast(h: ApiHarness, tenantId: string): Promise<void> {
  await h.seedOwner(tenantId, 'u-owner');                     // may change bank details, approve them, and import
  await h.provisionRole(tenantId, 'u-acct', 'accountant');    // may approve bank details; may not change them
  await h.provisionRole(tenantId, 'u-acct2', 'accountant');
  await h.provisionRole(tenantId, 'u-mgr', 'store_manager');  // may import (and so approve another person's import)
  await h.provisionRole(tenantId, 'u-mgr2', 'store_manager');
  await h.provisionRole(tenantId, 'u-cash', 'cashier');       // neither
}

describe('a supplier\'s bank account changes only on a second person\'s own approval (audit PA-03 · M06-FR-01)', () => {
  it('the audit\'s body — an approver NAMED who never approved — is refused, and the account is unchanged', async () => {
    const h = apiHarness();
    await cast(h, A);
    const res = await changeBank(h, A, 'u-owner', 's-1', { ...change('tok-1'), approvedBy: 'u-acct' }, 'b-1');
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('approver_named_without_approval');
    expect(codeOf(await changeBank(h, A, 'u-owner', 's-1', change('tok-1'), 'b-2'))).toBe('not_approved');
    // Nor is the maker a name in the body: a different requester than the signed-in person is refused.
    expect(codeOf(await changeBank(h, A, 'u-owner', 's-1', { ...change('tok-1'), requestedBy: 'u-acct' }, 'b-3'))).toBe('actor_is_the_caller');
    expect(await bankChanges(h, A, 's-1')).toEqual([]);
  });

  it('the owner asks; the accountant approves in their own session; the change lands, recording both people', async () => {
    const h = apiHarness();
    await cast(h, A);
    const approvalId = await approvedRequestId(h, A, 'u-owner', 'u-acct', bankAsk('s-1', change('tok-1')));
    const res = await changeBank(h, A, 'u-owner', 's-1', { ...change('tok-1'), approvalId }, 'b-1');
    expect(res.status).toBe(200);
    expect(await bankChanges(h, A, 's-1')).toEqual([expect.objectContaining({ newAccount: 'tok-1', requestedBy: 'u-owner', approvedBy: 'u-acct' })]);
    // The register shows who asked, who approved, and which action used it.
    const state = await approvalRequestsAdapter({ store: h.store, now: () => '2026-10-07T10:00:00.000Z' }).approvalState(A, approvalId);
    expect(state).toMatchObject({ request: { requestedBy: 'u-owner', kind: 'supplier_bank_change' }, decision: { decision: 'approved', decidedBy: 'u-acct' }, usedBy: 'bank-change-s-1' });
  });

  it('nobody approves their own request; nobody without the authority approves; nobody asks for what they may not do', async () => {
    const h = apiHarness();
    await cast(h, A);
    const asked = await askForApproval(h, A, 'u-owner', bankAsk('s-1', change('tok-1')));
    const requestId = (asked.body as { requestId: string }).requestId;
    expect(codeOf(await decide(h, A, 'u-owner', requestId))).toBe('self_approval');
    expect((await decide(h, A, 'u-mgr', requestId)).status).toBe(403);
    expect((await decide(h, A, 'u-cash', requestId)).status).toBe(403);
    expect((await askForApproval(h, A, 'u-acct', bankAsk('s-1', change('tok-1')))).status).toBe(403); // the accountant cannot change bank details
    // Still waiting: the change is refused by name and nothing moves.
    expect(codeOf(await changeBank(h, A, 'u-owner', 's-1', { ...change('tok-1'), approvalId: requestId }, 'b-1'))).toBe('approval_still_waiting');
    // Rejected: refused by name, and a rejection is final.
    expect((await decide(h, A, 'u-acct', requestId, 'rejected', 'that number is not on our file')).status).toBe(201);
    expect(codeOf(await changeBank(h, A, 'u-owner', 's-1', { ...change('tok-1'), approvalId: requestId }, 'b-2'))).toBe('approval_rejected');
    expect(codeOf(await decide(h, A, 'u-acct2', requestId))).toBe('already_decided');
    expect(await bankChanges(h, A, 's-1')).toEqual([]);
  });

  it('an approval allows exactly what was approved — not another account, supplier, maker or tenant', async () => {
    const h = apiHarness();
    await cast(h, A);
    await cast(h, B);
    await h.provisionRole(A, 'u-owner2', 'owner');
    const approvalId = await approvedRequestId(h, A, 'u-owner', 'u-acct', bankAsk('s-1', change('tok-1')));
    expect(codeOf(await changeBank(h, A, 'u-owner', 's-1', { ...change('tok-EVIL'), approvalId }, 'b-1'))).toBe('approval_does_not_match');
    expect(codeOf(await changeBank(h, A, 'u-owner', 's-2', { ...change('tok-1'), approvalId }, 'b-2'))).toBe('approval_does_not_match');
    expect(codeOf(await changeBank(h, A, 'u-owner', 's-1', { ...change('tok-1', '2026-10-02T08:00:00.000Z'), approvalId }, 'b-3'))).toBe('approval_does_not_match');
    expect(codeOf(await changeBank(h, A, 'u-owner2', 's-1', { ...change('tok-1'), approvalId }, 'b-4'))).toBe('approval_does_not_match');
    expect(codeOf(await changeBank(h, B, 'u-owner', 's-1', { ...change('tok-1'), approvalId }, 'b-5'))).toBe('approval_unknown');
    expect(await bankChanges(h, A, 's-1')).toEqual([]);
  });

  it('a spent approval is spent: a later change needs a new one, and the old one resent never moves the money back', async () => {
    const h = apiHarness();
    await cast(h, A);
    const first = await approvedRequestId(h, A, 'u-owner', 'u-acct', bankAsk('s-1', change('tok-1')));
    expect((await changeBank(h, A, 'u-owner', 's-1', { ...change('tok-1'), approvalId: first }, 'b-1')).status).toBe(200);
    const second = await approvedRequestId(h, A, 'u-owner', 'u-acct', bankAsk('s-1', change('tok-2', '2026-10-05T08:00:00.000Z')));
    expect((await changeBank(h, A, 'u-owner', 's-1', { ...change('tok-2', '2026-10-05T08:00:00.000Z'), approvalId: second }, 'b-2')).status).toBe(200);
    // The first approval, resent under a fresh key, is refused: one approval, one use — the money stays on tok-2.
    expect(codeOf(await changeBank(h, A, 'u-owner', 's-1', { ...change('tok-1'), approvalId: first }, 'b-3'))).toBe('approval_already_used');
    expect(codeOf(await changeBank(h, A, 'u-owner', 's-9', { ...change('tok-1'), approvalId: first }, 'b-4'))).toBe('approval_already_used');
    expect((await bankChanges(h, A, 's-1')).map((c) => c.newAccount)).toEqual(['tok-1', 'tok-2']);
    // A lost reply resent under its OWN key is the same answer, not a second use.
    expect((await changeBank(h, A, 'u-owner', 's-1', { ...change('tok-2', '2026-10-05T08:00:00.000Z'), approvalId: second }, 'b-2')).status).toBe(200);
  });

  it('an approval stops counting when the approver leaves — and a leaver can approve no more', async () => {
    const h = apiHarness();
    await cast(h, A);
    const approvalId = await approvedRequestId(h, A, 'u-owner', 'u-acct', bankAsk('s-1', change('tok-1')));
    await h.store.append(A, STREAM.identity, makeEvent({
      id: 'revoke-u-acct', type: ROLE_REVOKED, occurredAt: '2026-10-07T09:00:00.000Z', idempotencyKey: `revoke-${A}-u-acct`, source: 'test/provision',
      payload: { userId: 'u-acct', roleId: 'accountant', branchScope: 'all' },
    }));
    expect(codeOf(await changeBank(h, A, 'u-owner', 's-1', { ...change('tok-1'), approvalId }, 'b-1'))).toBe('checker_may_not_approve');
    const again = await askForApproval(h, A, 'u-owner', bankAsk('s-1', change('tok-1')));
    expect((await decide(h, A, 'u-acct', (again.body as { requestId: string }).requestId)).status).toBe(403);
    expect(await bankChanges(h, A, 's-1')).toEqual([]);
  });
});

describe('a bulk import loads only on a second person\'s own approval of THIS file (audit PA-03 · M30-FR-01)', () => {
  it('a typed checker is refused; an approval of this job and this content loads it once, recording both people', async () => {
    const h = apiHarness();
    await cast(h, A);
    expect(codeOf(await commit(h, A, 'u-mgr', { jobId: 'J1', approval: { status: 'approved', decidedBy: 'u-owner', reason: 'r' } }, 'c-1'))).toBe('approver_named_without_approval');
    expect(codeOf(await commit(h, A, 'u-mgr', { jobId: 'J1' }, 'c-2'))).toBe('no_approval');
    const contentFingerprint = await contentOf(h, A, 'u-mgr', FILE);
    const approvalId = await approvedRequestId(h, A, 'u-mgr', 'u-mgr2', { kind: 'data_import_commit', subjectRef: 'J1', details: { jobId: 'J1', contentFingerprint } });
    const res = await commit(h, A, 'u-mgr', { jobId: 'J1', approvalId }, 'c-3');
    expect(res.status).toBe(200);
    expect(await commits(h, A)).toEqual([expect.objectContaining({ jobId: 'J1', uploadedBy: 'u-mgr', approvedBy: 'u-mgr2' })]);
  });

  it('an approval of one file never loads another — a changed row, another job, or another uploader is refused', async () => {
    const h = apiHarness();
    await cast(h, A);
    const contentFingerprint = await contentOf(h, A, 'u-mgr', FILE);
    const approvalId = await approvedRequestId(h, A, 'u-mgr', 'u-owner', { kind: 'data_import_commit', subjectRef: 'J1', details: { jobId: 'J1', contentFingerprint } });
    expect(codeOf(await commit(h, A, 'u-mgr', { jobId: 'J1', approvalId, text: 'sku,name,qty\nA1,Rice 5kg,1000\nA2,Toor Dal,5' }, 'c-1'))).toBe('approval_does_not_match');
    expect(codeOf(await commit(h, A, 'u-mgr', { jobId: 'J2', approvalId }, 'c-2'))).toBe('approval_does_not_match');
    expect(codeOf(await commit(h, A, 'u-mgr2', { jobId: 'J1', approvalId }, 'c-3'))).toBe('approval_does_not_match');
    // An uploader cannot approve their own file.
    const own = await askForApproval(h, A, 'u-mgr', { kind: 'data_import_commit', subjectRef: 'J3', details: { jobId: 'J3', contentFingerprint } });
    expect(codeOf(await decide(h, A, 'u-mgr', (own.body as { requestId: string }).requestId))).toBe('self_approval');
    expect(await commits(h, A)).toEqual([]);
  });

  it('the inbox shows the checker what waits for them, and the maker what they asked', async () => {
    const h = apiHarness();
    await cast(h, A);
    const contentFingerprint = await contentOf(h, A, 'u-mgr', FILE);
    const asked = await askForApproval(h, A, 'u-mgr', { kind: 'data_import_commit', subjectRef: 'J1', details: { jobId: 'J1', contentFingerprint }, summary: 'Load 2 products' });
    const requestId = (asked.body as { requestId: string }).requestId;
    const inbox = async (u: string) => (await h.request({ method: 'GET', path: '/v1/approvals/requests', userId: u, tenantId: A })).body as { waitingForMe: { requestId: string }[]; mine: { requestId: string; status: string }[] };
    expect((await inbox('u-mgr2')).waitingForMe.map((r) => r.requestId)).toEqual([requestId]);
    expect((await inbox('u-mgr')).waitingForMe).toEqual([]);
    expect((await inbox('u-mgr')).mine).toEqual([expect.objectContaining({ requestId, status: 'waiting' })]);
    expect(await inbox('u-cash')).toEqual(expect.objectContaining({ waitingForMe: [], mine: [] })); // holds neither authority
  });
});

describe('a pay run step is the signed-in person\'s own (audit PA-03)', () => {
  it('a body naming another person as the actor is refused', async () => {
    const h = apiHarness();
    await cast(h, A);
    const res = await h.request({
      method: 'POST', path: '/v1/hr/payroll/pay-run/PR-1/append', userId: 'u-owner', tenantId: A, idempotencyKey: 'pr-1',
      body: { action: 'draft', payPeriod: '2026-09', actor: 'u-acct' },
    });
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe('actor_is_the_caller');
  });
});

// The races, on the database the cloud runs on. Skips (never passes quietly) without DATABASE_URL; runs in the "Stage
// gate suites" CI job.
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `mc${Date.now().toString(36)}`;
const PG_TENANT = `c${Date.now().toString(16).slice(-7)}-cccc-4ccc-8ccc-${'c'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('two people at the same moment — real PostgreSQL (audit PA-03)', () => {
  let pool: Pool;
  let h: ApiHarness;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    const dir = 'db/migrations';
    await runMigrations(sql, readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await cast(h, PG_TENANT);
  });
  afterAll(async () => { await pool.end(); });

  it('two checkers deciding one request at the same moment — one approves, one rejects: exactly one decision stands', async () => {
    const asked = await askForApproval(h, PG_TENANT, 'u-owner', bankAsk(`${RUN}-s1`, change('tok-1')));
    const requestId = (asked.body as { requestId: string }).requestId;
    const [a, b] = await Promise.all([
      decide(h, PG_TENANT, 'u-acct', requestId, 'approved', 'ok'),
      decide(h, PG_TENANT, 'u-acct2', requestId, 'rejected', 'not ours'),
    ]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
    const loser = a.status === 201 ? b : a;
    expect(['concurrent_change', 'already_decided']).toContain(codeOf(loser));
    const decisions = (await h.store.readStream(PG_TENANT, 'approval-requests'))
      .filter((e) => e.event.type === 'ApprovalDecided' && (e.event.payload as { requestId: string }).requestId === requestId);
    expect(decisions).toHaveLength(1);
  });

  it('one approved bank change sent three times at the same moment: one lands, the others are refused by name', async () => {
    const S = `${RUN}-s2`;
    const approvalId = await approvedRequestId(h, PG_TENANT, 'u-owner', 'u-acct', bankAsk(S, change('tok-1')));
    const results = await Promise.all([1, 2, 3].map((n) => changeBank(h, PG_TENANT, 'u-owner', S, { ...change('tok-1'), approvalId }, `${RUN}-b2-${n}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results) if (r.status !== 200) expect(['concurrent_change', 'approval_already_used']).toContain(codeOf(r));
    expect(await bankChanges(h, PG_TENANT, S)).toHaveLength(1);
    const used = (await h.store.readStream(PG_TENANT, 'approval-requests'))
      .filter((e) => e.event.type === 'ApprovalUsed' && (e.event.payload as { requestId: string }).requestId === approvalId);
    expect(used).toHaveLength(1);
  });

  it('one approved import committed three times at the same moment: one load, the others refused by name, never a crash', async () => {
    const J = `${RUN}-J1`;
    const contentFingerprint = await contentOf(h, PG_TENANT, 'u-mgr', FILE);
    const approvalId = await approvedRequestId(h, PG_TENANT, 'u-mgr', 'u-mgr2', { kind: 'data_import_commit', subjectRef: J, details: { jobId: J, contentFingerprint } });
    const results = await Promise.all([1, 2, 3].map((n) => commit(h, PG_TENANT, 'u-mgr', { jobId: J, approvalId }, `${RUN}-c-${n}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results) if (r.status !== 200) expect(['concurrent_change', 'approval_already_used', 'import_already_committed']).toContain(codeOf(r));
    expect((await commits(h, PG_TENANT)).filter((c) => c.jobId === J)).toHaveLength(1);
  });
});
