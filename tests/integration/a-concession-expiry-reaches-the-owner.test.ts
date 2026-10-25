import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedBody } from '../support/approval-request';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { commercialDesksSweep } from '../../services/api/src/commercial-desks-adapters';

/**
 * **OB-288 commercial desks — M27-FR-01/04 · OB-304: the Concessions desk lists every counter with whether it may trade
 * and why not, and an agreement / insurance / licence nearing its end reaches the OWNER — 30 days, 7 days, lapsed.**
 *
 * OB-304 (owner, 23 Oct 2026): SRE runs no concessions today — the feature stays OFF, and then nothing answers and the
 * worker raises nothing. With it ON (a shop that does run one):
 *   • the list shows each contract, its blockers (unapproved, lapsed insurance …), its deposit (a liability) and its alerts;
 *   • a raise puts each alert into the owner's alert board ONCE (a second raise finds it open); a store manager cannot raise;
 *   • the ops-alert worker's pass raises the same — only where the feature is on;
 *   • on PostgreSQL the list and the alerts survive a cold restart.
 * Synthetic data only.
 */

const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
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

const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe.each(backings)('M27-FR-01/04 — the Concessions desk and its expiry alerts — on $name', ({ name, harness }) => {
  it('off by default (OB-304); on, every counter is listed with its blockers and alerts, and the owner is told once per step', async () => {
    let h = harness();
    const T = randomUUID();
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${userId}-${randomUUID()}` }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-mgr', 'store_manager');

    // ── 0 · OB-304: switched off — nothing answers, and the worker raises nothing.
    expect(codeOf(await call('GET', '/v1/concession/contracts', 'u-owner'))).toBe('feature_not_entitled');
    expect(await commercialDesksSweep({ store: h.store, now: () => new Date().toISOString() })(T, new Date().toISOString())).toBe(0);

    await h.enableFeature(T, 'dept.concession');
    // A jewellery counter: approved, its insurance ending in 5 days (a 7-day alert), its agreement in 25 (a 30-day alert).
    const jewel = { concessionaireId: 'JEWEL', name: 'Jewellery counter', branchId: 'BR1', startsOn: day(-100), endsOn: day(25), basis: 'fixed_rent', fixedRentMinor: 500_000, depositMinor: 1_000_000, insuranceUntil: day(5) };
    await ok(call('POST', '/v1/concession/contracts/C-J', 'u-acct', await approvedBody(h, T, 'u-acct', 'u-owner', 'concession_contract', 'C-J', jewel, { contractId: 'C-J' })), 'jewel');
    // A mobile-phone counter recorded but NOT approved: it cannot trade, and it raises no expiry alert.
    await ok(call('POST', '/v1/concession/contracts/C-M', 'u-acct', { concessionaireId: 'MOBI', name: 'Mobile counter', branchId: 'BR1', startsOn: day(-1), endsOn: day(10), basis: 'revenue_share', revenueShareBps: 1_000, depositMinor: 0, insuranceUntil: day(200) }), 'mobile');
    await ok(call('POST', '/v1/concession/concessionaires/JEWEL/deposit-movements/dep-1', 'u-acct', { kind: 'received', amountMinor: 1_000_000 }), 'deposit');

    const list = (await ok(call('GET', '/v1/concession/contracts', 'u-owner'), 'list')).body as {
      contracts: { contract: { contractId: string }; trading: { mayTrade: boolean; blockedBy: string[]; warnings: string[] }; deposit: { outstandingLiabilityMinor: number }; alerts: { level: string; document: string }[] }[];
      alerts: { alertId: string; level: string; document: string }[];
    };
    const j = list.contracts.find((c) => c.contract.contractId === 'C-J')!;
    expect(j.trading.mayTrade).toBe(true);
    expect(j.trading.warnings).toHaveLength(2);
    expect(j.deposit.outstandingLiabilityMinor).toBe(1_000_000);
    expect(j.alerts.map((a) => `${a.document}:${a.level}`)).toEqual(['insurance:within_7_days', 'agreement:within_30_days']);
    const m = list.contracts.find((c) => c.contract.contractId === 'C-M')!;
    expect(m.trading.blockedBy).toContain('not_approved');
    expect(m.alerts).toEqual([]);
    // A store manager (no concession authority) reads nothing.
    expect((await call('GET', '/v1/concession/contracts', 'u-mgr')).status).toBe(403);

    // ── 1 · Raised to the owner once: a second raise finds them open; the manager cannot raise.
    expect((await ok(call('POST', '/v1/concession/expiry-alerts/raise', 'u-acct', {}), 'raise')).body).toMatchObject({ alerts: 2, raised: 2, alreadyOpen: 0 });
    expect((await ok(call('POST', '/v1/concession/expiry-alerts/raise', 'u-acct', {}), 'raise again')).body).toMatchObject({ alerts: 2, raised: 0, alreadyOpen: 2 });
    expect((await call('POST', '/v1/concession/expiry-alerts/raise', 'u-mgr', {})).status).toBe(403);
    expect(await commercialDesksSweep({ store: h.store, now: () => new Date().toISOString() })(T, new Date().toISOString())).toBe(0); // already open
    const board = JSON.stringify((await ok(call('GET', '/v1/platform/alerts', 'u-owner'), 'owner board')).body);
    expect(board).toContain(`concession-expiry:C-J:insurance:${day(5)}:within_7_days`);
    expect(board).toContain(`concession-expiry:C-J:agreement:${day(25)}:within_30_days`);

    // ── 2 · Cold restart (PostgreSQL): the counters and the owner's alerts are still there.
    if (name === 'real PostgreSQL') {
      const sql = pgPoolClient(pool!);
      h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
      const again = (await ok(call('GET', '/v1/concession/contracts', 'u-owner'), 'after restart')).body as { contracts: unknown[]; alerts: unknown[] };
      expect([again.contracts.length, again.alerts.length]).toEqual([2, 2]);
      expect(JSON.stringify((await ok(call('GET', '/v1/platform/alerts', 'u-owner'), 'board after restart')).body)).toContain('concession-expiry:C-J:insurance');
    }
  }, 120_000);
});
