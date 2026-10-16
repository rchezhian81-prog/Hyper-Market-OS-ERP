import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { recordingTransport } from '../../packages/notifications/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import { STREAM, ROLE_REVOKED, observedHealthAdapter, alertLifecycleAdapter } from '../../services/api/src/adapters';
import { OWNER_ROLE_ID, STORE_MANAGER_ROLE_ID } from '../../services/api/src/roles';
import { deliverAlerts, OPS_ALERT_WORKER } from '../../services/platform/src/ops-alert-worker';
import {
  raiseObservedAlerts, observedHealthRoutes, BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID as ID, BUILT_IN_RULE_CHANGED_NOTICE,
  type ObservedHealthDeps, type BuiltInRuleState,
} from '../../services/platform/src/observed-health';
import type { AlertLifecycleDeps } from '../../services/platform/src/alert-lifecycle';

/**
 * **Round 35 · M35-FR-04 · verifier r34 NEW-1 (OB-124 (2) "reaches every owner", OB-115 "only the owner changes it") — an
 * owner's edit of the built-in "store computer checks stuck" rule never silently cuts the other owners out, on memory and on
 * PostgreSQL.**
 *
 *   • owner A changes ONLY "answer within" (60 → 30) and sends the rule back exactly as GET showed it: BOTH owners still get
 *     the alert (inbox and phone); the page and the change notice say "every owner (all 2: …)";
 *   • who the rule reaches is filled in by head office from the owner role, never from the edit: an `alsoToUserIds` sent in
 *     the body (empty, or naming the store manager) changes nothing, and the reply says it was not used;
 *   • an owner added later is told; an owner whose role is revoked is not (the role is read when the rules are read);
 *   • the store manager may still save the shop's other rules with the edited built-in rule exactly as GET shows it;
 *   • the owner's REDIRECT to a non-owner (OB-115) is kept, and the page and the notice now say in words that the owners no
 *     longer get it.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const A = 'u-owner-a-r35';
const B = 'u-owner-b-r35';
const C = 'u-owner-c-r35';
const MANAGER = 'u-manager-r35';
const SINCE = new Date(Date.now() - 2 * 3_600_000).toISOString();
const BACKUP_RULE = { alertId: 'backup-to-manager', component: 'backup', firesAt: 'down', ownerUserId: MANAGER, ownerName: 'Manager', ackWithinMinutes: 60 };

function role(userId: string, roleId: string, revoke = false) {
  const at = '2026-10-15T00:00:00.000Z';
  return makeEvent({
    id: `${revoke ? 'revoke' : 'grant'}-${roleId}-${userId}`, type: revoke ? ROLE_REVOKED : 'RoleGranted', occurredAt: at,
    idempotencyKey: `${revoke ? 'revoke' : 'grant'}-${roleId}-${userId}-${randomUUID()}`, source: 'test/r35',
    payload: { userId, roleId, branchScope: 'all', request: { grantId: `${roleId}-${userId}`, userId, roleId, branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: at } },
  });
}
const ctx = (T: string, userId: string, body?: unknown): RequestContext =>
  ({ tenantId: T, userId, branchId: null, params: {}, query: {}, body, traceId: 't', idempotencyKey: `k-${randomUUID()}` }) as unknown as RequestContext;
const route = (routes: readonly Route[], method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
interface Rules { rules: { version: number } | null; builtIn: BuiltInRuleState[] }

async function deliveredTo(deps: ObservedHealthDeps, life: AlertLifecycleDeps, T: string): Promise<string[]> {
  const now = new Date().toISOString();
  await raiseObservedAlerts(deps, T, OPS_ALERT_WORKER, now, { clear: true });
  await deliverAlerts(life, T, OPS_ALERT_WORKER, now, recordingTransport());
  const live = (await life.alerts(T)).filter((a) => a.alert.alertId === ID).at(-1)!;
  return [...new Set(live.deliveries.filter((d) => d.via === 'inbox').map((d) => d.to))].sort();
}

async function anEditKeepsEveryOwner(store: EventStore): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r35');
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
  const get = async (): Promise<Rules> => (await route(routes, 'GET', '/v1/platform/alert-rules').handler(ctx(T, A))).body as Rules;
  const put = (who: string, body: unknown) => route(routes, 'PUT', '/v1/platform/alert-rules').handler(ctx(T, who, body));

  // As the verifier did: owner A changes ONLY "answer within", sending the rule exactly as GET showed it (alsoToUserIds too).
  const shown = (await get()).builtIn[0]!.rule!;
  expect(shown).toMatchObject({ ownerUserId: A, alsoToUserIds: [B] });
  const saved = await put(A, { basedOnVersion: 0, rules: [{ ...shown, ackWithinMinutes: 30 }] });
  expect(saved.body).toMatchObject({ version: 1, ownerNotified: `${A}, ${B}` });
  expect((saved.body as { builtInChanged: string[] }).builtInChanged.join(' ')).toContain(`every owner (all 2: ${A}, ${B})`);
  expect((saved.body as { recipientsFromOwnerRole?: string }).recipientsFromOwnerRole).toContain('was not used');
  let after = (await get()).builtIn[0]!;
  expect(after).toMatchObject({ state: 'edited', rule: { ownerUserId: A, alsoToUserIds: [B], ackWithinMinutes: 30 } });
  expect(after.description).toContain(`every owner (all 2: ${A}, ${B})`);
  expect(after.description).toContain('answered within 30 minutes');
  // Both owners are delivered to — before round 35 only A was.
  expect(await deliveredTo(deps, life, T)).toEqual([A, B]);
  // The change notice tells both owners, and names the real recipients.
  const notice = (await life.alerts(T)).find((a) => a.alert.alertId.startsWith(BUILT_IN_RULE_CHANGED_NOTICE))!;
  expect(notice.alert.alsoToUserIds).toEqual([B]);
  expect(notice.alert.detail).toContain(`every owner (all 2: ${A}, ${B})`);

  // A body that tries to set the recipients is not used: empty, or naming the store manager.
  await put(B, { basedOnVersion: 1, rules: [{ ...shown, ackWithinMinutes: 20, alsoToUserIds: [] }] });
  await put(B, { basedOnVersion: 2, rules: [{ ...shown, ackWithinMinutes: 20, alsoToUserIds: [MANAGER] }] });
  after = (await get()).builtIn[0]!;
  expect(after.rule).toMatchObject({ ownerUserId: A, alsoToUserIds: [B], ackWithinMinutes: 20 });

  // The store manager saves the shop's OTHER rules with the edited built-in rule exactly as GET shows it: not a change, allowed.
  const asShown = (await get()).builtIn[0]!.rule!;
  const mgr = await put(MANAGER, { basedOnVersion: 3, rules: [BACKUP_RULE, asShown] });
  expect(mgr.status).toBe(200);
  expect(mgr.body).toMatchObject({ version: 4, builtInChanged: [] });

  // An owner added later is told; an owner whose role is revoked is not — read from the role, never from the edit.
  await store.append(T, STREAM.identity, role(C, OWNER_ROLE_ID));
  expect((await get()).builtIn[0]!.rule).toMatchObject({ ownerUserId: A, alsoToUserIds: [B, C] });
  await store.append(T, STREAM.identity, role(B, OWNER_ROLE_ID, true));
  expect((await get()).builtIn[0]!.rule).toMatchObject({ ownerUserId: A, alsoToUserIds: [C], ackWithinMinutes: 20 });
  expect((await get()).builtIn[0]!.description).toContain(`every owner (all 2: ${A}, ${C})`);
  // (The alert already open keeps the owners it was raised to — STATUS round 35 says so; its next occurrence takes A and C.)

  // OB-115: the owner may still redirect the rule to somebody who is not an owner — kept, and now said in words.
  const redirect = await put(A, { basedOnVersion: 4, rules: [BACKUP_RULE, { ...asShown, ownerUserId: MANAGER, ownerName: 'Manager', alsoToUserIds: [A, C] }] });
  expect((redirect.body as { builtInChanged: string[] }).builtInChanged.join(' ')).toContain(`${A}, ${C} do NOT get it`);
  after = (await get()).builtIn[0]!;
  expect(after.rule).toMatchObject({ ownerUserId: MANAGER });
  expect(after.rule!.alsoToUserIds).toBeUndefined();
  expect(after.description).toContain(`Manager (${MANAGER}) ONLY`);
  expect(after.description).toContain(`${A}, ${C} do NOT get it`);
  const notices = (await life.alerts(T)).filter((a) => a.alert.alertId.startsWith(BUILT_IN_RULE_CHANGED_NOTICE));
  expect(notices.at(-1)!.alert.detail).toContain(`${A}, ${C} do NOT get it`);
  expect([notices.at(-1)!.alert.ownerUserId, ...(notices.at(-1)!.alert.alsoToUserIds ?? [])]).toEqual([A, C]);
}

describe('round 35 · M35-FR-04 · NEW-1 / OB-124 (2): an owner edit of the built-in alert still reaches every owner (memory)', () => {
  it('M35-FR-04 OB-124 OB-115: recipients come from the owner role, never the edit; a redirect is said in words', async () => {
    await anEditKeepsEveryOwner(new InMemoryEventStore());
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 35 · M35-FR-04 · NEW-1 / OB-124 (2): an owner edit of the built-in alert still reaches every owner (PostgreSQL)', () => {
  it('M35-FR-04 OB-124 OB-115: recipients come from the owner role, never the edit; a redirect is said in words', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    try { await anEditKeepsEveryOwner(new SqlEventStore(pgPoolClient(pool))); } finally { await pool.end(); }
  }, 120_000);
});
