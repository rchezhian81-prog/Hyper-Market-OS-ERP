import { describe, it, expect } from 'vitest';
import { readFleetHealth, fleetRowsOf, fleetHealthLine, fleetHealthPort, FLEET_HEALTH_WORDS, FLEET_HEALTH_PATH } from '../../apps/web-erp/src/fleet-health-read';
import { evaluateDevice, fleetSummary, type Device, type VersionPolicy } from '../../packages/platform-admin/src/devices';
import { fleetPortsFromData } from '../../apps/web-erp/src/browser-entry';
import { createFleetSession } from '../../apps/web-erp/src/fleet-session';

/**
 * W6 · M33-FR-04 (A-10 · P-03 · P-08) — the Devices page reads the shop's real fleet from head office's
 * `POST /v1/platform/devices/fleet-health`, as the person, for this store. No machine feeds that route and none should: it is
 * head office's own judgement of its own registry. Until this, the page on the store computer showed "No devices are
 * registered yet" — a fleet nobody read. Every way the read fails is said; none reads as "all well".
 */

const NOW = '2026-11-03T06:00:00.000Z';
const POLICY: VersionPolicy = { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0' };
const DEVICES: Device[] = [
  { deviceId: 'lane-1', tenantId: 't', branchId: 'store-1', kind: 'pos_lane', label: 'Till 1', status: 'registered', appVersion: '2.1.0', lastSeenAt: '2026-11-03T05:55:00.000Z' },
  { deviceId: 'lane-2', tenantId: 't', branchId: 'store-1', kind: 'pos_lane', label: 'Till 2', status: 'registered', appVersion: '1.9.0', lastSeenAt: '2026-11-03T05:59:00.000Z' },
  { deviceId: 'hh-7', tenantId: 't', branchId: 'store-1', kind: 'handheld', label: 'Handheld 7', status: 'registered', appVersion: '2.1.0' },
];
/** Exactly what the route answers (services/platform/src/device-registry.ts): the same two engines, the same shape. */
const ANSWER = { summary: fleetSummary(DEVICES, POLICY, NOW), devices: DEVICES.map((d) => ({ device: d, decision: evaluateDevice(d, POLICY) })), asAt: NOW };

type Sent = { method: string; path: string; key?: string; body?: string };
const fake = (status: number, body: unknown, sent: Sent[] = []) => (async (url: string, init?: RequestInit) => {
  sent.push({ method: init?.method ?? 'GET', path: String(url), key: (init?.headers as Record<string, string>)['idempotency-key'], body: String(init?.body) });
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof globalThis.fetch;

describe('W6 · the Devices page reads the fleet from head office (M33-FR-04)', () => {
  it('flattens head office\'s answer into the page\'s rows: each device with its verdict, "gone quiet" from the rollup', () => {
    const rows = fleetRowsOf(ANSWER)!;
    expect(rows.summary).toEqual({ total: 3, trading: 2, blocked: 1, mustUpgrade: 1, silent: 1, byVersion: { '2.1.0': 2, '1.9.0': 1 } });
    expect(rows.devices.map((d) => [d.deviceId, d.verdict, d.mayTrade, d.mustUpgrade, d.silent])).toEqual([
      ['lane-1', 'ok', true, false, false], ['lane-2', 'upgrade_required', false, true, false], ['hh-7', 'ok', true, false, true],
    ]);
    expect(fleetRowsOf({ summary: { total: 'x' }, devices: [] })).toBeUndefined();
    expect(fleetRowsOf({ ...ANSWER, devices: [{ device: { deviceId: 'x' }, decision: {} }] })).toBeUndefined();
  });

  it('asks as the person, for this store, with a fresh key every read (a read, never a replay)', async () => {
    const sent: Sent[] = [];
    let n = 0;
    const r = await readFleetHealth(fake(200, ANSWER, sent), 'store-1', () => `k-${(n += 1)}`);
    await readFleetHealth(fake(200, ANSWER, sent), 'store-1', () => `k-${(n += 1)}`);
    expect(r.state).toBe('read');
    expect(sent.map((s) => [s.method, s.path, s.key, s.body])).toEqual([
      ['POST', `${FLEET_HEALTH_PATH}?branchId=store-1`, 'k-1', '{}'], ['POST', `${FLEET_HEALTH_PATH}?branchId=store-1`, 'k-2', '{}'],
    ]);
  });

  it('every way the read fails is said, and none of them is "known"', async () => {
    const err = (code: string, whatHappened = 'x') => ({ error: { code, whatHappened } });
    const cases: [number, unknown, string][] = [
      [409, err('no_version_policy'), 'no_version_policy'], [503, {}, 'unreachable'], [401, err('unauthenticated', 'Sign in again.'), 'sign_in_needed'],
      [403, err('forbidden'), 'not_permitted'], [403, err('branch_out_of_scope', 'Not your store.'), 'refused'], [200, { nope: true }, 'not_known'],
    ];
    for (const [status, body, state] of cases) {
      const r = await readFleetHealth(fake(status, body), 'store-1');
      expect(r.state, `${status}`).toBe(state);
      for (const lang of ['en', 'ta'] as const) expect(fleetHealthLine(lang, r).known).toBe(false);
    }
    const thrown = (async () => { throw new Error('socket closed'); }) as unknown as typeof globalThis.fetch;
    expect((await readFleetHealth(thrown)).state).toBe('unreachable');
    expect(fleetHealthLine('en', { state: 'no_version_policy' }).text).toMatch(/no app version policy yet.*not "all well"/);
    expect(fleetHealthLine('en', { state: 'refused', status: 403, code: 'branch_out_of_scope', said: 'Not your store.' }).text).toBe('Head office refused: Not your store.');
    expect(Object.keys(FLEET_HEALTH_WORDS.ta).sort()).toEqual(Object.keys(FLEET_HEALTH_WORDS.en).sort());
    for (const k of Object.keys(FLEET_HEALTH_WORDS.en) as (keyof typeof FLEET_HEALTH_WORDS.en)[]) expect(FLEET_HEALTH_WORDS.ta[k]).not.toBe(FLEET_HEALTH_WORDS.en[k]);
  });

  it('the port reads only for whom head office would answer; a read becomes the fleet the page\'s session shows, worst first', async () => {
    const sent: Sent[] = [];
    const none = fleetHealthPort({ permissions: ['platform.device.manage'], fetch: fake(200, ANSWER, sent), onRead: () => undefined });
    expect(none.mayRead).toBe(false);
    expect(await none.read()).toEqual({ state: 'not_permitted' });
    expect(sent).toEqual([]);

    let live: ReturnType<typeof fleetRowsOf>;
    const data = { userId: 'u-mgr', permissions: ['platform.health.read'] };
    const session = createFleetSession({ userId: 'u-mgr' }, fleetPortsFromData(data, undefined, undefined, () => live));
    expect(session.view('en').total).toBe(0); // before head office answers there is no fleet — the page says so (fleet.js)
    const port = fleetHealthPort({ permissions: data.permissions, storeId: 'store-1', fetch: fake(200, ANSWER, sent), onRead: (f) => { live = f; } });
    expect((await port.read()).state).toBe('read');
    const view = session.view('en');
    expect(view.total).toBe(3);
    expect(view.devices.map((d) => d.deviceId)).toEqual(['lane-2', 'hh-7', 'lane-1']);
    expect(view.attentionCount).toBe(2);
    expect(port.line('en', { state: 'read', ...fleetRowsOf(ANSWER)!, asAt: NOW })).toEqual({ known: true, tone: 'ok', text: 'The fleet as head office holds it.' });
  });
});
