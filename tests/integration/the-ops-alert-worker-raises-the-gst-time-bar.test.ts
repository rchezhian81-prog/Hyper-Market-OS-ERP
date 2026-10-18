import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { apiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { localDateOf, gstTimeBarSweep } from '../../services/api/src/r3-gst-adapters';
import { alsoEachPassOf } from '../../services/api/src/ops-alert-sweeps';

/**
 * **R3 · A19 on the timer — the ops-alert worker raises a GST return near or past the 3-year bar with nobody pressing
 * anything, and keeps raising the delivery-exception breaches as before.**
 *
 *   • In memory: the worker's per-shop hook (`alsoEachPassOf`) runs BOTH sweeps — the breach sweep's count is what it
 *     answers, the time-bar alerts are raised and said — and one sweep failing never stops the other.
 *   • The REAL API (`startApi`) on REAL PostgreSQL: a sale four years ago leaves its GSTR-1 and GSTR-3B barred; the
 *     worker's own passes put them on the owner's alert board. Needs DATABASE_URL; without it that part SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TODAY = localDateOf(new Date().toISOString(), 'Asia/Kolkata');
const BARRED_DAY = `${Number(TODAY.slice(0, 4)) - 4}-${TODAY.slice(5, 7)}-05`;
const BARRED = `${BARRED_DAY.slice(5, 7)}${BARRED_DAY.slice(0, 4)}`;
const sale = (saleId: string) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-owner', tradingDay: BARRED_DAY, committedAt: `${BARRED_DAY}T05:30:00Z`, totalMinor: 10_500, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'p-paneer', quantityMinor: 1, uom: 'each', unitPriceMinor: 10_500, lineTotalMinor: 10_500, hsnCode: '040610', taxRateBps: 500 }],
  tenders: [{ kind: 'cash', amountMinor: 10_500 }],
});
interface Live { alert: { alertId: string; ownerUserId: string; detail: string }; state: string }

describe('the ops-alert worker\'s per-shop hook runs the GST time-bar sweep beside the breach sweep (A19)', () => {
  it('both run; the breach count is answered; the time-bar alerts are raised once and said', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    expect((await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body: sale('S-OLD') })).status).toBeLessThan(300);
    const said: string[] = [];
    let breachRuns = 0;
    const hook = alsoEachPassOf({
      breaches: async () => { breachRuns += 1; return 2; },
      gstTimeBar: gstTimeBarSweep({ store: h.store, now: () => new Date().toISOString() }),
      say: (l) => { said.push(l); },
    });
    const at = new Date().toISOString();
    expect(await hook(T, at)).toBe(2);
    expect(breachRuns).toBe(1);
    expect(said).toEqual([expect.stringMatching(/^alerts: [2-9]\d* GST time-bar alert\(s\) raised to the owners of shop /)]);
    const board = (await h.request({ method: 'GET', path: '/v1/platform/alerts', userId: 'u-owner', tenantId: T })).body as { alerts: Live[] };
    expect(board.alerts.map((a) => a.alert.alertId)).toEqual(expect.arrayContaining([`gst-time-bar:GSTR1:${BARRED}`, `gst-time-bar:GSTR3B:${BARRED}`]));
    // A second pass: the breaches run again, the time-bar alerts are already open — nothing new said.
    expect(await hook(T, at)).toBe(2);
    expect(breachRuns).toBe(2);
    expect(said).toHaveLength(1);
  });

  it('one sweep failing never stops the other — and the pass is then reported failed, not quiet', async () => {
    const ran: string[] = [];
    const failingBreaches = alsoEachPassOf({
      breaches: async () => { ran.push('breaches'); throw new Error('orders store unreachable'); },
      gstTimeBar: async () => { ran.push('gst'); return 0; },
      say: () => {},
    });
    await expect(failingBreaches('t1', '2030-01-01T00:00:00Z')).rejects.toThrow(/orders store unreachable/);
    expect(ran).toEqual(['breaches', 'gst']);
    ran.length = 0;
    const failingGst = alsoEachPassOf({
      breaches: async () => { ran.push('breaches'); return 1; },
      gstTimeBar: async () => { ran.push('gst'); throw new Error('time-bar fold failed'); },
      say: () => {},
    });
    await expect(failingGst('t1', '2030-01-01T00:00:00Z')).rejects.toThrow(/time-bar fold failed/);
    expect(ran).toEqual(['breaches', 'gst']);
  });
});

(DATABASE_URL ? describe : describe.skip)('the REAL API\'s ops-alert worker raises the GST time bar on its own timer — real PostgreSQL (A19)', () => {
  const clouds: RealCloud[] = [];
  afterAll(async () => { for (const c of clouds) await c.stop(); });

  it('a barred month reaches the owner\'s alert board with nobody pressing raise', async () => {
    const tenantId = randomUUID();
    const KEY = ['gst', 'time', 'bar', 'worker', 'key'].join('-').padEnd(48, '0');
    const cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: 'u-owner', packSigningKey: KEY, providers: { opsAlertWorkerIntervalMs: 50 } });
    clouds.push(cloud);
    expect(cloud.opsAlertWorker).toBeDefined();
    const r = await cloud.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', idempotencyKey: `k-${randomUUID()}`, body: sale('S-OLD') });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const want = [`gst-time-bar:GSTR1:${BARRED}`, `gst-time-bar:GSTR3B:${BARRED}`];
    let ids: string[] = [];
    for (let i = 0; i < 600; i += 1) {
      const board = (await cloud.request({ method: 'GET', path: '/v1/platform/alerts', userId: 'u-owner' })).body as { alerts: Live[] };
      ids = board.alerts.map((a) => a.alert.alertId);
      if (want.every((w) => ids.includes(w))) break;
      await sleep(20);
    }
    expect(ids).toEqual(expect.arrayContaining(want));
    const board = (await cloud.request({ method: 'GET', path: '/v1/platform/alerts', userId: 'u-owner' })).body as { alerts: Live[] };
    const g3b = board.alerts.find((a) => a.alert.alertId === `gst-time-bar:GSTR3B:${BARRED}`)!;
    expect(g3b.alert.ownerUserId).toBe('u-owner');
    expect(g3b.alert.detail).toMatch(/barred/);
    // The worker says what it raised (the line follows the write, so wait for the pass to finish).
    for (let i = 0; i < 200 && !/GST time-bar alert\(s\) raised/.test(cloud.said.join('\n')); i += 1) await sleep(20);
    expect(cloud.said.join('\n')).toMatch(/GST time-bar alert\(s\) raised to the owners of shop/);
    // No pass failed on the way.
    expect(cloud.opsAlertWorker!.passes.every((p) => p.failed.length === 0)).toBe(true);
  }, 120_000);
});
