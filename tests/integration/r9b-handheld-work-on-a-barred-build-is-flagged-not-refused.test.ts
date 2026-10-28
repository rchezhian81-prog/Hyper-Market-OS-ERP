import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { makeEvent } from '../../packages/contracts/src/event';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { DeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';
import { drainToBox } from '../../packages/sync/src/device-drain';
import { withTillPeople, issueTillPins, signInOnPhone, pinOf, type TillPerson } from '../support/till-operator';
import { deviceBase, trustTheBoxes } from '../support/box-tls';

/**
 * **OB-537 (Round 9 · R9-B) on a REAL store computer and the REAL head-office API: every handheld record carries the build
 * that made it; the store computer and head office FLAG work done on a withdrawn build — never refuse it, never drop it.**
 * In memory and, with DATABASE_URL, on real PostgreSQL (migrations run on an empty database):
 *
 *   • a picking handheld (enrolled, signed in with its holder's own PIN) queues a line outcome on its device outbox — the
 *     record names the build it was queued on — and hands it over with the shop's internet CUT: the box takes it (never
 *     refused for its build) and keeps the build on the record on its disk. Its pack held no version rule then, so it marks
 *     nothing;
 *   • a COLD RESTART of the box with a signed pack that WITHDRAWS this build: a second line outcome and a queue till's basket
 *     are taken — and MARKED on the box's disk, the basket on its own record too;
 *   • the line comes back: head office's wave register takes both line outcomes exactly as the picker made them (no build
 *     field reaches the handler); its own policy withdraws the build, so it keeps a MATERIAL finding for each — the first
 *     one by its own policy alone, the second and the basket also marked by the store computer — and they survive a cold
 *     restart of head office; a resend is one finding;
 *   • least privilege: a cashier may not read the findings (403); a person cannot send a queue basket's build report (403).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface Backing { readonly name: string; readonly make: () => () => ApiHarness }
const backings: Backing[] = [{
  name: 'the in-memory stores',
  make: () => { const first = apiHarness(); return () => apiHarness({ store: first.store }); },
}];
if (DATABASE_URL !== undefined) {
  backings.push({
    name: 'real PostgreSQL',
    make: () => {
      const sql = pgPoolClient(pool!);
      const store = new SqlEventStore(sql);
      return () => apiHarness({ store, idempotency: new SqlIdempotencyStore(sql) });
    },
  });
}

const STORE = 'store-1';
const LANE = 'lane-1';
const AT = new Date(Date.now() - 60_000).toISOString();
const PICKER_CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const QUEUE_CODE = 'QUEUE-TILL1-ENROL-CODE1';
const WITHDRAWN = { currentVersion: '99.0.0', previousVersion: '98.0.0', minimumSupportedVersion: '98.0.0', killedVersions: ['0.0.0'] };
const PEOPLE: readonly TillPerson[] = [
  { userId: 'u-picker', displayName: 'Picker One', permissions: ['fulfilment.pack.record'] },
  { userId: 'u-ravi', displayName: 'Ravi' },
];
const packJson = (withPolicy: boolean): string => JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: STORE, branchId: STORE, branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privilegedActions: [] },
  lossPreventionRules: [],
  wave: {
    waveId: 'W-1', pickerId: 'u-picker',
    lines: [
      { lineId: 'l1', orderRef: 'ORD-1', productId: 'p-rice', description: 'Rice 5kg', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPriceMinor: 100_00 },
      { lineId: 'l2', orderRef: 'ORD-1', productId: 'p-milk', description: 'Milk 1L', bin: 'B-04', requiredQty: 1, uom: 'ea', unitPriceMinor: 60_00 },
    ],
  },
  devices: [
    { deviceId: 'hh-02', kind: 'handheld', status: 'registered', label: 'Aisle picker', enrolment: { codeHash: enrolmentCodeHash(PICKER_CODE), expiresAt: '2099-01-01T00:00:00.000Z' } },
    { deviceId: 'hh-q1', kind: 'handheld', status: 'registered', label: 'Queue till 1', enrolment: { codeHash: enrolmentCodeHash(QUEUE_CODE), expiresAt: '2099-01-01T00:00:00.000Z' } },
  ],
  rollout: { format: 'sre-rollout/1', branchId: STORE, switches: [{ key: 'pos.queue_busting', branch: null, lanes: [{ laneId: LANE, enabled: true, version: 1 }] }] },
  ...(withPolicy ? { versionPolicy: WITHDRAWN } : {}),
}, PEOPLE));

const resolved = (lineId: string) => makeEvent({
  id: `W-1:${lineId}:picked`, type: 'PickLineResolved', occurredAt: AT, idempotencyKey: `pick:W-1:${lineId}:picked`, source: 'W-1',
  payload: {
    waveId: 'W-1', lineId, orderRef: 'ORD-1', productId: lineId === 'l1' ? 'p-rice' : 'p-milk', state: 'picked',
    description: lineId === 'l1' ? 'Rice 5kg' : 'Milk 1L', requiredQty: lineId === 'l1' ? 2 : 1, pickedQty: lineId === 'l1' ? 2 : 1, uom: 'ea',
    finalPriceMinor: lineId === 'l1' ? 200_00 : 60_00, currency: 'INR', substituted: false, note: null, pickedBy: 'u-picker',
  },
});

interface Finding { readonly recordRef: string; readonly severity: string; readonly verdict: string; readonly client: string; readonly appVersion: string | null; readonly markedByStoreComputer: string | null; readonly store: string | null; readonly route: string }

describe.each(backings)('OB-537: handheld work on a withdrawn build is carried, kept and flagged — $name', ({ make }) => {
  let harness: () => ApiHarness;
  let h: ApiHarness;
  let tenant: string;
  let dir: string;
  let edge: EdgeProcess | undefined;
  let cut = false;
  const original = globalThis.fetch;
  const saved = trustTheBoxes(original);

  const as = (userId: string, branchId?: string) => TEST_IDP.issue({ sub: userId, tenantId: tenant, ...(branchId === undefined ? {} : { branchId }) });
  const findings = async (userId = 'u-owner'): Promise<{ status: number; material: Finding[]; informational: number }> => {
    const r = await h.raw({ method: 'GET', path: '/v1/platform/handheld-work/version-exceptions', token: as(userId) });
    const body = r.body as { material?: Finding[]; informational?: number };
    return { status: r.status, material: body.material ?? [], informational: body.informational ?? 0 };
  };
  const boot = async (withPolicy: boolean): Promise<EdgeProcess> => {
    await writeFile(join(dir, 'store-pack.json'), packJson(withPolicy), 'utf8');
    return (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: tenant, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE,
      EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: join(dir, 'store-pack.json'),
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: as('u-box', STORE),
    }, () => {}))!;
  };
  const enrol = async (e: EdgeProcess, deviceId: string, code: string): Promise<string> => {
    const res = await saved(`${deviceBase(e)}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, code }) });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie')!.split(';')[0]!;
  };
  const onBox = async (e: EdgeProcess): Promise<Record<string, unknown>[]> => (await readLog(e.deviceEventsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));
  const payloadOf = (records: Record<string, unknown>[], key: string): Record<string, unknown> => (records.find((r) => r['idempotencyKey'] === key)?.['payload'] ?? {}) as Record<string, unknown>;

  beforeAll(async () => {
    harness = make();
    h = harness();
    tenant = randomUUID();
    await h.seedOwner(tenant, 'u-owner');
    await h.provisionRole(tenant, 'u-picker', 'store_manager');
    await h.provisionRole(tenant, 'u-box', 'store_computer', [STORE]);
    await h.provisionRole(tenant, 'u-cashier', 'cashier', [STORE]);
    await h.enableFeature(tenant, 'delivery');
    globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:') || String(url).startsWith('https://127.0.0.1:')) return saved(url, init);
      if (cut) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const u = new URL(url);
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown, ...(u.search === '' ? {} : { query: Object.fromEntries(u.searchParams) }),
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), 'sre-r9b-'));
    await issueTillPins(dir, TEST_PACK_KEY, PEOPLE.map((p) => p.userId));
  }, 120_000);
  afterAll(async () => {
    await edge?.stop();
    globalThis.fetch = original;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('carried on the record from the device, kept on the box offline across a cold restart, marked from the signed pack; head office flags each once, durably', async () => {
    cut = true; // ── THE SHOP'S INTERNET IS CUT ──
    edge = await boot(false);
    const pickerCookie = await signInOnPhone(deviceBase(edge), await enrol(edge, 'hh-02', PICKER_CODE), 'u-picker', 'picker');
    // The picker's device outbox, as the picker page opens it (OB-537: with the build it runs).
    const outbox = new DeviceOutbox(noDeviceStore(), [], undefined, '0.0.0');
    const phoneFetch = (url: string, init: Parameters<Parameters<typeof drainToBox>[0]['fetch']>[1]) =>
      saved(url, { ...init, headers: { ...init.headers, cookie: pickerCookie } } as RequestInit) as unknown as ReturnType<Parameters<typeof drainToBox>[0]['fetch']>;
    outbox.enqueue(resolved('l1'));
    expect(await drainToBox({ outbox, boxBase: deviceBase(edge), source: 'picker', fetch: phoneFetch })).toMatchObject({ handed: 1, refused: 0 });
    // The box's pack holds no version rule yet: the build is on the record, unmarked.
    expect(payloadOf(await onBox(edge), 'pick:W-1:l1:picked')['handheldBuild']).toEqual({ client: 'picker', appVersion: '0.0.0' });

    // ── A COLD RESTART with a signed pack that WITHDRAWS this build. Still offline. ──
    await edge.stop();
    edge = await boot(true);
    outbox.enqueue(resolved('l2'));
    expect(await drainToBox({ outbox, boxBase: deviceBase(edge), source: 'picker', fetch: (url, init) => saved(url, { ...init, headers: { ...init.headers, cookie: pickerCookie } } as RequestInit) as never })).toMatchObject({ handed: 1, refused: 0 });
    const records = await onBox(edge);
    expect(payloadOf(records, 'pick:W-1:l1:picked')['handheldBuild']).toEqual({ client: 'picker', appVersion: '0.0.0' }); // as it was kept
    expect(payloadOf(records, 'pick:W-1:l2:picked')['handheldBuild']).toEqual({ client: 'picker', appVersion: '0.0.0', storeComputerVersionCheck: { verdict: 'version_killed', reported: '0.0.0', minimumSupportedVersion: '98.0.0' } });

    // The queue till hands a basket over — taken, never refused for its build — and the basket keeps the build and the mark.
    const queueDevice = await enrol(edge, 'hh-q1', QUEUE_CODE);
    const signedIn = await saved(`${deviceBase(edge)}/queue-pos/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: queueDevice }, body: JSON.stringify({ staffId: 'u-ravi', pin: pinOf('u-ravi') }) });
    expect(await signedIn.json()).toMatchObject({ signedIn: true });
    const queueCookie = `${queueDevice}; ${signedIn.headers.get('set-cookie')!.split(';')[0]!}`;
    const handOver = await saved(`${deviceBase(edge)}/queue-pos/handoff`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: queueCookie },
      body: JSON.stringify({ basketId: 'B-Q-1', lines: [{ productId: 'p-rice', name: 'Rice 5kg', barcode: '8901234567890', quantityMinor: 1 }], handheldTotalMinor: 100_00, appVersion: '0.0.0' }),
    });
    expect(await handOver.json()).toMatchObject({ handedOver: true });
    const basket = (await readLog(join(dir, 'queue-baskets.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []))[0]!;
    expect(basket['handheldBuild']).toEqual({ client: 'queue_till', appVersion: '0.0.0', storeComputerVersionCheck: { verdict: 'version_killed', reported: '0.0.0', minimumSupportedVersion: '98.0.0' } });
    expect(payloadOf(await onBox(edge), `queue-basket-build-${tenant}-device:hh-q1-B-Q-1`)).toMatchObject({ basketId: 'B-Q-1', handheldLane: 'device:hh-q1', handedOverBy: 'u-ravi' });
    expect(edge.deviceEventsOutbox.pending()).toHaveLength(3); // held for head office, nothing lost

    // ── THE LINE COMES BACK. Head office withdraws the build in its own policy too. ──
    cut = false;
    expect((await h.raw({ method: 'POST', path: '/v1/platform/version-policy', token: as('u-owner'), idempotencyKey: `k-${randomUUID()}`, body: { policy: WITHDRAWN } })).status).toBeLessThan(300);
    const pass = await edge.syncOnce!();
    expect([pass.sent, pass.dead], JSON.stringify(edge.deviceEventsOutbox.all().filter((i) => i.state === "dead_letter").map((i) => [i.key, i.reason]))).toEqual([3, 0]);
    // The wave register took both outcomes exactly as the picker made them: the build never reached the handler.
    const wave = (await h.request({ method: 'GET', path: '/v1/fulfilment/waves/W-1', userId: 'u-owner', tenantId: tenant })).body as { lines: Record<string, unknown>[] };
    expect(wave.lines.map((l) => [l['lineId'], l['pickedBy'], l['relayedBy']])).toEqual([['l1', 'u-picker', 'u-box'], ['l2', 'u-picker', 'u-box']]);
    expect(JSON.stringify(wave)).not.toContain('handheldBuild');

    h = harness(); // ── A COLD RESTART of head office ──
    const got = await findings();
    expect(got.status).toBe(200);
    const byRef = Object.fromEntries(got.material.map((f) => [f.recordRef.split('#')[0], f]));
    expect(Object.keys(byRef).sort()).toEqual(['device:hh-q1/B-Q-1', 'waveId=W-1&lineId=l1', 'waveId=W-1&lineId=l2']);
    expect(byRef['waveId=W-1&lineId=l1']).toMatchObject({ severity: 'material', verdict: 'version_killed', client: 'picker', appVersion: '0.0.0', markedByStoreComputer: null, store: STORE });
    expect(byRef['waveId=W-1&lineId=l2']).toMatchObject({ severity: 'material', verdict: 'version_killed', markedByStoreComputer: 'version_killed' });
    expect(byRef['device:hh-q1/B-Q-1']).toMatchObject({ severity: 'material', client: 'queue_till', markedByStoreComputer: 'version_killed' });

    // A resend of the same record is one finding.
    const again = await h.raw({ method: 'POST', path: '/v1/platform/handheld-work/queue-baskets/B-Q-1/build/synced', token: as('u-box', STORE), idempotencyKey: `k-${randomUUID()}`, body: { basketId: 'B-Q-1', handheldLane: 'device:hh-q1', handedOverBy: 'u-ravi', handedOverAt: AT, reportedBuild: { client: 'queue_till', appVersion: '0.0.0' } } });
    expect(again.status).toBe(200);
    expect((await findings()).material).toHaveLength(3);

    // Least privilege: a cashier may not read the register; a person may not send a basket's build report.
    expect((await findings('u-cashier')).status).toBe(403);
    expect((await h.raw({ method: 'POST', path: '/v1/platform/handheld-work/queue-baskets/B-Q-9/build/synced', token: as('u-cashier', STORE), idempotencyKey: `k-${randomUUID()}`, body: {} })).status).toBe(403);
    // A malformed report from the store computer is refused by name and keeps nothing.
    const bad = await h.raw({ method: 'POST', path: '/v1/platform/handheld-work/queue-baskets/B-Q-9/build/synced', token: as('u-box', STORE), idempotencyKey: `k-${randomUUID()}`, body: { basketId: 'B-Q-9' } });
    expect([bad.status, (bad.body as { error?: { code?: string } }).error?.code]).toEqual([400, 'not_readable_as_a_queue_basket_build']);
    expect((await findings()).material).toHaveLength(3);
  }, 180_000);
});
