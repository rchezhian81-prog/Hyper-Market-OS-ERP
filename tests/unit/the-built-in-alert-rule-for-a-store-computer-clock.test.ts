import { describe, it, expect } from 'vitest';
import { judgeBoxes, STORE_COMPUTER_CLOCK_HELD_COMPONENT, type BoxHealthRecord, type BoxClockCheck } from '../../services/platform/src/box-health';
import {
  rulesInForce, raiseObservedAlerts, BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID, BUILT_IN_STORE_COMPUTER_CLOCK_ACK_MINUTES, BUILT_IN_ALERT_RULE_IDS,
  BUILT_IN_RULE_COMPONENTS, EVERY_OWNER, type StoredAlertRules, type ObservedHealthDeps,
} from '../../services/platform/src/observed-health';
import { projectAlerts, type AlertLifecycleEvent } from '../../services/platform/src/alert-lifecycle';
import { DEFAULT_THRESHOLDS } from '../../packages/ops/src/index';
import { recordingTransport } from '../../packages/notifications/src/index';
import { deliverAlerts, OPS_ALERT_WORKER } from '../../services/platform/src/ops-alert-worker';

/**
 * **§31.1 · owner decision OB-409 "C" (27 Oct 2026, in writing; extends OB-403) — the built-in alert rule for a store
 * computer's clock, as rules.**
 *   • `box_clock_held` is present (degraded) only while a store computer is at the 5-minute flag (it holds new prices and
 *     offers), naming the store, the minutes out and what is held — never at the 2-minute warning, never when in step;
 *     a store whose last word was "held" and that has gone quiet stays on it, said STALE (never cleared on no news);
 *   • the built-in rule is in force for every owner, with no rule of his own, at degraded on that one component;
 *   • the ops-alert worker's raise opens ONE alert for the episode (later reports and passes add nothing), clears it when the
 *     clock is back in step, and opens a new occurrence when it goes out again.
 */

const T0 = Date.parse('2026-10-27T06:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (minutes: number): string => iso(T0 + minutes * 60_000);
const OWNER = { userId: 'u-owner', name: 'the owner (u-owner)' };
const OWNER2 = { userId: 'u-owner-2', name: 'the second owner' };

const clock = (verdict: BoxClockCheck['verdict'], offsetSeconds: number | null, held: boolean, ids: { promotions?: string[]; prices?: string[] } = {}): BoxClockCheck => ({
  verdict, offsetSeconds, lastCheckedAt: at(0), warnSeconds: 120, flagSeconds: 300,
  hold: { held, ...(held ? { since: at(0) } : {}), heldPromotions: ids.promotions ?? [], heldPrices: ids.prices ?? [] },
});
const report = (storeId: string, minutes: number, c: BoxClockCheck | undefined): BoxHealthRecord => ({
  storeId, observedAt: at(minutes), receivedAt: at(minutes), reportedBy: `u-box-${storeId}`,
  disk: { freeBytes: 50e9, totalBytes: 100e9, salesLogUsedBytes: 1e6, salesLogCapacityBytes: 1e9, reserveBytes: 1e8 },
  queue: { unsent: 0, deadLettered: 0 }, tills: [], clockAheadCorrected: false,
  ...(c === undefined ? {} : { clockCheck: c }),
});
const heldLine = (records: readonly BoxHealthRecord[], now = at(1)) =>
  judgeBoxes({ records, at: now, thresholds: DEFAULT_THRESHOLDS }).components.find((x) => x.name === STORE_COMPUTER_CLOCK_HELD_COMPONENT);

describe('§31.1 · OB-409: the clock-hold line (`box_clock_held`)', () => {
  it('absent in step, at the 2-minute warning, never checked, or with no clock check at all', () => {
    expect(heldLine([report('S1', 0, clock('in_step', 3, false))])).toBeUndefined();
    expect(heldLine([report('S1', 0, clock('warning', -200, false))])).toBeUndefined();
    expect(heldLine([report('S1', 0, clock('not_checked', null, false))])).toBeUndefined();
    expect(heldLine([report('S1', 0, undefined)])).toBeUndefined();
    // The per-store line still shows the warning (degraded) — only the owner's built-in alert waits for the flag.
    expect(judgeBoxes({ records: [report('S1', 0, clock('warning', -200, false))], at: at(1), thresholds: DEFAULT_THRESHOLDS }).components
      .find((x) => x.name === 'box_clock:S1')).toMatchObject({ status: 'degraded' });
  });

  it('degraded at the 5-minute flag — which store, how many minutes out, and what is held, in plain words', () => {
    const line = heldLine([report('S1', 0, clock('flag_bills', -1_560 * 60, true, { promotions: ['oil-10-new'], prices: ['pe-today'] })), report('S2', 0, clock('in_step', 1, false))])!;
    expect(line.status).toBe('degraded');
    expect(line.detail).toMatch(/^price change held — a store computer's clock is 5 minutes or more out: store S1 \(computer u-box-S1\): its clock is 1560 minutes \(26 hours\) AHEAD of head office/);
    expect(line.detail).toContain('held now: offer oil-10-new, price pe-today');
    expect(line.detail).toContain('selling goes on');
    expect(line.detail).toContain('clears by itself when it reports its clock back in step');
    expect(line.detail).not.toContain('S2');
    expect(line.evidence).toMatchObject({ stores: 'S1', computers: 'u-box-S1', offsetSeconds: `S1:${-1_560 * 60}`, heldPromotions: 'S1:oil-10-new', heldPrices: 'S1:pe-today', staleStores: '' });
    // Behind, by 6 minutes, nothing due yet; and two stores at once — both named.
    const two = heldLine([report('S1', 0, clock('flag_bills', 360, true)), report('S2', 0, clock('flag_bills', -400, true, { prices: ['pe-1'] }))])!;
    expect(two.detail).toMatch(/2 store computers' clocks are 5 minutes or more out: store S1 .*6 minutes BEHIND head office.*nothing new has been due yet; store S2 .*7 minutes AHEAD of head office.*held now: price pe-1/);
    expect(two.evidence).toMatchObject({ stores: 'S1,S2' });
  });

  it('a store that said "held" and went quiet stays on it, said STALE — never cleared on no news', () => {
    const line = heldLine([report('S1', 0, clock('flag_bills', -600, true))], at(120))!;
    expect(line.status).toBe('degraded');
    expect(line.detail).toMatch(/STALE — it last reported 2h 0m ago/);
    expect(line.evidence).toMatchObject({ staleStores: 'S1' });
  });
});

describe('§31.1 · OB-409: the built-in clock rule in force', () => {
  it('on for every owner with no rule of his own — the clock-hold component, at degraded, owner-only', () => {
    expect(BUILT_IN_ALERT_RULE_IDS).toContain(BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID);
    expect(BUILT_IN_RULE_COMPONENTS[BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID]).toBe(STORE_COMPUTER_CLOCK_HELD_COMPONENT);
    const r = rulesInForce(undefined, [OWNER2, OWNER]);
    expect(r.rules.find((x) => x.alertId === BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID)).toEqual({
      alertId: BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID, component: STORE_COMPUTER_CLOCK_HELD_COMPONENT, firesAt: 'degraded',
      ownerUserId: 'u-owner', ownerName: 'the owner (u-owner)', ackWithinMinutes: BUILT_IN_STORE_COMPUTER_CLOCK_ACK_MINUTES, alsoToUserIds: ['u-owner-2'],
    });
    const state = r.builtIn.find((b) => b.alertId === BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID)!;
    expect(state.state).toBe('on');
    expect(state.description).toMatch(/tells every owner \(all 2: u-owner, u-owner-2\) when any store computer's clock is 5 minutes or more out, so new prices and offers are held there .* not at the 2-minute warning/);
    expect(state.rule?.ownerUserId).not.toBe(EVERY_OWNER);
    // Turned off by the owner (builtInOff): not in force; nobody holding the owner role: not in force, said.
    const stored: StoredAlertRules = { version: 1, rules: [], thresholds: DEFAULT_THRESHOLDS, backupMaxAgeSeconds: 86_400, definedBy: 'u-owner', definedAt: at(0), builtInOff: [BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID] };
    const off = rulesInForce(stored, OWNER);
    expect(off.rules.some((x) => x.alertId === BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID)).toBe(false);
    expect(off.builtIn.find((b) => b.alertId === BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID)?.state).toBe('off');
    expect(rulesInForce(undefined, undefined).builtIn.find((b) => b.alertId === BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID)?.state).toBe('no_owner');
  });
});

describe('§31.1 · OB-409: one alert per episode; cleared back in step; again a new occurrence', () => {
  it('raised once at the flag (not at the warning), kept through later reports and passes, cleared in step, re-raised as occurrence 2', async () => {
    const events: (AlertLifecycleEvent & { key: string })[] = [];
    let records: BoxHealthRecord[] = [];
    const d: ObservedHealthDeps = {
      now: () => at(0),
      alerts: () => projectAlerts(events),
      recordAlertEvent: (_t, e, key) => { if (!events.some((x) => x.key === key)) events.push({ ...e, key }); },
      lastSaleSyncedAt: () => undefined, catalogueBuiltAt: () => undefined, connectorQueues: () => [], integrationHealth: () => ({}),
      backups: () => [], recordBackup: () => undefined,
      alertRules: () => undefined, defineAlertRules: () => undefined,
      shopOwner: () => OWNER,
      storeComputers: async () => ({ records, knownStores: [] }),
    };
    const pass = async (minutes: number) => raiseObservedAlerts(d, 't', 'system:ops-alert-worker', at(minutes), { clear: true });
    const mine = async () => (await d.alerts('t')).filter((a) => a.alert.alertId === BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID);

    records = [report('S1', 0, clock('warning', -200, false))];
    expect((await pass(1))!.newlyOpened).toBe(0);
    expect(await mine()).toEqual([]);

    records = [...records, report('S1', 2, clock('flag_bills', -400, true, { promotions: ['oil-10-new'] }))];
    expect((await pass(3))!.newlyOpened).toBe(1);
    const open = (await mine())[0]!;
    expect(open).toMatchObject({ state: 'open', occurrence: 1, alert: { ownerUserId: 'u-owner', status: 'degraded', component: STORE_COMPUTER_CLOCK_HELD_COMPONENT } });
    expect(open.alert.detail).toMatch(/store S1 .*7 minutes AHEAD of head office.*held now: offer oil-10-new/);
    // Later reports while it lasts (the clock drifting further) and passes: the same alert — nothing more is raised.
    for (const m of [4, 5, 6]) {
      records = [...records, report('S1', m, clock('flag_bills', -400 - m * 60, true, { promotions: ['oil-10-new'] }))];
      expect((await pass(m))!.newlyOpened).toBe(0);
    }
    expect(events.filter((e) => e.alertId === BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID && e.change === 'raised')).toHaveLength(1);

    // Back in step: cleared (kept, never deleted). Again at only the warning: nothing.
    records = [...records, report('S1', 7, clock('in_step', 2, false))];
    expect((await pass(7))!.cleared).toBe(1);
    expect((await mine())[0]).toMatchObject({ state: 'cleared', occurrence: 1 });
    records = [...records, report('S1', 8, clock('warning', 150, false))];
    expect((await pass(8))!.newlyOpened).toBe(0);
    // Out again past the flag: a NEW occurrence.
    records = [...records, report('S1', 9, clock('flag_bills', 330, true))];
    expect((await pass(9))!.newlyOpened).toBe(1);
    expect((await mine())[0]).toMatchObject({ state: 'open', occurrence: 2 });
  });
});

/**
 * **§31.1 · owner decision OB-414 "C" — when the stores in the open clock alert change, the SAME alert is updated and sent
 * again (to tick again); the same stores again change nothing; it clears only when every store is back in step.**
 */
describe('§31.1 · OB-414: the open clock alert follows the stores it is about', () => {
  function shop() {
    const events: (AlertLifecycleEvent & { key: string })[] = [];
    let records: BoxHealthRecord[] = [];
    const d: ObservedHealthDeps = {
      now: () => at(0),
      alerts: () => projectAlerts(events),
      recordAlertEvent: (_t, e, key) => { if (!events.some((x) => x.key === key)) events.push({ ...e, key }); },
      lastSaleSyncedAt: () => undefined, catalogueBuiltAt: () => undefined, connectorQueues: () => [], integrationHealth: () => ({}),
      backups: () => [], recordBackup: () => undefined,
      alertRules: () => undefined, defineAlertRules: () => undefined,
      shopOwner: () => OWNER,
      storeComputers: async () => ({ records, knownStores: [] }),
    };
    const transport = recordingTransport();
    return {
      events, transport,
      say: (r: BoxHealthRecord): void => { records = [...records, r]; },
      pass: async (minutes: number) => {
        const r = (await raiseObservedAlerts(d, 't', OPS_ALERT_WORKER, at(minutes), { clear: true }))!;
        const delivered = await deliverAlerts(d as never, 't', OPS_ALERT_WORKER, at(minutes), transport);
        return { ...r, delivered };
      },
      live: async () => (await d.alerts('t')).filter((a) => a.alert.alertId === BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID),
      ack: async (minutes: number, key: string): Promise<void> => { await d.recordAlertEvent('t', { alertId: BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID, change: 'acknowledged', by: 'u-owner', at: at(minutes) }, key); },
    };
  }

  it('S1 out → raised; S2 too → updated naming both, sent once; same again → nothing; S1 back → updated naming only S2; S2 back → cleared', async () => {
    const s = shop();
    s.say(report('S1', 0, clock('flag_bills', -400, true, { promotions: ['oil-10-new'] })));
    const first = await s.pass(1);
    expect([first.newlyOpened, first.updated, first.delivered]).toEqual([1, 0, 2]);
    expect((await s.live())[0]).toMatchObject({ state: 'open', occurrence: 1, alert: { members: ['S1'] } });
    expect((await s.live())[0]!.revision).toBeUndefined();
    // The owner ticks it.
    await s.ack(2, 'ack-clock');
    expect((await s.live())[0]!.state).toBe('acknowledged');

    // S2 goes out too: the SAME alert (occurrence 1), its words naming both, asked to be ticked again, sent again once.
    s.say(report('S2', 3, clock('flag_bills', 420, true, { prices: ['pe-s2'] })));
    const both = await s.pass(3);
    expect([both.newlyOpened, both.updated, both.cleared, both.delivered]).toEqual([0, 1, 0, 2]);
    const updated = (await s.live())[0]!;
    expect(updated).toMatchObject({ state: 'open', occurrence: 1, revision: 1, updatedAt: at(3), alert: { members: ['S1', 'S2'], raisedAt: at(1) } });
    expect(updated.alert.detail).toMatch(/2 store computers' clocks are 5 minutes or more out: store S1 .*held now: offer oil-10-new; store S2 .*7 minutes BEHIND head office.*held now: price pe-s2/);
    expect(s.transport.sent.map((m) => m.text.startsWith('UPDATED: '))).toEqual([false, true]);
    expect(s.transport.sent[1]!.text).toContain('store S2');

    // Another report with the same stores out (the minutes drift): nothing updated, nothing sent.
    s.say(report('S1', 4, clock('flag_bills', -460, true, { promotions: ['oil-10-new'] })));
    const same = await s.pass(4);
    expect([same.newlyOpened, same.updated, same.delivered]).toEqual([0, 0, 0]);
    // A second pass at the same moment (a second head-office instance) writes nothing more either.
    expect((await s.pass(4)).updated).toBe(0);

    // S1 back in step, S2 still out: updated again, naming only S2, sent once more — still not cleared.
    s.say(report('S1', 5, clock('in_step', 2, false)));
    const one = await s.pass(5);
    expect([one.newlyOpened, one.updated, one.cleared, one.delivered]).toEqual([0, 1, 0, 2]);
    const now = (await s.live())[0]!;
    expect(now).toMatchObject({ state: 'open', occurrence: 1, revision: 2, alert: { members: ['S2'] } });
    expect(now.alert.detail).toMatch(/^price change held — a store computer's clock is 5 minutes or more out: store S2 /);
    expect(now.alert.detail).not.toContain('store S1');
    expect(s.transport.sent).toHaveLength(3);
    expect(s.transport.sent[2]!.text).toMatch(/^UPDATED: box_clock_held is degraded — .*store S2/);

    // S2 back in step: cleared (kept); nothing more sent.
    s.say(report('S2', 6, clock('in_step', 1, false)));
    const done = await s.pass(6);
    expect([done.updated, done.cleared, done.delivered]).toEqual([0, 1, 0]);
    expect((await s.live())[0]).toMatchObject({ state: 'cleared', occurrence: 1, revision: 2 });
    expect(s.events.filter((e) => e.change === 'raised')).toHaveLength(1);
    expect(s.events.filter((e) => e.change === 'updated')).toHaveLength(2);
  });

  it('an update is head office\'s own and only for an open occurrence — a stray or late one changes nothing', () => {
    const raised = { alertId: BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID, component: STORE_COMPUTER_CLOCK_HELD_COMPONENT, status: 'degraded' as const, ownerUserId: 'u-owner', ownerName: 'o', detail: 'S1', raisedAt: at(0), ackDueBy: at(60), members: ['S1'] };
    const base: AlertLifecycleEvent[] = [{ alertId: raised.alertId, change: 'raised', by: OPS_ALERT_WORKER, at: at(0), alert: raised, origin: 'built-in-rule' }];
    const upd: AlertLifecycleEvent = { alertId: raised.alertId, change: 'updated', by: OPS_ALERT_WORKER, at: at(2), alert: { ...raised, detail: 'S1, S2', members: ['S1', 'S2'] }, origin: 'built-in-rule' };
    const cleared: AlertLifecycleEvent = { alertId: raised.alertId, change: 'cleared', by: OPS_ALERT_WORKER, at: at(1) };
    // Head office's own update of the open alert: applied.
    expect(projectAlerts([...base, upd])[0]).toMatchObject({ revision: 1, alert: { detail: 'S1, S2' } });
    // Not head office's own rule (no origin): ignored.
    const { origin: _o, ...stray } = upd;
    void _o;
    expect(projectAlerts([...base, stray])[0]).toMatchObject({ alert: { detail: 'S1' } });
    // After it cleared: ignored (no reopening on an update).
    const late = projectAlerts([...base, cleared, upd])[0]!;
    expect(late).toMatchObject({ state: 'cleared', alert: { detail: 'S1' } });
    expect(late.revision).toBeUndefined();
    // For an alert never raised: no phantom.
    expect(projectAlerts([upd])).toEqual([]);
  });
});
