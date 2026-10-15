import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { SqlSnapshotStore, InMemorySnapshotStore, type SnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { recordingTransport } from '../../packages/notifications/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import { STREAM, streamName, storeComputerHistory, observedHealthAdapter, boxHistoryBuilding, BOX_HISTORY_INLINE_MAX } from '../../services/api/src/adapters';
import { seedGenesisOwner } from '../../services/api/src/access';
import { OWNER_ROLE_ID } from '../../services/api/src/roles';
import {
  observedHealthRoutes, judgeObserved, BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID, BUILT_IN_STORE_COMPUTER_CHECKS_ACK_MINUTES,
  type ObservedHealthDeps, type StoredAlertRules, type BuiltInRuleState,
} from '../../services/platform/src/observed-health';
import { startOpsAlertWorker, type OpsAlertWorker, type OpsAlertPass } from '../../services/platform/src/ops-alert-worker';
import { STORE_COMPUTER_CHECKS_STUCK_COMPONENT, STORE_COMPUTER_CHECKS_STUCK_MINUTES, type BoxHealthRecord } from '../../services/platform/src/box-health';
import type { AlertLifecycleDeps, LiveAlert } from '../../services/platform/src/alert-lifecycle';
import { honestStore, iso, TEST_BOX_HISTORY_KEY } from '../support/box-history';

/**
 * **Round 31 · owner decision OB-114 "A" (14 Oct 2026, in writing, "Built-in alert to you") — the owner is told when the
 * store computer checks stay "being prepared" (or the saved history cannot be sealed) for more than an hour; on memory and
 * on PostgreSQL, with the ops-alert worker running on a short timer.**
 *
 *   • BEING PREPARED (a big store's history held in its background build): the worker's passes at 0 and 59 minutes raise
 *     nothing (the component is `ok`, saying how long so far); at 61 minutes the built-in alert is raised to the person who
 *     holds the owner role — in his inbox and as a message to his phone — even though that same pass skips the store
 *     computers' other checks ("being prepared" never suppresses THIS alert); once the history is ready it is CLEARED (kept);
 *   • CANNOT BE SEALED (head office started without the seal key): the same — raised after the hour, cleared when the key is there;
 *   • the owner TURNS IT OFF (PUT alert-rules `builtInOff`, a new rules version naming who and when): nothing is raised; he
 *     EDITS it (a rule with the same alertId): his version is the one raised, to the person he named; he turns it back on;
 *   • with nobody holding the owner role the rule is not in force and GET alert-rules says so — nothing is raised.
 */

const BOX = streamName(STREAM.org, 'store-computer-health');
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner-r31';
const MANAGER = 'u-manager-r31';

interface Ctx { readonly store: EventStore; readonly snapshots: SnapshotStore; readonly T: string }
async function onMemory(run: (c: Ctx) => Promise<void>): Promise<void> {
  await run({ store: new InMemoryEventStore(), snapshots: new InMemorySnapshotStore(), T: randomUUID() });
}
async function onPg(run: (c: Ctx) => Promise<void>): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
  const sql = pgPoolClient(pool);
  const store = new SqlEventStore(sql);
  const T = randomUUID();
  await store.registerTenant(T, 'r31');
  try { await run({ store, snapshots: new SqlSnapshotStore(sql), T }); } finally { await pool.end(); }
}

async function put(store: EventStore, T: string, records: readonly BoxHealthRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += 500) {
    await store.appendBatch(T, records.slice(i, i + 500).map((r, j) => ({
      stream: BOX,
      event: makeEvent({ id: `bh-${i + j}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${i + j}`, source: 'test/r31', payload: r }),
    })));
  }
}
const plain = (r: BoxHealthRecord & { seq?: number }): BoxHealthRecord => { const { seq: _s, ...rest } = r; void _s; return rest as BoxHealthRecord; };

/** A clock the test moves (the worker's `now`). */
function clock(startMs: number) {
  let ms = startMs;
  return { now: (): string => iso(ms), to: (minutes: number): void => { ms = startMs + minutes * 60_000; }, at: (minutes: number): string => iso(startMs + minutes * 60_000) };
}

/** Wait (bounded) for the worker's first pass that ran at exactly `at` — the worker runs on its own short timer. */
async function passAt(worker: OpsAlertWorker, at: string): Promise<OpsAlertPass> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const p = worker.passes.find((x) => x.at === at);
    if (p !== undefined) return p;
    if (Date.now() > deadline) throw new Error(`no alert pass ran at ${at} within 60 s`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}
const builtIn = (alerts: readonly LiveAlert[]): LiveAlert | undefined => alerts.find((a) => a.alert.alertId === BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID);

const ctx = (T: string, userId: string, body?: unknown): RequestContext =>
  ({ tenantId: T, userId, branchId: null, params: {}, query: {}, body, traceId: 't' }) as unknown as RequestContext;
const route = (routes: readonly Route[], method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;

async function beingPreparedForMoreThanAnHour(c: Ctx): Promise<void> {
  const records = honestStore((BOX_HISTORY_INLINE_MAX + 760) / 5_760).map(plain);
  await put(c.store, c.T, records);
  await seedGenesisOwner(c.store, OWNER_ROLE_ID, c.T, OWNER, records[0]!.receivedAt);
  const t = clock(Date.parse(records[records.length - 1]!.receivedAt) + 60_000);
  // The history's background build is started and HELD between its steps until the test lets it go (never a race).
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = await storeComputerHistory(c.store, c.T, t.now(), { sealKey: TEST_BOX_HISTORY_KEY, snapshots: c.snapshots, timeZone: 'UTC', waitMs: 0, buildPause: () => gate });
  expect(first.preparing).toBeDefined();
  const deps = observedHealthAdapter({ store: c.store, now: t.now, snapshots: c.snapshots, boxHistorySealKey: TEST_BOX_HISTORY_KEY, storeTimeZone: async () => 'UTC', boxHistoryWaitMs: 0 });
  const transport = recordingTransport();
  const said: string[] = [];
  const worker = startOpsAlertWorker({ tenants: async () => [c.T], deps, transport, intervalMs: 20, now: t.now, say: (l) => said.push(l) });
  try {
    for (const minutes of [0, 59]) {
      t.to(minutes);
      const p = await passAt(worker, t.now());
      expect(p.failed).toEqual([]);
      expect(p.skipped.map((s) => s.tenantId)).toEqual([c.T]);
      expect(builtIn(await deps.alerts(c.T))).toBeUndefined();
    }
    const health = await judgeObserved(deps, c.T, t.now());
    expect(health.health.components.find((x) => x.name === STORE_COMPUTER_CHECKS_STUCK_COMPONENT)).toMatchObject({ status: 'ok' });
    expect(health.builtIn).toEqual([expect.objectContaining({ alertId: BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID, state: 'on', rule: expect.objectContaining({ ownerUserId: OWNER }) })]);

    // 61 minutes: still being prepared — the pass skips the store computers' other checks AND raises this alert to the owner.
    t.to(STORE_COMPUTER_CHECKS_STUCK_MINUTES + 1);
    const late = await passAt(worker, t.now());
    expect(late.failed).toEqual([]);
    expect(late.skipped.map((s) => s.tenantId)).toEqual([c.T]);
    expect(late.raised).toBe(1);
    const raised = builtIn(await deps.alerts(c.T))!;
    expect(raised).toMatchObject({ state: 'open', alert: { ownerUserId: OWNER, status: 'down', component: STORE_COMPUTER_CHECKS_STUCK_COMPONENT } });
    expect(raised.alert.detail).toMatch(/not been ready for 61 minutes .*being prepared/);
    expect(raised.alert.ackDueBy).toBe(new Date(Date.parse(t.now()) + BUILT_IN_STORE_COMPUTER_CHECKS_ACK_MINUTES * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    expect(raised.deliveries.map((d) => `${d.to}/${d.via}`).sort()).toEqual([`${OWNER}/inbox`, `${OWNER}/${transport.name}`]);
    expect(transport.sent.map((m) => m.customerId)).toEqual([OWNER]);
    expect(transport.sent[0]!.text).toMatch(/store_computer_checks_stuck is down/);
    // Later passes while it stays: the same alert, never raised or delivered twice.
    t.to(STORE_COMPUTER_CHECKS_STUCK_MINUTES + 2);
    expect((await passAt(worker, t.now())).raised).toBe(0);
    expect(transport.sent).toHaveLength(1);

    // Ready: the history is built; the next pass clears the alert (kept, never deleted).
    release();
    await boxHistoryBuilding(c.snapshots, c.T);
    t.to(STORE_COMPUTER_CHECKS_STUCK_MINUTES + 3);
    // (A pass already running when the build finished may be the one that clears it — so the alert's state is what is checked.)
    const ready = await passAt(worker, t.now());
    expect(ready.skipped).toEqual([]);
    expect(builtIn(await deps.alerts(c.T))).toMatchObject({ state: 'cleared', occurrence: 1 });
    expect((await judgeObserved(deps, c.T, t.now())).health.components.some((x) => x.name === STORE_COMPUTER_CHECKS_STUCK_COMPONENT)).toBe(false);
  } finally { release(); await worker.stop(); }
}

/** A small store, its checks read by an adapter with or without the seal key (the same saved-history state). */
function smallStore(c: Ctx, t: ReturnType<typeof clock>, keyed: () => boolean): ObservedHealthDeps & AlertLifecycleDeps {
  const without = observedHealthAdapter({ store: c.store, now: t.now, snapshots: c.snapshots, storeTimeZone: async () => 'UTC', boxHistoryWaitMs: 0 });
  const withKey = observedHealthAdapter({ store: c.store, now: t.now, snapshots: c.snapshots, boxHistorySealKey: TEST_BOX_HISTORY_KEY, storeTimeZone: async () => 'UTC', boxHistoryWaitMs: 0 });
  return { ...without, storeComputers: (tenantId, at) => (keyed() ? withKey : without).storeComputers!(tenantId, at) };
}
async function seedSmall(c: Ctx, owner = true): Promise<ReturnType<typeof clock>> {
  const records = honestStore(50 / 5_760).map(plain);
  await put(c.store, c.T, records);
  if (owner) await seedGenesisOwner(c.store, OWNER_ROLE_ID, c.T, OWNER, records[0]!.receivedAt);
  return clock(Date.parse(records[records.length - 1]!.receivedAt) + 60_000);
}

async function cannotBeSealedForMoreThanAnHour(c: Ctx): Promise<void> {
  const t = await seedSmall(c);
  let keyed = false;
  const deps = smallStore(c, t, () => keyed);
  const transport = recordingTransport();
  const worker = startOpsAlertWorker({ tenants: async () => [c.T], deps, transport, intervalMs: 20, now: t.now, say: () => undefined });
  try {
    for (const minutes of [0, 60]) {
      t.to(minutes);
      const p = await passAt(worker, t.now());
      expect(p.failed).toEqual([]);
      expect(builtIn(await deps.alerts(c.T))).toBeUndefined();
    }
    expect((await judgeObserved(deps, c.T, t.now())).health.components.find((x) => x.name === 'box_history_seal')).toMatchObject({ status: 'degraded' });
    t.to(61);
    expect((await passAt(worker, t.now())).raised).toBe(1);
    const raised = builtIn(await deps.alerts(c.T))!;
    expect(raised).toMatchObject({ state: 'open', alert: { ownerUserId: OWNER } });
    expect(raised.alert.detail).toMatch(/cannot be sealed/);
    expect(transport.sent.map((m) => m.customerId)).toEqual([OWNER]);
    // Head office has its seal key again: the next pass clears it.
    keyed = true;
    t.to(62);
    await passAt(worker, t.now()); // (a pass already running when the key came back may be the one that clears it)
    expect(builtIn(await deps.alerts(c.T))?.state).toBe('cleared');
  } finally { await worker.stop(); }
}

async function theOwnerTurnsItOffAndEditsIt(c: Ctx): Promise<void> {
  const t = await seedSmall(c);
  const deps = smallStore(c, t, () => false);
  const routes = observedHealthRoutes(deps);
  const rulesNow = async (): Promise<{ rules: StoredAlertRules | null; builtIn: BuiltInRuleState[] }> =>
    (await route(routes, 'GET', '/v1/platform/alert-rules').handler(ctx(c.T, OWNER))).body as never;
  expect((await rulesNow()).builtIn).toEqual([expect.objectContaining({ alertId: BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID, state: 'on' })]);
  // Not a built-in rule: refused, nothing changed.
  await expect(route(routes, 'PUT', '/v1/platform/alert-rules').handler(ctx(c.T, OWNER, { rules: [], builtInOff: ['built-in:nothing'] }))).rejects.toMatchObject({ status: 400 });
  // An empty set that turns nothing off is refused as before (every rule set needs an owner's rule or a built-in turned off).
  await expect(route(routes, 'PUT', '/v1/platform/alert-rules').handler(ctx(c.T, OWNER, { rules: [] }))).rejects.toMatchObject({ status: 400 });
  // The owner turns it off: a new rules version, saying who and when.
  const off = await route(routes, 'PUT', '/v1/platform/alert-rules').handler(ctx(c.T, OWNER, { basedOnVersion: 0, rules: [], builtInOff: [BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID] }));
  expect(off.body).toMatchObject({ version: 1, builtInOff: [BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID] });
  const v1 = await rulesNow();
  expect(v1.rules).toMatchObject({ version: 1, definedBy: OWNER, builtInOff: [BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID] });
  expect(v1.builtIn).toEqual([expect.objectContaining({ state: 'off' })]);
  const worker = startOpsAlertWorker({ tenants: async () => [c.T], deps, intervalMs: 20, now: t.now, say: () => undefined });
  try {
    t.to(0);
    await passAt(worker, t.now());
    t.to(90);
    const p = await passAt(worker, t.now());
    expect(p.raised).toBe(0);
    expect(builtIn(await deps.alerts(c.T))).toBeUndefined();
    // He edits it instead — his manager to answer it within 15 minutes; a later version that does not name builtInOff keeps
    // it off, so he names the list (empty) to turn it back on, with his own version of the rule.
    const edited = { alertId: BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID, component: STORE_COMPUTER_CHECKS_STUCK_COMPONENT, firesAt: 'down', ownerUserId: MANAGER, ownerName: 'Store manager', ackWithinMinutes: 15 };
    await route(routes, 'PUT', '/v1/platform/alert-rules').handler(ctx(c.T, OWNER, { basedOnVersion: 1, rules: [edited] }));
    expect((await rulesNow()).builtIn).toEqual([expect.objectContaining({ state: 'off' })]);
    await route(routes, 'PUT', '/v1/platform/alert-rules').handler(ctx(c.T, OWNER, { basedOnVersion: 2, rules: [edited], builtInOff: [] }));
    const v3 = await rulesNow();
    expect(v3.rules).toMatchObject({ version: 3, definedBy: OWNER, builtInOff: [] });
    expect(v3.builtIn).toEqual([expect.objectContaining({ state: 'edited', rule: expect.objectContaining({ ownerUserId: MANAGER }) })]);
    // (A pass still at 90 minutes after the change may be the one that raises it — so the alert itself is what is checked.)
    t.to(91);
    await passAt(worker, t.now());
    expect(builtIn(await deps.alerts(c.T))).toMatchObject({ state: 'open', alert: { ownerUserId: MANAGER, ownerName: 'Store manager' } });
  } finally { await worker.stop(); }
}

async function noOwnerNoRule(c: Ctx): Promise<void> {
  const t = await seedSmall(c, false);
  const deps = smallStore(c, t, () => false);
  const routes = observedHealthRoutes(deps);
  const read = (await route(routes, 'GET', '/v1/platform/alert-rules').handler(ctx(c.T, 'u-it'))).body as { builtIn: BuiltInRuleState[] };
  expect(read.builtIn).toEqual([expect.objectContaining({ state: 'no_owner', description: expect.stringMatching(/NOT in force: nobody holds the owner role/) })]);
  const worker = startOpsAlertWorker({ tenants: async () => [c.T], deps, intervalMs: 20, now: t.now, say: () => undefined });
  try {
    t.to(0); await passAt(worker, t.now());
    t.to(90);
    expect((await passAt(worker, t.now())).raised).toBe(0);
    expect(await deps.alerts(c.T)).toEqual([]);
  } finally { await worker.stop(); }
}

describe('round 31 · OB-114 (memory)', () => {
  it('"being prepared" for more than an hour: raised to the owner (inbox and phone) at 61 minutes, not before; cleared when ready', async () => { await onMemory(beingPreparedForMoreThanAnHour); }, 300_000);
  it('the saved history cannot be sealed for more than an hour: raised to the owner; cleared when the key is there', async () => { await onMemory(cannotBeSealedForMoreThanAnHour); }, 120_000);
  it('the owner turns the built-in rule off (nothing raised), edits it (his version raised to the person he named), recorded as rule versions', async () => { await onMemory(theOwnerTurnsItOffAndEditsIt); }, 120_000);
  it('with nobody holding the owner role the built-in rule is not in force, and GET alert-rules says so', async () => { await onMemory(noOwnerNoRule); }, 120_000);
});

describe.skipIf(DATABASE_URL === undefined)('round 31 · OB-114 (PostgreSQL)', () => {
  it('"being prepared" for more than an hour: raised to the owner (inbox and phone) at 61 minutes, not before; cleared when ready', async () => { await onPg(beingPreparedForMoreThanAnHour); }, 600_000);
  it('the saved history cannot be sealed for more than an hour: raised to the owner; cleared when the key is there', async () => { await onPg(cannotBeSealedForMoreThanAnHour); }, 300_000);
  it('the owner turns the built-in rule off (nothing raised), edits it (his version raised to the person he named), recorded as rule versions', async () => { await onPg(theOwnerTurnsItOffAndEditsIt); }, 300_000);
  it('with nobody holding the owner role the built-in rule is not in force, and GET alert-rules says so', async () => { await onPg(noOwnerNoRule); }, 300_000);
});
