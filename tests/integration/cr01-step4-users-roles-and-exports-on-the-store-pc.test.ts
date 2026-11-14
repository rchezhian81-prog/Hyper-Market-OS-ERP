import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { TEST_IDP } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { aStoreWithRules } from '../support/store-rules';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { createOfficeCentre, CENTRE_WORDS, type OfficeCentreDeps } from '../../edge/store-edge/src/office-centre';
import type { ThisPcApiSettings } from '../../edge/store-edge/src/this-pc-api';

/**
 * **CR-01 step 4 (OI-06 · OI-07) — Users & roles and exports on the store PC, against the REAL API, on the in-memory store
 * AND on PostgreSQL.** Every call is the one the store PC's Office centre makes: as the person signed in to the office
 * screens, after their own PIN was typed again for the act, with the token the store PC makes (pin + swk). Made-up data.
 *
 *   add a person    the manager asks the cashier role for a NEW staff ID at this store → it waits; the manager cannot
 *                   approve their own request; the owner approves it → the new person holds the role here
 *   OB-95           the IT administrator can never also be given a shop role — refused by the API, words shown
 *   own access      nobody asks a role for themselves
 *   a leaver        the manager asks → the owner decides on the page → the manager applies → the role is gone
 *   their PIN       the new person sets their own first PIN on the page (a reset of an existing PIN is refused)
 *   export          the owner exports products: in his name, logged by the API, Excel-safe
 */

const backings = r3OpsBackings();
const OWNER = 'owner-01';
const MANAGER = 'store-manager-01';
const IT = 'it-admin-01';
const NEW = 'cashier-07';
const STORE = 'SRE-T1';
const PINS: Record<string, string> = { [OWNER]: '111111', [MANAGER]: '222222', [IT]: '444444' };
const ROLE_OF: Record<string, string> = { [OWNER]: 'owner', [MANAGER]: 'store_manager', [IT]: 'platform_admin' };

/** The store PC's own fetch, answered in-process by the API (token, body and idempotency key carried as sent). */
function apiFetch(get: () => ApiHarness): typeof globalThis.fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const headers = new Headers(init?.headers);
    const r = await get().raw({
      method: (init?.method ?? 'GET') as 'GET', path: u.pathname,
      ...(u.search === '' ? {} : { query: Object.fromEntries(u.searchParams) }),
      token: String(headers.get('authorization')).replace(/^Bearer /, ''),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      ...(headers.get('idempotency-key') === null ? {} : { idempotencyKey: headers.get('idempotency-key')! }),
    });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
}

describe.each(backings)('Users & roles and exports on the store PC — on $name (CR-01 step 4)', ({ harness }) => {
  it('a new person is added by two people; OB-95 holds; a leaver goes through approval; their own PIN; an export', async () => {
    const h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await aStoreWithRules(h, T, OWNER, STORE, 0);
    await h.provisionRole(T, MANAGER, 'store_manager');
    await h.provisionRole(T, IT, 'platform_admin');
    const { req } = tenantClient(() => h, T);
    const policy = TEST_IDP.policy();
    const api: ThisPcApiSettings = { apiBase: 'http://127.0.0.1:8081', tenantId: T, policy: { secret: policy.secret, issuer: policy.issuer, audience: policy.audience } };
    const log: Record<string, unknown>[] = [];
    const pinHolders = new Set([OWNER, MANAGER, IT]);
    const setPins: string[] = [];
    let n = 0;
    const deps: OfficeCentreDeps = {
      api, fetch: apiFetch(() => h), now: () => Date.now(), storeId: STORE,
      verifyPin: async (u, p) => (PINS[u] === p ? 'ok' : 'wrong'),
      pinHolders: async () => pinHolders,
      setPin: async (u) => { setPins.push(u); pinHolders.add(u); return { ok: true, lines: [] }; },
      permissionsOf: (u) => ROLE_CATALOGUE.find((r) => r.id === ROLE_OF[u])?.permissions ?? [],
      append: async (e) => { log.push(e); },
      newId: (p) => `${p}-${(n += 1)}-${randomUUID().slice(0, 8)}`,
    };
    const centre = createOfficeCentre(deps);
    // Signed in to the office screens twenty minutes ago — past the API's five-minute step-up. Each act still works,
    // because the act's own PIN is typed now; nothing borrows the old sign-in.
    const signedInAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const owner = { userId: OWNER, signedInAt };
    const manager = { userId: MANAGER, signedInAt };

    // ── add a person: asked by the manager, at this store only ──────────────────────────────────────────────────
    const asked = await centre.peopleAct(manager, { act: 'give', pin: PINS[MANAGER], userId: NEW, name: 'Test Person', roleId: 'cashier', reason: 'new cashier' });
    expect(asked.json, JSON.stringify(asked.json)).toMatchObject({ ok: true, en: CENTRE_WORDS.asked.en });
    const pending = (await centre.peopleState(owner)).json['pending'] as { grantId: string; userId: string; requestedBy: string; branchScope: unknown }[];
    const mine = pending.find((p) => p.userId === NEW)!;
    expect(mine).toMatchObject({ requestedBy: MANAGER, branchScope: [STORE] });
    // Not given yet: the new person holds nothing.
    expect(((await centre.peopleState(owner)).json['people'] as { userId: string }[]).some((p) => p.userId === NEW)).toBe(false);

    // ── nobody asks for themselves; the manager may not approve (only the owner holds identity.role.grant) ──────────
    const self = await centre.peopleAct(owner, { act: 'give', pin: PINS[OWNER], userId: OWNER, name: 'Owner', roleId: 'cashier', reason: 'x' });
    expect(self.json['en']).toBe(CENTRE_WORDS.yourself.en);
    const notManager = await centre.peopleAct(manager, { act: 'approve', pin: PINS[MANAGER], grantId: mine.grantId });
    expect(notManager.json['ok']).toBe(false);

    // ── a wrong PIN reaches nothing ──────────────────────────────────────────────────────────────────────────────
    expect((await centre.peopleAct(owner, { act: 'approve', pin: '000000', grantId: mine.grantId })).status).toBe(401);

    // ── the owner approves: the new person holds the cashier role at this store ──────────────────────────────────
    const ok = await centre.peopleAct(owner, { act: 'approve', pin: PINS[OWNER], grantId: mine.grantId });
    expect(ok.json, JSON.stringify(ok.json)).toMatchObject({ ok: true, en: CENTRE_WORDS.approved.en });
    const people = (await centre.peopleState(owner)).json['people'] as { userId: string; grants: { roleId: string }[]; hasPin: boolean }[];
    expect(people.find((p) => p.userId === NEW)).toMatchObject({ grants: [{ roleId: 'cashier' }], hasPin: false });
    // Head office's audit trail names who asked and who approved (§28).
    const trail = (await req('GET', '/v1/audit/trail', undefined, OWNER)).body as { matches: { action: string; objectId: string; actorId: string; after?: Record<string, unknown> | null }[] };
    expect(trail.matches.some((e) => e.action === 'role.grant.request' && e.objectId === NEW && e.actorId === MANAGER)).toBe(true);
    expect(trail.matches.some((e) => e.action === 'role.grant' && e.objectId === NEW && e.actorId === OWNER)).toBe(true);

    // ── their own first PIN; a second time (a reset) is refused ───────────────────────────────────────────────────
    expect((await centre.peopleAct(manager, { act: 'set-pin', pin: PINS[MANAGER], userId: NEW, newPin: '583920', newPinAgain: '583920' })).json['en']).toBe(CENTRE_WORDS.pinSet.en);
    expect((await centre.peopleAct(manager, { act: 'set-pin', pin: PINS[MANAGER], userId: NEW, newPin: '583921', newPinAgain: '583921' })).json['en']).toBe(CENTRE_WORDS.pinAlready.en);
    expect(setPins).toEqual([NEW]);

    // ── OB-95: the IT administrator is never given a shop role ───────────────────────────────────────────────────
    const it95 = await centre.peopleAct(manager, { act: 'give', pin: PINS[MANAGER], userId: IT, name: 'IT Person', roleId: 'cashier', reason: 'help at the till' });
    expect(it95.json['ok']).toBe(false);
    expect(String(it95.json['en'])).toContain('OB-95');

    // ── a leaver: asked by the manager, decided by the owner on the page, applied by the manager ─────────────────
    const leave = await centre.peopleAct(manager, { act: 'leaver', pin: PINS[MANAGER], userId: NEW, reason: 'left the shop' });
    expect(leave.json, JSON.stringify(leave.json)).toMatchObject({ ok: true });
    const toDecide = (await centre.peopleState(owner)).json['toDecide'] as { requestId: string; kind: string }[];
    const change = toDecide.find((c) => c.kind === 'access_change')!;
    expect(change).toBeDefined();
    const decided = await centre.peopleAct(owner, { act: 'decide-change', pin: PINS[OWNER], requestId: change.requestId, decision: 'approved', reason: 'confirmed' });
    expect(decided.json, JSON.stringify(decided.json)).toMatchObject({ ok: true });
    const applied = await centre.peopleAct(manager, { act: 'apply', pin: PINS[MANAGER], requestId: change.requestId });
    expect(applied.json, JSON.stringify(applied.json)).toMatchObject({ ok: true, en: CENTRE_WORDS.applied.en });
    const after = (await centre.peopleState(owner)).json['people'] as { userId: string }[];
    expect(after.some((p) => p.userId === NEW)).toBe(false);

    // ── export: in the owner's name, logged by the API, Excel-safe ───────────────────────────────────────────────
    const ex = await centre.ioExport(owner, { domain: 'products', pin: PINS[OWNER] });
    expect(ex.json, JSON.stringify(ex.json).slice(0, 300)).toMatchObject({ ok: true });
    expect(String(ex.json['csv']).startsWith('﻿')).toBe(true);
    const exports = ((await req('GET', '/v1/exports', undefined, OWNER)).body as { exports: { userId: string; domain: string }[] }).exports;
    expect(exports.some((e) => e.userId === OWNER && e.domain === 'products')).toBe(true);
    expect((await centre.ioState(owner)).json['domains']).toEqual(expect.arrayContaining([expect.objectContaining({ domain: 'products' })]));

    // ── every act and refusal written down on this PC; never a PIN ───────────────────────────────────────────────
    expect(log.length).toBeGreaterThan(10);
    for (const pin of [...Object.values(PINS), '583920']) expect(JSON.stringify(log)).not.toContain(pin);
  });
});
