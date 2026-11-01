import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { askForApproval, decide, approvedRequestId } from '../support/approval-request';
import { aBranch } from '../support/a-branch';
import { storeRules } from '../support/store-rules';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { InMemoryConfigVersionStore, SqlConfigVersionStore } from '../../packages/persistence/src/config-store';
import { DurableTenantSettings } from '../../packages/tenant/src/durable-settings';
import { approvalAgeSweep } from '../../services/api/src/p1-identity-adapters';
import { alertLifecycleAdapter } from '../../services/api/src/adapters';

/**
 * **The owner's money limits, escalation waits and price-check size — on the real API, in memory AND on real PostgreSQL,
 * with a cold restart (OB-290 · OB-291 · OB-292 · M02-FR-02 · M02-FR-03 · M05-FR-01 · §28 · P-08).**
 *
 *   • the limit is the SERVER's: `/v1/access/approvals/decide` ignores a limit in the body (the audit's finding) — a ₹6,000
 *     refund is refused for a store manager even when the body says "unlimited", and a ₹500 one passes though the body
 *     says ₹100;
 *   • on the engine, a ₹3,000 write-off is above a store manager's ₹2,000 adjustment limit: it leaves their inbox (they are
 *     told how many went to the owner), their approval is refused by name, and the owner approves it;
 *   • the limits change only through two people: a manager may not touch their own role's limits; the accountant asks,
 *     the owner approves, the change applies, survives a cold restart, and shows in the history; a second blind change is
 *     refused; a rollback is its own version;
 *   • a store manager's write-off waits; at 47 hours nothing; at 48 hours it is escalated ONCE to the owner, recorded and
 *     raised in the owner's alert inbox; the inbox row says so;
 *   • a price change of more than 10% or ₹50 needs a second person; 10% exactly commits alone.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface Backing { readonly store: ApiHarness['store']; readonly settings: DurableTenantSettings; readonly harness: () => ApiHarness }
const backings: { name: string; make: () => Backing }[] = [{
  name: 'the in-memory stores',
  make: () => {
    const settings = new DurableTenantSettings(new InMemoryConfigVersionStore());
    const first = apiHarness({ settings });
    return { store: first.store, settings, harness: () => apiHarness({ store: first.store, settings }) };
  },
}];
if (DATABASE_URL !== undefined) {
  backings.push({
    name: 'real PostgreSQL',
    make: () => {
      const sql = pgPoolClient(pool!);
      const settings = new DurableTenantSettings(new SqlConfigVersionStore(sql));
      const store = new SqlEventStore(sql);
      return { store, settings, harness: () => apiHarness({ store, idempotency: new SqlIdempotencyStore(sql), settings }) };
    },
  });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const inr = (minor: number) => ({ minor, currency: 'INR' });

describe.each(backings)('the owner\'s approval rules on $name (OB-290/291/292)', ({ make }) => {
  async function shop() {
    const b = make();
    const T = randomUUID();
    let h = b.harness();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-mgr2', 'store_manager');
    await h.provisionRole(T, 'u-acc', 'accountant');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    return { b, T, h: () => h, restart: () => { h = b.harness(); }, req };
  }

  it('a limit in the body is ignored — the server\'s figure decides (the audit\'s finding)', async () => {
    const { req } = await shop();
    const refund = (minor: number) => ({ id: `r-${minor}`, subjectType: 'refund', subjectRef: 'sale-9', requestedBy: 'u-desk', branchId: null, value: inr(minor) });
    const own = (authorityLimit: unknown) => ({ userId: 'u-mgr', branchScope: 'all', authorityLimit });
    const big = await req('POST', '/v1/access/approvals/decide', 'u-mgr', { request: refund(600_000), decision: 'approved', reason: 'ok', own: own(null) });
    expect(big.status).toBe(422);
    expect(codeOf(big)).toBe('exceeds_authority');
    const small = await req('POST', '/v1/access/approvals/decide', 'u-mgr', { request: refund(50_000), decision: 'approved', reason: 'ok', own: own(inr(10_000)) });
    expect(small.status, JSON.stringify(small.body)).toBe(200);
    expect(small.body).toMatchObject({ limitFrom: 'server', limitApplied: inr(500_000) });
    // The owner is unlimited whatever the body says.
    const owner = await req('POST', '/v1/access/approvals/decide', 'u-owner', { request: refund(9_000_000), decision: 'approved', reason: 'ok', own: { userId: 'u-owner', branchScope: 'all', authorityLimit: inr(1) } });
    expect(owner.status).toBe(200);
  });

  it('above a checker\'s limit the request goes to the owner; the limits change only through two people; a cold restart keeps them', async () => {
    const s = await shop();
    const { T, req } = s;
    const loss = { productId: 'p-1', locationId: 'store-1', qty: 3, uom: 'EA', lossType: 'damage', reasonCode: 'damaged', writeOffId: 'wo-1' };
    const asked = await askForApproval(s.h(), T, 'u-mgr', { kind: 'stock_write_off', subjectRef: 'wo-1', details: loss, valueMinor: 300_000 });
    expect(asked.status).toBe(201);
    const id = (asked.body as { requestId: string }).requestId;
    const inbox = (await req('GET', '/v1/approvals/requests', 'u-mgr2')).body as { waitingForMe: { requestId: string }[]; routedToOwnerAboveYourLimit: number };
    expect(inbox.waitingForMe.map((r) => r.requestId)).not.toContain(id);
    expect(inbox.routedToOwnerAboveYourLimit).toBe(1);
    const refused = await decide(s.h(), T, 'u-mgr2', id);
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('exceeds_your_limit');
    expect(((await req('GET', '/v1/approvals/requests', 'u-owner')).body as { waitingForMe: { requestId: string }[] }).waitingForMe.map((r) => r.requestId)).toContain(id);

    // The rules as they stand: the owner's decided ladder, version 0.
    const rules = (await req('GET', '/v1/approvals/rules', 'u-mgr')).body as { rules: { limits: { version: number; source: string; value: { byRole: Record<string, Record<string, number | null>> } } } };
    expect(rules.rules.limits).toMatchObject({ version: 0, source: 'owner_decision_23_oct_2026' });
    expect((await req('GET', '/v1/approvals/rules', 'u-cash')).status).toBe(403);

    const raised = { byRole: { ...rules.rules.limits.value.byRole, store_manager: { refund: 500_000, purchase_order: 2_500_000, stock_adjustment: 500_000 } } };
    const change = { value: raised, basedOnVersion: 0, reason: 'managers handle bigger write-offs at Diwali' };
    // A manager may not change their own role's limits (§28).
    const ownAsk = await approvedRequestId(s.h(), T, 'u-mgr', 'u-owner', { kind: 'approval_rule_change', subjectRef: 'rule:limits', details: actionDetails(change, { rule: 'limits' }) });
    const own = await req('PUT', '/v1/approvals/rules/limits', 'u-mgr', { ...change, approvalId: ownAsk });
    expect(own.status).toBe(422);
    expect(codeOf(own)).toBe('cannot_change_own_limits');
    // No approval: refused by name.
    expect(codeOf(await req('PUT', '/v1/approvals/rules/limits', 'u-acc', change))).toBe('not_readable_as_a_rule_change');
    // Only the owner approves a rule change; the maker never approves their own.
    const ask = await askForApproval(s.h(), T, 'u-acc', { kind: 'approval_rule_change', subjectRef: 'rule:limits', details: actionDetails(change, { rule: 'limits' }) });
    const ruleId = (ask.body as { requestId: string }).requestId;
    expect((await decide(s.h(), T, 'u-mgr', ruleId)).status).toBe(403);
    expect((await decide(s.h(), T, 'u-owner', ruleId)).status).toBe(201);
    const applied = await req('PUT', '/v1/approvals/rules/limits', 'u-acc', { ...change, approvalId: ruleId });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ version: 1, approvedBy: 'u-owner', changedBy: 'u-acc' });
    // The same approval does not apply twice; a change asked against the old version is refused.
    expect((await req('PUT', '/v1/approvals/rules/limits', 'u-acc', { ...change, approvalId: ruleId })).status).toBe(409);

    s.restart(); // ── cold restart: the rule is read back from the store ──
    expect(((await req('GET', '/v1/approvals/rules', 'u-owner')).body as { rules: { limits: { version: number; changedBy: string } } }).rules.limits).toMatchObject({ version: 1, changedBy: 'u-acc' });
    expect(((await req('GET', '/v1/approvals/authority/me', 'u-mgr2')).body as { authority: { subjectType: string; limitMinor: number | null }[] }).authority.find((a) => a.subjectType === 'stock_adjustment')!.limitMinor).toBe(500_000);
    // Now the ₹3,000 write-off is within the second manager's limit.
    expect((await decide(s.h(), T, 'u-mgr2', id)).status).toBe(201);

    // One-step rollback, approved like a change, is its own version.
    const back = { toVersion: 1, basedOnVersion: 1, reason: 'restore' };
    const rbId = await approvedRequestId(s.h(), T, 'u-acc', 'u-owner', { kind: 'approval_rule_change', subjectRef: 'rule:limits', details: actionDetails(back, { rule: 'limits' }) });
    const rb = await req('POST', '/v1/approvals/rules/limits/rollback', 'u-acc', { ...back, approvalId: rbId });
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    const history = (await req('GET', '/v1/approvals/rules/limits/history', 'u-owner')).body as { versions: { version: number; rolledBackFrom: number | null }[] };
    expect(history.versions.map((v) => [v.version, v.rolledBackFrom])).toEqual([[1, null], [2, 1]]);
    // The generic config rollback cannot reach an approval rule.
    expect(codeOf(await req('POST', '/v1/platform/config/approvals.authority_limits/rollback', 'u-owner', { toVersion: 1, reason: 'x' }))).toBe('approval_rule_has_its_own_route');
  });

  it('an approval waiting past its kind\'s time is escalated once to the owner, recorded and raised in his alert inbox', async () => {
    const s = await shop();
    const { T, req, b } = s;
    const asked = await askForApproval(s.h(), T, 'u-mgr', { kind: 'stock_write_off', subjectRef: 'wo-9', details: { writeOffId: 'wo-9' }, valueMinor: 100_000 });
    const id = (asked.body as { requestId: string }).requestId;
    const sweep = approvalAgeSweep({ store: b.store, now: () => new Date().toISOString(), settings: b.settings });
    const hoursOn = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    expect(await sweep(T, hoursOn(47))).toBe(0);
    expect(await sweep(T, hoursOn(48.1))).toBe(1);
    expect(await sweep(T, hoursOn(49))).toBe(0); // once
    const report = (await req('GET', '/v1/approvals/escalations', 'u-owner')).body as { escalations: { requestId: string; escalatedTo: string; waitMinutes: number }[]; waits: Record<string, number> };
    expect(report.escalations).toEqual([expect.objectContaining({ requestId: id, escalatedTo: 'owner', waitMinutes: 2_880 })]);
    expect(report.waits).toEqual({ refund: 60, purchase_order: 1_440, stock_adjustment: 2_880 });
    const alerts = await alertLifecycleAdapter({ store: b.store, now: () => new Date().toISOString() }).alerts(T);
    expect(alerts.find((a) => a.alert.alertId === `approval-age:${id}`)).toMatchObject({ state: expect.not.stringMatching('cleared'), alert: { ownerUserId: 'u-owner' } });
    s.restart();
    const row = ((await req('GET', '/v1/approvals/requests', 'u-owner')).body as { waitingForMe: { requestId: string; escalation?: { escalatedTo: string } }[] }).waitingForMe.find((r) => r.requestId === id);
    expect(row?.escalation).toMatchObject({ escalatedTo: 'owner' });
    expect(await sweep(T, hoursOn(50))).toBe(0); // still once, after the restart
    // Decided: the alert is cleared on the next pass (kept, never deleted).
    expect((await decide(s.h(), T, 'u-owner', id)).status).toBe(201);
    await sweep(T, hoursOn(51));
    expect((await alertLifecycleAdapter({ store: b.store, now: () => new Date().toISOString() }).alerts(T)).find((a) => a.alert.alertId === `approval-age:${id}`)?.state).toBe('cleared');
  });

  it('a price change of more than 10% or ₹50 a unit needs a second person; 10% exactly commits alone (OB-291)', async () => {
    const s = await shop();
    const { T, req } = s;
    await s.h().provisionOwner(T, 'u-owner2');
    await aBranch(s.h(), T, 'u-owner');
    await storeRules(s.h(), T, 'u-owner', 'store-1', 0);
    const price = (priceMinor: number) => ({ productId: 'P1', priceMinor, mrpMinor: 50_000, costMinor: 1_000, marginFloorBps: 0, currency: 'INR' });
    expect((await req('POST', '/v1/prices/changes', 'u-owner', price(10_000))).status).toBe(201); // a first price is not a change
    expect((await req('POST', '/v1/prices/changes', 'u-owner', price(11_000))).status).toBe(201); // exactly 10%
    const big = await req('POST', '/v1/prices/changes', 'u-owner', price(12_200)); // 10.9%
    expect(big.status).toBe(422);
    expect(codeOf(big)).toBe('price_change_needs_second_person');
    const approvalId = await approvedRequestId(s.h(), T, 'u-owner', 'u-owner2', { kind: 'price_change', subjectRef: 'P1', details: price(12_200), valueMinor: 12_200 });
    const ok = await req('POST', '/v1/prices/changes', 'u-owner', { ...price(12_200), approvalId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ approvedBy: 'u-owner2' });
    expect((await req('POST', '/v1/prices/changes', 'u-cash', price(12_300))).status).toBe(403);
  });

  it('a decision relayed from the store above the decider\'s limit is recorded, flagged and not applied', async () => {
    const s = await shop();
    const { T } = s;
    await s.h().provisionRole(T, 'box-1', 'store_computer', ['store-1']);
    const decision = { id: 'sreq-1', subjectType: 'refund', subjectRef: 'sale-1', requestedBy: 'u-desk', branchId: null, value: inr(700_000), status: 'approved', decidedBy: 'u-mgr', reason: 'ok', decidedAt: new Date().toISOString(), storeId: 'store-1', source: 'manager-screen' };
    const r = await s.h().request({ method: 'POST', path: '/v1/approvals/decisions/sreq-1/synced', userId: 'box-1', tenantId: T, idempotencyKey: 'sync-1', body: decision });
    expect(r.status).toBe(202);
    expect((r.body as { flags: string[]; applied: boolean }).flags).toContain('decider_over_limit');
    expect((r.body as { applied: boolean }).applied).toBe(false);
  });
});
