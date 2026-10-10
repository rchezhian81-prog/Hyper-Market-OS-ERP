import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { heldVersionsAdapter } from '../../services/api/src/adapters';

/**
 * **A branch opens and closes only on measured facts, with the owner's approval (audit PA-04 · M01-FR-04).**
 *
 * `evaluate` stays a what-if: fed made-up figures, it says "allowed" — and changes nothing. The governed command
 * measures the branch from head office's own records (the inventory ledger's valuation, the till cash records, the
 * purchase orders, the store computer's own report of what it still holds unsent and how fresh that report is),
 * refuses a body that brings its own figures, and needs the OWNER's approval on the maker-checker engine. A blocked
 * close changes nothing and leaves the approval unspent. An allowed permanent close is persisted and revokes every grant
 * limited to the branch in the same write — so on their next request the branch's people, and its store computer, are
 * refused; a manager who also runs another branch keeps that one. After it, the branch takes no further transition.
 * Run in memory and on real PostgreSQL.
 */

const G1 = '33AABCS1429B1Z1'; // a valid Tamil Nadu GSTIN
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const textOf = (res: { body: unknown }): string => (res.body as { error?: { whatHappened?: string } }).error?.whatHappened ?? '';

interface Readiness { allowed: boolean; preview: boolean; blockers: { code: string }[]; readiness: { stockUnits: number; stockValue: { minor: number }; cashBalance: { minor: number }; openShifts: number; unsentSyncItems: number; syncStateUnknown?: string } }

const as = (h: ApiHarness, t: string, userId: string, branchId?: string) => ({
  get: (path: string, query?: Record<string, string>) => h.request({ method: 'GET', path, userId, tenantId: t, ...(branchId === undefined ? {} : { branchId }), ...(query === undefined ? {} : { query }) }),
  post: (path: string, body: unknown, key: string) => h.request({ method: 'POST', path, userId, tenantId: t, ...(branchId === undefined ? {} : { branchId }), body, idempotencyKey: key }),
});

async function cast(h: ApiHarness, t: string): Promise<void> {
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-mgr', 'store_manager', ['B1', 'B2']);
  await h.provisionRole(t, 'u-cash1', 'cashier', ['B1']);
  await h.provisionRole(t, 'u-cash2', 'cashier', ['B2']);
  await h.provisionRole(t, 'u-box1', 'store_computer', ['B1']);
  await h.provisionRole(t, 'u-box2', 'store_computer', ['B2']);
  const owner = as(h, t, 'u-owner');
  expect((await owner.post('/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }, 'c1')).status).toBe(201);
  expect((await owner.post(`/v1/org/gst-registrations/${G1}`, { companyId: 'C1', legalName: 'SRE Retail Pvt Ltd' }, 'g1')).status).toBe(201);
  for (const b of ['B1', 'B2']) {
    expect((await owner.post(`/v1/org/nodes/${b}`, { kind: 'branch', name: `Store ${b}`, parentId: 'C1', companyId: 'C1', gstin: G1 }, `n-${b}`)).status).toBe(201);
    expect((await owner.post(`/v1/org/nodes/${b}/activation`, {}, `a-${b}`)).status).toBe(200);
    expect((await owner.post(`/v1/stores/${b}/settings`, { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100000, handoverToleranceMinor: 5000, cashVarianceToleranceMinor: 5000, privacySlaDays: 30, warehouseId: null }, `s-${b}`)).status).toBe(201);
  }
  // B1 is trading: a till, stock on the shelf, a cashier holding a float — and its computer still has 3 records to send.
  expect((await owner.post('/v1/platform/devices/till-1/register', { branchId: 'B1', kind: 'pos_lane', label: 'Lane 1' }, 'd1')).status).toBe(201);
  expect((await owner.post('/v1/platform/devices/till-2/register', { branchId: 'B2', kind: 'pos_lane', label: 'Lane 1' }, 'd2')).status).toBe(201);
  expect((await owner.post('/v1/inventory/movements', { movementId: 'mv-1', productId: 'P1', locationId: 'B1', kind: 'received', quantityMinor: 10, uom: 'ea', occurredAt: '2026-10-09T09:00:00Z', enteredBy: 'u-owner', unitCostMinor: 5000 }, 'mv-1')).status).toBeLessThan(300);
  expect((await owner.post('/v1/tills/till-1/cash-movements', { movementId: 'cm-1', kind: 'float_issue', amountMinor: 200000, currency: 'INR', custodianId: 'u-cash1', tradingDay: '2026-10-10' }, 'cm-1')).status).toBeLessThan(300);
  expect((await as(h, t, 'u-box1', 'B1').post('/v1/store-packs/B1/held', { catalogueVersion: null, storePackVersion: null, unsentItems: 3 }, 'held-1')).status).toBe(200);
}

function scenarios(make: () => Promise<{ h: ApiHarness; t: string }>): void {
  const askApproval = async (h: ApiHarness, t: string, maker: string, branchId: string, details: Record<string, unknown>, key: string): Promise<string> => {
    const res = await as(h, t, maker, branchId).post('/v1/approvals/requests', { kind: 'branch_transition', subjectRef: branchId, details: { ...details, branchId }, summary: `${String(details['transition'])} ${branchId}`, reason: String(details['reason']) }, key);
    expect(res.status).toBe(201);
    return (res.body as { requestId: string }).requestId;
  };
  const decide = (h: ApiHarness, t: string, who: string, requestId: string, key: string) =>
    as(h, t, who, who === 'u-owner' ? undefined : 'B2').post(`/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'checked the branch myself' }, key);

  it('evaluate is a preview: fed made-up figures it says "allowed", and the branch does not change', async () => {
    const { h, t } = await make();
    const owner = as(h, t, 'u-owner');
    const zero = { minor: 0, currency: 'INR' };
    const res = await owner.post('/v1/platform/branches/transition/evaluate', {
      request: { branchId: 'B1', transition: 'permanently_close', requestedBy: 'u-mgr', reason: 'made up', at: '2026-10-10T10:00:00Z' },
      currentState: 'open', approval: { subjectRef: 'B1', status: 'approved', decidedBy: 'u-owner' },
      readiness: { branchId: 'B1', stockValue: zero, stockUnits: 0, cashBalance: zero, openDocuments: 0, unsentSyncItems: 0, unresolvedExceptions: 0, activeUserCount: 0 },
    }, 'eval-1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ allowed: true, preview: true, nothingChanged: true });
    expect(((await owner.get('/v1/org/nodes/B1')).body as { node: { status: string } }).node.status).toBe('active');
    expect(((await owner.get('/v1/platform/branches/B1/transitions')).body as { transitions: unknown[] }).transitions).toEqual([]);
  });

  it('the command measures the branch itself and refuses figures sent with it', async () => {
    const { h, t } = await make();
    const res = await as(h, t, 'u-mgr', 'B1').post('/v1/platform/branches/B1/transition', { transition: 'permanently_close', reason: 'lease ends', readiness: { stockUnits: 0 } }, 'cmd-figures');
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe('readiness_is_measured_not_sent');
  });

  it('stock, cash, an open shift and unsent box items each block a permanent close — even with the owner\'s approval — and nothing changes', async () => {
    const { h, t } = await make();
    const preview = await as(h, t, 'u-mgr', 'B1').get('/v1/platform/branches/B1/readiness', { transition: 'permanently_close' });
    expect(preview.status).toBe(200);
    const p = preview.body as Readiness;
    expect(p.preview).toBe(true);
    expect(p.readiness).toMatchObject({ stockUnits: 10, stockValue: { minor: 50000 }, cashBalance: { minor: 200000 }, openShifts: 1, unsentSyncItems: 3 });
    expect(p.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['stock_remains', 'cash_remains', 'open_shifts', 'unsent_sync', 'approval_required']));

    const details = { transition: 'permanently_close', reason: 'the lease on this building ends this month' };
    const approvalId = await askApproval(h, t, 'u-mgr', 'B1', details, 'ask-b1');
    expect((await decide(h, t, 'u-owner', approvalId, 'dec-b1')).status).toBe(201);
    const blocked = await as(h, t, 'u-mgr', 'B1').post('/v1/platform/branches/B1/transition', { ...details, approvalId }, 'close-b1');
    expect(blocked.status).toBe(409);
    expect(codeOf(blocked)).toBe('branch_transition_blocked');
    expect(textOf(blocked)).toContain('10 units');
    expect(textOf(blocked)).toContain('never reached the cloud');
    // Nothing changed: still open, nobody lost access, nothing recorded.
    expect(((await as(h, t, 'u-owner').get('/v1/org/nodes/B1')).body as { node: { status: string } }).node.status).toBe('active');
    expect((await as(h, t, 'u-cash1', 'B1').get('/v1/tills/till-1/cash')).status).toBe(200);
    expect(((await as(h, t, 'u-owner').get('/v1/platform/branches/B1/transitions')).body as { transitions: unknown[] }).transitions).toEqual([]);
  });

  it('a box that never said how much it holds unsent — or said so too long ago — blocks a permanent close (a missing signal is not a zero)', async () => {
    const { h, t } = await make();
    const never = (await as(h, t, 'u-owner').get('/v1/platform/branches/B2/readiness')).body as Readiness;
    expect(never.blockers.map((b) => b.code)).toContain('sync_state_unknown');
    // An old report, older than the store's 900-second limit.
    await heldVersionsAdapter({ store: h.store }).recordHeldVersions(t, { storeId: 'B2', catalogueVersion: null, storePackVersion: null, unsentItems: 0, reportedBy: 'u-box2', reportedAt: '2026-01-01T00:00:00.000Z' });
    const stale = (await as(h, t, 'u-owner').get('/v1/platform/branches/B2/readiness')).body as Readiness;
    expect(stale.readiness.syncStateUnknown).toContain('older than the store');
    // A fresh report of zero clears it.
    expect((await as(h, t, 'u-box2', 'B2').post('/v1/store-packs/B2/held', { catalogueVersion: null, storePackVersion: null, unsentItems: 0 }, 'held-2')).status).toBe(200);
    const fresh = (await as(h, t, 'u-owner').get('/v1/platform/branches/B2/readiness')).body as Readiness;
    expect(fresh.blockers.map((b) => b.code)).toEqual(['approval_required']);
  });

  it('a clean branch closes only with the owner\'s approval; access to it is revoked at once and it takes no further transition', async () => {
    const { h, t } = await make();
    expect((await as(h, t, 'u-box2', 'B2').post('/v1/store-packs/B2/held', { catalogueVersion: null, storePackVersion: null, unsentItems: 0 }, 'held-2')).status).toBe(200);
    const details = { transition: 'permanently_close', reason: 'merged into the B1 store across the road' };

    // No approval → blocked. A typed approver name is not an approval.
    const unapproved = await as(h, t, 'u-mgr', 'B2').post('/v1/platform/branches/B2/transition', details, 'close-b2-none');
    expect(codeOf(unapproved)).toBe('branch_transition_blocked');
    expect(codeOf(await as(h, t, 'u-mgr', 'B2').post('/v1/platform/branches/B2/transition', { ...details, approvedBy: 'u-owner' }, 'close-b2-typed'))).toBe('approver_named_without_approval');

    const approvalId = await askApproval(h, t, 'u-mgr', 'B2', details, 'ask-b2');
    // The maker cannot approve their own, and a store manager does not hold the owner's approval authority.
    expect((await decide(h, t, 'u-mgr', approvalId, 'dec-b2-self')).status).toBe(403);
    expect((await decide(h, t, 'u-owner', approvalId, 'dec-b2')).status).toBe(201);

    const closed = await as(h, t, 'u-mgr', 'B2').post('/v1/platform/branches/B2/transition', { ...details, approvalId }, 'close-b2');
    expect(closed.status).toBe(200);
    const rec = (closed.body as { transition: { toState: string; approvedBy: string; requestedBy: string; readiness: { stockUnits: number; unsentSyncItems: number }; accessRevoked: { userId: string; keeps: string[] }[] } }).transition;
    expect(rec).toMatchObject({ toState: 'permanently_closed', approvedBy: 'u-owner', requestedBy: 'u-mgr', readiness: { stockUnits: 0, unsentSyncItems: 0 } });
    const revoked = Object.fromEntries(rec.accessRevoked.map((r) => [r.userId, r.keeps]));
    expect(revoked).toEqual({ 'u-mgr': ['B1'], 'u-cash2': [], 'u-box2': [] });

    // Persisted: the register says closed, and the transition is on record with what it was decided on.
    expect(((await as(h, t, 'u-owner').get('/v1/org/nodes/B2')).body as { node: { status: string } }).node.status).toBe('closed');
    expect(((await as(h, t, 'u-owner').get('/v1/platform/branches/B2/transitions')).body as { transitions: unknown[] }).transitions).toHaveLength(1);

    // Post-close denial: the branch's cashier and its store computer are refused on their next request…
    expect((await as(h, t, 'u-cash2', 'B2').get('/v1/tills/till-2/cash')).status).toBe(403);
    expect((await as(h, t, 'u-box2', 'B2').post('/v1/store-packs/B2/held', { catalogueVersion: null, storePackVersion: null, unsentItems: 0 }, 'held-after')).status).toBe(403);
    // …the manager can no longer act at B2, but still runs B1.
    expect((await as(h, t, 'u-mgr', 'B2').get('/v1/platform/branches/B2/readiness')).status).toBe(403);
    expect((await as(h, t, 'u-mgr', 'B1').get('/v1/platform/branches/B1/readiness')).status).toBe(200);
    // No further transition from a permanent close — not even a reopen, which needs no approval.
    const reopen = await as(h, t, 'u-owner').post('/v1/platform/branches/B2/transition', { transition: 'reopen', reason: 'changed our mind' }, 'reopen-b2');
    expect(codeOf(reopen)).toBe('branch_transition_blocked');
    expect(textOf(reopen)).toContain('permanently closed');
    // The manager's B2 seat is gone, so even the same request again is refused at the door…
    expect((await as(h, t, 'u-mgr', 'B2').post('/v1/platform/branches/B2/transition', { ...details, approvalId }, 'close-b2-again')).status).toBe(403);
    // …and the owner's approval was spent on this close: one approval, one action.
    const mine = (await as(h, t, 'u-mgr', 'B1').get('/v1/approvals/requests')).body as { mine: { requestId: string; status: string }[] };
    expect(mine.mine.find((r) => r.requestId === approvalId)?.status).toBe('used');
  });

  it('a temporary close keeps stock, cash and people in place, and a reopen needs no approval', async () => {
    const { h, t } = await make();
    const details = { transition: 'temporarily_close', reason: 'flooding on the ground floor', reopensOn: '2026-10-20' };
    const approvalId = await askApproval(h, t, 'u-mgr', 'B1', details, 'ask-tc');
    expect((await decide(h, t, 'u-owner', approvalId, 'dec-tc')).status).toBe(201);
    const res = await as(h, t, 'u-mgr', 'B1').post('/v1/platform/branches/B1/transition', { ...details, approvalId }, 'tc-b1');
    expect(res.status).toBe(200);
    expect((res.body as { transition: { accessRevoked: unknown[] } }).transition.accessRevoked).toEqual([]);
    expect(((await as(h, t, 'u-owner').get('/v1/org/nodes/B1')).body as { node: { status: string } }).node.status).toBe('suspended');
    expect((await as(h, t, 'u-cash1', 'B1').get('/v1/tills/till-1/cash')).status).toBe(200);
    const reopened = await as(h, t, 'u-mgr', 'B1').post('/v1/platform/branches/B1/transition', { transition: 'reopen', reason: 'the floor is dry' }, 'reopen-b1');
    expect(reopened.status).toBe(200);
    expect(((await as(h, t, 'u-owner').get('/v1/org/nodes/B1')).body as { node: { status: string } }).node.status).toBe('active');
  });

}

describe('a branch closes only on measured facts (PA-04) — in memory', () => {
  scenarios(async () => {
    const h = apiHarness();
    const t = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab4';
    await cast(h, t);
    return { h, t };
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('a branch closes only on measured facts (PA-04) — real PostgreSQL', () => {
  let pool: Pool;
  let run = 0;
  const stamp = Date.now().toString(16).slice(-7);
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  scenarios(async () => {
    run += 1;
    const t = `b${stamp}-bbbb-4bbb-8bbb-${String(run).padStart(12, '0')}`;
    const sql = pgPoolClient(pool);
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await cast(h, t);
    return { h, t };
  });
});
