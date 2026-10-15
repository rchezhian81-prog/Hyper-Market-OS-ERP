import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { recordingTransport } from '../../packages/notifications/src/index';
import { STREAM, observedHealthAdapter, alertLifecycleAdapter } from '../../services/api/src/adapters';
import { deliverAlerts, OPS_ALERT_WORKER } from '../../services/platform/src/ops-alert-worker';
import { raiseObservedAlerts, BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID as ID, BUILT_IN_RULE_CHANGED_NOTICE, type ObservedHealthDeps } from '../../services/platform/src/observed-health';
import { raiseKey, type LiveAlert } from '../../services/platform/src/alert-lifecycle';
import { apiHarness, TEST_PACK_KEY } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **Round 33 · owner decision OB-119 "A" (15 Oct 2026, in writing, "Reserve name, only you tick"; verifier r32 NEW-1, NEW-2,
 * probe zz-v32-alerts A1/A2)** — through the real API (the pipeline and its permission checks; on PostgreSQL the served API
 * with its audit trail, read back from audit_log):
 *
 *   • nobody raises an alert under a reserved id by hand — the built-in rule's (`built-in:…`) or an owner's notice
 *     (`notice:…`): POST /v1/platform/alerts/raise is refused by name (403 `built_in_alert_id_reserved`) for the IT
 *     administrator, head office staff and the owner himself; a hand-made alert rule under one is refused the same way;
 *   • an alert planted under the built-in id BEFORE the name was reserved (owned by IT, ticked by IT) does not swallow the
 *     real one: the alert worker's own raise opens a NEW occurrence, to the owner, in his inbox and to his phone;
 *   • only the owner ticks a built-in alert (or his notice) as seen: IT is refused by name
 *     (`built_in_alert_acknowledge_refused_to_platform_administrator`), head office staff too (`…_owner_only`); the alert
 *     stays open in the owner's inbox; the owner's own tick is accepted.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner-r33a';
const IT = 'u-it-r33a';
const HO = 'u-ho-r33a';
const SINCE = '2026-10-15T06:00:00.000Z';

type Send = (userId: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => Promise<{ status: number; body: unknown; key: string }>;
const err = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const ackPath = (id: string): string => `/v1/platform/alerts/${encodeURIComponent(id)}/acknowledge`;
const plant = (alertId: string, ownerUserId: string) => ({ signals: {}, alertRules: [{ alertId, component: 'queue', firesAt: 'unknown', ownerUserId, ownerName: ownerUserId, ackWithinMinutes: 100_000 }] });

/** The ops-alert worker's own raise, with the store computer checks stuck for more than an hour (the real adapters otherwise). */
function stuckWorkerDeps(store: EventStore, now: () => string): ObservedHealthDeps {
  return {
    ...observedHealthAdapter({ store, now }),
    storeComputers: async () => ({
      records: [], knownStores: [], preparing: { since: SINCE, why: 'nothing is saved yet' },
      history: { sizeBytes: null, saveHeld: null, lastBuildFailed: null, notReadySince: SINCE },
    }),
  };
}

/** The whole story. Returns the idempotency keys of every refused request, for the audit read-back. */
async function story(send: Send, store: EventStore, T: string): Promise<string[]> {
  const refused: string[] = [];
  const now = () => new Date().toISOString();
  const life = alertLifecycleAdapter({ store, now });
  const board = async (): Promise<LiveAlert | undefined> => (await life.alerts(T)).find((a) => a.alert.alertId === ID);
  const inbox = async (): Promise<string[]> => ((await send(OWNER, 'GET', '/v1/platform/alerts/inbox')).body as { alerts: { alert: { alertId: string } }[] }).alerts.map((a) => a.alert.alertId);

  // 1. Nobody raises under a reserved id by hand — not IT, not head office, not even the owner (the worker raises it).
  for (const [who, id] of [[IT, ID], [HO, ID], [OWNER, ID], [IT, `${BUILT_IN_RULE_CHANGED_NOTICE}:v9`], [IT, 'built-in:something-new']] as const) {
    const r = await send(who, 'POST', '/v1/platform/alerts/raise', plant(id, who));
    expect([r.status, err(r)], `${who} ${id}`).toEqual([403, 'built_in_alert_id_reserved']);
    expect(JSON.stringify(r.body)).toMatch(/reserved for head office's own built-in rules and the owner's notices \(owner decision OB-119\)/);
    refused.push(r.key);
  }
  // …nor as a hand-made alert rule.
  for (const id of ['built-in:mine', `${BUILT_IN_RULE_CHANGED_NOTICE}:v2`]) {
    const r = await send(IT, 'PUT', '/v1/platform/alert-rules', { basedOnVersion: 0, rules: [{ alertId: id, component: 'queue', firesAt: 'unknown', ownerUserId: IT, ownerName: 'IT', ackWithinMinutes: 60 }] });
    expect([r.status, err(r)], id).toEqual([403, 'built_in_alert_id_reserved']);
    refused.push(r.key);
  }
  // An own id is still fine.
  expect((await send(HO, 'POST', '/v1/platform/alerts/raise', plant('ho-queue', HO))).status).toBe(200);
  expect(await board()).toBeUndefined();

  // 2. A FOREIGN alert planted before the name was reserved (legacy facts: raised by IT, owned by IT, ticked by IT).
  const at0 = now();
  await life.recordAlertEvent(T, { alertId: ID, change: 'raised', by: IT, at: at0, alert: { alertId: ID, component: 'queue', status: 'unknown', ownerUserId: IT, ownerName: 'IT', detail: 'planted', raisedAt: at0, ackDueBy: at0 } }, raiseKey(ID, undefined));
  await life.recordAlertEvent(T, { alertId: ID, change: 'acknowledged', by: IT, at: at0 }, `ack-${ID}`);
  expect(await board()).toMatchObject({ state: 'acknowledged', foreign: true, occurrence: 1, alert: { ownerUserId: IT } });

  // 3. The worker's real raise (the checks stuck past the hour) opens a NEW occurrence, to the owner — never a dropped duplicate.
  const deps = stuckWorkerDeps(store, now);
  const raised = await raiseObservedAlerts(deps, T, OPS_ALERT_WORKER, now(), { clear: true });
  expect(raised!.newlyOpened).toBe(1);
  const real = await board();
  expect(real).toMatchObject({ state: 'open', occurrence: 2, alert: { ownerUserId: OWNER, status: 'down' } });
  expect(real).not.toHaveProperty('foreign');
  // A second pass is the same ongoing condition (no third occurrence).
  await raiseObservedAlerts(deps, T, OPS_ALERT_WORKER, now(), { clear: true });
  expect((await board())!.occurrence).toBe(2);
  // It reaches him: his inbox, and his phone through the worker's delivery step.
  const transport = recordingTransport();
  await deliverAlerts(deps, T, OPS_ALERT_WORKER, now(), transport);
  expect(await inbox()).toContain(ID);
  expect(transport.sent.filter((m) => m.customerId === OWNER).length).toBeGreaterThanOrEqual(1);
  expect(transport.sent.filter((m) => m.customerId === IT)).toEqual([]);
  // A person's observed raise never raises it (only the worker does) — and says so.
  expect((await send(OWNER, 'PUT', '/v1/platform/alert-rules', { basedOnVersion: 0, rules: [{ alertId: 'ho-backup', component: 'backup', firesAt: 'down', ownerUserId: HO, ownerName: 'HO', ackWithinMinutes: 60 }] })).status).toBe(200);

  // 4. Only the owner ticks it as seen.
  const itAck = await send(IT, 'POST', ackPath(ID));
  expect([itAck.status, err(itAck)]).toEqual([403, 'built_in_alert_acknowledge_refused_to_platform_administrator']);
  expect(JSON.stringify(itAck.body)).toMatch(/Only the shop's owner may acknowledge \(tick as seen\) built-in:store-computer-checks-stuck \(owner decision OB-119\)/);
  refused.push(itAck.key);
  const hoAck = await send(HO, 'POST', ackPath(ID));
  expect([hoAck.status, err(hoAck)]).toEqual([403, 'built_in_alert_acknowledge_owner_only']);
  refused.push(hoAck.key);
  expect(await board()).toMatchObject({ state: 'open', occurrence: 2 });
  expect(await inbox()).toContain(ID); // still in his inbox
  const ownAck = await send(OWNER, 'POST', ackPath(ID));
  expect(ownAck.status, JSON.stringify(ownAck.body)).toBe(200);
  expect(await board()).toMatchObject({ state: 'acknowledged', acknowledgedBy: OWNER });

  // 5. His notices are his too: the owner turns the rule off (a notice to him) — IT may not tick the notice.
  expect((await send(OWNER, 'PUT', '/v1/platform/alert-rules', { basedOnVersion: 1, rules: [{ alertId: 'ho-backup', component: 'backup', firesAt: 'down', ownerUserId: HO, ownerName: 'HO', ackWithinMinutes: 60 }], builtInOff: [ID] })).status).toBe(200);
  const notice = `${BUILT_IN_RULE_CHANGED_NOTICE}:v2`;
  const itNotice = await send(IT, 'POST', ackPath(notice));
  expect([itNotice.status, err(itNotice)]).toEqual([403, 'built_in_alert_acknowledge_refused_to_platform_administrator']);
  refused.push(itNotice.key);
  expect(await inbox()).toContain(notice);
  // An ordinary alert is acknowledged as before by anyone with alert rights.
  expect((await send(IT, 'POST', ackPath('ho-queue'))).status).toBe(200);
  return refused;
}

describe('round 33 · OB-119: built-in alerts are raised only by head office and ticked only by the owner (memory, the real pipeline)', () => {
  it('a reserved id is refused by hand, a planted alert does not swallow the real one, only the owner ticks it', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await h.provisionOwner(T, OWNER);
    await h.provisionRole(T, IT, 'platform_admin', 'all');
    await h.provisionRole(T, HO, 'store_manager', 'all');
    const send: Send = async (userId, method, path, body) => {
      const key = `k-${randomUUID()}`;
      const r = await h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key }) });
      return { status: r.status, body: r.body, key };
    };
    await story(send, h.store, T);
  }, 120_000);
});

describe.skipIf(DATABASE_URL === undefined)('round 33 · OB-119: the same on the served API (PostgreSQL, audit_log read back)', () => {
  const clouds: RealCloud[] = [];
  afterAll(async () => { for (const c of clouds) await c.stop(); });

  it('every refusal is a 403 on the audit trail; the planted alert is superseded on PostgreSQL', async () => {
    const tenantId = randomUUID();
    // The worker's own timer is held back (an hour) — this test runs its passes itself.
    const cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: TEST_PACK_KEY, providers: { opsAlertWorkerIntervalMs: 3_600_000 } });
    clouds.push(cloud);
    const platform = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    try {
      const store = new SqlEventStore(pgPoolClient(platform));
      await store.append(tenantId, STREAM.identity, makeEvent({
        id: `grant-it-${tenantId}`, type: 'RoleGranted', occurredAt: new Date().toISOString(), idempotencyKey: `grant-${tenantId}-platform_admin-${IT}`, source: 'test/r33',
        payload: { userId: IT, roleId: 'platform_admin', branchScope: 'all', request: { grantId: `platform_admin-${IT}`, userId: IT, roleId: 'platform_admin', branchScope: 'all', requestedBy: 'operator', approvedBy: 'operator', requestedAt: new Date().toISOString() } },
      }));
      await cloud.grant(HO, 'store_manager');
      const send: Send = async (userId, method, path, body) => {
        const key = `k-${randomUUID()}`;
        const r = await cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key }) });
        return { status: r.status, body: r.body, key };
      };
      const refused = await story(send, store, tenantId);
      const audit = await platform.query<{ status: number; idempotency_key: string; user_id: string }>(
        'SELECT status, idempotency_key, user_id FROM audit_log WHERE tenant_id = $1 AND idempotency_key = ANY($2::text[])', [tenantId, refused]);
      const byKey = new Map(audit.rows.map((r) => [r.idempotency_key, r]));
      for (const key of refused) expect(byKey.get(key), key).toMatchObject({ status: 403 });
      expect(audit.rows.filter((r) => r.user_id === IT).length).toBeGreaterThanOrEqual(5);
    } finally { await platform.end(); }
  }, 300_000);
});
