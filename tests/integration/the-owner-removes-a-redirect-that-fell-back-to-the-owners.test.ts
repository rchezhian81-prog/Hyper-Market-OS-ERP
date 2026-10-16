import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { recordingTransport } from '../../packages/notifications/src/index';
import { DEFAULT_THRESHOLDS } from '../../packages/ops/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import { STREAM, ROLE_REVOKED, observedHealthAdapter, alertLifecycleAdapter } from '../../services/api/src/adapters';
import { OWNER_ROLE_ID, STORE_MANAGER_ROLE_ID, PLATFORM_ADMIN_ROLE_ID } from '../../services/api/src/roles';
import { deliverAlerts, OPS_ALERT_WORKER } from '../../services/platform/src/ops-alert-worker';
import { STORE_COMPUTER_CHECKS_STUCK_COMPONENT } from '../../services/platform/src/box-health';
import {
  raiseObservedAlerts, observedHealthRoutes, BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID as ID, BUILT_IN_RULE_CHANGED_NOTICE,
  type ObservedHealthDeps, type BuiltInRuleState, type StoredAlertRules,
} from '../../services/platform/src/observed-health';
import type { AlertLifecycleDeps } from '../../services/platform/src/alert-lifecycle';

/**
 * **Round 39 · M35-FR-04 · verifier r37 L5 (OB-115, OB-132 / OB-134 "A") — after a redirect of the built-in alert falls back to
 * the owners, the page says EXACTLY what stops it coming back, and the owner can always do that. On memory and on PostgreSQL,
 * through head office's production adapters.**
 *
 *   • the owner redirects the built-in "store computer checks stuck" alert to the store manager, and that is the ONLY rule the
 *     shop has saved; the manager's role is revoked: the alert goes to the owners, and the page now says "until the owner
 *     removes this edit, or <manager> is given a role that may see alerts again, when it goes back … by itself (OB-134).
 *     Saving the rule as shown here ("every owner") keeps the edit" (round 36-38: "until the owner changes the edit" — but
 *     saving it as shown, "every owner", is no change and kept the redirect);
 *   • round 38 could not remove that edit at all: a save with no rules was refused (400 "needs a non-empty rules[]") — the
 *     owner had no way to put the rule back to "every owner". Now a save with no rules, when the saved rules are only edits of
 *     built-in rules, removes them: a built-in change, so OWNER-ONLY (the IT administrator: 403, the store manager … 403),
 *     kept as a new rules version with who and when (`builtInChangedBy`), and noticed to every owner (the kept notice event);
 *   • after that, giving the manager a role again does NOT bring the redirect back — the alert stays with the owners;
 *   • a save with no rules is still refused when the shop has rules of its own (it would remove them all).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const B = 'u-owner-b-r39';
const ADMIN = 'u-it-admin-r39';
const MANAGER = 'u-manager-r39';
const SINCE = new Date(Date.now() - 2 * 3_600_000).toISOString();

function role(userId: string, roleId: string, revoke = false) {
  const at = '2026-10-16T00:00:00.000Z';
  return makeEvent({
    id: `${revoke ? 'revoke' : 'grant'}-${roleId}-${userId}-${randomUUID()}`, type: revoke ? ROLE_REVOKED : 'RoleGranted', occurredAt: at,
    idempotencyKey: `${revoke ? 'revoke' : 'grant'}-${roleId}-${userId}-${randomUUID()}`, source: 'test/r39',
    payload: { userId, roleId, branchScope: 'all', request: { grantId: `${roleId}-${userId}`, userId, roleId, branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: at } },
  });
}
const ctx = (T: string, userId: string, body?: unknown): RequestContext =>
  ({ tenantId: T, userId, branchId: null, params: {}, query: {}, body, traceId: 't', idempotencyKey: `k-${randomUUID()}` }) as unknown as RequestContext;
const route = (routes: readonly Route[], method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
interface Rules { rules: StoredAlertRules | null; builtIn: BuiltInRuleState[] }
interface Reply { status: number | string; body: { builtInChanged?: string[]; code?: string; ownerNotified?: string; whatHappened?: string } }

async function deliveredTo(deps: ObservedHealthDeps, life: AlertLifecycleDeps, T: string): Promise<string[]> {
  const now = new Date().toISOString();
  await raiseObservedAlerts(deps, T, OPS_ALERT_WORKER, now, { clear: true });
  await deliverAlerts(life, T, OPS_ALERT_WORKER, now, recordingTransport());
  const live = (await life.alerts(T)).filter((a) => a.alert.alertId === ID).at(-1)!;
  const to = [...new Set(live.deliveries.filter((d) => d.via === 'inbox').map((d) => d.to))].sort();
  await life.recordAlertEvent(T, { alertId: ID, change: 'cleared', by: OPS_ALERT_WORKER, at: now }, `clear-${ID}-${randomUUID()}`);
  return to;
}

async function ownerRemovesTheRedirect(store: EventStore): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r39');
  for (const [u, r] of [[B, OWNER_ROLE_ID], [ADMIN, PLATFORM_ADMIN_ROLE_ID], [MANAGER, STORE_MANAGER_ROLE_ID]] as const) await store.append(T, STREAM.identity, role(u, r));
  const now = (): string => new Date().toISOString();
  const deps: ObservedHealthDeps = {
    ...observedHealthAdapter({ store, now }),
    storeComputers: async () => ({ records: [], knownStores: [], preparing: { since: SINCE, why: 'x' }, history: { sizeBytes: null, saveHeld: null, lastBuildFailed: null, notReadySince: SINCE } }),
  };
  const life = alertLifecycleAdapter({ store, now });
  const routes = observedHealthRoutes(deps);
  const get = async (): Promise<Rules> => (await route(routes, 'GET', '/v1/platform/alert-rules').handler(ctx(T, B))).body as Rules;
  const put = async (who: string, body: unknown): Promise<Reply> => {
    try { return await route(routes, 'PUT', '/v1/platform/alert-rules').handler(ctx(T, who, body)) as Reply; } catch (e) { const x = e as { status?: number; body?: Reply['body'] }; return { status: x.status ?? 'thrown', body: x.body ?? {} }; }
  };
  const base = { thresholds: DEFAULT_THRESHOLDS, backupMaxAgeSeconds: 86_400 };

  // The owner redirects the built-in alert to the manager — the only rule the shop has saved.
  const redirect = await put(B, { ...base, basedOnVersion: 0, rules: [{ alertId: ID, component: STORE_COMPUTER_CHECKS_STUCK_COMPONENT, firesAt: 'down', ownerUserId: MANAGER, ownerName: 'Manager', ackWithinMinutes: 20 }] });
  expect(redirect.status).toBe(200);
  expect(await deliveredTo(deps, life, T)).toEqual([MANAGER]);

  // The manager's role is revoked: the alert goes to the owners — and the page says exactly what stops it coming back.
  await store.append(T, STREAM.identity, role(MANAGER, STORE_MANAGER_ROLE_ID, true));
  const fell = await get();
  const words = fell.builtIn[0]!.description;
  expect(words).toContain(`so it goes to the owners instead — until the owner removes this edit, or ${MANAGER} is given a role that may see alerts again, when it goes back to Manager by itself (OB-115, OB-134)`);
  expect(words).toContain('Saving the rule as shown here ("every owner") keeps the edit');
  expect(words).not.toContain('until the owner changes the edit');
  expect(await deliveredTo(deps, life, T)).toEqual([B]);

  // Round 38: removing that edit was impossible — a save with no rules was refused (400). Now it is a built-in change:
  // owner-only. The IT administrator and the (former) store manager are refused by name; nothing changes.
  const byAdmin = await put(ADMIN, { ...base, basedOnVersion: 1, rules: [] });
  expect(byAdmin.status).toBe(403);
  expect(byAdmin.body.code).toBe('built_in_alert_rule_refused_to_platform_administrator');
  expect(byAdmin.body.whatHappened).toContain(`removed the owner's edit of ${ID}`);
  const byOther = await put(MANAGER, { ...base, basedOnVersion: 1, rules: [] });
  expect(byOther.status).toBe(403);
  expect(byOther.body.code).toBe('built_in_alert_rule_owner_only');
  expect((await deps.alertRules(T))!.version).toBe(1);

  // The owner removes it: saved as a new version, who and when kept, and every owner told (a kept notice event).
  const removed = await put(B, { ...base, basedOnVersion: 1, rules: [] });
  expect(removed.status).toBe(200);
  expect(removed.body.builtInChanged).toEqual([`removed the owner's edit of ${ID} (it goes back to the built-in rule, to the owner (${B}))`]);
  expect(removed.body.ownerNotified).toBe(B);
  const saved = (await deps.alertRules(T))!;
  expect(saved).toMatchObject({ version: 2, rules: [], builtInChangedBy: B, definedBy: B });
  const notice = (await life.alerts(T)).find((a) => a.alert.alertId === `${BUILT_IN_RULE_CHANGED_NOTICE}:v2`);
  expect(notice).toBeDefined();
  expect(notice!.alert.detail).toContain(`a built-in alert rule was changed by ${B}`);
  expect(notice!.alert.detail).toContain(`removed the owner's edit of ${ID}`);
  const after = await get();
  expect(after.builtIn[0]).toMatchObject({ state: 'on' });
  expect(await deliveredTo(deps, life, T)).toEqual([B]);

  // The manager is given a role again: the redirect does NOT come back (it was removed, not kept as "every owner").
  await store.append(T, STREAM.identity, role(MANAGER, STORE_MANAGER_ROLE_ID));
  expect((await get()).builtIn[0]).toMatchObject({ state: 'on' });
  expect(await deliveredTo(deps, life, T)).toEqual([B]);

  // A save with no rules is still refused when the shop has rules of its own (it would remove them all, OB-114).
  const own = await put(B, { ...base, basedOnVersion: 2, rules: [{ alertId: 'my-backup', component: 'backup', firesAt: 'down', ownerUserId: B, ownerName: 'B', ackWithinMinutes: 60 }] });
  expect(own.status).toBe(200);
  const empty = await put(B, { ...base, basedOnVersion: 3, rules: [] });
  expect(empty.status).toBe(400);
  expect(empty.body.code).toBe('alert_rules_not_readable');
}

describe('round 39 · M35-FR-04 · verifier r37 L5: the owner removes a redirect that fell back to the owners (memory)', () => {
  it('M35-FR-04 OB-115 OB-134 L5: exact words; removing the edit is owner-only, kept and noticed; the redirect never comes back after', async () => {
    await ownerRemovesTheRedirect(new InMemoryEventStore());
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 39 · M35-FR-04 · verifier r37 L5: the owner removes a redirect that fell back to the owners (PostgreSQL)', () => {
  it('M35-FR-04 OB-115 OB-134 L5: exact words; removing the edit is owner-only, kept and noticed; the redirect never comes back after', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    try { await ownerRemovesTheRedirect(new SqlEventStore(pgPoolClient(pool))); } finally { await pool.end(); }
  }, 120_000);
});
