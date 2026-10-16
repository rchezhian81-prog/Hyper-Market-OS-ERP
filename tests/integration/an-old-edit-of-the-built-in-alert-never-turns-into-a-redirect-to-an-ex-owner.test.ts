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
import { OWNER_ROLE_ID, STORE_MANAGER_ROLE_ID } from '../../services/api/src/roles';
import { deliverAlerts, OPS_ALERT_WORKER } from '../../services/platform/src/ops-alert-worker';
import { STORE_COMPUTER_CHECKS_STUCK_COMPONENT } from '../../services/platform/src/box-health';
import {
  raiseObservedAlerts, observedHealthRoutes, BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID as ID,
  type ObservedHealthDeps, type BuiltInRuleState, type StoredAlertRules,
} from '../../services/platform/src/observed-health';
import type { AlertLifecycleDeps } from '../../services/platform/src/alert-lifecycle';

/**
 * **Round 36 · M35-FR-04 · verifier r35 NEW-1 (OB-124 (2) "reaches every owner", OB-115 / OB-130 "A" the owner's redirect) — an
 * edit of the built-in "store computer checks stuck" rule saved before round 36 never turns into a redirect to an ex-owner; a
 * redirect is only what the owner saved as one; a redirect's person who can no longer see alerts does not get it. On memory
 * and on PostgreSQL, through head office's production adapters.**
 *
 *   • an edit saved in rounds 31-34 named the editing owner's own id (A). A stops being an owner: the rule goes to the owners
 *     now (B) — never to A — and the page says the old edit is read as going to every owner (before round 36 it went to A ONLY
 *     and said "redirected by the owner's edit", which nobody did);
 *   • from round 36 the owner's redirect is SAVED with a marker (`builtInRedirect`), set only by head office — one sent in a
 *     body is not used (an edit naming an owner stays with the owners);
 *   • the redirect's person (the store manager) gets it while they hold a role that may see alerts; once that role is revoked
 *     the rule goes to every owner instead, said by name on the page, until the owner removes the edit (round 39 words).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const A = 'u-owner-a-r36';
const B = 'u-owner-b-r36';
const MANAGER = 'u-manager-r36';
const SINCE = new Date(Date.now() - 2 * 3_600_000).toISOString();

function role(userId: string, roleId: string, revoke = false) {
  const at = '2026-10-15T00:00:00.000Z';
  return makeEvent({
    id: `${revoke ? 'revoke' : 'grant'}-${roleId}-${userId}`, type: revoke ? ROLE_REVOKED : 'RoleGranted', occurredAt: at,
    idempotencyKey: `${revoke ? 'revoke' : 'grant'}-${roleId}-${userId}-${randomUUID()}`, source: 'test/r36',
    payload: { userId, roleId, branchScope: 'all', request: { grantId: `${roleId}-${userId}`, userId, roleId, branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: at } },
  });
}
const ctx = (T: string, userId: string, body?: unknown): RequestContext =>
  ({ tenantId: T, userId, branchId: null, params: {}, query: {}, body, traceId: 't', idempotencyKey: `k-${randomUUID()}` }) as unknown as RequestContext;
const route = (routes: readonly Route[], method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
interface Rules { rules: (StoredAlertRules & { rules: { builtInRedirect?: true }[] }) | null; builtIn: BuiltInRuleState[] }

/** Raise, deliver, and say who the newest occurrence of the built-in alert reached (inbox). Clears it again after. */
async function deliveredTo(deps: ObservedHealthDeps, life: AlertLifecycleDeps, T: string): Promise<string[]> {
  const now = new Date().toISOString();
  await raiseObservedAlerts(deps, T, OPS_ALERT_WORKER, now, { clear: true });
  await deliverAlerts(life, T, OPS_ALERT_WORKER, now, recordingTransport());
  const live = (await life.alerts(T)).filter((a) => a.alert.alertId === ID).at(-1)!;
  const to = [...new Set(live.deliveries.filter((d) => d.via === 'inbox').map((d) => d.to))].sort();
  // Clear it (the condition goes away for a moment), so the next check raises a NEW occurrence to the people of that moment.
  await life.recordAlertEvent(T, { alertId: ID, change: 'cleared', by: OPS_ALERT_WORKER, at: now }, `clear-${ID}-${randomUUID()}`);
  return to;
}

async function noRedirectToAnExOwner(store: EventStore): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r36');
  await store.append(T, STREAM.identity, role(A, OWNER_ROLE_ID));
  await store.append(T, STREAM.identity, role(B, OWNER_ROLE_ID));
  await store.append(T, STREAM.identity, role(MANAGER, STORE_MANAGER_ROLE_ID));
  const now = (): string => new Date().toISOString();
  const deps: ObservedHealthDeps = {
    ...observedHealthAdapter({ store, now }),
    storeComputers: async () => ({
      records: [], knownStores: [], preparing: { since: SINCE, why: 'nothing is saved yet' },
      history: { sizeBytes: null, saveHeld: null, lastBuildFailed: null, notReadySince: SINCE },
    }),
  };
  const life = alertLifecycleAdapter({ store, now });
  const routes = observedHealthRoutes(deps);
  const get = async (): Promise<Rules> => (await route(routes, 'GET', '/v1/platform/alert-rules').handler(ctx(T, B))).body as Rules;
  const put = (who: string, body: unknown) => route(routes, 'PUT', '/v1/platform/alert-rules').handler(ctx(T, who, body));

  // An edit as rounds 31-34 SAVED it: owner A changed "answer within"; the save kept A's own id (no redirect marker).
  await deps.defineAlertRules(T, {
    version: 1, rules: [{ alertId: ID, component: STORE_COMPUTER_CHECKS_STUCK_COMPONENT, firesAt: 'down', ownerUserId: A, ownerName: 'A', ackWithinMinutes: 30 }],
    thresholds: DEFAULT_THRESHOLDS, backupMaxAgeSeconds: 86_400, backupsExpectedSince: SINCE, builtInChangedBy: A, builtInChangedAt: SINCE, definedBy: A, definedAt: SINCE,
  });
  let b = (await get()).builtIn[0]!;
  expect(b).toMatchObject({ state: 'edited', rule: { ownerUserId: A, alsoToUserIds: [B], ackWithinMinutes: 30 } });
  expect(b.description).toContain(`every owner (all 2: ${A}, ${B})`);
  expect(b.description).toContain(`saved before round 36 naming ${A} — it is read as going to every owner`);
  expect(await deliveredTo(deps, life, T)).toEqual([A, B]);

  // A stops being an owner (the shop is handed over). Before round 36 the old edit then read as a redirect to A ONLY.
  await store.append(T, STREAM.identity, role(A, OWNER_ROLE_ID, true));
  b = (await get()).builtIn[0]!;
  expect(b).toMatchObject({ state: 'edited', rule: { ownerUserId: B, ackWithinMinutes: 30 } });
  expect(b.rule!.alsoToUserIds).toBeUndefined();
  expect(b.description).toContain(`the owner (${B})`);
  expect(b.description).not.toContain('ONLY');
  expect(b.description).not.toContain('redirected by');
  expect(await deliveredTo(deps, life, T)).toEqual([B]); // the real owner gets it; the ex-owner does not

  // A marker sent in a body is never used: an edit naming the owner (B) stays with the owners, saved WITHOUT a marker.
  const kept = await put(B, { basedOnVersion: 1, rules: [{ ...b.rule!, ackWithinMinutes: 25, builtInRedirect: true }] });
  expect(kept.status).toBe(200);
  let saved = (await get()).rules!;
  expect(saved.rules[0]).toMatchObject({ ownerUserId: 'role:owner' });
  expect(saved.rules[0]!.builtInRedirect).toBeUndefined();

  // The owner redirects it to the store manager (OB-115 / OB-130): saved WITH the marker, said, delivered to the manager only.
  const redirect = await put(B, { basedOnVersion: 2, rules: [{ ...b.rule!, ownerUserId: MANAGER, ownerName: 'Manager', ackWithinMinutes: 25 }] });
  expect(redirect.status).toBe(200);
  saved = (await get()).rules!;
  expect(saved.rules[0]).toMatchObject({ ownerUserId: MANAGER, builtInRedirect: true });
  b = (await get()).builtIn[0]!;
  expect(b.rule).toMatchObject({ ownerUserId: MANAGER });
  expect(b.description).toContain(`Manager (${MANAGER}) ONLY`);
  expect(b.description).toContain(`${B} does NOT get it`);
  expect(await deliveredTo(deps, life, T)).toEqual([MANAGER]);

  // The manager's role is revoked (left the shop): the redirect is not in force for them — it goes to the owners, said.
  await store.append(T, STREAM.identity, role(MANAGER, STORE_MANAGER_ROLE_ID, true));
  b = (await get()).builtIn[0]!;
  expect(b).toMatchObject({ state: 'edited', rule: { ownerUserId: B, ackWithinMinutes: 25 } });
  expect((b.rule as { builtInRedirect?: true }).builtInRedirect).toBeUndefined();
  expect(b.description).toContain(`redirects it to Manager (${MANAGER}) only, but ${MANAGER} no longer holds any role that may see alerts, so it goes to the owners instead — until the owner removes this edit`); // round 39 · verifier r37 L5: the exact words
  expect(await deliveredTo(deps, life, T)).toEqual([B]);
  // The saved edit itself is unchanged (append-only; the owner decides what to do with it). Round 37 (verifier r36 NEW-1):
  // GET shows it as it is read — to every owner, never naming the manager, who no longer may see alerts.
  expect((await deps.alertRules(T))!.rules[0]).toMatchObject({ ownerUserId: MANAGER, builtInRedirect: true });
  expect((await get()).rules!.rules[0]).toMatchObject({ ownerUserId: 'role:owner', ownerName: 'every owner' });
  // Given the role back, the redirect is in force again.
  await store.append(T, STREAM.identity, { ...role(MANAGER, STORE_MANAGER_ROLE_ID), id: `regrant-${MANAGER}` });
  expect((await get()).builtIn[0]!.rule).toMatchObject({ ownerUserId: MANAGER });
}

describe('round 36 · M35-FR-04 · verifier r35 NEW-1: an old edit of the built-in alert never turns into a redirect to an ex-owner (memory)', () => {
  it('M35-FR-04 OB-124 OB-130: old edits go to every owner; a redirect is only what was saved as one; a target who may not see alerts does not get it', async () => {
    await noRedirectToAnExOwner(new InMemoryEventStore());
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 36 · M35-FR-04 · verifier r35 NEW-1: an old edit of the built-in alert never turns into a redirect to an ex-owner (PostgreSQL)', () => {
  it('M35-FR-04 OB-124 OB-130: old edits go to every owner; a redirect is only what was saved as one; a target who may not see alerts does not get it', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    try { await noRedirectToAnExOwner(new SqlEventStore(pgPoolClient(pool))); } finally { await pool.end(); }
  }, 120_000);
});
