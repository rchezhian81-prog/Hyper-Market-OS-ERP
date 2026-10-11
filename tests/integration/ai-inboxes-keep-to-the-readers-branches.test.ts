import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore, MemoryIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **The three shared AI inboxes keep to the reader's branches, cite their evidence, and leave the decision to a person
 * (audit EA-09 · A06 / A08 / A10 · AI-NFR-02/04/07/10 · QG-11 · PA-01 · hard rule #5).**
 *
 * Through the real API (memory and PostgreSQL), for the Operations (A06), Data Quality (A08) and Workforce (A10) inboxes:
 *   • every finding names the BRANCH of the governed record behind it (an alert's rule, a task) — or null when that
 *     record is the whole shop's (the product master) — and carries its EVIDENCE and the route a person acts through;
 *   • a manager whose grant reaches ONE branch sees that branch's findings plus the shop-wide ones, never another
 *     branch's; asking for a branch they do not hold is refused by name; the owner sees every branch;
 *   • setting a finding aside is a person's act in their own name: another branch's finding is refused, a shop-wide one
 *     needs company-wide authority, an unknown one is refused; a replay records once;
 *   • the inbox says how it was made — deterministic rules, no model called, no provider configured;
 *   • the kill switch hides all three at once, and switching it back restores them;
 *   • the data refreshes: completing the task / acknowledging the alert the ordinary way drops it off on its own;
 *   • a RESTART (a new API over the same store) reads the same decisions back;
 *   • and the AI committed nothing: the task is still open and the alert still unacknowledged until a person acts.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr-br1'; const CASHIER = 'u-cash';
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const base = { baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' };

interface Entry {
  readonly finding: { readonly findingId: string };
  readonly status: string;
  readonly branchId: string | null;
  readonly evidence: readonly { readonly source: string; readonly reference: string; readonly summary: string }[];
  readonly wouldRequire: string;
  readonly dismissal?: { readonly by: string; readonly reason: string };
}
interface Inbox {
  readonly agentActive: boolean; readonly open: readonly Entry[]; readonly dismissed: readonly Entry[];
  readonly openCount: number; readonly withheldWithoutEvidence?: number;
  readonly scope: { readonly held: string[] | 'all'; readonly asked: string | null };
  readonly governance: { readonly basis: string; readonly calledAModel: boolean; readonly modelProvider: string; readonly said: string; readonly decidedBy: string };
  readonly committedAnything: boolean;
}

const INBOXES = ['operations', 'data-quality', 'workforce'] as const;
type InboxName = (typeof INBOXES)[number];

let n = 0;
const req = (h: ApiHarness, T: string, userId: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, query?: Record<string, string>, key?: string) =>
  h.request({
    method, path, userId, tenantId: T, ...(userId === MGR ? { branchId: 'br-1' } : {}),
    ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${++n}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }),
  });
const inbox = async (h: ApiHarness, T: string, who: string, name: InboxName, query?: Record<string, string>) => {
  const r = await req(h, T, who, 'GET', `/v1/ai/${name}/worklist`, undefined, query);
  return { status: r.status, code: codeOf(r), body: r.body as Inbox };
};
const ids = (b: Inbox): string[] => b.open.map((e) => e.finding.findingId).sort();
const ok = async (p: Promise<{ status: number; body: unknown }>, label: string): Promise<void> => {
  const r = await p;
  expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
};

async function seed(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MGR, 'store_manager', ['br-1']); // the AI inbox permissions, ONE branch
  await h.provisionRole(T, CASHIER, 'cashier');
  // A06 — three live incidents: one watched for br-1's store computer, one for br-2's, one shop-wide.
  const rule = (alertId: string, branchId?: string) => ({ alertId, component: 'dead_letter', firesAt: 'degraded', ownerUserId: 'u-op', ownerName: 'Operator', ackWithinMinutes: 15, ...(branchId === undefined ? {} : { branchId }) });
  await ok(req(h, T, OWNER, 'POST', '/v1/platform/alerts/raise', { signals: { deadLetterCount: 3 }, alertRules: [rule('dl-br1', 'br-1'), rule('dl-br2', 'br-2'), rule('dl-shop')] }), 'raise');
  // A10 — a critical overdue task at each branch, and an overdue one naming no branch (shop-wide).
  for (const [id, branchId] of [['T-br1', 'br-1'], ['T-br2', 'br-2'], ['T-shop', undefined]] as const) {
    await ok(req(h, T, OWNER, 'POST', `/v1/hr/workforce/tasks/${id}`, { description: `Chiller check ${id}`, forRole: 'store_manager', dueAt: PAST, critical: true, ...(branchId === undefined ? {} : { branchId }) }), id);
  }
  // A08 — one product with no MRP (the product master is the whole shop's, P-02).
  await ok(req(h, T, OWNER, 'POST', '/v1/catalogue/products/p-nomrp/publish', { product: { ...base, sku: 'SKU-NOMRP', name: 'Sugar 1kg', brand: 'Local' }, categories: [GROCERY] }), 'publish');
  await ok(req(h, T, OWNER, 'POST', '/v1/catalogue/products/p-nomrp/barcodes/8901000000004', { kind: 'ean' }), 'barcode');
  // Switch on the three agents by name, the kill switch off (AI starts stopped).
  await ok(req(h, T, OWNER, 'PUT', '/v1/ai/kill-switch', { on: false }), 'unkill');
  await ok(req(h, T, OWNER, 'PUT', '/v1/ai/agents/enabled', { agents: ['A06', 'A08', 'A10'] }), 'enable');
}

async function journey(make: () => ApiHarness, T: string): Promise<void> {
  const h = make();
  await seed(h, T);

  // ── The owner sees every branch; every entry is branch-keyed, evidenced, and names the person's route.
  const ownerOps = (await inbox(h, T, OWNER, 'operations')).body;
  expect(ids(ownerOps)).toEqual(['ops-runbook:dl-br1', 'ops-runbook:dl-br2', 'ops-runbook:dl-shop']);
  expect(Object.fromEntries(ownerOps.open.map((e) => [e.finding.findingId, e.branchId]))).toEqual({ 'ops-runbook:dl-br1': 'br-1', 'ops-runbook:dl-br2': 'br-2', 'ops-runbook:dl-shop': null });
  const ownerWf = (await inbox(h, T, OWNER, 'workforce')).body;
  expect(ids(ownerWf)).toEqual(['wf-guidance:escalated:T-br1', 'wf-guidance:escalated:T-br2', 'wf-guidance:escalated:T-shop']);
  const ownerDq = (await inbox(h, T, OWNER, 'data-quality')).body;
  expect(ids(ownerDq)).toEqual(['dq-missing-mrp:p-nomrp']);
  expect(ownerDq.open[0]!.branchId).toBeNull();
  for (const b of [ownerOps, ownerWf, ownerDq]) {
    expect(b.agentActive).toBe(true);
    expect(b.committedAnything).toBe(false);
    expect(b.withheldWithoutEvidence).toBe(0);
    for (const e of b.open) {
      expect(e.evidence.length, e.finding.findingId).toBeGreaterThan(0);
      expect(e.wouldRequire).toMatch(/^(POST|GET) \/v1\//);
    }
    // How it was made, said on every reply: rules, no model, no provider — and a person decides.
    expect(b.governance).toMatchObject({ basis: 'deterministic_rules', calledAModel: false, modelProvider: 'none_configured' });
    expect(b.governance.decidedBy).toMatch(/a person/);
  }
  expect(ownerWf.open.find((e) => e.finding.findingId === 'wf-guidance:escalated:T-br2')!.evidence[0]!.reference).toBe('T-br2');
  expect(ownerOps.open.find((e) => e.finding.findingId === 'ops-runbook:dl-br1')!.evidence[0]!.reference).toBe('dl-br1');

  // ── A manager of br-1 sees br-1 plus shop-wide, never br-2 — the server's scope, not the page's.
  const mOps = await inbox(h, T, MGR, 'operations');
  expect(ids(mOps.body)).toEqual(['ops-runbook:dl-br1', 'ops-runbook:dl-shop']);
  expect(mOps.body.scope.held).toEqual(['br-1']);
  const mWf = await inbox(h, T, MGR, 'workforce');
  expect(ids(mWf.body)).toEqual(['wf-guidance:escalated:T-br1', 'wf-guidance:escalated:T-shop']);
  expect(ids((await inbox(h, T, MGR, 'data-quality')).body)).toEqual(['dq-missing-mrp:p-nomrp']);
  // Asking for a branch not held is refused by name, for every inbox; asking for their own narrows to it.
  for (const name of INBOXES) {
    const asked = await inbox(h, T, MGR, name, { branchId: 'br-2' });
    expect(asked.status, name).toBe(403);
    expect(asked.code).toBe('scope_not_held');
  }
  expect(ids((await inbox(h, T, MGR, 'workforce', { branchId: 'br-1' })).body)).toEqual(['wf-guidance:escalated:T-br1']);
  expect(ids((await inbox(h, T, OWNER, 'workforce', { branchId: 'br-2' })).body)).toEqual(['wf-guidance:escalated:T-br2']);
  // A cashier holds no AI inbox permission at all.
  for (const name of INBOXES) expect((await inbox(h, T, CASHIER, name)).status).toBe(403);

  // ── Setting aside is a person's act, in their own name, within their branches.
  const dismiss = (who: string, name: InboxName, body: unknown, key?: string) => req(h, T, who, 'POST', `/v1/ai/${name}/dismissals`, body, undefined, key);
  expect(codeOf(await dismiss(MGR, 'workforce', { findingId: 'wf-guidance:escalated:T-br2', reason: 'not mine' }))).toBe('outside_your_branch_scope');
  expect(codeOf(await dismiss(MGR, 'operations', { findingId: 'ops-runbook:dl-br2', reason: 'not mine' }))).toBe('outside_your_branch_scope');
  expect(codeOf(await dismiss(MGR, 'data-quality', { findingId: 'dq-missing-mrp:p-nomrp', reason: 'priced next week' }))).toBe('shop_wide_record_needs_company_scope');
  expect(codeOf(await dismiss(MGR, 'operations', { findingId: 'ops-runbook:dl-shop', reason: 'head office has it' }))).toBe('shop_wide_record_needs_company_scope');
  const unknown = await dismiss(OWNER, 'workforce', { findingId: 'wf-guidance:escalated:T-nope', reason: 'x' });
  expect(unknown.status).toBe(404);
  expect(codeOf(unknown)).toBe('unknown_finding');
  // Allowed: br-1's own finding; the owner's on a shop-wide one. A replay of the same key records once.
  const first = await dismiss(MGR, 'workforce', { findingId: 'wf-guidance:escalated:T-br1', reason: 'the closing lead is on it' }, `wf-d-${T}`);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  const replay = await dismiss(MGR, 'workforce', { findingId: 'wf-guidance:escalated:T-br1', reason: 'the closing lead is on it' }, `wf-d-${T}`);
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual(first.body);
  await ok(dismiss(OWNER, 'data-quality', { findingId: 'dq-missing-mrp:p-nomrp', reason: 'priced next week' }), 'owner dq dismiss');
  await ok(dismiss(MGR, 'operations', { findingId: 'ops-runbook:dl-br1', reason: 'on-call has it' }), 'mgr ops dismiss');
  const afterWf = (await inbox(h, T, MGR, 'workforce')).body;
  expect(ids(afterWf)).toEqual(['wf-guidance:escalated:T-shop']);
  expect(afterWf.dismissed.map((e) => [e.finding.findingId, e.dismissal?.by])).toEqual([['wf-guidance:escalated:T-br1', MGR]]);
  // The manager never sees br-2's set-aside list either.
  expect((await inbox(h, T, OWNER, 'workforce')).body.dismissed).toHaveLength(1);

  // ── The kill switch hides all three at once; off again, they are back exactly as they were.
  await ok(req(h, T, OWNER, 'PUT', '/v1/ai/kill-switch', { on: true }), 'kill');
  for (const name of INBOXES) {
    const b = (await inbox(h, T, MGR, name)).body as Inbox & { note?: string };
    expect(b.agentActive, name).toBe(false);
    expect(b.open).toEqual([]);
    expect(b.note).toMatch(/kill switch/);
  }
  expect((await inbox(h, T, MGR, 'workforce', { branchId: 'br-2' })).code).toBe('scope_not_held'); // scope holds even when stopped
  await ok(req(h, T, OWNER, 'PUT', '/v1/ai/kill-switch', { on: false }), 'unkill again');
  expect(ids((await inbox(h, T, MGR, 'workforce')).body)).toEqual(['wf-guidance:escalated:T-shop']);

  // ── The AI committed nothing: br-2's task is still open and its alert still unacknowledged.
  const tasks = (await req(h, T, OWNER, 'GET', '/v1/hr/workforce/tasks', undefined, { asOf: new Date().toISOString() })).body as { tasks: { taskId: string; status: string }[] };
  const t2 = tasks.tasks.find((t) => t.taskId === 'T-br2');
  expect(t2).toBeDefined();
  expect(t2!.status).toBe('escalated'); // still a person's to do — no AI completed it
  const alerts = (await req(h, T, OWNER, 'GET', '/v1/platform/alerts')).body as { alerts: { alert: { alertId: string }; state: string }[] };
  expect(alerts.alerts.find((a) => a.alert.alertId === 'dl-br2')!.state).toBe('open');

  // ── Refreshed data: a person completes T-shop and acknowledges dl-br2 the ordinary way; both drop off on their own.
  await ok(req(h, T, OWNER, 'POST', '/v1/hr/workforce/tasks/T-shop/complete', { doneBy: OWNER }), 'complete');
  await ok(req(h, T, OWNER, 'POST', '/v1/platform/alerts/dl-br2/acknowledge', {}), 'ack');
  expect(ids((await inbox(h, T, MGR, 'workforce')).body)).toEqual([]);
  expect(ids((await inbox(h, T, OWNER, 'operations')).body)).toEqual(['ops-runbook:dl-shop']);

  // ── RESTART: a new API over the same store reads the same inbox and the same decisions.
  const again = make();
  const r1 = (await inbox(again, T, MGR, 'workforce')).body;
  expect(r1.dismissed.map((e) => e.finding.findingId)).toEqual(['wf-guidance:escalated:T-br1']);
  expect(ids(r1)).toEqual([]);
  const r2 = (await inbox(again, T, MGR, 'operations')).body;
  expect(ids(r2)).toEqual(['ops-runbook:dl-shop']);
  expect(r2.dismissed.map((e) => e.finding.findingId)).toEqual(['ops-runbook:dl-br1']);
  expect((await inbox(again, T, OWNER, 'data-quality')).body.dismissed.map((e) => e.dismissal?.by)).toEqual([OWNER]);
}

describe('the shared AI inboxes keep to the reader\'s branches (EA-09)', () => {
  it('A06, A08 and A10 — scope, evidence, a person decides, kill switch, refresh and restart (in memory)', async () => {
    let store: ApiHarness['store'] | undefined;
    const idem = new MemoryIdempotencyStore();
    await journey(() => {
      const h = apiHarness({ ...(store === undefined ? {} : { store }), idempotency: idem });
      store = h.store;
      return h;
    }, 'ab000000-0000-4000-8000-0000000ea009');
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('the shared AI inboxes keep to the reader\'s branches — real PostgreSQL (EA-09)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('the same journey on PostgreSQL, restart included', async () => {
    const sql = pgPoolClient(pool);
    await journey(() => apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }), randomUUID());
  });
});
