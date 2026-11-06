import { describe, it, expect } from 'vitest';
import { InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { findUsageSignals } from '../../packages/integration/src/index';
import {
  addDays, baselineDayOf, daysToRollUp, rollUpSecretUseDay, totalCounts, usageWindowsOf, summariseSecretUse, usageSignalsOf,
  type SecretUseCount,
} from '../../services/platform/src/secret-use';
import {
  secretUseCounter, secretUseCounts, secretUseRollups, secretUseRollupSweep, secretUseRollupStream, secretUseAlertId,
} from '../../services/api/src/w6-secret-use-adapters';
import { alertLifecycleAdapter } from '../../services/api/src/adapters';
import { twoSignatureAdapter } from '../../services/api/src/gates-adapters';
import { apiHarness, TEST_IDP } from '../support/api-harness';
import * as ui from '../../apps/web-erp/src/w5-platform-session';
import type { CredentialUse } from '../../services/kernel/src/index';

// W6 · M32-FR-03 ("abnormal usage alerts") · owner decision OB-688: abnormal secret use is detected from a DURABLE DAILY
// COUNT. These prove the pieces in memory: the roll-up's arithmetic, that a day is judged once and a missed night caught up,
// that "changes sharply" is the usage-signals route's own rule, that only machine credentials are counted, that a count the
// ledger refused is kept and tried again, that the alert goes to the IT custodian with references and counts — and that no
// token, key or secret value is anywhere in what is kept (a guardrail-style scan of every appended event).

const T = 'ab000000-0000-4000-8000-00000000w601';
const c = (over: Partial<SecretUseCount>): SecretUseCount => ({ day: '2026-10-20', credentialRef: 'cred-box-1', callerId: 'box-1', api: 'API-01', calls: 100, errors: 0, ...over });
const use = (over: Partial<CredentialUse>): CredentialUse => ({ tenantId: T, callerId: 'box-1', credentialRef: 'cred-box-1', api: 'API-01', status: 200, at: '2026-10-20T06:00:00.000Z', roleIds: ['store_computer'], ...over });

/** An event store that remembers every event appended to it — the scan "no secret value anywhere" reads. */
function recording(): { store: EventStore; appended: unknown[] } {
  const inner = new InMemoryEventStore();
  const appended: unknown[] = [];
  const store = new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === 'append') return async (t: string, s: string, e: unknown) => { appended.push({ t, s, e }); return target.append(t, s, e as never); };
      if (prop === 'appendBatch') return async (t: string, es: readonly { stream: string; event: unknown }[], o?: unknown) => { appended.push(...es.map((x) => ({ t, ...x }))); return target.appendBatch(t, es as never, o as never); };
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as EventStore;
  return { store, appended };
}

describe('M32-FR-03 · the daily roll-up — pure arithmetic', () => {
  it('sums appended counts per day, credential, caller and API (order does not matter); a day\'s windows are per caller and API', () => {
    const counts = [c({ calls: 40, errors: 1 }), c({ calls: 60, errors: 2 }), c({ credentialRef: 'cred-box-1-new', calls: 5 }), c({ api: 'API-04', calls: 7 }), c({ day: '2026-10-21', calls: 9 })];
    expect(totalCounts(counts).find((x) => x.day === '2026-10-20' && x.api === 'API-01' && x.credentialRef === 'cred-box-1')).toMatchObject({ calls: 100, errors: 3 });
    expect(totalCounts([...counts].reverse())).toEqual(totalCounts(counts));
    // Two credentials of one caller are one window: a re-issued token is not "a new caller" and "a silent one".
    expect(usageWindowsOf(counts, '2026-10-20')).toEqual([
      { identityId: 'box-1', api: 'API-01', calls: 105, errors: 3, onDate: '2026-10-20' },
      { identityId: 'box-1', api: 'API-04', calls: 7, errors: 0, onDate: '2026-10-20' },
    ]);
  });

  it('the baseline is the same weekday a week before; dates move by whole days', () => {
    expect(baselineDayOf('2026-11-04')).toBe('2026-10-28');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(() => addDays('04-11-2026', 1)).toThrow(RangeError);
  });

  it('days to roll up: every finished day since counting began, not yet rolled up — a missed night is caught up, never doubled', () => {
    expect(daysToRollUp({ firstCountedDay: undefined, yesterday: '2026-11-03', rolledUp: new Set() })).toEqual([]);
    expect(daysToRollUp({ firstCountedDay: '2026-11-04', yesterday: '2026-11-03', rolledUp: new Set() })).toEqual([]);
    // The head office was down on the nights of the 1st and 2nd: both are caught up with the 3rd.
    expect(daysToRollUp({ firstCountedDay: '2026-10-25', yesterday: '2026-11-03', rolledUp: new Set(['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']) }))
      .toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(daysToRollUp({ firstCountedDay: '2026-11-01', yesterday: '2026-11-03', rolledUp: new Set(['2026-11-01', '2026-11-02', '2026-11-03']) })).toEqual([]);
    // Down for months: the most recent 31 days are caught up.
    const long = daysToRollUp({ firstCountedDay: '2026-01-01', yesterday: '2026-11-03', rolledUp: new Set() });
    expect(long).toHaveLength(31);
    expect(long[0]).toBe('2026-10-04');
  });

  it('"changes sharply" is the usage-signals route\'s own rule, with its own defaults — no number is made up here', () => {
    const current = usageWindowsOf([c({ day: '2026-10-27', calls: 5_000 }), c({ day: '2026-10-27', callerId: 'relay', api: 'API-08', calls: 100, errors: 40 })], '2026-10-27');
    const baseline = usageWindowsOf([c({ day: '2026-10-20', calls: 100 }), c({ day: '2026-10-20', callerId: 'relay', api: 'API-08', calls: 100 }), c({ day: '2026-10-20', callerId: 'backup', api: 'API-11', calls: 3 })], '2026-10-20');
    expect(usageSignalsOf({ current, baseline })).toEqual(findUsageSignals({ current, baseline }));
    expect(usageSignalsOf({ current, baseline }).map((f) => `${f.identityId}:${f.signal}`)).toEqual(['box-1:spike', 'relay:error_surge', 'backup:silent']);
    // Ordinary variation (1.4×) says nothing.
    expect(usageSignalsOf({ current: usageWindowsOf([c({ day: '2026-10-27', calls: 140 })], '2026-10-27'), baseline: usageWindowsOf([c({ calls: 100 })], '2026-10-20') })).toEqual([]);
  });

  it('a day is judged only once counting had started on its baseline day — before that every caller would be "new"', () => {
    const counts = [c({ day: '2026-10-27', calls: 50 })];
    const early = rollUpSecretUseDay({ day: '2026-10-27', counts, firstCountedDay: '2026-10-25', at: '2026-10-28T00:10:00.000Z' });
    expect(early).toMatchObject({ day: '2026-10-27', baselineDay: '2026-10-20', judged: false, findings: [] });
    const later = rollUpSecretUseDay({ day: '2026-10-27', counts: [...counts, c({ calls: 10 })], firstCountedDay: '2026-10-20', at: '2026-10-28T00:10:00.000Z' });
    expect(later.judged).toBe(true);
    expect(later.findings.map((f) => f.signal)).toEqual(['spike']);
    expect(later.findings.every((f) => f.actionTaken === false)).toBe(true);
  });

  it('the 30-day summary is per credential reference, caller and API, with the days it was used', () => {
    const sum = summariseSecretUse([c({ day: '2026-10-01', calls: 3 }), c({ day: '2026-10-20', calls: 4, errors: 1 }), c({ day: '2026-09-01', calls: 99 })], '2026-10-01', '2026-10-30');
    expect(sum).toEqual([{ credentialRef: 'cred-box-1', callerId: 'box-1', api: 'API-01', calls: 7, errors: 1, daysUsed: 2, lastUsedOn: '2026-10-20', byDay: [{ day: '2026-10-01', calls: 3, errors: 0 }, { day: '2026-10-20', calls: 4, errors: 1 }] }]);
  });
});

describe('M32-FR-03 · the counter — machine credentials only, appended, never lost quietly', () => {
  it('counts a machine credential\'s calls per shop day (the shop\'s clock, not UTC); a person\'s sign-in is not counted', async () => {
    const { store } = recording();
    await store.registerTenant(T, 'test');
    const counter = secretUseCounter({ store, now: () => '2026-10-21T00:00:00.000Z' });
    counter.record(use({}));
    counter.record(use({ status: 403 }));
    counter.record(use({ at: '2026-10-20T19:00:00.000Z' })); // 00:30 on the 21st in the shop
    counter.record(use({ callerId: 'u-owner', credentialRef: 'jti-person', roleIds: ['owner'] }));
    counter.record(use({ callerId: 'relay', credentialRef: undefined, roleIds: ['message_provider_relay'] }));
    expect(await counter.flush()).toBe(3);
    expect(totalCounts(await secretUseCounts(store, T, '2026-10-20', '2026-10-21'))).toEqual([
      { day: '2026-10-20', credentialRef: 'cred-box-1', callerId: 'box-1', api: 'API-01', calls: 2, errors: 1 },
      { day: '2026-10-20', credentialRef: 'unnamed', callerId: 'relay', api: 'API-01', calls: 1, errors: 0 },
      { day: '2026-10-21', credentialRef: 'cred-box-1', callerId: 'box-1', api: 'API-01', calls: 1, errors: 0 },
    ]);
    // A second flush with nothing new appends nothing; a further call appends a new count — the first is never rewritten.
    expect(await counter.flush()).toBe(0);
    counter.record(use({}));
    await counter.flush();
    const day = (await secretUseCounts(store, T, '2026-10-20', '2026-10-20')).filter((x) => x.callerId === 'box-1');
    expect(day.map((x) => x.calls)).toEqual([2, 1]);
  });

  it('a count the ledger refused is kept in memory, said, and kept on the next flush', async () => {
    const inner = new InMemoryEventStore();
    await (inner as EventStore).registerTenant(T, 'test');
    let fail = true;
    const store = new Proxy(inner, { get(t, p, r) { if (p === 'appendBatch') return async (...a: unknown[]) => { if (fail) throw new Error('database away'); return (t.appendBatch as (...x: unknown[]) => unknown)(...a); }; const v = Reflect.get(t, p, r) as unknown; return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v; } }) as EventStore;
    const said: string[] = [];
    const counter = secretUseCounter({ store, now: () => '2026-10-20T12:00:00.000Z', say: (l) => said.push(l) });
    counter.record(use({})); counter.record(use({}));
    expect(await counter.flush()).toBe(0);
    expect(said.join('\n')).toMatch(/not kept this time \(database away\); it is kept in memory and tried again/);
    fail = false;
    counter.record(use({}));
    expect(await counter.flush()).toBe(1);
    expect(totalCounts(await secretUseCounts(store, T, '2026-10-20', '2026-10-20'))[0]).toMatchObject({ calls: 3 });
  });
});

describe('M32-FR-03 · the nightly sweep — once per day, missed nights caught up, alerts to the IT custodian', () => {
  async function shop() {
    const { store, appended } = recording();
    await store.registerTenant(T, 'test');
    const h = apiHarness({ store });
    await h.seedOwner(T, 'u-owner');
    return { store, appended, h };
  }

  it('a sharp change raises one alert to the named IT custodian (and the owner) with the reference, the caller and the counts; a second pass doubles nothing', async () => {
    const { store, h } = await shop();
    await h.provisionRole(T, 'u-siva', 'security_reviewer');
    await twoSignatureAdapter({ store, now: () => '2026-10-01T00:00:00.000Z' }).twoSignature.recordReviewer(T, { userId: 'u-siva', displayName: 'Mr Sivakumar', namedBy: 'u-owner', namedAt: '2026-10-01T00:00:00.000Z', reason: 'OB-405' });
    const counter = secretUseCounter({ store, now: () => '2026-10-28T00:00:00.000Z' });
    for (let i = 0; i < 10; i++) counter.record(use({ at: '2026-10-20T06:00:00.000Z' }));
    for (let i = 0; i < 50; i++) counter.record(use({ at: '2026-10-27T06:00:00.000Z' }));
    await counter.flush();
    const sweep = secretUseRollupSweep({ store, now: () => '2026-10-28T01:00:00.000Z' });
    expect(await sweep(T, '2026-10-28T01:00:00.000Z')).toBe(1);
    const alerts = await alertLifecycleAdapter({ store, now: () => '2026-10-28T01:00:00.000Z' }).alerts(T);
    const a = alerts.find((x) => x.alert.alertId === secretUseAlertId('2026-10-27', 'box-1', 'API-01', 'spike'))!;
    expect(a.alert.ownerUserId).toBe('u-siva');
    expect(a.alert.alsoToUserIds).toEqual(['u-owner']);
    expect(a.alert.component).toBe('Secret use · box-1 · API-01');
    expect(a.alert.detail).toContain('credential reference cred-box-1');
    expect(a.alert.detail).toContain('50 call(s), 0 refused or failed; on 2026-10-20 (the same day a week before): 10 call(s)');
    expect(a.alert.detail).toContain('Reported, not blocked');
    // Eight days rolled up (20th..27th); the 20th..26th not judged (no history a week before them).
    const rolled = await secretUseRollups(store, T);
    expect(rolled.map((r) => r.day)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
    expect(rolled.filter((r) => r.judged).map((r) => r.day)).toEqual(['2026-10-27']);
    // A second pass the same night, and the next minute: nothing new raised, no roll-up kept twice.
    expect(await sweep(T, '2026-10-28T01:01:00.000Z')).toBe(0);
    expect((await store.readStream(T, secretUseRollupStream())).length).toBe(8);
    expect((await alertLifecycleAdapter({ store, now: () => '2026-10-28T01:02:00.000Z' }).alerts(T)).filter((x) => x.alert.alertId.startsWith('secret-use:'))).toHaveLength(1);
  });

  it('missed nights are caught up: a caller that went quiet is found for each day it was due', async () => {
    const { store, h } = await shop();
    const counter = secretUseCounter({ store, now: () => '2026-10-20T00:00:00.000Z' });
    for (const day of ['2026-10-19', '2026-10-20', '2026-10-21']) counter.record(use({ callerId: 'backup', credentialRef: 'cred-backup', api: 'API-11', roleIds: ['backup_job'], at: `${day}T20:00:00.000Z` }));
    await counter.flush();
    void h;
    // 20:00 UTC is 01:30 the next morning in the shop: the backup job called on the shop's 20th, 21st and 22nd. No pass ran
    // after that (head office down) until 01:30 on the 30th, which judges every day still due, once each.
    const sweep = secretUseRollupSweep({ store, now: () => '2026-10-30T00:00:00.000Z' });
    expect(await sweep(T, '2026-10-29T20:00:00.000Z')).toBe(3); // 30 Oct 01:30 in the shop: the 27th, 28th, 29th were each due
    const found = (await secretUseRollups(store, T)).flatMap((r) => r.findings.map((f) => `${r.day}:${f.signal}`));
    expect(found).toEqual(['2026-10-27:silent', '2026-10-28:silent', '2026-10-29:silent']);
    // The owner receives them when no IT custodian is named — and the alert says so.
    const a = (await alertLifecycleAdapter({ store, now: () => '2026-10-30T00:00:00.000Z' }).alerts(T)).find((x) => x.alert.alertId === secretUseAlertId('2026-10-27', 'backup', 'API-11', 'silent'))!;
    expect(a.alert.ownerUserId).toBe('u-owner');
    expect(a.alert.detail).toContain('Nobody is named as the IT custodian');
    expect(await sweep(T, '2026-10-29T20:05:00.000Z')).toBe(0);
  });
});

describe('M32-FR-03 · hard rule #4 — no token, key or secret value is ever kept (guardrail-style scan)', () => {
  it('a store computer\'s real calls through the kernel are counted by reference; every appended event is free of the token and the signing key', async () => {
    const { store, appended, h } = await (async () => {
      const r = recording();
      await r.store.registerTenant(T, 'test');
      const hh = apiHarness({ store: r.store });
      await hh.seedOwner(T, 'u-owner');
      await hh.provisionRole(T, 'box-1', 'store_computer', ['store-1']);
      return { ...r, h: hh };
    })();
    const token = TEST_IDP.issue({ sub: 'box-1', tenantId: T, branchId: 'store-1', jti: 'cred-box-1', authTimeFromNowSeconds: null, amr: null });
    for (let i = 0; i < 3; i++) expect((await h.raw({ method: 'GET', path: '/v1/catalogue/ratings', token })).status).toBe(200);
    expect((await h.raw({ method: 'GET', path: '/v1/integration/secrets', token })).status).toBe(403);
    // A person's call is not a machine credential's use.
    expect((await h.request({ method: 'GET', path: '/v1/integration/secrets', userId: 'u-owner', tenantId: T })).status).toBe(200);
    await h.secretUse.flush();
    const today = new Date().toISOString();
    const days = [addDays(today.slice(0, 10), -1), addDays(today.slice(0, 10), 1)];
    expect(totalCounts(await secretUseCounts(store, T, days[0]!, days[1]!)).map((x) => [x.credentialRef, x.callerId, x.api, x.calls, x.errors])).toEqual([
      ['cred-box-1', 'box-1', 'API-07', 3, 0],
      ['cred-box-1', 'box-1', 'API-11', 1, 1],
    ]);
    // The scan: nothing appended holds the token, any part of it, or the signing key.
    const secretUse = JSON.stringify(appended.filter((x) => /secret-use/.test(JSON.stringify((x as { stream?: string; s?: string }).stream ?? (x as { s?: string }).s ?? ''))));
    expect(secretUse).toContain('cred-box-1');
    const [head, body, sig] = token.split('.');
    for (const bad of [token, head!, body!, sig!, 'eyJ', h.idp.policy().secret]) expect(JSON.stringify(appended)).not.toContain(bad);
  });

  it('what the kernel hands the counter has no field that could hold a value, and the page keeps only the named fields', () => {
    const fields = Object.keys(use({})).sort();
    expect(fields).toEqual(['api', 'at', 'callerId', 'credentialRef', 'roleIds', 'status', 'tenantId']);
    for (const f of fields) expect(f).not.toMatch(/token|value|plain|password|key|secret/i);
    const view = ui.secretUsageViewOf({ from: '2026-10-06', to: '2026-11-04', uses: [{ credentialRef: 'cred-box-1', callerId: 'box-1', api: 'API-07', calls: 3, errors: 0, daysUsed: 1, lastUsedOn: '2026-11-04', value: 'NOT-TO-BE-SHOWN', token: 'eyJ.x.y' }], lastRolledUpDay: '2026-11-03', findings: [{ day: '2026-11-03', baselineDay: '2026-10-27', identityId: 'box-1', api: 'API-07', signal: 'spike', detail: 'x' }], notJudged: ['2026-11-01'] });
    expect(JSON.stringify(view)).not.toContain('NOT-TO-BE-SHOWN');
    expect(JSON.stringify(view)).not.toContain('eyJ');
    expect(ui.secretUseLine('en', view.uses[0]!)).toBe('reference cred-box-1 · by box-1 · on API-07 · 3 calls · 0 refused or failed · 1 days used · last used 2026-11-04');
    expect(ui.secretUseOf('en', 'cred-box-1', view.uses)).toBe('use in the last 30 days: 3 calls, 0 refused or failed');
    expect(ui.secretUseOf('en', 'sec-pay', view.uses)).toBe('no use recorded in the last 30 days');
    expect(ui.secretUseFindingLine('en', view.findings[0]!)).toBe('2026-11-03 · box-1 · API-07 · far more calls than the same day a week before (2026-10-27)');
    expect(ui.secretUseFindingLine('ta', view.findings[0]!)).toContain('ஒரு வாரம் முந்தைய');
  });

  it('the Integration health secrets session reads the use list only on "Show", under the route\'s own permission', async () => {
    const calls: string[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => { calls.push(`${init?.method ?? 'GET'} ${String(url)}`); return new Response(JSON.stringify({ from: 'a', to: 'b', uses: [], lastRolledUpDay: null, findings: [], notJudged: [] }), { status: 200 }); }) as typeof globalThis.fetch;
    const s = ui.createSecretsSession({ viewer: { userId: 'u-owner', permissions: ['platform.setup.read'] }, fetch });
    expect(calls).toEqual([]);
    expect(await s.usage()).toEqual({ result: 'ok', value: { from: 'a', to: 'b', uses: [], lastRolledUpDay: null, findings: [], notJudged: [] } });
    expect(calls).toEqual(['GET /v1/integration/secrets/usage']);
    const no = ui.createSecretsSession({ viewer: { userId: 'u-mgr', permissions: ['platform.health.read'] }, fetch });
    expect(await no.usage()).toEqual({ result: 'invalid', why: 'cannot' });
    expect(calls).toHaveLength(1);
  });
});
