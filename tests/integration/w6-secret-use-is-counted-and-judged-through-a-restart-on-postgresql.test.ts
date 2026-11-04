import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP } from '../support/api-harness';
import { pinTheEveningClock } from '../support/evening-clock';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { addDays } from '../../services/platform/src/secret-use';
import { secretUseRollupSweep, secretUseRollupStream, secretUseAlertId } from '../../services/api/src/w6-secret-use-adapters';

/**
 * **W6 · M32-FR-03 ("abnormal usage alerts") · owner decision OB-688 — the durable daily count of secret use, on PostgreSQL.**
 *
 * Head office counts every call a MACHINE credential makes (here the store computer `box-1`, signing in with credential
 * reference `cred-box-1`, and the backup job) per caller, per API, per shop day, appends the counts to its ledger, and each
 * night judges each finished day ONCE against the same weekday a week before, with the usage-signals route's own rule.
 * Proven on real PostgreSQL:
 *   • counts kept by one head office are read by a fresh one (a cold restart), including the last tally kept on shutdown;
 *   • the nightly pass did not run for nine nights (head office down): the first pass catches every day up, judging each
 *     day once — a spike (box-1: 200 calls against 10) and a caller gone quiet (the backup job) — and raises each to the
 *     named IT custodian (the security reviewer, OB-405) and the owner;
 *   • a second pass after another restart raises nothing and keeps no roll-up twice (counted on the ledger table);
 *   • the Integration health read shows each credential's last-30-days use and what the check found;
 *   • nothing kept anywhere holds the token, any part of it, or the signing key.
 * Synthetic data only.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const SIVA = 'u-siva';
const evening = pinTheEveningClock();
afterAll(() => { vi.useRealTimers(); });
const TODAY = evening.shopDate;
const A = addDays(TODAY, -9); // the baseline day
const B = addDays(TODAY, -2); // a week after A — the day that changed sharply
const noonOf = (day: string): string => `${day}T06:30:00.000Z`; // 12:00 in the shop

describe.skipIf(!DATABASE_URL)('M32-FR-03 · OB-688 — secret use counted daily, judged once, through a restart and missed nights (PostgreSQL)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  }, 120_000);
  afterAll(async () => { await pool.end(); });

  it('counts survive a restart; missed nights are caught up once; the custodian is told; nothing secret is kept', async () => {
    const sql = pgPoolClient(pool);
    const T = randomUUID();
    const boot = () => apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    const h1 = boot();
    await h1.seedOwner(T, OWNER);
    await h1.provisionRole(T, 'box-1', 'store_computer', ['store-1']);
    await h1.provisionRole(T, 'backup', 'backup_job');
    await h1.provisionRole(T, SIVA, 'security_reviewer');
    expect((await h1.request({ method: 'PUT', path: '/v1/compliance/security-reviewer', userId: OWNER, tenantId: T, idempotencyKey: `rev-${T}`, body: { userId: SIVA, displayName: 'Mr Sivakumar', reason: 'OB-405: the IT custodian' } })).status).toBe(200);

    // The past days' use, handed to the counter exactly as the kernel hands it (the same sink).
    const past = (callerId: string, ref: string, api: string, role: string, day: string, n: number): void => {
      for (let i = 0; i < n; i++) h1.secretUse.record({ tenantId: T, callerId, credentialRef: ref, api, status: 200, at: noonOf(day), roleIds: [role] });
    };
    past('box-1', 'cred-box-1', 'API-07', 'store_computer', A, 10);
    past('backup', 'cred-backup', 'API-11', 'backup_job', A, 3);
    past('box-1', 'cred-box-1', 'API-07', 'store_computer', B, 200);
    expect(await h1.secretUse.flush()).toBe(3);
    // Today's use: real calls through the kernel with the box's own credential (the token is never kept, only cred-box-1).
    const token = TEST_IDP.issue({ sub: 'box-1', tenantId: T, branchId: 'store-1', jti: 'cred-box-1', authTimeFromNowSeconds: null, amr: null });
    for (let i = 0; i < 3; i++) expect((await h1.raw({ method: 'GET', path: '/v1/catalogue/ratings', token })).status).toBe(200);
    await h1.secretUse.stop(); // shutdown keeps the last tally

    // A cold restart. The nightly pass has not run since before A (nine nights missed); the first pass now catches up.
    const h2 = boot();
    const sweep = secretUseRollupSweep({ store: new SqlEventStore(sql), now: () => new Date().toISOString() });
    expect(await sweep(T, new Date().toISOString())).toBe(2);
    const rolled = await pool.query('SELECT payload FROM event_ledger WHERE tenant_id = $1 AND stream = $2 ORDER BY seq', [T, secretUseRollupStream()]);
    const days = rolled.rows.map((r: { payload: { day: string; judged: boolean } }) => r.payload);
    expect(days.map((d) => d.day)).toEqual(Array.from({ length: 9 }, (_, i) => addDays(A, i)));
    expect(days.filter((d) => d.judged).map((d) => d.day)).toEqual([B, addDays(TODAY, -1)]);

    // The alerts: on the operational alerts board, owned by the IT custodian, the owner also told — references and counts.
    const board = await h2.request({ method: 'GET', path: '/v1/platform/alerts', userId: OWNER, tenantId: T });
    expect(board.status).toBe(200);
    const alerts = (board.body as { alerts: { alert: { alertId: string; ownerUserId: string; alsoToUserIds?: string[]; detail: string } }[] }).alerts.filter((a) => a.alert.alertId.startsWith('secret-use:'));
    expect(alerts.map((a) => a.alert.alertId).sort()).toEqual([secretUseAlertId(B, 'backup', 'API-11', 'silent'), secretUseAlertId(B, 'box-1', 'API-07', 'spike')].sort());
    const spike = alerts.find((a) => a.alert.alertId.endsWith(':spike'))!.alert;
    expect(spike.ownerUserId).toBe(SIVA);
    expect(spike.alsoToUserIds).toEqual([OWNER]);
    expect(spike.detail).toContain(`On ${B}, box-1 (credential reference cred-box-1) used API-07: 200 call(s), 0 refused or failed; on ${A} (the same day a week before): 10 call(s)`);

    // Another restart and another pass the same night: nothing new, no roll-up kept twice (append-only, counted on the table).
    const h3 = boot();
    expect(await secretUseRollupSweep({ store: new SqlEventStore(sql), now: () => new Date().toISOString() })(T, new Date().toISOString())).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM event_ledger WHERE tenant_id = $1 AND stream = $2', [T, secretUseRollupStream()])).rows[0].n).toBe(9);

    // The Integration health read: each credential's last 30 days, from the durable count, after the restarts.
    const read = await h3.request({ method: 'GET', path: '/v1/integration/secrets/usage', userId: OWNER, tenantId: T });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const body = read.body as { from: string; to: string; uses: { credentialRef: string; callerId: string; api: string; calls: number; daysUsed: number; lastUsedOn: string }[]; lastRolledUpDay: string; findings: { day: string; signal: string }[] };
    expect(body.to).toBe(TODAY);
    expect(body.from).toBe(addDays(TODAY, -29));
    expect(body.uses.map((u) => [u.credentialRef, u.callerId, u.api, u.calls, u.daysUsed, u.lastUsedOn])).toEqual([
      ['cred-backup', 'backup', 'API-11', 3, 1, A],
      ['cred-box-1', 'box-1', 'API-07', 213, 3, TODAY],
    ]);
    expect(body.lastRolledUpDay).toBe(addDays(TODAY, -1));
    expect(body.findings.map((f) => `${f.day}:${f.signal}`).sort()).toEqual([`${B}:silent`, `${B}:spike`]);
    // A store manager may not read it (the route's own permission).
    await h3.provisionRole(T, 'u-mgr', 'store_manager');
    expect((await h3.request({ method: 'GET', path: '/v1/integration/secrets/usage', userId: 'u-mgr', tenantId: T })).status).toBe(403);

    // Hard rule #4: nothing on the shop's ledger holds the token, any part of it, or the signing key.
    const all = JSON.stringify((await pool.query('SELECT stream, payload FROM event_ledger WHERE tenant_id = $1', [T])).rows);
    expect(all).toContain('cred-box-1');
    const [head, payload, sig] = token.split('.');
    for (const bad of [token, head!, payload!, sig!, h3.idp.policy().secret]) expect(all).not.toContain(bad);
  }, 180_000);
});
