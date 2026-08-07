import { describe, it, expect } from 'vitest';
import {
  checkHealth,
  raiseAlerts,
  escalateUnacknowledged,
  worstOf,
  DEFAULT_THRESHOLDS,
  type AlertRule,
  type HealthSignals,
} from '../../packages/ops/src/index';

// M35-FR-03/04 — P-08 says sync lag, stale data and reconciliation differences are
// VISIBLE. The failure this prevents: everything looks green, the till keeps
// printing, and 41 sales have not reached the cloud since 11am.

const NOW = '2026-08-03T15:00:00Z';

function signals(over: Partial<HealthSignals> = {}): HealthSignals {
  return {
    lastSyncAt: '2026-08-03T14:58:00Z',
    queueDepth: 0,
    deadLetterCount: 0,
    catalogueBuiltAt: '2026-08-03T13:00:00Z',
    databaseReachable: true,
    localStoreWritable: true,
    lastBackupAt: '2026-08-03T03:00:00Z',
    ...over,
  };
}

describe('checkHealth — health from evidence, never from optimism', () => {
  it('reports a healthy system as up to date', () => {
    const health = checkHealth(signals(), NOW);
    expect(health.status).toBe('ok');
    expect(health.canTrade).toBe(true);
    expect(health.summary).toBe('Everything is up to date');
  });

  it('treats a missing signal as unknown, never as ok', () => {
    // The absence of a heartbeat is not a heartbeat.
    const health = checkHealth({}, NOW);
    expect(health.status).toBe('unknown');
    expect(health.components.find((c) => c.name === 'sync')?.status).toBe('unknown');
    expect(health.components.find((c) => c.name === 'backup')?.detail).toContain(
      'no backup has ever been reported',
    );
    expect(health.summary).toContain('not the same as healthy');
  });

  it('catches the sales that never left the building', () => {
    const health = checkHealth(
      signals({ lastSyncAt: '2026-08-03T11:00:00Z', queueDepth: 41 }),
      NOW,
    );
    expect(health.status).toBe('down'); // 4 hours of lag
    expect(health.components.find((c) => c.name === 'sync')?.detail).toContain('4h 0m');
    expect(health.components.find((c) => c.name === 'queue')?.detail).toContain('41 item(s) waiting');
    // ...and the store is still trading throughout (P-01).
    expect(health.canTrade).toBe(true);
  });

  it('grades sync lag against the tenant’s own thresholds', () => {
    const fresh = checkHealth(signals({ lastSyncAt: '2026-08-03T14:50:00Z' }), NOW);
    expect(fresh.components.find((c) => c.name === 'sync')?.status).toBe('ok');

    const lagging = checkHealth(signals({ lastSyncAt: '2026-08-03T14:30:00Z' }), NOW);
    expect(lagging.components.find((c) => c.name === 'sync')?.status).toBe('degraded');

    const custom = checkHealth(signals({ lastSyncAt: '2026-08-03T14:30:00Z' }), NOW, {
      ...DEFAULT_THRESHOLDS,
      syncLagWarnSeconds: 7_200,
    });
    expect(custom.components.find((c) => c.name === 'sync')?.status).toBe('ok');
  });

  it('never lets a dead letter go quiet — each one is a real sale', () => {
    const health = checkHealth(signals({ deadLetterCount: 3 }), NOW);
    expect(health.components.find((c) => c.name === 'dead_letter')?.status).toBe('down');
    expect(health.components.find((c) => c.name === 'dead_letter')?.detail).toContain(
      'each one is a real sale',
    );
  });

  it('losing the cloud is degraded; losing the lane’s own store is the only stop', () => {
    const cloudDown = checkHealth(signals({ databaseReachable: false }), NOW);
    expect(cloudDown.components.find((c) => c.name === 'database')?.status).toBe('degraded');
    expect(cloudDown.canTrade).toBe(true); // P-01: the store keeps trading

    const laneDown = checkHealth(signals({ localStoreWritable: false }), NOW);
    expect(laneDown.canTrade).toBe(false);
    expect(laneDown.components.find((c) => c.name === 'local_store')?.detail).toContain(
      'an unrecorded sale is worse than a refused one',
    );
  });

  it('calls out a stale backup — the silent disaster', () => {
    const health = checkHealth(signals({ lastBackupAt: '2026-07-30T03:00:00Z' }), NOW);
    const backup = health.components.find((c) => c.name === 'backup');
    expect(backup?.status).toBe('down');
    expect(backup?.detail).toContain('4 days ago');
    expect(backup?.detail).toContain('silent disaster');
  });

  it('warns when lane prices are old enough to be wrong', () => {
    const health = checkHealth(signals({ catalogueBuiltAt: '2026-08-03T04:00:00Z' }), NOW);
    expect(health.components.find((c) => c.name === 'catalogue')?.status).toBe('degraded');
    expect(health.components.find((c) => c.name === 'catalogue')?.detail).toContain(
      'a price changed today may not be here',
    );
  });

  it('reports each integration by name, queued not lost', () => {
    const health = checkHealth(
      signals({ integrations: { tally: false, whatsapp: true } }),
      NOW,
    );
    expect(health.components.find((c) => c.name === 'integration:tally')?.detail).toContain(
      'work is queued, not lost',
    );
    expect(health.components.find((c) => c.name === 'integration:whatsapp')?.status).toBe('ok');
  });

  it('takes the worst of its parts', () => {
    expect(worstOf(['ok', 'degraded', 'ok'])).toBe('degraded');
    expect(worstOf(['ok', 'unknown'])).toBe('unknown');
    expect(worstOf(['degraded', 'down'])).toBe('down');
    expect(worstOf([])).toBe('unknown');
  });
});

describe('alerts — every one has a named owner and escalates (M35-FR-04)', () => {
  const RULES: AlertRule[] = [
    {
      alertId: 'a-sync',
      component: 'sync',
      firesAt: 'degraded',
      ownerUserId: 'u-it',
      ownerName: 'Karthik',
      ackWithinMinutes: 15,
      escalatesToUserId: 'u-owner',
    },
    {
      alertId: 'a-backup',
      component: 'backup',
      firesAt: 'down',
      ownerUserId: 'u-it',
      ownerName: 'Karthik',
      ackWithinMinutes: 15,
    },
  ];

  it('raises nothing when everything is fine', () => {
    expect(raiseAlerts(checkHealth(signals(), NOW), RULES)).toEqual([]);
  });

  it('routes an alert to a person by name, with an acknowledgement deadline', () => {
    const health = checkHealth(signals({ lastSyncAt: '2026-08-03T11:00:00Z' }), NOW);
    const alerts = raiseAlerts(health, RULES);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.ownerName).toBe('Karthik');
    expect(alerts[0]?.ackDueBy).toBe('2026-08-03T15:15:00Z'); // §32: 15-minute ack
  });

  it('does not fire an alert configured for a worse state than we are in', () => {
    // sync is degraded, but the backup rule only fires at down.
    const health = checkHealth(signals({ lastSyncAt: '2026-08-03T14:30:00Z' }), NOW);
    expect(raiseAlerts(health, RULES).map((a) => a.alertId)).toEqual(['a-sync']);
  });

  it('escalates an unacknowledged alert to a named person', () => {
    const health = checkHealth(signals({ lastSyncAt: '2026-08-03T11:00:00Z' }), NOW);
    const alerts = raiseAlerts(health, RULES);

    expect(escalateUnacknowledged(alerts, RULES, [], '2026-08-03T15:10:00Z')).toEqual([]);
    expect(escalateUnacknowledged(alerts, RULES, ['a-sync'], '2026-08-03T15:30:00Z')).toEqual([]);

    const escalated = escalateUnacknowledged(alerts, RULES, [], '2026-08-03T15:20:00Z');
    expect(escalated[0]?.escalatedTo).toBe('u-owner');
    expect(escalated[0]?.detail).toContain('has not acknowledged in time');
  });

  it('says plainly when an alert has nowhere to escalate to', () => {
    const health = checkHealth(signals({ lastBackupAt: '2026-07-01T03:00:00Z' }), NOW);
    const alerts = raiseAlerts(health, RULES);
    const escalated = escalateUnacknowledged(alerts, RULES, [], '2026-08-03T15:30:00Z');
    expect(escalated.find((e) => e.alert.alertId === 'a-backup')?.detail).toContain(
      'nowhere to escalate to',
    );
  });
});
