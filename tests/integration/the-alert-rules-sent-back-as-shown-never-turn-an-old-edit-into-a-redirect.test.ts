import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { recordingTransport } from '../../packages/notifications/src/index';
import { DEFAULT_THRESHOLDS, type AlertRule } from '../../packages/ops/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import { STREAM, ROLE_REVOKED, observedHealthAdapter, alertLifecycleAdapter } from '../../services/api/src/adapters';
import { OWNER_ROLE_ID, STORE_MANAGER_ROLE_ID, PLATFORM_ADMIN_ROLE_ID } from '../../services/api/src/roles';
import { deliverAlerts, OPS_ALERT_WORKER } from '../../services/platform/src/ops-alert-worker';
import { STORE_COMPUTER_CHECKS_STUCK_COMPONENT } from '../../services/platform/src/box-health';
import {
  raiseObservedAlerts, observedHealthRoutes, BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID as ID, EVERY_OWNER,
  type ObservedHealthDeps, type BuiltInRuleState, type StoredAlertRules,
} from '../../services/platform/src/observed-health';
import type { AlertLifecycleDeps } from '../../services/platform/src/alert-lifecycle';

/**
 * **Round 37 · M35-FR-04 · verifier r36 NEW-1 (OB-130 / OB-132 / OB-133 "A") — the alert rules sent back exactly as GET shows
 * them never turn an old edit of the built-in alert into a redirect, and the IT administrator may save his own rules. On memory
 * and on PostgreSQL, through head office's production adapters (the verifier's probe scenario).**
 *
 *   • an edit saved in rounds 31-34 names owner A; A hands the shop over and stays on as store manager (still may see alerts).
 *     GET shows that edit addressed to every owner (never naming A); the IT administrator sends GET's rules back with one rule of
 *     his own: 200 (round 36: 403 "would have changed the edit"), no built-in change, the edit kept as saved (no marker), and
 *     the alert reaches owner B, not A. Owner B does the same: 200, no marker, still B (round 36: a marked redirect to A);
 *   • a redirect is set only when the owner CHANGES the recipient to one named non-owner (A): saved with the marker, said;
 *   • a redirect in force sent back as shown is unchanged (the administrator may send it); one whose person lost every role
 *     that may see alerts is shown as "every owner" (OB-132), and sent back so it is unchanged too — the marker stays, so it
 *     goes back to that person if they are given a role again;
 *   • the administrator still may not CHANGE the built-in edit (403, as OB-115).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const A = 'u-owner-a-r37';
const B = 'u-owner-b-r37';
const ADMIN = 'u-it-admin-r37';
const MANAGER = 'u-manager-r37';
const SINCE = new Date(Date.now() - 2 * 3_600_000).toISOString();

function role(userId: string, roleId: string, revoke = false) {
  const at = '2026-10-16T00:00:00.000Z';
  return makeEvent({
    id: `${revoke ? 'revoke' : 'grant'}-${roleId}-${userId}-${randomUUID()}`, type: revoke ? ROLE_REVOKED : 'RoleGranted', occurredAt: at,
    idempotencyKey: `${revoke ? 'revoke' : 'grant'}-${roleId}-${userId}-${randomUUID()}`, source: 'test/r37',
    payload: { userId, roleId, branchScope: 'all', request: { grantId: `${roleId}-${userId}`, userId, roleId, branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: at } },
  });
}
const ctx = (T: string, userId: string, body?: unknown): RequestContext =>
  ({ tenantId: T, userId, branchId: null, params: {}, query: {}, body, traceId: 't', idempotencyKey: `k-${randomUUID()}` }) as unknown as RequestContext;
const route = (routes: readonly Route[], method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
interface Rules { rules: StoredAlertRules | null; builtIn: BuiltInRuleState[] }
interface Reply { status: number | string; body: { builtInChanged?: string[]; code?: string; ownerNotified?: string } }

async function deliveredTo(deps: ObservedHealthDeps, life: AlertLifecycleDeps, T: string): Promise<string[]> {
  const now = new Date().toISOString();
  await raiseObservedAlerts(deps, T, OPS_ALERT_WORKER, now, { clear: true });
  await deliverAlerts(life, T, OPS_ALERT_WORKER, now, recordingTransport());
  const live = (await life.alerts(T)).filter((a) => a.alert.alertId === ID).at(-1)!;
  const to = [...new Set(live.deliveries.filter((d) => d.via === 'inbox').map((d) => d.to))].sort();
  await life.recordAlertEvent(T, { alertId: ID, change: 'cleared', by: OPS_ALERT_WORKER, at: now }, `clear-${ID}-${randomUUID()}`);
  return to;
}

async function sentBackAsShown(store: EventStore): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r37');
  for (const [u, r] of [[A, OWNER_ROLE_ID], [B, OWNER_ROLE_ID], [ADMIN, PLATFORM_ADMIN_ROLE_ID], [MANAGER, STORE_MANAGER_ROLE_ID]] as const) await store.append(T, STREAM.identity, role(u, r));
  const now = (): string => new Date().toISOString();
  const deps: ObservedHealthDeps = {
    ...observedHealthAdapter({ store, now }),
    storeComputers: async () => ({ records: [], knownStores: [], preparing: { since: SINCE, why: 'x' }, history: { sizeBytes: null, saveHeld: null, lastBuildFailed: null, notReadySince: SINCE } }),
  };
  const life = alertLifecycleAdapter({ store, now });
  const routes = observedHealthRoutes(deps);
  const get = async (who = B): Promise<Rules> => (await route(routes, 'GET', '/v1/platform/alert-rules').handler(ctx(T, who))).body as Rules;
  const put = async (who: string, body: unknown): Promise<Reply> => {
    try { return await route(routes, 'PUT', '/v1/platform/alert-rules').handler(ctx(T, who, body)) as Reply; } catch (e) { const x = e as { status?: number; body?: Reply['body'] }; return { status: x.status ?? 'thrown', body: x.body ?? {} }; }
  };
  const saved = async (): Promise<AlertRule> => (await deps.alertRules(T))!.rules.find((r) => r.alertId === ID)!;
  const custom = (n: number): AlertRule => ({ alertId: `my-backup-alert-${n}`, component: 'backup', firesAt: 'down', ownerUserId: ADMIN, ownerName: 'IT', ackWithinMinutes: 60 });
  /** The ordinary save: GET, keep every rule as shown, add one of one's own, PUT the whole set. */
  const echo = async (who: string, n: number): Promise<Reply> => {
    const g = (await get(who)).rules!;
    return put(who, { basedOnVersion: g.version, rules: [...g.rules, custom(n)], thresholds: g.thresholds, backupMaxAgeSeconds: g.backupMaxAgeSeconds });
  };

  // The verifier's scenario: an edit as rounds 31-34 saved it, naming owner A (no marker).
  const legacy: AlertRule = { alertId: ID, component: STORE_COMPUTER_CHECKS_STUCK_COMPONENT, firesAt: 'down', ownerUserId: A, ownerName: 'A', ackWithinMinutes: 30 };
  await deps.defineAlertRules(T, {
    version: 1, rules: [legacy], thresholds: DEFAULT_THRESHOLDS, backupMaxAgeSeconds: 86_400, backupsExpectedSince: SINCE,
    builtInChangedBy: A, builtInChangedAt: SINCE, definedBy: A, definedAt: SINCE,
  });
  // A hands over: no longer an owner, stays on as store manager (a role that may still see alerts).
  await store.append(T, STREAM.identity, role(A, OWNER_ROLE_ID, true));
  await store.append(T, STREAM.identity, role(A, STORE_MANAGER_ROLE_ID));

  // GET shows the old edit as it is READ: to every owner — never naming A.
  const shown = (await get()).rules!.rules.find((r) => r.alertId === ID)!;
  expect(shown).toMatchObject({ ownerUserId: EVERY_OWNER, ownerName: 'every owner', ackWithinMinutes: 30 });
  expect(shown.builtInRedirect).toBeUndefined();
  expect(JSON.stringify((await get()).rules!.rules)).not.toContain(A); // (who saved it last is still said: definedBy)

  // (a) The IT administrator sends it back with a rule of his own: saved (round 36: 403), no built-in change, nobody notified.
  const byAdmin = await echo(ADMIN, 1);
  expect(byAdmin.status).toBe(200);
  expect(byAdmin.body.builtInChanged).toEqual([]);
  expect(byAdmin.body.ownerNotified).toBeUndefined();
  expect(await saved()).toEqual(legacy); // kept exactly as saved — no marker
  expect(await deliveredTo(deps, life, T)).toEqual([B]);

  // (b) Owner B does the same: saved, no change, no marker (round 36: a MARKED redirect to the ex-owner A).
  const byOwner = await echo(B, 2);
  expect(byOwner.status).toBe(200);
  expect(byOwner.body.builtInChanged).toEqual([]);
  expect((await saved()).builtInRedirect).toBeUndefined();
  expect((await get()).builtIn[0]!.description).not.toContain('ONLY');
  expect(await deliveredTo(deps, life, T)).toEqual([B]);

  // (c) The administrator may still not CHANGE the built-in edit.
  {
    const g = (await get(ADMIN)).rules!;
    const changed = await put(ADMIN, { basedOnVersion: g.version, rules: g.rules.map((r) => r.alertId === ID ? { ...r, ackWithinMinutes: 10 } : r), thresholds: g.thresholds, backupMaxAgeSeconds: g.backupMaxAgeSeconds });
    expect(changed.status).toBe(403);
    expect(changed.body.code).toBe('built_in_alert_rule_refused_to_platform_administrator');
  }

  // (d) A redirect is set only when the OWNER changes the recipient to one named non-owner: A (now store manager).
  {
    const g = (await get()).rules!;
    const redirect = await put(B, { basedOnVersion: g.version, rules: g.rules.map((r) => r.alertId === ID ? { ...r, ownerUserId: A, ownerName: 'A' } : r), thresholds: g.thresholds, backupMaxAgeSeconds: g.backupMaxAgeSeconds });
    expect(redirect.status).toBe(200);
    expect(redirect.body.builtInChanged!.join(' ')).toContain(`A (${A}) ONLY`);
    expect(await saved()).toMatchObject({ ownerUserId: A, builtInRedirect: true });
    expect(await deliveredTo(deps, life, T)).toEqual([A]);
  }
  // A redirect in force is shown as saved, and sent back as shown it is unchanged — the administrator may send it.
  expect((await get(ADMIN)).rules!.rules.find((r) => r.alertId === ID)).toMatchObject({ ownerUserId: A });
  const adminAgain = await echo(ADMIN, 3);
  expect(adminAgain.status).toBe(200);
  expect(adminAgain.body.builtInChanged).toEqual([]);
  expect(await saved()).toMatchObject({ ownerUserId: A, builtInRedirect: true });

  // (e) OB-132: the redirect's person loses every role that may see alerts — shown as every owner, delivered to the owners.
  await store.append(T, STREAM.identity, role(A, STORE_MANAGER_ROLE_ID, true));
  expect((await get(ADMIN)).rules!.rules.find((r) => r.alertId === ID)).toMatchObject({ ownerUserId: EVERY_OWNER });
  expect(await deliveredTo(deps, life, T)).toEqual([B]);
  // Sent back as shown by the administrator, and by the owner: unchanged — the saved redirect (marker) stays as it was.
  for (const [who, n] of [[ADMIN, 4], [B, 5]] as const) {
    const r = await echo(who, n);
    expect(r.status).toBe(200);
    expect(r.body.builtInChanged).toEqual([]);
    expect(await saved()).toMatchObject({ ownerUserId: A, builtInRedirect: true });
  }
  expect(await deliveredTo(deps, life, T)).toEqual([B]);
  // Given a role again, the owner's redirect is in force again (OB-132 "until an owner sets a new redirect").
  await store.append(T, STREAM.identity, role(A, STORE_MANAGER_ROLE_ID));
  expect(await deliveredTo(deps, life, T)).toEqual([A]);
}

describe('round 37 · M35-FR-04 · verifier r36 NEW-1: the alert rules sent back as shown never turn an old edit into a redirect (memory)', () => {
  it('M35-FR-04 OB-130 OB-132 OB-133: GET shows old edits as every owner; sent back unchanged by the IT admin and the owner; a redirect only by an explicit owner change', async () => {
    await sentBackAsShown(new InMemoryEventStore());
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 37 · M35-FR-04 · verifier r36 NEW-1: the alert rules sent back as shown never turn an old edit into a redirect (PostgreSQL)', () => {
  it('M35-FR-04 OB-130 OB-132 OB-133: GET shows old edits as every owner; sent back unchanged by the IT admin and the owner; a redirect only by an explicit owner change', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    try { await sentBackAsShown(new SqlEventStore(pgPoolClient(pool))); } finally { await pool.end(); }
  }, 120_000);
});
