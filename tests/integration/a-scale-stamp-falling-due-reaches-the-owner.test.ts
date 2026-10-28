import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings } from '../support/r3-ops-backings';
import type { ApiHarness } from '../support/api-harness';
import { tradingDayIn, shiftDate } from '../../packages/calendar/src/index';
import { scaleStampExpirySweep } from '../../services/api/src/r6b-quality-scale-adapters';
import { scaleRegisterAdapter } from '../../services/api/src/r2-till-adapters';
import { alsoEachPassOf } from '../../services/api/src/ops-alert-sweeps';
import { SCALE_VERIFICATION_NOTICE_DAYS } from '../../packages/facilities/src/index';
import type { WeighingScaleRecord } from '../../services/platform/src/scale-register';

/**
 * **Round 6 · B7 (roadmap v2.1 addendum, M34) — "an alert fires before expiry".** Before this round a scale whose stamp
 * was falling due showed only as "due soon" on the Scales page. Now the ops-alert worker sweeps the weighing-scale
 * register and raises, into every owner's alert inbox, each scale whose Legal Metrology stamp falls due within the
 * register's notice period (`SCALE_VERIFICATION_NOTICE_DAYS` — 30 days, the same window the Scales page judges "due soon"
 * by) or has lapsed: once while it is open, cleared when the scale is re-stamped. A far-off stamp raises nothing. It is
 * one line on the worker's own hook. In memory and on real PostgreSQL, with a cold restart. Synthetic data only.
 */

const backings = r3OpsBackings();
const today = tradingDayIn(new Date().toISOString(), { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' });
const day = (n: number): string => shiftDate(today, n);
const scale = (assetId: string, dueIn: number, version = 1): WeighingScaleRecord => ({
  assetId, storeId: 'S1', laneIds: ['L1'], approvalNo: `LM/APP/${assetId}`, capacityGrams: 30_000, lastStampedOn: day(dueIn - 365),
  reverificationDueOn: day(dueIn), certificateRef: `LM/VC/${assetId}/${version}`, version, setBy: 'u-owner', setAt: new Date().toISOString(),
});

describe.each(backings)('B7 — a weighing-scale stamp falling due reaches the owner — on $name', ({ harness, restart }) => {
  it('raises the due-soon and lapsed scales once, not the far-off one; a re-stamp clears; survives a restart', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const now = () => new Date().toISOString();
    const register = () => scaleRegisterAdapter({ store: h.store, now });
    const sweep = () => scaleStampExpirySweep({ store: h.store, now })(T, now());
    const alerts = async (userId = 'u-owner') => h.request({ method: 'GET', path: '/v1/platform/alerts', userId, tenantId: T });
    const open = async () => ((await alerts()).body as { alerts: { alert: { alertId: string; component: string; detail: string; ownerUserId: string }; state: string }[] }).alerts;

    expect(SCALE_VERIFICATION_NOTICE_DAYS).toBe(30);
    await register().recordScale(T, scale('SC-SOON', 10));
    await register().recordScale(T, scale('SC-EDGE', 30));      // exactly at the notice period: due soon
    await register().recordScale(T, scale('SC-FAR', 31));       // one day outside it: nothing
    await register().recordScale(T, scale('SC-LAPSED', -2));

    expect(await sweep()).toBe(3);
    expect(await sweep()).toBe(0); // raised once while open
    const board = await open();
    const ids = board.map((a) => a.alert.alertId).sort();
    expect(ids).toEqual([`scale-stamp-due:SC-EDGE:${day(30)}`, `scale-stamp-due:SC-LAPSED:${day(-2)}`, `scale-stamp-due:SC-SOON:${day(10)}`]);
    const soon = board.find((a) => a.alert.alertId.includes('SC-SOON'))!;
    expect(soon.alert).toMatchObject({ component: 'Weighing scale SC-SOON (S1)', ownerUserId: 'u-owner' });
    expect(soon.alert.detail).toContain(`valid only until ${day(10)}`);
    expect(soon.alert.detail).toContain('verification due in 10 day(s)');
    expect(board.find((a) => a.alert.alertId.includes('SC-LAPSED'))!.alert.detail).toContain('lapsed');

    h = restart(h); // ── COLD RESTART ─────────────────────────────────────────────────────────────────────────────────────
    expect(await sweep()).toBe(0); // still open after the restart — not raised twice

    // A re-stamp (a new version with a later due date) clears its alert on the next pass; the others stay open.
    await register().recordScale(T, scale('SC-SOON', 365, 2));
    expect(await sweep()).toBe(0);
    const after = await open();
    expect(after.find((a) => a.alert.alertId === `scale-stamp-due:SC-SOON:${day(10)}`)?.state).toBe('cleared');
    expect(after.find((a) => a.alert.alertId === `scale-stamp-due:SC-LAPSED:${day(-2)}`)?.state).not.toBe('cleared');

    // The ops-alert worker's own hook runs it, and says what it raised.
    await register().recordScale(T, scale('SC-NEW', 5));
    const said: string[] = [];
    await alsoEachPassOf({ breaches: async () => 0, gstTimeBar: async () => 0, scaleStamp: scaleStampExpirySweep({ store: h.store, now }), say: (l) => said.push(l) })(T, now());
    expect(said).toEqual([`alerts: 1 weighing-scale stamp alert(s) raised to the owners of shop ${T}`]);

    // A cashier cannot read the owner's alerts.
    expect((await alerts('u-cash')).status).toBe(403);
  });

  it('a failing sweep is said, and the other sweeps still run', async () => {
    const said: string[] = [];
    let ran = false;
    await expect(alsoEachPassOf({
      breaches: async () => 0, gstTimeBar: async () => { ran = true; return 0; },
      scaleStamp: async () => { throw new Error('scale register unreadable'); }, say: (l) => said.push(l),
    })('t', new Date().toISOString())).rejects.toThrow(/scale register unreadable/);
    expect(ran).toBe(true);
  });
});
