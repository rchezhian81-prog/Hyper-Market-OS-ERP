import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, observedHealthAdapter, alertLifecycleAdapter } from '../../services/api/src/adapters';
import { observedHealthRoutes, BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID as ID, BUILT_IN_STORE_COMPUTER_CLOCK_RULE_ID as CLOCK_ID, BUILT_IN_RULE_CHANGED_NOTICE, type ObservedHealthDeps } from '../../services/platform/src/observed-health';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import { apiHarness, TEST_PACK_KEY } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **Round 33 · owner decision OB-120 "A" (15 Oct 2026, in writing, "Refuse the second save"; verifier r32 NEW-3, probe
 * zz-v32-alerts A3; hard rule 10)** — a save of the alert rules says which version of the rules it was based on
 * (`basedOnVersion` in the body: `rules.version` from GET /v1/platform/alert-rules, 0 when none are saved yet).
 *
 *   • a save without it is refused by name (428 `alert_rules_save_needs_based_on_version`) — there is no older client to keep:
 *     no page or script in the repository saves the alert rules (apps/, scripts/, edge/ checked by a guard below);
 *   • a save based on a version that is no longer the one in force is refused by name (409 `alert_rules_changed_since_you_looked`,
 *     "Someone else just changed these rules — look again and resend"), nothing saved;
 *   • two saves at the same moment, both based on the same version: the append is CONDITIONAL on the rules' write guard, so
 *     exactly one is kept (200) and the other is refused (409) — never two "saved" answers with one silently dropped. Proved
 *     with both saves held until each has read the rules in force (the window the verifier's race used), on memory and on
 *     PostgreSQL, and on the served API on PostgreSQL with the 409 read back from audit_log;
 *   • the owner's notice of a built-in rule change matches what is stored: it is raised only by the save that was kept.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner-r33c';
const IT = 'u-it-r33c';
const HO = 'u-ho-r33c';
const PATH = '/v1/platform/alert-rules';
const BACKUP_RULE = { alertId: 'backup-to-ho', component: 'backup', firesAt: 'down', ownerUserId: HO, ownerName: 'Head office', ackWithinMinutes: 60 };
const err = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
interface Rules { rules: { version: number; definedBy: string; builtInOff?: string[] } | null; builtIn: { alertId: string; state: string }[] }

type Send = (userId: string, method: 'GET' | 'PUT', body?: unknown, key?: string) => Promise<{ status: number; body: unknown; key: string; headers?: Record<string, string> }>;

/** The refusals and the replay, through the real pipeline. Returns the idempotency keys of the refused saves. */
async function versions(send: Send): Promise<string[]> {
  const refused: string[] = [];
  const get = async (): Promise<Rules> => (await send(OWNER, 'GET')).body as Rules;
  // No version: refused by name, nothing saved.
  const none = await send(HO, 'PUT', { rules: [BACKUP_RULE] });
  expect([none.status, err(none)]).toEqual([428, 'alert_rules_save_needs_based_on_version']);
  expect(JSON.stringify(none.body)).toMatch(/must say which version of the rules it was based on \(basedOnVersion/);
  refused.push(none.key);
  for (const bad of ['0', -1, 1.5, null]) {
    const r = await send(HO, 'PUT', { rules: [BACKUP_RULE], basedOnVersion: bad });
    expect([r.status, err(r)], JSON.stringify(bad)).toEqual([400, 'alert_rules_not_readable']);
  }
  expect((await get()).rules).toBeNull();
  // A first save is based on 0.
  const first = await send(HO, 'PUT', { rules: [BACKUP_RULE], basedOnVersion: 0 });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body).toMatchObject({ version: 1 });
  // A re-send of the SAME request (same idempotency key) is the same save — answered with the first result, nothing added.
  const again = await send(HO, 'PUT', { rules: [BACKUP_RULE], basedOnVersion: 0 }, first.key);
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ version: 1 });
  expect((await get()).rules).toMatchObject({ version: 1, definedBy: HO });
  // A save still based on 0 (someone who read before the first save) is refused by name, nothing saved.
  const stale = await send(OWNER, 'PUT', { rules: [{ ...BACKUP_RULE, ackWithinMinutes: 15 }], basedOnVersion: 0 });
  expect([stale.status, err(stale)]).toEqual([409, 'alert_rules_changed_since_you_looked']);
  expect(JSON.stringify(stale.body)).toMatch(/Someone else just changed these rules — look again and resend\. This save was based on version 0, but the rules in force are now version 1, saved by u-ho-r33c/);
  refused.push(stale.key);
  // A save "from the future" is refused the same way.
  const ahead = await send(OWNER, 'PUT', { rules: [BACKUP_RULE], basedOnVersion: 7 });
  expect([ahead.status, err(ahead)]).toEqual([409, 'alert_rules_changed_since_you_looked']);
  expect((await get()).rules).toMatchObject({ version: 1, definedBy: HO });
  // Looked again and resent: kept.
  const resent = await send(OWNER, 'PUT', { rules: [{ ...BACKUP_RULE, ackWithinMinutes: 15 }], basedOnVersion: 1 });
  expect(resent.status).toBe(200);
  expect((await get()).rules).toMatchObject({ version: 2, definedBy: OWNER });
  return refused;
}

/**
 * The verifier's race (A3), with the window held open: the owner has turned the built-in rule OFF (version `v`); then IT saves
 * the backup rule and the owner turns the built-in rule back ON — both based on version `v`, both held until each has read the
 * rules in force. Exactly one is kept; the other is refused by name; the stored state and the owner's notice agree.
 */
async function heldRace(store: EventStore, T: string): Promise<{ statuses: number[]; winner: string }> {
  const now = () => new Date().toISOString();
  const base = observedHealthAdapter({ store, now });
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  let holding = false;
  const deps: ObservedHealthDeps = {
    ...base,
    alertRules: async (t) => {
      const r = await base.alertRules(t);
      if (holding) { reads += 1; if (reads === 2) release(); await bothRead; }
      return r;
    },
  };
  const put = (routes: readonly Route[]) => routes.find((r) => r.method === 'PUT' && r.path === PATH)!;
  const ctx = (userId: string, body: unknown): RequestContext => ({ tenantId: T, userId, branchId: null, scope: 'all', params: {}, query: {}, body, idempotencyKey: `k-${randomUUID()}`, traceId: 't' });
  const call = async (userId: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    try { return await put(observedHealthRoutes(deps)).handler(ctx(userId, body)); } catch (e) { const x = e as { status?: number; body?: unknown }; if (x.status === undefined) throw e; return { status: x.status, body: { error: x.body } }; }
  };
  const off = await call(OWNER, { rules: [BACKUP_RULE], builtInOff: [ID], basedOnVersion: (await base.alertRules(T))?.version ?? 0 });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  const v = (await base.alertRules(T))!.version;
  holding = true;
  const [it, own] = await Promise.all([
    call(IT, { rules: [{ ...BACKUP_RULE, ackWithinMinutes: 45 }], basedOnVersion: v }),
    call(OWNER, { rules: [BACKUP_RULE], builtInOff: [], basedOnVersion: v }),
  ]);
  holding = false;
  const statuses = [it.status, own.status].sort();
  expect(statuses, JSON.stringify([it.body, own.body])).toEqual([200, 409]);
  const loser = it.status === 409 ? it : own;
  expect(err(loser)).toBe('alert_rules_changed_since_you_looked');
  const stored = (await base.alertRules(T))!;
  expect(stored.version).toBe(v + 1);
  const winner = it.status === 200 ? IT : OWNER;
  expect(stored.definedBy).toBe(winner);
  expect((it.status === 200 ? it : own).body).toMatchObject({ version: stored.version });
  // What is stored is what the kept save said; the owner's notice exists only for a kept built-in change, and says so.
  const alerts = await alertLifecycleAdapter({ store, now }).alerts(T);
  const notice = alerts.find((a) => a.alert.alertId === `${BUILT_IN_RULE_CHANGED_NOTICE}:v${stored.version}`);
  if (winner === OWNER) {
    expect(stored.builtInOff ?? []).toEqual([]);
    expect(own.body).toMatchObject({ builtIn: [expect.objectContaining({ alertId: ID, state: 'on' }), expect.objectContaining({ alertId: CLOCK_ID, state: 'on' })], ownerNotified: OWNER });
    expect(notice?.alert.detail).toMatch(new RegExp(`Now: ${ID} is on`));
  } else {
    expect(stored.builtInOff).toEqual([ID]);
    expect(notice).toBeUndefined();
  }
  // Exactly one rules event per version (no second, silently deduped save under the same version).
  const kept = await store.readStream(T, streamName(STREAM.platform, 'alert-rules'), { type: 'AlertRulesDefined' });
  expect(kept.filter((e) => (e.event.payload as { version: number }).version === v + 1)).toHaveLength(1);
  return { statuses, winner };
}

async function provision(store: EventStore, T: string): Promise<void> {
  const at = new Date().toISOString();
  await store.append(T, STREAM.identity, makeEvent({
    id: `grant-owner-${T}`, type: 'RoleGranted', occurredAt: at, idempotencyKey: `grant-${T}-owner-${OWNER}`, source: 'test/r33c',
    payload: { userId: OWNER, roleId: 'owner', branchScope: 'all', request: { grantId: `owner-${OWNER}`, userId: OWNER, roleId: 'owner', branchScope: 'all', requestedBy: 'operator', approvedBy: 'operator', requestedAt: at } },
  }));
}

describe('round 33 · OB-120: an alert-rules save carries the version it was based on (memory, the real pipeline)', () => {
  it('no version refused (428), a stale one refused (409), a re-send is the same save, a fresh one kept', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await h.provisionOwner(T, OWNER);
    await h.provisionRole(T, HO, 'store_manager', 'all');
    const send: Send = async (userId, method, body, key = `k-${randomUUID()}`) => {
      const r = await h.request({ method, path: PATH, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key }) });
      return { status: r.status, body: r.body, key };
    };
    await versions(send);
  }, 60_000);

  it('two saves held open together (memory store): exactly one 200, one 409; the stored state and the notice agree', async () => {
    const winners = new Set<string>();
    for (let k = 0; k < 6; k += 1) {
      const store = new InMemoryEventStore();
      const T = randomUUID();
      await provision(store, T);
      winners.add((await heldRace(store, T)).winner);
    }
    expect(winners.size).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe('round 33 · OB-120: every caller in the repository sends the version (guard)', () => {
  it('no page, script or store computer saves the alert rules without basedOnVersion', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx|js|mjs|html)$/.test(name)) continue;
        const text = readFileSync(p, 'utf8');
        if (text.includes('/v1/platform/alert-rules') && !text.includes('basedOnVersion')) hits.push(p);
      }
    };
    for (const d of ['apps', 'scripts', 'edge', 'db/seed']) walk(d);
    expect(hits).toEqual([]);
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 33 · OB-120: the same on PostgreSQL (conditional append; served API and audit_log)', () => {
  const clouds: RealCloud[] = [];
  afterAll(async () => { for (const c of clouds) await c.stop(); });

  it('two saves held open together on PostgreSQL: exactly one 200, one 409, stored version = the 200\'s, the notice agrees', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
    try {
      for (let k = 0; k < 4; k += 1) {
        const T = randomUUID();
        const store = new SqlEventStore(pgPoolClient(pool));
        await store.registerTenant(T, 'tests/r33c');
        await provision(store, T);
        await heldRace(store, T);
      }
    } finally { await pool.end(); }
  }, 180_000);

  it('the served API: the refusals are on the audit trail; two saves sent together give one 200 and one 409', async () => {
    const tenantId = randomUUID();
    const cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: TEST_PACK_KEY, providers: { opsAlertWorkerIntervalMs: 3_600_000 } });
    clouds.push(cloud);
    const platform = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    try {
      await new SqlEventStore(pgPoolClient(platform)).append(tenantId, STREAM.identity, makeEvent({
        id: `grant-it-${tenantId}`, type: 'RoleGranted', occurredAt: new Date().toISOString(), idempotencyKey: `grant-${tenantId}-platform_admin-${IT}`, source: 'test/r33c',
        payload: { userId: IT, roleId: 'platform_admin', branchScope: 'all', request: { grantId: `platform_admin-${IT}`, userId: IT, roleId: 'platform_admin', branchScope: 'all', requestedBy: 'operator', approvedBy: 'operator', requestedAt: new Date().toISOString() } },
      }));
      await cloud.grant(HO, 'store_manager');
      const send: Send = async (userId, method, body, key = `k-${randomUUID()}`) => {
        const r = await cloud.request({ method, path: PATH, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key }) });
        return { status: r.status, body: r.body, key };
      };
      const refused = await versions(send);
      // Two saves sent at the same moment, both based on the version in force: one kept, one refused by name.
      const races: string[] = [];
      for (let k = 0; k < 5; k += 1) {
        const v = ((await send(OWNER, 'GET')).body as Rules).rules!.version;
        const [a, b] = await Promise.all([
          send(IT, 'PUT', { rules: [{ ...BACKUP_RULE, ackWithinMinutes: 40 + k }], basedOnVersion: v }),
          send(OWNER, 'PUT', { rules: [{ ...BACKUP_RULE, ackWithinMinutes: 20 + k }], basedOnVersion: v }),
        ]);
        expect([a.status, b.status].sort(), JSON.stringify([a.body, b.body])).toEqual([200, 409]);
        const kept = a.status === 200 ? a : b;
        const lost = a.status === 409 ? a : b;
        expect(err(lost)).toBe('alert_rules_changed_since_you_looked');
        races.push(lost.key);
        const now = ((await send(OWNER, 'GET')).body as Rules).rules!;
        expect(now.version).toBe(v + 1);
        expect(now).toMatchObject({ version: (kept.body as { version: number }).version, definedBy: kept === a ? IT : OWNER });
      }
      const audit = await platform.query<{ status: number; idempotency_key: string }>(
        'SELECT status, idempotency_key FROM audit_log WHERE tenant_id = $1 AND path = $2 AND method = $3 AND idempotency_key = ANY($4::text[])', [tenantId, PATH, 'PUT', [...refused, ...races]]);
      const byKey = new Map(audit.rows.map((r) => [r.idempotency_key, r.status]));
      expect(byKey.get(refused[0]!)).toBe(428);
      for (const key of [refused[1]!, ...races]) expect(byKey.get(key), key).toBe(409);
    } finally { await platform.end(); }
  }, 300_000);
});
