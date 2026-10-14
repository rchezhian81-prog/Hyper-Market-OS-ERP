import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { recordingTransport } from '../../packages/notifications/src/index';
import { STREAM, observedHealthAdapter, alertLifecycleAdapter } from '../../services/api/src/adapters';
import { deliverAlerts } from '../../services/platform/src/ops-alert-worker';
import { BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID as ID, BUILT_IN_RULE_CHANGED_NOTICE } from '../../services/platform/src/observed-health';
import { STORE_COMPUTER_CHECKS_STUCK_COMPONENT } from '../../services/platform/src/box-health';
import { apiHarness, TEST_PACK_KEY } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **Round 32 · owner decision OB-115 "A" (14 Oct 2026, in writing, "Only you"; verifier r31 NEW-1, probe zz-v31-builtin-off) —
 * only the shop's owner may turn off, edit or re-point a built-in alert rule; every change he makes is also sent to him.**
 * Through the real API (the pipeline, its permission checks and — on PostgreSQL — the served API with its audit trail):
 *
 *   • the IT/platform administrator is REFUSED by name (403 `built_in_alert_rule_refused_to_platform_administrator`) when
 *     turning it off, re-pointing it to himself, or removing the owner's edit — nothing changes, the refusal is in audit_log;
 *   • head office business staff (all stores) are refused too (403 `built_in_alert_rule_owner_only`), but may still save the
 *     shop's OTHER rules when each built-in rule is sent as it stands;
 *   • an edit naming a component that cannot fire for it (a misspelt one, or "ok") is refused even from the owner (400);
 *   • the owner's change is kept as a rules version naming him, shown on GET (who last changed it, when) whoever saves next,
 *     and SENT TO HIM: a notice in his inbox at once, and to his phone when a message provider is set;
 *   • a rule left off is kept off by a later save that leaves builtInOff out — and that save's reply says so in words.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner-r32';
const IT = 'u-it-r32';
const HO = 'u-ho-r32';
const PATH = '/v1/platform/alert-rules';

type Send = (userId: string, method: 'GET' | 'PUT', body?: unknown) => Promise<{ status: number; body: unknown; key: string }>;
interface Rules { rules: { version: number; definedBy: string; builtInOff?: string[] } | null; builtIn: { alertId: string; state: string; rule?: { ownerUserId: string }; lastChangedBy?: string; lastChangedAt?: string }[] }
const err = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;

const BACKUP_RULE = { alertId: 'backup-to-ho', component: 'backup', firesAt: 'down', ownerUserId: HO, ownerName: 'Head office', ackWithinMinutes: 60 };
const edit = (ownerUserId: string, more: Record<string, unknown> = {}) => ({ alertId: ID, component: STORE_COMPUTER_CHECKS_STUCK_COMPONENT, firesAt: 'down', ownerUserId, ownerName: ownerUserId, ackWithinMinutes: 30, ...more });

/** The whole story, through `send` (the real pipeline). Returns the idempotency keys of the IT administrator's refused saves. */
async function onlyTheOwner(send: Send, inbox: () => Promise<{ alertId: string; detail: string }[]>): Promise<string[]> {
  const get = async (): Promise<Rules> => (await send(OWNER, 'GET')).body as Rules;
  expect((await get()).builtIn).toEqual([expect.objectContaining({ alertId: ID, state: 'on', rule: expect.objectContaining({ ownerUserId: OWNER }) })]);
  const refusedKeys: string[] = [];

  // The IT administrator: turn it off, re-point it to himself — refused by name, nothing changes.
  for (const body of [{ rules: [], builtInOff: [ID] }, { rules: [edit(IT, { ackWithinMinutes: 10_000 })], builtInOff: [] }, { rules: [edit(IT)] }]) {
    const r = await send(IT, 'PUT', body);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(err(r)).toBe('built_in_alert_rule_refused_to_platform_administrator');
    expect(JSON.stringify(r.body)).toMatch(/Only the shop's owner may turn off, edit or re-point a built-in alert rule \(owner decision OB-115\)/);
    refusedKeys.push(r.key);
  }
  expect((await get()).rules).toBeNull();
  expect((await get()).builtIn[0]).toMatchObject({ state: 'on', rule: { ownerUserId: OWNER } });

  // Head office business staff (all stores): refused for the built-in rule, allowed for the shop's other rules.
  const ho = await send(HO, 'PUT', { rules: [BACKUP_RULE], builtInOff: [ID] });
  expect([ho.status, err(ho)]).toEqual([403, 'built_in_alert_rule_owner_only']);
  const hoOwn = await send(HO, 'PUT', { rules: [BACKUP_RULE] });
  expect(hoOwn.status, JSON.stringify(hoOwn.body)).toBe(200);
  expect(hoOwn.body).toMatchObject({ version: 1, builtInChanged: [], builtIn: [expect.objectContaining({ state: 'on' })] });
  expect(hoOwn.body).not.toHaveProperty('ownerNotified');

  // Even the owner cannot make it an edit that can never fire.
  for (const bad of [edit(OWNER, { component: 'store_computer_checks_stuk' }), edit(OWNER, { firesAt: 'ok' }), edit(OWNER, { branchId: 'S1' })]) {
    const r = await send(OWNER, 'PUT', { rules: [BACKUP_RULE, bad] });
    expect([r.status, err(r)], JSON.stringify(bad)).toEqual([400, 'built_in_alert_rule_cannot_fire']);
  }

  // The owner turns it off: kept, named, and sent to him (his inbox at once).
  const off = await send(OWNER, 'PUT', { rules: [BACKUP_RULE], builtInOff: [ID] });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(off.body).toMatchObject({ version: 2, builtInOff: [ID], builtInChanged: [`turned ${ID} OFF`], ownerNotified: OWNER, builtIn: [expect.objectContaining({ state: 'off', lastChangedBy: OWNER })] });
  const v2 = await get();
  expect(v2.builtIn[0]).toMatchObject({ state: 'off', lastChangedBy: OWNER });
  const notices = (await inbox()).filter((a) => a.alertId.startsWith(BUILT_IN_RULE_CHANGED_NOTICE));
  expect(notices.map((a) => a.alertId)).toEqual([`${BUILT_IN_RULE_CHANGED_NOTICE}:v2`]);
  expect(notices[0]!.detail).toMatch(new RegExp(`a built-in alert rule was changed by ${OWNER} at .* \\(rules version 2\\): turned ${ID} OFF\\. Now: ${ID} is off`));

  // Head office saves its rules later without naming builtInOff: allowed (not a change), it STAYS off — and the reply says so.
  const later = await send(HO, 'PUT', { rules: [{ ...BACKUP_RULE, ackWithinMinutes: 45 }] });
  expect(later.status).toBe(200);
  expect(later.body).toMatchObject({ version: 3, builtInOff: [ID], builtInChanged: [] });
  expect((later.body as { builtInStillOff: string }).builtInStillOff).toMatch(new RegExp(`${ID} is still TURNED OFF \\(by ${OWNER} at .*\\) — only the owner can turn it back on`));
  const v3 = await get();
  expect(v3.rules).toMatchObject({ version: 3, definedBy: HO });
  expect(v3.builtIn[0]).toMatchObject({ state: 'off', lastChangedBy: OWNER }); // who changed it is still shown, whoever saved last
  // Turning it back on is the owner's too.
  expect(err(await send(HO, 'PUT', { rules: [BACKUP_RULE], builtInOff: [] }))).toBe('built_in_alert_rule_owner_only');
  expect(err(await send(IT, 'PUT', { rules: [BACKUP_RULE], builtInOff: [] }))).toBe('built_in_alert_rule_refused_to_platform_administrator');

  // The owner turns it back on with his own edit (to head office, 30 minutes): a second notice.
  const on = await send(OWNER, 'PUT', { rules: [BACKUP_RULE, edit(HO)], builtInOff: [] });
  expect(on.status).toBe(200);
  expect(on.body).toMatchObject({ version: 4, builtInChanged: [`turned ${ID} back on`, expect.stringMatching(new RegExp(`^edited ${ID}: it would go to ${HO}`))], ownerNotified: OWNER });
  expect((await get()).builtIn[0]).toMatchObject({ state: 'edited', rule: { ownerUserId: HO }, lastChangedBy: OWNER });
  expect((await inbox()).filter((a) => a.alertId.startsWith(BUILT_IN_RULE_CHANGED_NOTICE)).map((a) => a.alertId).sort()).toEqual([`${BUILT_IN_RULE_CHANGED_NOTICE}:v2`, `${BUILT_IN_RULE_CHANGED_NOTICE}:v4`]);

  // Anyone with alert rights may save the other rules when the owner's edit is sent exactly as it stands…
  const keep = await send(IT, 'PUT', { rules: [BACKUP_RULE, edit(HO)] });
  expect(keep.status, JSON.stringify(keep.body)).toBe(200);
  expect(keep.body).toMatchObject({ version: 5, builtInChanged: [] });
  // …but leaving it out (removing the owner's edit) or changing it is a change: refused.
  for (const body of [{ rules: [BACKUP_RULE] }, { rules: [BACKUP_RULE, edit(IT)] }]) {
    const r = await send(IT, 'PUT', body);
    expect(err(r)).toBe('built_in_alert_rule_refused_to_platform_administrator');
    refusedKeys.push(r.key);
  }
  expect((await get()).builtIn[0]).toMatchObject({ state: 'edited', rule: { ownerUserId: HO } });
  return refusedKeys;
}

describe('round 32 · OB-115: only the owner changes a built-in alert rule (memory, the real pipeline)', () => {
  it('IT refused by name, head office refused, an edit that cannot fire refused; the owner\'s changes kept, shown, and sent to him (inbox and phone)', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await h.provisionOwner(T, OWNER);
    await h.provisionRole(T, IT, 'platform_admin', 'all');
    await h.provisionRole(T, HO, 'store_manager', 'all');
    const send: Send = async (userId, method, body) => {
      const key = `k-${randomUUID()}`;
      const r = await h.request({ method, path: PATH, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key }) });
      return { status: r.status, body: r.body, key };
    };
    const inbox = async () => ((await h.request({ method: 'GET', path: '/v1/platform/alerts/inbox', userId: OWNER, tenantId: T })).body as { alerts: { alert: { alertId: string; detail: string } }[] }).alerts.map((a) => a.alert);
    await onlyTheOwner(send, inbox);
    // The ops-alert worker's delivery step sends each notice to the owner's phone when a message provider is set.
    const transport = recordingTransport();
    const now = () => new Date().toISOString();
    await deliverAlerts({ ...alertLifecycleAdapter({ store: h.store, now }), ...observedHealthAdapter({ store: h.store, now }) } as never, T, 'system:ops-alert-worker', now(), transport);
    expect(transport.sent.filter((m) => m.customerId === OWNER && /a built-in alert rule was changed by u-owner-r32/.test(m.text))).toHaveLength(2);
  }, 120_000);
});

describe.skipIf(DATABASE_URL === undefined)('round 32 · OB-115: only the owner changes a built-in alert rule (PostgreSQL, the served API, audit_log)', () => {
  const clouds: RealCloud[] = [];
  afterAll(async () => { for (const c of clouds) await c.stop(); });

  it('the same story on the served API; every refusal of the IT administrator is in audit_log as a 403; the notices reach his phone', async () => {
    const tenantId = randomUUID();
    const transport = recordingTransport();
    const cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: TEST_PACK_KEY, providers: { notificationTransport: transport, opsAlertWorkerIntervalMs: 200 } });
    clouds.push(cloud);
    const platform = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    try {
      // The IT administrator's grant, laid down as the operator's provisioning does (the platform role, all stores).
      await new SqlEventStore(pgPoolClient(platform)).append(tenantId, STREAM.identity, makeEvent({
        id: `grant-it-${tenantId}`, type: 'RoleGranted', occurredAt: new Date().toISOString(), idempotencyKey: `grant-${tenantId}-platform_admin-${IT}`, source: 'test/r32',
        payload: { userId: IT, roleId: 'platform_admin', branchScope: 'all', request: { grantId: `platform_admin-${IT}`, userId: IT, roleId: 'platform_admin', branchScope: 'all', requestedBy: 'operator', approvedBy: 'operator', requestedAt: new Date().toISOString() } },
      }));
      await cloud.grant(HO, 'store_manager');
      const send: Send = async (userId, method, body) => {
        const key = `k-${randomUUID()}`;
        const r = await cloud.request({ method, path: PATH, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key }) });
        return { status: r.status, body: r.body, key };
      };
      const inbox = async () => ((await cloud.request({ method: 'GET', path: '/v1/platform/alerts/inbox', userId: OWNER })).body as { alerts: { alert: { alertId: string; detail: string } }[] }).alerts.map((a) => a.alert);
      const refused = await onlyTheOwner(send, inbox);
      // Each of the IT administrator's refused saves is on the audit trail: who, what, 403 (read back from audit_log).
      const audit = await platform.query<{ status: number; permission: string; idempotency_key: string }>(
        'SELECT status, permission, idempotency_key FROM audit_log WHERE tenant_id = $1 AND user_id = $2 AND path = $3 AND method = $4 ORDER BY seq', [tenantId, IT, PATH, 'PUT']);
      const byKey = new Map(audit.rows.map((r) => [r.idempotency_key, r]));
      for (const key of refused) expect(byKey.get(key), key).toMatchObject({ status: 403, permission: 'platform.alert.manage' });
      // The owner's two notices reach his phone by the ops-alert worker running on its own timer (bounded wait).
      const deadline = Date.now() + 60_000;
      while (transport.sent.filter((m) => m.customerId === OWNER && /a built-in alert rule was changed/.test(m.text)).length < 2) {
        if (Date.now() > deadline) throw new Error(`the notices did not reach the owner's phone: ${JSON.stringify(transport.sent.map((m) => m.customerId))}`);
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
    } finally { await platform.end(); }
  }, 300_000);
});
