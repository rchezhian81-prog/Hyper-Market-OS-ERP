import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sentWithApproval } from '../support/approval-request';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { tradingDayIn, shiftDate } from '../../packages/calendar/src/index';
import { contractExpirySweep } from '../../services/api/src/fg4-buying-adapters';
import { alsoEachPassOf } from '../../services/api/src/ops-alert-sweeps';

/**
 * **FG-4 · M04-FR-04 / M06-FR-03 — an expired display contract and an expired (or expiring) supplier contract reach the
 * OWNER's alert inbox from the ops-alert worker's sweep; the "how many days ahead" window is NOT SET until the owner
 * enters it (no invented number), and a renewal clears the alert.**
 *
 *   • with the window not set: only contracts that have already ended are raised — once (a second pass finds them open);
 *   • the owner sets the window (a store manager cannot): a contract ending inside it is raised as "expiring";
 *   • a renewal (the same contract id recorded with a later end) clears its alert on the next pass;
 *   • an unapproved contract raises nothing (it carries no agreed terms);
 *   • the worker's own hook runs the sweep (`alsoEachPassOf`);
 *   • on PostgreSQL the window and the alerts survive a cold restart.
 * Synthetic data only.
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
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const today = tradingDayIn(new Date().toISOString(), { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' });
const day = (n: number): string => shiftDate(today, n);
const inr = (minor: number) => ({ minor, currency: 'INR' });
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe.each(backings)('FG-4 — contract-expiry alerts reach the owner — on $name', ({ name, harness }) => {
  it('expired contracts are raised once; the window is not set until the owner enters it; a renewal clears', async () => {
    let h = harness();
    const T = randomUUID();
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${userId}-${randomUUID()}` }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], ['s1', { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }]] as const) {
      await ok(call('POST', `/v1/org/nodes/${id}`, 'u-owner', body), `org ${id}`);
    }
    const display = (id: string, endsOn: string) => sentWithApproval(h, T, 'u-mgr', 'u-owner',
      { kind: 'display_contract', subjectRef: id, pathIds: { contractId: id }, valueMinor: 50_000 },
      { storeId: 's1', supplierId: 'sup-d', description: 'end-cap by the door', fundingAmount: inr(50_000), startsOn: day(-200), endsOn, locationIds: ['end1'] },
      (b) => call('POST', `/v1/merchandising/display-contracts/${id}`, 'u-mgr', b));
    const buying = (id: string, endsOn: string, approved = true) => {
      const body = { supplierId: 'sup-b', startsOn: day(-300), endsOn, agreedLeadTimeDays: 7 };
      return approved
        ? sentWithApproval(h, T, 'u-mgr', 'u-owner', { kind: 'purchase_contract', subjectRef: id, pathIds: { contractId: id } }, body, (b) => call('POST', `/v1/purchase/contracts/${id}`, 'u-mgr', b))
        : call('POST', `/v1/purchase/contracts/${id}`, 'u-mgr', body);
    };
    const sweep = () => contractExpirySweep({ store: h.store, now: () => new Date().toISOString() })(T, new Date().toISOString());
    const board = async () => JSON.stringify((await ok(call('GET', '/v1/platform/alerts', 'u-owner'), 'owner board')).body);

    // An expired display contract, an expired buying contract, one ending in 10 days, one far off, one never approved.
    expect((await display('DC-OLD', day(-3))).status).toBe(201);
    expect((await buying('SC-OLD', day(-1))).status).toBe(201);
    expect((await buying('SC-SOON', day(10))).status).toBe(201);
    expect((await buying('SC-FAR', day(200))).status).toBe(201);
    expect((await buying('SC-UNAPPROVED', day(-5), false)).status).toBe(201);

    // ── 1 · Window not set: the list says so, and only the two that have ended are due.
    const before = (await ok(call('GET', '/v1/reporting/contract-expiry-alerts', 'u-owner'), 'due')).body as { warningDays: { state: string }; due: { contractId: string; step: string }[] };
    expect(before.warningDays.state).toBe('not_set');
    expect(before.due.map((d) => `${d.contractId}:${d.step}`).sort()).toEqual(['DC-OLD:expired', 'SC-OLD:expired']);
    expect(await sweep()).toBe(2);
    expect(await sweep()).toBe(0); // already open — raised once
    let b = await board();
    expect(b).toContain(`display-contract-expiry:DC-OLD:${day(-3)}:expired`);
    expect(b).toContain(`supplier-contract-expiry:SC-OLD:${day(-1)}:expired`);
    expect(b).not.toContain('SC-SOON');
    expect(b).not.toContain('SC-UNAPPROVED');

    // ── 2 · The owner sets the window; a store manager cannot; a nonsense window is refused.
    expect((await call('POST', '/v1/reporting/contract-expiry-alerts/warning-days', 'u-mgr', { days: 30 })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/reporting/contract-expiry-alerts/warning-days', 'u-owner', { days: 0 }))).toBe('not_readable_as_a_warning_window');
    expect(codeOf(await call('POST', '/v1/reporting/contract-expiry-alerts/warning-days', 'u-owner', { days: null }))).toBe('clearing_needs_a_reason');
    await ok(call('POST', '/v1/reporting/contract-expiry-alerts/warning-days', 'u-owner', { days: 30 }), 'window');
    expect(await sweep()).toBe(1);
    expect(await board()).toContain(`supplier-contract-expiry:SC-SOON:${day(10)}:expiring`);

    // ── 3 · The worker's own hook runs it (nothing new to raise now).
    const said: string[] = [];
    expect(await alsoEachPassOf({ breaches: async () => 0, gstTimeBar: async () => 0, contractExpiry: contractExpirySweep({ store: h.store, now: () => new Date().toISOString() }), say: (l) => said.push(l) })(T, new Date().toISOString())).toBe(0);

    // ── 4 · A renewal clears: the display contract is recorded again ending next year.
    expect((await display('DC-OLD', day(300))).status).toBe(201);
    expect(await sweep()).toBe(0);
    const alerts = ((await ok(call('GET', '/v1/platform/alerts', 'u-owner'), 'board')).body as { alerts: { alert: { alertId: string }; state: string }[] }).alerts;
    expect(alerts.find((a) => a.alert.alertId === `display-contract-expiry:DC-OLD:${day(-3)}:expired`)?.state).toBe('cleared');
    expect(alerts.find((a) => a.alert.alertId === `supplier-contract-expiry:SC-OLD:${day(-1)}:expired`)?.state).not.toBe('cleared');

    // ── 5 · Cold restart (PostgreSQL): the window and the alerts are still there.
    if (name === 'real PostgreSQL') {
      const sql = pgPoolClient(pool!);
      h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
      const again = (await ok(call('GET', '/v1/reporting/contract-expiry-alerts', 'u-owner'), 'after restart')).body as { warningDays: { state: string; days: number } };
      expect(again.warningDays).toMatchObject({ state: 'set', days: 30 });
      b = await board();
      expect(b).toContain('supplier-contract-expiry:SC-SOON');
      expect(await sweep()).toBe(0);
    }
  }, 120_000);
});
