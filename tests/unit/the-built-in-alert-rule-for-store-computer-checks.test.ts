import { describe, it, expect } from 'vitest';
import {
  boxHistoryComponents, STORE_COMPUTER_CHECKS_STUCK_COMPONENT, STORE_COMPUTER_CHECKS_STUCK_MINUTES,
} from '../../services/platform/src/box-health';
import {
  rulesInForce, raiseObservedAlerts, BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID, BUILT_IN_ALERT_RULE_IDS, BUILT_IN_STORE_COMPUTER_CHECKS_ACK_MINUTES,
  type StoredAlertRules, type ObservedHealthDeps,
} from '../../services/platform/src/observed-health';
import { projectAlerts, type AlertLifecycleEvent } from '../../services/platform/src/alert-lifecycle';
import { DEFAULT_THRESHOLDS, type AlertRule } from '../../packages/ops/src/index';

/**
 * **Round 31 · owner decision OB-114 "A" — the built-in alert rule, as rules.**
 *   • `store_computer_checks_stuck` is shown `ok` while the checks have been not ready for up to an hour, `down` past it
 *     (to the minute), and absent when they are ready;
 *   • the built-in rule is in force for whoever holds the owner role, alongside the owner's own rules; replaced by his own
 *     version of it; turned off by `builtInOff`; not in force with nobody holding the owner role;
 *   • while the store computer checks are being prepared, an open "checks not ready" alert is cleared once they are ready,
 *     while the store computers' own alerts are kept (round 29).
 */

const SINCE = '2026-10-14T08:00:00.000Z';
const after = (minutes: number, seconds = 0): string => new Date(Date.parse(SINCE) + minutes * 60_000 + seconds * 1000).toISOString();
const OWNER = { userId: 'u-owner', name: 'the owner (u-owner)' };
const stored = (over: Partial<StoredAlertRules> = {}): StoredAlertRules => ({
  version: 1, rules: [], thresholds: DEFAULT_THRESHOLDS, backupMaxAgeSeconds: 86_400, definedBy: 'u-owner', definedAt: SINCE, ...over,
});
const DISK_RULE: AlertRule = { alertId: 'disk', component: 'box_disk:S1', firesAt: 'degraded', ownerUserId: 'u-mgr', ownerName: 'Manager', ackWithinMinutes: 15 };

describe('round 31 · OB-114: the "checks not ready" component', () => {
  const at = (minutes: number, seconds = 0, preparing = true) => boxHistoryComponents({
    at: after(minutes, seconds), ...(preparing ? { preparing: { since: SINCE, why: 'nothing is saved yet' } } : {}),
    history: { sizeBytes: null, saveHeld: null, lastBuildFailed: null, notReadySince: SINCE, ...(preparing ? {} : { noSealKey: true as const }) },
  }).find((c) => c.name === STORE_COMPUTER_CHECKS_STUCK_COMPONENT);

  it(`ok up to ${STORE_COMPUTER_CHECKS_STUCK_MINUTES} minutes (saying how long so far), down past it — to the second`, () => {
    expect(at(0)).toMatchObject({ status: 'ok' });
    expect(at(59)!.detail).toMatch(/not ready yet \(being prepared, for 59 minutes of head office running so far\); the owner is told if this lasts more than 60 minutes of head office running/);
    expect(at(STORE_COMPUTER_CHECKS_STUCK_MINUTES)).toMatchObject({ status: 'ok' });
    expect(at(STORE_COMPUTER_CHECKS_STUCK_MINUTES, 1)).toMatchObject({ status: 'down', evidence: { why: 'being_prepared', notReadySince: SINCE } });
    expect(at(61)!.detail).toMatch(/have not been ready for 61 minutes of head office running \(since 2026-10-14T08:00:00.000Z; now being prepared\)/);
    expect(at(61, 0, false)!.detail).toMatch(/now running without the seal key, so the saved history cannot be sealed/);
    expect(at(61, 0, false)!.evidence).toMatchObject({ why: 'no_seal_key' });
  });

  it('absent when the checks are ready, or when no time is given', () => {
    expect(boxHistoryComponents({ at: after(90), history: { sizeBytes: 10, saveHeld: null, lastBuildFailed: null } }).map((c) => c.name)).toEqual(['box_history']);
    expect(boxHistoryComponents({ history: { sizeBytes: null, saveHeld: null, lastBuildFailed: null, notReadySince: SINCE } })).toEqual([]);
  });
});

describe('round 31 · OB-114: the built-in rule in force', () => {
  it('on for the owner, beside his own rules — the stuck component, at down, acknowledged within the built-in time', () => {
    const r = rulesInForce(stored({ rules: [DISK_RULE] }), OWNER);
    expect(r.rules).toEqual([DISK_RULE, {
      alertId: BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID, component: STORE_COMPUTER_CHECKS_STUCK_COMPONENT, firesAt: 'down',
      ownerUserId: 'u-owner', ownerName: 'the owner (u-owner)', ackWithinMinutes: BUILT_IN_STORE_COMPUTER_CHECKS_ACK_MINUTES,
    }]);
    expect(r.builtIn).toEqual([expect.objectContaining({ alertId: BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID, state: 'on' })]);
    // With no rules of his own at all, it is still in force.
    expect(rulesInForce(undefined, OWNER).rules.map((x) => x.alertId)).toEqual([BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID]);
    expect(BUILT_IN_ALERT_RULE_IDS).toEqual([BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID]);
  });

  it('his own version replaces it; turned off it is not in force (nor his version); nobody holding the owner role: not in force, said', () => {
    const mine: AlertRule = { alertId: BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID, component: STORE_COMPUTER_CHECKS_STUCK_COMPONENT, firesAt: 'down', ownerUserId: 'u-mgr', ownerName: 'Manager', ackWithinMinutes: 10 };
    const edited = rulesInForce(stored({ rules: [mine] }), OWNER);
    expect(edited.rules).toEqual([mine]);
    expect(edited.builtIn).toEqual([expect.objectContaining({ state: 'edited', rule: mine })]);
    const off = rulesInForce(stored({ rules: [DISK_RULE, mine], builtInOff: [BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID] }), OWNER);
    expect(off.rules).toEqual([DISK_RULE]);
    expect(off.builtIn).toEqual([expect.objectContaining({ state: 'off' })]);
    const none = rulesInForce(stored({ rules: [DISK_RULE] }), undefined);
    expect(none.rules).toEqual([DISK_RULE]);
    expect(none.builtIn).toEqual([expect.objectContaining({ state: 'no_owner' })]);
    expect(rulesInForce(stored({ builtInOff: [] }), OWNER).builtIn[0]!.state).toBe('on');
  });
});

describe('round 31 · OB-114: while being prepared, this alert is judged; the store computers\' own alerts are kept', () => {
  function deps(components: { preparing: boolean; stuck: boolean }) {
    const events: AlertLifecycleEvent[] = [];
    const d: ObservedHealthDeps = {
      now: () => after(120),
      alerts: () => projectAlerts(events),
      recordAlertEvent: (_t, e, key) => { if (!events.some((x) => (x as { key?: string }).key === key)) events.push({ ...e, key } as AlertLifecycleEvent); },
      lastSaleSyncedAt: () => undefined, catalogueBuiltAt: () => undefined, connectorQueues: () => [], integrationHealth: () => ({}),
      backups: () => [], recordBackup: () => undefined,
      alertRules: () => stored({ rules: [DISK_RULE] }), defineAlertRules: () => undefined,
      shopOwner: () => OWNER,
      storeComputers: async () => ({
        records: [], knownStores: [],
        ...(components.preparing ? { preparing: { since: SINCE, why: 'nothing is saved yet' } } : {}),
        history: { sizeBytes: null, saveHeld: null, lastBuildFailed: null, ...(components.stuck ? { notReadySince: SINCE } : {}) },
      }),
    };
    return { d, events };
  }

  it('raised while being prepared; cleared once ready — and an open store-computer alert is kept while preparing', async () => {
    const s = deps({ preparing: true, stuck: true });
    // An open store-computer alert from before.
    await s.d.recordAlertEvent('t', { alertId: 'disk', change: 'raised', by: 'x', at: SINCE, alert: { alertId: 'disk', component: 'box_disk:S1', status: 'down', ownerUserId: 'u-mgr', ownerName: 'Manager', detail: 'full', raisedAt: SINCE, ackDueBy: SINCE } }, 'raise-disk');
    const raised = await raiseObservedAlerts(s.d, 't', 'w', after(120), { clear: true });
    expect(raised!.newlyOpened).toBe(1);
    expect(raised!.keptWhilePreparing).toBe(1);
    const live = await s.d.alerts('t');
    expect(live.map((a) => `${a.alert.alertId}:${a.state}:${a.alert.ownerUserId}`).sort()).toEqual([`${BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID}:open:u-owner`, 'disk:open:u-mgr']);
    // Still being prepared, but no longer past the hour (a fresh not-ready span): this alert is cleared, the disk alert kept.
    const again = deps({ preparing: true, stuck: false });
    const carried = { ...again.d, alerts: s.d.alerts, recordAlertEvent: s.d.recordAlertEvent };
    const r2 = await raiseObservedAlerts(carried, 't', 'w', after(121), { clear: true });
    expect([r2!.cleared, r2!.keptWhilePreparing]).toEqual([1, 1]);
    expect((await s.d.alerts('t')).find((a) => a.alert.alertId === BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID)!.state).toBe('cleared');
  });
});
