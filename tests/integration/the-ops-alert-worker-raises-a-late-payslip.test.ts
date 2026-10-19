import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { apiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { caller, addStaff } from '../support/r4-lane1';
import { payslipLateSweep } from '../../services/api/src/r4-pay-epr-adapters';
import { alsoEachPassOf } from '../../services/api/src/ops-alert-sweeps';

/**
 * **R4 · C15 on the timer — the ops-alert worker raises a payslip not issued by its pay date to the owner with nobody
 * pressing anything, beside the delivery-exception breaches and the GST time bar.**
 *
 *   • In memory: the worker's per-shop hook (`alsoEachPassOf`) runs all three sweeps; the late-payslip alerts are raised
 *     once and said; one sweep failing never stops the others, and the pass is then reported failed.
 *   • The REAL API (`startApi`) on REAL PostgreSQL: a payslip prepared for a pay date long past (2025) and never issued
 *     reaches the owner's alert board on the worker's own passes. Needs DATABASE_URL; without it that part SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const PERIOD = '2025-03';
const ALERT = `payslip-late:${PERIOD}:e1`;
const body = { onDate: '2025-03-31', attendance: { calendarDaysInMonth: 31, paidDays: 31 }, components: [{ code: 'BASIC', monthlyMinor: 1_200_000, partOfPfWage: true }] };
interface Live { alert: { alertId: string; ownerUserId: string; detail: string }; state: string }

describe('the ops-alert worker\'s per-shop hook runs the late-payslip sweep beside the others (C15)', () => {
  it('all three run; the breach count is answered; the late payslip is raised once and said', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const c = caller(() => h, T);
    await addStaff(c, 'e1');
    await c.ok(c.req('POST', `/v1/hr/payroll/statutory-payslips/e1/${PERIOD}`, body), 'prepare e1');
    const said: string[] = [];
    const ran: string[] = [];
    const hook = alsoEachPassOf({
      breaches: async () => { ran.push('breaches'); return 1; },
      gstTimeBar: async () => { ran.push('gst'); return 0; },
      payslipLate: payslipLateSweep({ store: h.store, now: () => new Date().toISOString() }),
      say: (l) => { said.push(l); },
    });
    const at = new Date().toISOString();
    expect(await hook(T, at)).toBe(1);
    expect(ran).toEqual(['breaches', 'gst']);
    expect(said).toEqual([`alerts: 1 late-payslip alert(s) raised to the owners of shop ${T}`]);
    const board = (await h.request({ method: 'GET', path: '/v1/platform/alerts', userId: 'u-owner', tenantId: T })).body as { alerts: Live[] };
    const a = board.alerts.find((x) => x.alert.alertId === ALERT)!;
    expect(a.alert.ownerUserId).toBe('u-owner');
    expect(a.alert.detail).toBe(`e1's payslip for ${PERIOD} was not issued by the pay date 2025-03-31`);
    // A second pass: already open — nothing new raised or said.
    expect(await hook(T, at)).toBe(1);
    expect(said).toHaveLength(1);
  });

  it('one sweep failing never stops the others — and the pass is then reported failed, not quiet', async () => {
    const ran: string[] = [];
    const sweeps = (fail: string) => alsoEachPassOf({
      breaches: async () => { ran.push('breaches'); if (fail === 'breaches') throw new Error('orders store unreachable'); return 0; },
      gstTimeBar: async () => { ran.push('gst'); if (fail === 'gst') throw new Error('time-bar fold failed'); return 0; },
      payslipLate: async () => { ran.push('payslip'); if (fail === 'payslip') throw new Error('payslip fold failed'); return 0; },
      say: () => {},
    });
    for (const [fail, words] of [['breaches', /orders store unreachable/], ['gst', /time-bar fold failed/], ['payslip', /payslip fold failed/]] as const) {
      ran.length = 0;
      await expect(sweeps(fail)('t1', '2030-01-01T00:00:00Z')).rejects.toThrow(words);
      expect(ran).toEqual(['breaches', 'gst', 'payslip']);
    }
  });
});

(DATABASE_URL ? describe : describe.skip)('the REAL API\'s ops-alert worker raises a late payslip on its own timer — real PostgreSQL (C15)', () => {
  const clouds: RealCloud[] = [];
  afterAll(async () => { for (const c of clouds) await c.stop(); });

  it('a payslip not issued by its pay date reaches the owner\'s alert board with nobody pressing raise', async () => {
    const tenantId = randomUUID();
    const KEY = ['late', 'payslip', 'worker', 'key'].join('-').padEnd(48, '0');
    const cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: 'u-owner', packSigningKey: KEY, providers: { opsAlertWorkerIntervalMs: 50 } });
    clouds.push(cloud);
    expect(cloud.opsAlertWorker).toBeDefined();
    const staff = await cloud.request({ method: 'POST', path: '/v1/hr/workforce/employees/e1', userId: 'u-owner', idempotencyKey: `k-${randomUUID()}`, body: { name: 'Staff e1', branchId: 'br-1', roles: ['cashier'], active: true } });
    expect(staff.status, JSON.stringify(staff.body)).toBeLessThan(300);
    const prep = await cloud.request({ method: 'POST', path: `/v1/hr/payroll/statutory-payslips/e1/${PERIOD}`, userId: 'u-owner', idempotencyKey: `k-${randomUUID()}`, body });
    expect(prep.status, JSON.stringify(prep.body)).toBeLessThan(300);
    let found: Live | undefined;
    for (let i = 0; i < 600 && found === undefined; i += 1) {
      const board = (await cloud.request({ method: 'GET', path: '/v1/platform/alerts', userId: 'u-owner' })).body as { alerts: Live[] };
      found = board.alerts.find((a) => a.alert.alertId === ALERT);
      if (found === undefined) await sleep(20);
    }
    expect(found, 'the late payslip never reached the owner').toBeDefined();
    expect(found!.alert.ownerUserId).toBe('u-owner');
    expect(found!.alert.detail).toMatch(/was not issued by the pay date 2025-03-31/);
    const target = cloud.opsAlertWorker!.total() + 2;
    for (let i = 0; i < 1_500 && cloud.opsAlertWorker!.total() < target; i += 1) await sleep(20);
    expect(cloud.said.join('\n')).toMatch(/late-payslip alert\(s\) raised to the owners of shop/);
    expect(cloud.opsAlertWorker!.passes.every((p) => p.failed.length === 0), JSON.stringify(cloud.opsAlertWorker!.passes)).toBe(true);
  }, 120_000);
});
