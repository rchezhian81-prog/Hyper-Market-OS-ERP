import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { recordingTransport } from '../../packages/notifications/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import { STREAM, observedHealthAdapter, alertLifecycleAdapter } from '../../services/api/src/adapters';
import { OWNER_ROLE_ID, PLATFORM_ADMIN_ROLE_ID, STORE_MANAGER_ROLE_ID } from '../../services/api/src/roles';
import { deliverAlerts, OPS_ALERT_WORKER } from '../../services/platform/src/ops-alert-worker';
import {
  raiseObservedAlerts, observedHealthRoutes, BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID as ID, BUILT_IN_RULE_CHANGED_NOTICE, type ObservedHealthDeps, type BuiltInRuleState,
} from '../../services/platform/src/observed-health';
import { alertLifecycleRoutes, type LiveAlert } from '../../services/platform/src/alert-lifecycle';

/**
 * **Round 34 · M35-FR-04 · owner decision OB-124 (2) "A" (15 Oct 2026, in writing, "Build all five before pilot"), finishing
 * OB-114 "A" ("Built-in alert to you") — the built-in "store computer checks stuck" alert reaches EVERY owner, on memory and
 * on PostgreSQL.**
 *
 *   • with two people holding the owner role, the rule names both (GET alert-rules), the alert worker's raise is delivered to
 *     EACH — inbox and phone — and each owner's inbox shows it; before round 34 only the alphabetically first was told;
 *   • it stays OWNER-ONLY: a store manager and the IT/platform administrator get nothing, and are refused when they try to
 *     acknowledge it; EITHER owner may acknowledge it (the other's inbox then no longer asks);
 *   • a change to the built-in rule is sent to every owner too (the OB-115 notice).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const ALICE = 'u-owner-a-r34';
const BALA = 'u-owner-b-r34';
const MANAGER = 'u-manager-r34';
const IT = 'u-it-r34';
const SINCE = new Date(Date.now() - 2 * 3_600_000).toISOString();

async function grant(store: EventStore, T: string, userId: string, roleId: string): Promise<void> {
  const at = '2026-10-15T00:00:00.000Z';
  await store.append(T, STREAM.identity, makeEvent({
    id: `grant-${roleId}-${userId}`, type: 'RoleGranted', occurredAt: at, idempotencyKey: `grant-${T}-${roleId}-${userId}`, source: 'test/r34',
    payload: { userId, roleId, branchScope: 'all', request: { grantId: `${roleId}-${userId}`, userId, roleId, branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: at } },
  }));
}
const ctx = (T: string, userId: string, params: Record<string, string> = {}, body?: unknown): RequestContext =>
  ({ tenantId: T, userId, branchId: null, params, query: {}, body, traceId: 't', idempotencyKey: `k-${randomUUID()}` }) as unknown as RequestContext;
const route = (routes: readonly Route[], method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;

async function everyOwnerIsTold(store: EventStore): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r34');
  // Two owners (listed in the "wrong" order on purpose), a store manager and the IT administrator.
  await grant(store, T, BALA, OWNER_ROLE_ID);
  await grant(store, T, ALICE, OWNER_ROLE_ID);
  await grant(store, T, MANAGER, STORE_MANAGER_ROLE_ID);
  await grant(store, T, IT, PLATFORM_ADMIN_ROLE_ID);
  const now = (): string => new Date().toISOString();
  // The real adapters, with the store computer checks stuck for two hours (the hour itself is tested elsewhere).
  const deps: ObservedHealthDeps = {
    ...observedHealthAdapter({ store, now }),
    storeComputers: async () => ({
      records: [], knownStores: [], preparing: { since: SINCE, why: 'nothing is saved yet' },
      history: { sizeBytes: null, saveHeld: null, lastBuildFailed: null, notReadySince: SINCE },
    }),
  };
  const life = alertLifecycleAdapter({ store, now });
  const routes = observedHealthRoutes(deps);
  const lifeRoutes = alertLifecycleRoutes(life);
  const transport = recordingTransport();

  // GET alert-rules names both owners (owner-only: nobody else).
  const rules = (await route(routes, 'GET', '/v1/platform/alert-rules').handler(ctx(T, ALICE))).body as { builtIn: BuiltInRuleState[] };
  expect(rules.builtIn).toEqual([expect.objectContaining({ alertId: ID, state: 'on', rule: expect.objectContaining({ ownerUserId: ALICE, alsoToUserIds: [BALA] }) })]);
  expect(rules.builtIn[0]!.description).toContain(`all 2: ${ALICE}, ${BALA}`);

  // The alert worker raises it and delivers it — to EACH owner, inbox and phone.
  const raised = await raiseObservedAlerts(deps, T, OPS_ALERT_WORKER, now(), { clear: true });
  expect(raised?.alerts.map((a) => a.alertId)).toContain(ID);
  await deliverAlerts(life, T, OPS_ALERT_WORKER, now(), transport);
  const live = (await life.alerts(T)).find((a) => a.alert.alertId === ID)!;
  expect(live).toMatchObject({ state: 'open', alert: { ownerUserId: ALICE, alsoToUserIds: [BALA] } });
  expect(live.deliveries.map((d) => `${d.to}/${d.via}`).sort()).toEqual([`${ALICE}/${transport.name}`, `${ALICE}/inbox`, `${BALA}/${transport.name}`, `${BALA}/inbox`].sort());
  expect(transport.sent.map((m) => m.customerId).sort()).toEqual([ALICE, BALA].sort());
  // Delivered once each: a second pass sends nothing more.
  expect(await deliverAlerts(life, T, OPS_ALERT_WORKER, now(), transport)).toBe(0);

  const inbox = async (who: string): Promise<string[]> =>
    ((await route(lifeRoutes, 'GET', '/v1/platform/alerts/inbox').handler(ctx(T, who))).body as { alerts: { alert: { alertId: string } }[] }).alerts.map((a) => a.alert.alertId);
  expect(await inbox(ALICE)).toContain(ID);
  expect(await inbox(BALA)).toContain(ID);
  // Owner-only: nobody else is told, or may tick it.
  expect(await inbox(MANAGER)).not.toContain(ID);
  expect(await inbox(IT)).not.toContain(ID);
  expect(transport.sent.some((m) => m.customerId === MANAGER || m.customerId === IT)).toBe(false);
  const ack = route(lifeRoutes, 'POST', '/v1/platform/alerts/:alertId/acknowledge');
  await expect(ack.handler(ctx(T, IT, { alertId: ID }))).rejects.toMatchObject({ status: 403, body: { code: 'built_in_alert_acknowledge_refused_to_platform_administrator' } });
  await expect(ack.handler(ctx(T, MANAGER, { alertId: ID }))).rejects.toMatchObject({ status: 403, body: { code: 'built_in_alert_acknowledge_owner_only' } });
  // The SECOND owner (not the one the rule names first) acknowledges it: his tick is kept; neither inbox asks any more.
  expect((await ack.handler(ctx(T, BALA, { alertId: ID }))).body).toMatchObject({ alertId: ID, acknowledgedBy: BALA });
  expect((await life.alerts(T)).find((a: LiveAlert) => a.alert.alertId === ID)).toMatchObject({ state: 'acknowledged', acknowledgedBy: BALA });
  expect(await inbox(ALICE)).not.toContain(ID);
  expect(await inbox(BALA)).not.toContain(ID);

  // A change to the built-in rule (Alice turns it off) is sent to BOTH owners.
  const off = await route(routes, 'PUT', '/v1/platform/alert-rules').handler(ctx(T, ALICE, {}, { basedOnVersion: 0, rules: [], builtInOff: [ID] }));
  expect(off.body).toMatchObject({ ownerNotified: `${ALICE}, ${BALA}` });
  await deliverAlerts(life, T, OPS_ALERT_WORKER, now(), transport);
  const notice = (await life.alerts(T)).find((a) => a.alert.alertId.startsWith(BUILT_IN_RULE_CHANGED_NOTICE))!;
  expect(notice.deliveries.filter((d) => d.via === 'inbox').map((d) => d.to).sort()).toEqual([ALICE, BALA].sort());
  expect(await inbox(BALA)).toContain(notice.alert.alertId);
  expect(await inbox(MANAGER)).not.toContain(notice.alert.alertId);
}

describe('round 34 · M35-FR-04 · OB-124 (2) / OB-114: the built-in alert reaches every owner (memory)', () => {
  it('M35-FR-04 OB-124 OB-114: two owners — both told (inbox and phone), either may tick it; nobody else told or allowed; a rule change told to both', async () => {
    await everyOwnerIsTold(new InMemoryEventStore());
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 34 · M35-FR-04 · OB-124 (2) / OB-114: the built-in alert reaches every owner (PostgreSQL)', () => {
  it('M35-FR-04 OB-124 OB-114: two owners — both told (inbox and phone), either may tick it; nobody else told or allowed; a rule change told to both', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    try { await everyOwnerIsTold(new SqlEventStore(pgPoolClient(pool))); } finally { await pool.end(); }
  }, 120_000);
});
