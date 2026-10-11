// M35-FR-03/04/01 — observed operational health over stub deps: the cloud reads its own signals, judges
// them with the same engine, needs named owners before it raises anything, and never guesses a lane's disk.
import { describe, it, expect } from 'vitest';
import {
  observedHealthRoutes, observeSignals, goodBackup, DEFAULT_BACKUP_MAX_AGE_SECONDS,
  type ObservedHealthDeps, type BackupRecord, type StoredAlertRules, type ConnectorQueueDepth,
} from '../../services/platform/src/observed-health';
import { projectAlerts, type AlertLifecycleEvent } from '../../services/platform/src/alert-lifecycle';
import { DEFAULT_THRESHOLDS, type AlertRule } from '../../packages/ops/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';

const T = 't-sre';
const NOW = '2026-09-29T10:00:00.000Z';
const minutesAgo = (m: number): string => new Date(Date.parse(NOW) - m * 60_000).toISOString();

interface World {
  lastSale?: string; catalogue?: string; queues: ConnectorQueueDepth[]; integrations: Record<string, boolean>;
  backups: BackupRecord[]; rules: StoredAlertRules[]; alertEvents: AlertLifecycleEvent[]; keys: string[];
}
function stub(over: Partial<World> = {}) {
  const w: World = { queues: [], integrations: {}, backups: [], rules: [], alertEvents: [], keys: [], ...over };
  const deps: ObservedHealthDeps = {
    now: () => NOW,
    lastSaleSyncedAt: () => w.lastSale,
    catalogueBuiltAt: () => w.catalogue,
    connectorQueues: () => w.queues,
    integrationHealth: () => w.integrations,
    backups: () => w.backups,
    recordBackup: (_t, r) => { w.backups.push(r); },
    alertRules: () => w.rules[w.rules.length - 1],
    defineAlertRules: (_t, r) => { w.rules.push(r); },
    alerts: () => projectAlerts(w.alertEvents),
    recordAlertEvent: (_t, e, key) => { w.alertEvents.push(e); w.keys.push(key); },
    // PA-12 r7: 'u-ops' (the default caller here) stands for the backup job's own machine identity.
    isBackupJob: (_t, u) => u === 'u-ops',
  };
  return { w, deps, routes: observedHealthRoutes(deps) };
}
const ctx = (over: Partial<RequestContext> = {}): RequestContext =>
  ({ tenantId: T, userId: 'u-ops', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });
const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};
const RULES_PATH = '/v1/platform/alert-rules';
const OBSERVED = '/v1/platform/operational-health/observed';
const RAISE = `${OBSERVED}/raise`;
const BACKUP = '/v1/platform/backups/:backupId/taken';
const RULE: AlertRule = { alertId: 'sync-lag', component: 'sync', firesAt: 'degraded', ownerUserId: 'u-owner', ownerName: 'The owner', ackWithinMinutes: 30, escalatesToUserId: 'u-mgr' };
const DEAD: AlertRule = { alertId: 'dead-letters', component: 'dead_letter', firesAt: 'down', ownerUserId: 'u-ops', ownerName: 'Ops', ackWithinMinutes: 60 };
const putRules = (routes: readonly Route[], body: unknown, userId = 'u-ops') => routeFor(routes, 'PUT', RULES_PATH).handler(ctx({ userId, body }));

interface Thrown { status: number; body: { code: string; whatHappened: string } }
const thrown = async (fn: () => unknown): Promise<Thrown> => {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected a refusal');
};
interface Health { status: string; canTrade: boolean; components: { name: string; status: string; detail: string }[] }
interface ObservedBody { observed: { signals: Record<string, unknown>; freshness: { lastSaleAt: string | null; ageSeconds: number | null }; lastBackup: BackupRecord | null; notObserved: string[]; provenance: Record<string, string> }; health: Health; wouldRaise: { alertId: string }[]; rulesVersion: number | null }
interface RaiseBody { raised: number; newlyOpened: number; alerts: { alertId: string; component: string; status: string; ownerUserId: string }[]; health: Health }

describe('shape and permissions (API-11)', () => {
  it('five routes: read/define the alert rules, observe, raise from what was observed, record a backup', () => {
    const { routes } = stub();
    expect(routes.map((r) => [r.method, r.path, r.permission, r.idempotent === true])).toEqual([
      ['GET', RULES_PATH, 'platform.health.read', false],
      ['PUT', RULES_PATH, 'platform.alert.manage', true],
      ['GET', OBSERVED, 'platform.health.read', false],
      ['POST', RAISE, 'platform.alert.manage', true],
      ['POST', BACKUP, 'platform.backup.record', true],
    ]);
  });
});

describe('observeSignals — the cloud reads its own ledgers', () => {
  it('composes the signal shape from real sources and says where each came from; a lane-side signal is named, not guessed', async () => {
    const { deps } = stub({
      lastSale: minutesAgo(3), catalogue: minutesAgo(90),
      queues: [{ connectorId: 'tally', queued: 4, deadLettered: 1 }, { connectorId: 'gst', queued: 1, deadLettered: 0 }],
      integrations: { payments: true, sms: false },
      backups: [
        { backupId: 'b1', at: minutesAgo(600), ok: true, encrypted: true, offsite: true, recordedBy: 'u', recordedAt: NOW },
        { backupId: 'b2', at: minutesAgo(60), ok: false, encrypted: true, offsite: true, recordedBy: 'u', recordedAt: NOW },
        { backupId: 'b3', at: minutesAgo(30), ok: true, encrypted: false, offsite: true, recordedBy: 'u', recordedAt: NOW },
      ],
    });
    const o = await observeSignals(deps, T, NOW, DEFAULT_BACKUP_MAX_AGE_SECONDS);
    expect(o.signals).toEqual({
      lastSyncAt: minutesAgo(3), queueDepth: 5, deadLetterCount: 1, catalogueBuiltAt: minutesAgo(90),
      databaseReachable: true, integrations: { payments: true, sms: false },
      lastBackupAt: minutesAgo(600), // b2 failed, b3 unencrypted — neither moves the clock
      backupMaxAgeSeconds: DEFAULT_BACKUP_MAX_AGE_SECONDS,
    });
    expect(o.signals).not.toHaveProperty('localStoreWritable');
    expect(o.freshness).toEqual({ lastSaleAt: minutesAgo(3), ageSeconds: 180 });
    expect(o.lastBackup?.backupId).toBe('b3'); // the newest record is shown even though it does not count
    expect(o.notObserved[0]).toMatch(/localStoreWritable/);
    expect(Object.keys(o.provenance)).toEqual(expect.arrayContaining(['lastSyncAt', 'deadLetterCount', 'lastBackupAt', 'integrations']));
    expect(goodBackup(o.lastBackup!)).toBe(false);
  });

  it('with nothing yet recorded the signals say so — no sale, no catalogue, no backup, empty queues', async () => {
    const { deps } = stub();
    const o = await observeSignals(deps, T, NOW, DEFAULT_BACKUP_MAX_AGE_SECONDS);
    expect(o.signals).toEqual({ queueDepth: 0, deadLetterCount: 0, databaseReachable: true, integrations: {}, backupMaxAgeSeconds: DEFAULT_BACKUP_MAX_AGE_SECONDS });
    expect(o.freshness).toEqual({ lastSaleAt: null, ageSeconds: null });
    expect(o.lastBackup).toBeNull();
  });
});

describe('GET observed — judged by the same engine, previewing what the rules would raise', () => {
  it('a two-hour sync gap is DOWN, the shop still trades (the lane disk is unknown, never assumed broken), and without rules nothing would be raised', async () => {
    const s = stub({ lastSale: minutesAgo(120), catalogue: minutesAgo(10), backups: [{ backupId: 'b1', at: minutesAgo(60), ok: true, encrypted: true, offsite: true, recordedBy: 'u', recordedAt: NOW }] });
    const body = (await routeFor(s.routes, 'GET', OBSERVED).handler(ctx())).body as ObservedBody;
    expect(body.health.components.find((c) => c.name === 'sync')).toMatchObject({ status: 'down' });
    expect(body.health.components.find((c) => c.name === 'backup')).toMatchObject({ status: 'ok' });
    expect(body.health.components.find((c) => c.name === 'dead_letter')).toMatchObject({ status: 'ok' });
    expect(body.health.components.some((c) => c.name === 'local_store')).toBe(false);
    expect(body.health.canTrade).toBe(true);
    expect(body.wouldRaise).toEqual([]);
    expect(body.rulesVersion).toBeNull();
    expect(body.observed.freshness.ageSeconds).toBe(7_200);
  });

  it('with rules in force the preview names the alerts that would fire — under the stored thresholds', async () => {
    const s = stub({ lastSale: minutesAgo(20) });
    await putRules(s.routes, { rules: [RULE], thresholds: { syncLagWarnSeconds: 600 } });
    const body = (await routeFor(s.routes, 'GET', OBSERVED).handler(ctx())).body as ObservedBody;
    expect(body.health.components.find((c) => c.name === 'sync')).toMatchObject({ status: 'degraded' });
    expect(body.wouldRaise.map((a) => a.alertId)).toEqual(['sync-lag']);
    expect(body.rulesVersion).toBe(1);
    expect(s.w.alertEvents).toEqual([]); // a preview writes nothing
  });
});

describe('alert rules — every alert needs a named owner (§32)', () => {
  it('refuses an empty or malformed set and leaves the rules in force; accepts a good set as the next version by a named person', async () => {
    const s = stub();
    expect((await thrown(() => putRules(s.routes, { rules: [] }))).body.code).toBe('alert_rules_not_readable');
    expect((await thrown(() => putRules(s.routes, { rules: [{ ...RULE, ackWithinMinutes: 0 }] }))).body.code).toBe('alert_rules_not_readable');
    expect((await thrown(() => putRules(s.routes, { rules: [RULE], thresholds: { syncLagWarnSeconds: -1 } }))).body.code).toBe('alert_rules_not_readable');
    expect((await thrown(() => putRules(s.routes, { rules: [RULE], backupMaxAgeSeconds: 0 }))).body.code).toBe('alert_rules_not_readable');
    expect(s.w.rules).toEqual([]);
    const ok = await putRules(s.routes, { rules: [RULE, DEAD], backupMaxAgeSeconds: 100_000 }, 'u-owner');
    expect(ok.body).toEqual({ version: 1, rules: 2, components: ['sync', 'dead_letter'] });
    expect(s.w.rules[0]).toMatchObject({ version: 1, definedBy: 'u-owner', definedAt: NOW, thresholds: DEFAULT_THRESHOLDS, backupMaxAgeSeconds: 100_000 });
    await putRules(s.routes, { rules: [RULE] });
    const read = (await routeFor(s.routes, 'GET', RULES_PATH).handler(ctx())).body as { rules: StoredAlertRules; defaults: { backupMaxAgeSeconds: number } };
    expect(read.rules.version).toBe(2);
    expect(read.defaults.backupMaxAgeSeconds).toBe(DEFAULT_BACKUP_MAX_AGE_SECONDS);
  });
});

describe('POST raise — observed signals become owned alerts in the durable lifecycle store', () => {
  it('with no rules nothing is raised and the refusal says who to define them', async () => {
    const s = stub({ lastSale: minutesAgo(600), queues: [{ connectorId: 'tally', queued: 0, deadLettered: 3 }] });
    const refused = await thrown(() => routeFor(s.routes, 'POST', RAISE).handler(ctx()));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('alert_rules_not_defined');
    expect(s.w.alertEvents).toEqual([]);
  });

  it('a stale sync and a stalled dead-letter queue raise their owners\' alerts, once; a re-run re-raises but opens nothing new', async () => {
    const s = stub({ lastSale: minutesAgo(600), queues: [{ connectorId: 'tally', queued: 0, deadLettered: 3 }] });
    await putRules(s.routes, { rules: [RULE, DEAD] });
    const first = (await routeFor(s.routes, 'POST', RAISE).handler(ctx({ userId: 'u-sweep' }))).body as RaiseBody;
    expect(first.raised).toBe(2);
    expect(first.newlyOpened).toBe(2);
    expect(first.alerts.map((a) => [a.alertId, a.component, a.status, a.ownerUserId])).toEqual([
      ['sync-lag', 'sync', 'down', 'u-owner'], ['dead-letters', 'dead_letter', 'down', 'u-ops'],
    ]);
    expect(s.w.alertEvents.map((e) => [e.alertId, e.change, e.by, e.escalatesToUserId])).toEqual([
      ['sync-lag', 'raised', 'u-sweep', 'u-mgr'], ['dead-letters', 'raised', 'u-sweep', undefined],
    ]);
    expect(s.w.keys).toEqual(['raise-sync-lag', 'raise-dead-letters']);
    const live = projectAlerts(s.w.alertEvents);
    expect(live.map((a) => [a.alert.alertId, a.state])).toEqual([['sync-lag', 'open'], ['dead-letters', 'open']]);
    const again = (await routeFor(s.routes, 'POST', RAISE).handler(ctx())).body as RaiseBody;
    expect(again.raised).toBe(2);
    expect(again.newlyOpened).toBe(0);
  });

  it('when the lanes are fresh and the queues clean, the same rules raise nothing', async () => {
    const s = stub({ lastSale: minutesAgo(2), queues: [{ connectorId: 'tally', queued: 2, deadLettered: 0 }] });
    await putRules(s.routes, { rules: [RULE, DEAD] });
    const body = (await routeFor(s.routes, 'POST', RAISE).handler(ctx())).body as RaiseBody;
    expect(body.raised).toBe(0);
    expect(body.health.components.find((c) => c.name === 'sync')).toMatchObject({ status: 'ok' });
  });
});

describe('backups — recorded facts, counted only when protected (FR-01)', () => {
  const taken = (routes: readonly Route[], id: string, body: unknown) =>
    routeFor(routes, 'POST', BACKUP).handler(ctx({ params: { backupId: id }, body }));

  it('a completed, encrypted, off-site backup counts and moves the backup clock; a failed one is kept but does not', async () => {
    const s = stub({ lastSale: minutesAgo(1) });
    const good = await taken(s.routes, 'b-1', { at: minutesAgo(120), ok: true, encrypted: true, offsite: true, sizeBytes: 12_345 });
    expect(good.status).toBe(201);
    expect(good.body).toEqual({ backupId: 'b-1', counts: true });
    let body = (await routeFor(s.routes, 'GET', OBSERVED).handler(ctx())).body as ObservedBody;
    expect(body.health.components.find((c) => c.name === 'backup')).toMatchObject({ status: 'ok' });
    const bad = await taken(s.routes, 'b-2', { at: minutesAgo(5), ok: false, encrypted: true, offsite: false, detail: 'disk full' });
    expect(bad.body).toEqual({ backupId: 'b-2', counts: false, why: ['it did not complete', 'it has no off-site copy'] });
    body = (await routeFor(s.routes, 'GET', OBSERVED).handler(ctx())).body as ObservedBody;
    expect(body.observed.signals['lastBackupAt']).toBe(minutesAgo(120));
    expect(body.observed.lastBackup).toMatchObject({ backupId: 'b-2', ok: false, recordedBy: 'u-ops' });
  });

  it('an overdue backup is DOWN under the stored maximum age; nothing recorded ever is UNKNOWN, never ok', async () => {
    const s = stub({ lastSale: minutesAgo(1) });
    let body = (await routeFor(s.routes, 'GET', OBSERVED).handler(ctx())).body as ObservedBody;
    expect(body.health.components.find((c) => c.name === 'backup')).toMatchObject({ status: 'unknown' });
    await taken(s.routes, 'b-1', { at: minutesAgo(30 * 60), ok: true, encrypted: true, offsite: true });
    await putRules(s.routes, { rules: [RULE], backupMaxAgeSeconds: 24 * 3_600 });
    body = (await routeFor(s.routes, 'GET', OBSERVED).handler(ctx())).body as ObservedBody;
    expect(body.health.components.find((c) => c.name === 'backup')).toMatchObject({ status: 'down' });
  });

  it('PA-12 r7: only the backup job records a backup — any other caller, and a deployment that cannot tell, is refused and nothing is kept', async () => {
    const s = stub();
    const asPerson = await thrown(() => routeFor(s.routes, 'POST', BACKUP).handler(ctx({ userId: 'u-owner', params: { backupId: 'b-9' }, body: { at: minutesAgo(1), ok: true, encrypted: true, offsite: true } })));
    expect(asPerson.status).toBe(403);
    expect(asPerson.body.code).toBe('not_the_backup_job');
    const withoutCheck: ObservedHealthDeps = { ...s.deps, isBackupJob: undefined };
    const blind = await thrown(() => routeFor(observedHealthRoutes(withoutCheck), 'POST', BACKUP).handler(ctx({ params: { backupId: 'b-9' }, body: { at: minutesAgo(1), ok: true, encrypted: true, offsite: true } })));
    expect(blind.body.code).toBe('not_the_backup_job');
    expect(s.w.backups).toEqual([]);
  });

  it('refuses an unreadable record and a reused backup id, recording nothing', async () => {
    const s = stub();
    expect((await thrown(() => taken(s.routes, 'b-1', { at: 'yesterday', ok: true, encrypted: true, offsite: true }))).body.code).toBe('not_readable_as_a_backup_record');
    expect((await thrown(() => taken(s.routes, 'b-1', { at: minutesAgo(1), ok: 'yes', encrypted: true, offsite: true }))).body.code).toBe('not_readable_as_a_backup_record');
    await taken(s.routes, 'b-1', { at: minutesAgo(1), ok: true, encrypted: true, offsite: true });
    const dup = await thrown(() => taken(s.routes, 'b-1', { at: minutesAgo(1), ok: true, encrypted: true, offsite: true }));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('backup_already_recorded');
    expect(s.w.backups).toHaveLength(1);
  });
});
