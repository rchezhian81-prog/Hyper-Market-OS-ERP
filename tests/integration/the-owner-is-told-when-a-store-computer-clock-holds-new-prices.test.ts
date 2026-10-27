import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { MemoryIdempotencyStore, SqlIdempotencyStore, type IdempotencyStore } from '../../services/kernel/src/index';
import { recordingTransport } from '../../packages/notifications/src/index';
import { apiHarness, TEST_BOX_HISTORY_SEAL_SECRET, type ApiHarness } from '../support/api-harness';
import { observedHealthAdapter, alertLifecycleAdapter } from '../../services/api/src/adapters';
import { startOpsAlertWorker, type OpsAlertWorker } from '../../services/platform/src/ops-alert-worker';
import { boxHistorySealKey, STORE_COMPUTER_CLOCK_HELD_COMPONENT } from '../../services/platform/src/box-health';
import { BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID as CLOCK_ID } from '../../services/platform/src/observed-health';

/**
 * **§31.1 · owner decision OB-409 "C" (27 Oct 2026, in writing; extends OB-403) — the owner hears that a store computer's clock
 * is out, with no alert rule of his own, only at the 5-minute flag (when new prices and offers are held), through the real
 * API pipeline and the ops-alert worker as head office runs it.**
 *
 *   • no rule configured: GET alert-rules shows the built-in clock rule ON, to the owner;
 *   • store S1's computer at the 2-MINUTE WARNING: `box_clock:S1` is degraded on the health page, but nothing reaches the
 *     owner's inbox or phone;
 *   • at the 5-MINUTE FLAG (prices and offers held): the alert is in the owner's inbox and sent to his phone — which store,
 *     how many minutes out, what is held — and to nobody else;
 *   • later reports and passes, a SECOND head-office instance and a head-office RESTART (a fresh worker over the same kept
 *     records): still one alert, delivered once;
 *   • a store manager and the IT administrator may neither turn it off nor tick it (refused by name); the owner may tick it;
 *   • back in step: the alert is CLEARED (kept, never deleted); the owner turns it off and a later flag reaches nobody.
 * On memory, and on PostgreSQL when DATABASE_URL is set (the same story; a second instance and a restart over the same
 * database). Synthetic data only (hard rule #7).
 */

const DATABASE_URL = process.env['DATABASE_URL'];

const OWNER = 'u-owner-ob409';
const MANAGER = 'u-mgr-ob409';
const IT = 'u-it-ob409';
const BOX1 = 'u-box-ob409-s1';
const BOX2 = 'u-box-ob409-s2';
const RULES = '/v1/platform/alert-rules';
const INBOX = '/v1/platform/alerts/inbox';

interface Live { alertId: string; component: string; status: string; detail: string; ownerUserId: string }
interface Rules { rules: { version: number } | null; builtIn: { alertId: string; state: string; rule?: { ownerUserId: string; component: string; firesAt: string } }[] }
const err = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;

const clockCheck = (verdict: 'in_step' | 'warning' | 'flag_bills', offsetSeconds: number, held: { promotions: string[]; prices: string[] } | null) => ({
  verdict, offsetSeconds, lastCheckedAt: new Date().toISOString(), warnSeconds: 120, flagSeconds: 300,
  hold: held === null ? { held: false, heldPromotions: [], heldPrices: [] } : { held: true, since: new Date(Date.now() - 60_000).toISOString(), heldPromotions: held.promotions, heldPrices: held.prices },
});

interface Ctx { readonly store: EventStore; readonly idempotency: IdempotencyStore; readonly T: string }
async function onMemory(run: (c: Ctx) => Promise<void>): Promise<void> {
  await run({ store: new InMemoryEventStore(), idempotency: new MemoryIdempotencyStore(), T: randomUUID() });
}
async function onPg(run: (c: Ctx) => Promise<void>): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
  const sql = pgPoolClient(pool);
  const store = new SqlEventStore(sql);
  const T = randomUUID();
  await store.registerTenant(T, 'ob409');
  try { await run({ store, idempotency: new SqlIdempotencyStore(sql), T }); } finally { await pool.end(); }
}

async function theOwnerIsToldAtTheFlagOnly(c: Ctx): Promise<void> {
  const T = c.T;
  let h: ApiHarness = apiHarness({ store: c.store, idempotency: c.idempotency });
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MANAGER, 'store_manager', 'all');
  await h.provisionRole(T, IT, 'platform_admin', 'all');
  await h.provisionRole(T, BOX1, 'store_computer', ['S1']);
  await h.provisionRole(T, BOX2, 'store_computer', ['S2']);
  const as = (hh: ApiHarness, userId: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
    hh.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const report = async (box: string, store: string, check: ReturnType<typeof clockCheck>): Promise<void> => {
    const r = await h.request({ method: 'POST', path: '/v1/store-computers/health-reports', userId: box, tenantId: T, branchId: store, idempotencyKey: `rep-${randomUUID()}`, body: {
      observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
      queue: { unsent: 0, deadLettered: 0 }, tills: [], clockCheck: check,
    } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const inbox = async (userId: string): Promise<Live[]> => ((await as(h, userId, 'GET', INBOX)).body as { alerts: { alert: Live }[] }).alerts.map((a) => a.alert);
  const clockAlerts = async (userId = OWNER): Promise<Live[]> => (await inbox(userId)).filter((a) => a.alertId === CLOCK_ID);
  // Head office's ops-alert worker, composed as main.ts composes it (the same keyed seal the reads use).
  const now = (): string => new Date().toISOString();
  const workerOf = (transport: ReturnType<typeof recordingTransport>): OpsAlertWorker => startOpsAlertWorker({
    tenants: async () => [T], intervalMs: 3_600_000, now, say: () => undefined, transport,
    deps: { ...alertLifecycleAdapter({ store: h.store, now }), ...observedHealthAdapter({ store: h.store, now, boxHistorySealKey: boxHistorySealKey(TEST_BOX_HISTORY_SEAL_SECRET), boxHistoryWaitMs: 5_000 }) },
  });
  const phone = recordingTransport();
  let worker = workerOf(phone);
  const workers: OpsAlertWorker[] = [worker];
  try {
    // No rule of his own: the built-in clock rule is on, to the owner, on the shop-wide clock-hold line at degraded.
    const rules = (await as(h, OWNER, 'GET', RULES)).body as Rules;
    expect(rules.rules).toBeNull();
    expect(rules.builtIn.find((b) => b.alertId === CLOCK_ID)).toMatchObject({ state: 'on', rule: { ownerUserId: OWNER, component: STORE_COMPUTER_CLOCK_HELD_COMPONENT, firesAt: 'degraded' } });

    // ── The 2-minute WARNING on S1 (and S2 in step): shown on the health page, but the owner is not told.
    await report(BOX1, 'S1', clockCheck('warning', -200, null));
    await report(BOX2, 'S2', clockCheck('in_step', 1, null));
    expect((await worker.runOnce()).failed).toEqual([]);
    const health = ((await as(h, OWNER, 'GET', '/v1/platform/operational-health/observed')).body as { health: { components: { name: string; status: string }[] } }).health.components;
    expect(health.find((c) => c.name === 'box_clock:S1')).toMatchObject({ status: 'degraded' });
    expect(health.some((c) => c.name === STORE_COMPUTER_CLOCK_HELD_COMPONENT)).toBe(false);
    expect(await clockAlerts()).toEqual([]);
    expect(phone.sent).toEqual([]);

    // ── The 5-minute FLAG on S1: new prices and offers held. The owner is told — inbox and phone — and nobody else.
    await report(BOX1, 'S1', clockCheck('flag_bills', -26 * 3_600, { promotions: ['oil-10-new'], prices: ['pe-today'] }));
    const flagged = await worker.runOnce();
    expect(flagged.failed).toEqual([]);
    expect(flagged.raised).toBe(1);
    const [alert, ...more] = await clockAlerts();
    expect(more).toEqual([]);
    expect(alert).toMatchObject({ ownerUserId: OWNER, status: 'degraded', component: STORE_COMPUTER_CLOCK_HELD_COMPONENT });
    expect(alert!.detail).toMatch(/^price change held — a store computer's clock is 5 minutes or more out: store S1 \(computer u-box-ob409-s1\): its clock is 1560 minutes \(26 hours\) AHEAD of head office/);
    expect(alert!.detail).toContain('held now: offer oil-10-new, price pe-today');
    expect(alert!.detail).not.toContain('store S2');
    expect(phone.sent.map((m) => m.customerId)).toEqual([OWNER]);
    expect(await clockAlerts(MANAGER)).toEqual([]);
    expect(await clockAlerts(IT)).toEqual([]);

    // ── Later reports and passes; a SECOND head-office instance; a RESTART (a fresh worker): one alert, delivered once.
    await report(BOX1, 'S1', clockCheck('flag_bills', -26 * 3_600 - 60, { promotions: ['oil-10-new'], prices: ['pe-today'] }));
    expect((await worker.runOnce()).raised).toBe(0);
    h = apiHarness({ store: c.store, idempotency: c.idempotency });
    const phone2 = recordingTransport();
    const second = workerOf(phone2);
    workers.push(second);
    expect((await second.runOnce()).raised).toBe(0);
    await worker.stop();
    worker = workerOf(phone);
    workers.push(worker);
    expect((await worker.runOnce()).raised).toBe(0);
    expect(await clockAlerts()).toHaveLength(1);
    expect(phone.sent).toHaveLength(1);
    expect(phone2.sent).toEqual([]);

    // ── Only the owner may turn it off or tick it.
    const version = ((await as(h, OWNER, 'GET', RULES)).body as Rules).rules?.version ?? 0;
    const mgrOff = await as(h, MANAGER, 'PUT', RULES, { basedOnVersion: version, rules: [], builtInOff: [CLOCK_ID] });
    expect([mgrOff.status, err(mgrOff)]).toEqual([403, 'built_in_alert_rule_owner_only']);
    const itOff = await as(h, IT, 'PUT', RULES, { basedOnVersion: version, rules: [], builtInOff: [CLOCK_ID] });
    expect([itOff.status, err(itOff)]).toEqual([403, 'built_in_alert_rule_refused_to_platform_administrator']);
    expect(((await as(h, OWNER, 'GET', RULES)).body as Rules).builtIn.find((b) => b.alertId === CLOCK_ID)?.state).toBe('on');
    const ack = `/v1/platform/alerts/${encodeURIComponent(CLOCK_ID)}/acknowledge`;
    const mgrAck = await as(h, MANAGER, 'POST', ack, {});
    expect([mgrAck.status, err(mgrAck)]).toEqual([403, 'built_in_alert_acknowledge_owner_only']);
    const itAck = await as(h, IT, 'POST', ack, {});
    expect([itAck.status, err(itAck)]).toEqual([403, 'built_in_alert_acknowledge_refused_to_platform_administrator']);
    const ownerAck = await as(h, OWNER, 'POST', ack, {});
    expect(ownerAck.status, JSON.stringify(ownerAck.body)).toBe(200);
    expect(ownerAck.body).toMatchObject({ alertId: CLOCK_ID, acknowledgedBy: OWNER });

    // ── Back in step: cleared by the worker (kept, never deleted).
    await report(BOX1, 'S1', clockCheck('in_step', 2, null));
    expect((await worker.runOnce()).cleared).toBe(1);
    const life = alertLifecycleAdapter({ store: h.store, now });
    expect((await life.alerts(T)).filter((a) => a.alert.alertId === CLOCK_ID).map((a) => [a.state, a.occurrence])).toEqual([['cleared', 1]]);

    // ── The owner turns it off: a later flag (on S2 now) reaches nobody.
    const v = ((await as(h, OWNER, 'GET', RULES)).body as Rules).rules?.version ?? 0;
    const off = await as(h, OWNER, 'PUT', RULES, { basedOnVersion: v, rules: [], builtInOff: [CLOCK_ID] });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    await report(BOX2, 'S2', clockCheck('flag_bills', 400, { promotions: [], prices: ['pe-s2'] }));
    expect((await worker.runOnce()).raised).toBe(0);
    expect((await life.alerts(T)).filter((a) => a.alert.alertId === CLOCK_ID).map((a) => a.state)).toEqual(['cleared']);
  } finally {
    for (const w of workers) await w.stop();
  }
}

/**
 * §31.1 · OB-414 "C" (owner, in writing): while the clock alert is open, a store joining or leaving UPDATES the same alert —
 * its words name the stores out now, it is sent again once and asks to be ticked again — and a report with the same stores
 * changes nothing (nor does a second head-office instance or a restart). It clears only when every store is back in step.
 */
async function theOpenAlertFollowsTheStores(c: Ctx): Promise<void> {
  const T = c.T;
  let h: ApiHarness = apiHarness({ store: c.store, idempotency: c.idempotency });
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, BOX1, 'store_computer', ['S1']);
  await h.provisionRole(T, BOX2, 'store_computer', ['S2']);
  const report = async (box: string, store: string, check: ReturnType<typeof clockCheck>): Promise<void> => {
    const r = await h.request({ method: 'POST', path: '/v1/store-computers/health-reports', userId: box, tenantId: T, branchId: store, idempotencyKey: `rep-${randomUUID()}`, body: {
      observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
      queue: { unsent: 0, deadLettered: 0 }, tills: [], clockCheck: check,
    } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const inboxClock = async (): Promise<Live[]> =>
    ((await h.request({ method: 'GET', path: INBOX, userId: OWNER, tenantId: T })).body as { alerts: { alert: Live }[] }).alerts.map((a) => a.alert).filter((a) => a.alertId === CLOCK_ID);
  const now = (): string => new Date().toISOString();
  const workerOf = (transport: ReturnType<typeof recordingTransport>): OpsAlertWorker => startOpsAlertWorker({
    tenants: async () => [T], intervalMs: 3_600_000, now, say: () => undefined, transport,
    deps: { ...alertLifecycleAdapter({ store: c.store, now }), ...observedHealthAdapter({ store: c.store, now, boxHistorySealKey: boxHistorySealKey(TEST_BOX_HISTORY_SEAL_SECRET), boxHistoryWaitMs: 5_000 }) },
  });
  const life = alertLifecycleAdapter({ store: c.store, now });
  const clockLive = async () => (await life.alerts(T)).filter((a) => a.alert.alertId === CLOCK_ID);
  const phone = recordingTransport();
  const phone2 = recordingTransport();
  const workers: OpsAlertWorker[] = [];
  const start = (t: ReturnType<typeof recordingTransport>): OpsAlertWorker => { const w = workerOf(t); workers.push(w); return w; };
  try {
    const worker = start(phone);
    // S1 out past the flag: the alert, naming S1.
    await report(BOX1, 'S1', clockCheck('flag_bills', -400, { promotions: ['oil-10-new'], prices: [] }));
    expect((await worker.runOnce()).raised).toBe(1);
    expect((await inboxClock()).map((a) => a.detail)).toEqual([expect.stringMatching(/^price change held — a store computer's clock is 5 minutes or more out: store S1 /)]);
    expect(phone.sent).toHaveLength(1);
    const tick = await h.request({ method: 'POST', path: `/v1/platform/alerts/${encodeURIComponent(CLOCK_ID)}/acknowledge`, userId: OWNER, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body: {} });
    expect(tick.status).toBe(200);
    expect(await inboxClock()).toEqual([]); // ticked: it leaves his inbox

    // S2 out too: the SAME alert, updated to name both, sent again ONCE — and back in his inbox to tick.
    await report(BOX2, 'S2', clockCheck('flag_bills', 420, { promotions: [], prices: ['pe-s2'] }));
    const both = await worker.runOnce();
    expect([both.raised, both.updated, both.cleared]).toEqual([0, 1, 0]);
    // A second head-office instance at the same time: nothing more (no second update, no second message).
    h = apiHarness({ store: c.store, idempotency: c.idempotency });
    const second = start(phone2);
    const again = await second.runOnce();
    expect([again.raised, again.updated ?? 0]).toEqual([0, 0]);
    const [shown, ...more] = await inboxClock();
    expect(more).toEqual([]);
    expect(shown!.detail).toMatch(/2 store computers' clocks are 5 minutes or more out: store S1 .*held now: offer oil-10-new; store S2 .*held now: price pe-s2/);
    expect(phone.sent).toHaveLength(2);
    expect(phone.sent[1]!.text).toMatch(/^UPDATED: box_clock_held is degraded — .*store S1.*store S2/);
    expect(phone2.sent).toEqual([]);
    expect((await clockLive()).map((a) => [a.state, a.occurrence, a.revision])).toEqual([['open', 1, 1]]);

    // Another report with the same stores out, and a RESTART (a fresh worker): no update, no message.
    await report(BOX1, 'S1', clockCheck('flag_bills', -460, { promotions: ['oil-10-new'], prices: [] }));
    await worker.stop();
    const restarted = start(phone);
    const same = await restarted.runOnce();
    expect([same.raised, same.updated ?? 0, same.cleared]).toEqual([0, 0, 0]);
    expect((await second.runOnce()).updated ?? 0).toBe(0);
    expect(phone.sent).toHaveLength(2);

    // S1 back in step, S2 still out: updated again, naming only S2, sent once more — not cleared.
    await report(BOX1, 'S1', clockCheck('in_step', 2, null));
    const one = await restarted.runOnce();
    expect([one.raised, one.updated, one.cleared]).toEqual([0, 1, 0]);
    expect((await second.runOnce()).updated ?? 0).toBe(0);
    const [only] = await inboxClock();
    expect(only!.detail).toMatch(/^price change held — a store computer's clock is 5 minutes or more out: store S2 /);
    expect(only!.detail).not.toContain('store S1');
    expect(phone.sent).toHaveLength(3);
    expect(phone2.sent).toEqual([]);
    expect((await clockLive()).map((a) => [a.state, a.occurrence, a.revision])).toEqual([['open', 1, 2]]);

    // S2 back in step: cleared (kept, never deleted); nothing more sent.
    await report(BOX2, 'S2', clockCheck('in_step', 1, null));
    const done = await restarted.runOnce();
    expect([done.updated ?? 0, done.cleared]).toEqual([0, 1]);
    expect((await clockLive()).map((a) => [a.state, a.occurrence, a.revision])).toEqual([['cleared', 1, 2]]);
    expect(await inboxClock()).toEqual([]);
    expect(phone.sent).toHaveLength(3);
  } finally {
    for (const w of workers) await w.stop();
  }
}

const FOLLOWS = 'OB-414: S1 out → alert; S2 too → the same alert updated naming both, sent once; same again → nothing; S1 back → naming only S2; S2 back → cleared';
describe('§31.1 · OB-414 — the open clock alert follows the stores that are out (memory)', () => {
  it(FOLLOWS, async () => { await onMemory(theOpenAlertFollowsTheStores); }, 120_000);
});
describe.skipIf(DATABASE_URL === undefined)('§31.1 · OB-414 — the open clock alert follows the stores that are out (PostgreSQL)', () => {
  it(FOLLOWS, async () => { await onPg(theOpenAlertFollowsTheStores); }, 300_000);
});

const NAME = 'no rule needed; not at the warning; at the flag once (two instances, a restart); owner-only to turn off or tick; cleared in step';
describe('§31.1 · OB-409 — the built-in alert tells every owner when a store computer\'s clock holds new prices and offers (memory)', () => {
  it(NAME, async () => { await onMemory(theOwnerIsToldAtTheFlagOnly); }, 120_000);
});

describe.skipIf(DATABASE_URL === undefined)('§31.1 · OB-409 — the built-in alert tells every owner when a store computer\'s clock holds new prices and offers (PostgreSQL)', () => {
  it(NAME, async () => { await onPg(theOwnerIsToldAtTheFlagOnly); }, 300_000);
});
