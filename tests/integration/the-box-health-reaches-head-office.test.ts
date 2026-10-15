import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { boxHealthAdapter } from '../../services/api/src/adapters';
import { prepareTillBox, signInAtLane, operatorHeader } from '../support/till-operator';

/**
 * **M35-FR-03 · D04-FR-05 · OB-54 · P-08 · §31 — the store computer's own health reaches head office, and head office
 * judges it instead of saying `unknown`; a box that has gone quiet is shown STALE, never fine.**
 *
 * A REAL store computer (`startEdge`: its disk, its till socket, its durable queues and sync loop) talks to the REAL head
 * office (the production route table through the harness, in memory and on PostgreSQL):
 *   • before any box reports, head office names the lane-side signal as not observed;
 *   • a cashier signs in at the till and the till's devices report (printer out of paper); after a sync pass the box
 *     relays its disk free space, its queue depth and that device report — head office's observed health now has
 *     `box_disk:S1` unknown while its hours left are not yet known (with the free bytes), `till_devices:S1` degraded naming the printer, `box_queue:S1` ok — and the
 *     owner's alert rule for the till devices raises to its named owner;
 *   • the line goes down: a sale waits on the box's disk, the report cannot go, twenty minutes pass — head office shows
 *     the store computer STALE (its last values, how old), never ok; the line comes back: the queue empties, the box
 *     reports, and it is fresh again;
 *   • a box whose disk can no longer take a sale (by its own rule) is `down` at head office and the shop "cannot trade"
 *     names that store;
 *   • store-locked (OB-54): the report names no store and head office stamps the credential's (kept on the stamp record);
 *     a report naming another store is refused at the door; a person — cashier, manager or owner — cannot report; a
 *     garbled report is refused; a re-sent report is one record; a second head-office instance reads the same.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaab801';
const KEY = ['m35', 'box', 'health', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';
const T0 = Date.parse('2026-10-12T04:00:00.000Z'); // 09:30 in the shop
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const travel = (minutes: number): void => { vi.setSystemTime(new Date(T0 + minutes * 60_000)); };
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Component { name: string; status: string; detail: string; evidence?: Record<string, number | string> }
interface Box { storeId: string; state: string; stale: boolean; lastReportAt: string | null; canRecordSales: boolean | null; disk: { freeBytes: number; totalBytes: number } | null; queue: { unsent: number; deadLettered: number } | null; tills: { laneId: string; devices: { kind: string; state: string; detail?: string }[] }[] }
interface Observed {
  observed: { signals: { localStoreWritable?: boolean }; notObserved: string[]; boxes: Box[] };
  health: { status: string; canTrade: boolean; summary: string; components: Component[] };
  wouldRaise: { alertId: string; component: string; status: string; ownerUserId: string; detail: string }[];
}

async function scene(h: ApiHarness, tenant: string) {
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];
  const savedFetch = globalThis.fetch;
  const token = ['box', 's1', tenant].join('-').padEnd(48, '0');
  const cut = { on: false };
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    const hdr = (init.headers ?? {}) as Record<string, string>;
    if (hdr['authorization']?.replace(/^Bearer /, '') !== token) return new Response('{}', { status: 401 });
    if (cut.on) throw new Error('network down');
    const res = await h.request({
      method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname, userId: 'u-box1', tenantId: tenant, branchId: 'S1',
      ...(hdr['idempotency-key'] === undefined ? {} : { idempotencyKey: hdr['idempotency-key'] }),
      ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const owner = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
    h.request({ method, path, userId: OWNER, tenantId: tenant, ...(method === 'GET' ? {} : { idempotencyKey: `k-${Math.random()}` }), ...(body === undefined ? {} : { body }) });
  await h.seedOwner(tenant, OWNER);
  await h.provisionRole(tenant, 'u-box1', 'store_computer', ['S1']);
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    ['S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }],
    ['S2', { kind: 'branch', name: 'Second store', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await owner('POST', `/v1/org/nodes/${id}`, body)).status).toBe(201);

  const dir = await mkdtemp(join(tmpdir(), 'sre-box-health-'));
  dirs.push(dir);
  const ready = await prepareTillBox({
    dir, key: KEY, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }],
    pack: { managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 }, lossPreventionRules: [], policies: { storeId: 'S1', branchId: 'S1', branchName: 'S1', tradingDayCutoff: '00:00', staleAfterSeconds: 3600, countApprovalThresholdMinor: 1, handoverToleranceMinor: 1, privacySlaDays: 30, warehouseId: 'S1' } },
  });
  const boot = async (capacityBytes = '10485760'): Promise<EdgeProcess> => {
    const e = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: tenant, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: capacityBytes, EDGE_LANE_PORT: '0',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: token, EDGE_STORE_ID: 'S1', ...ready,
    }, () => {}))!;
    edges.push(e);
    return e;
  };
  const stop = async (e: EdgeProcess): Promise<void> => { await e.stop(); edges.splice(edges.indexOf(e), 1); };
  const saleOnDisk = async (saleId: string, committedAt: string): Promise<void> => {
    const record = JSON.stringify({ id: saleId, saleId, laneId: 'lane-1', tradingDay: committedAt.slice(0, 10), committedAt, total: 5_000, totalMinor: 5_000, currency: 'INR', lines: [{ productId: 'P1', qty: 1, unitPriceMinor: 5_000 }], tenders: [{ kind: 'cash', amountMinor: 5_000 }] });
    await appendFile(join(dir, 'sales.log'), `${Buffer.byteLength(record, 'utf8')} ${record}\n`);
  };
  const observed = async (hh: ApiHarness = h): Promise<Observed> => {
    const res = await hh.request({ method: 'GET', path: '/v1/platform/operational-health/observed', userId: OWNER, tenantId: tenant });
    expect(res.status).toBe(200);
    return res.body as Observed;
  };
  const comp = (o: Observed, name: string): Component | undefined => o.health.components.find((c) => c.name === name);
  const done = async (): Promise<void> => {
    for (const e of edges.splice(0)) await e.stop();
    globalThis.fetch = savedFetch;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  };
  return { boot, stop, saleOnDisk, observed, comp, owner, cut, done };
}

async function theBoxHealthReachesHeadOffice(h: ApiHarness, tenant: string, again?: () => ApiHarness): Promise<void> {
  const s = await scene(h, tenant);
  try {
    travel(0);
    // Before any store computer reports: the lane-side signal is named as not observed — never guessed ok.
    const before = await s.observed();
    expect(before.observed.boxes).toEqual([]);
    expect(before.observed.notObserved.join(' ')).toMatch(/localStoreWritable/);
    expect(before.health.components.some((c) => c.name.startsWith('box_disk:'))).toBe(false);

    // The owner names who owns the till devices and the store computer's disk (§32: every alert has a named owner).
    expect((await s.owner('PUT', '/v1/platform/alert-rules', { basedOnVersion: 0, rules: [
      { alertId: 's1-till-devices', component: 'till_devices:S1', firesAt: 'degraded', ownerUserId: 'u-mgr', ownerName: 'Store manager', ackWithinMinutes: 15, escalatesToUserId: OWNER },
      { alertId: 's1-box-disk', component: 'box_disk:S1', firesAt: 'down', ownerUserId: 'u-mgr', ownerName: 'Store manager', ackWithinMinutes: 15, escalatesToUserId: OWNER },
    ] })).status).toBe(200);

    // A cashier signs in; the till's device adapter says the printer is out of paper.
    let box = await s.boot();
    const tok = await signInAtLane(box.lane!.port, 'u-lanecash');
    const sent = await fetch(`http://127.0.0.1:${box.lane!.port}/lane/peripherals`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(tok) },
      body: JSON.stringify({ devices: [{ kind: 'scanner', state: 'ok' }, { kind: 'printer', state: 'failed', detail: 'paper out' }] }),
    }).then((r) => r.json() as Promise<Record<string, unknown>>);
    expect(sent).toMatchObject({ recorded: true });

    travel(1);
    await box.syncOnce!();
    expect(await box.reportBoxHealth!()).toBe(true);
    const live = await s.observed();
    const s1 = live.observed.boxes.find((b) => b.storeId === 'S1')!;
    expect(s1).toMatchObject({ state: 'reported', stale: false, lastReportAt: at(1), canRecordSales: true, queue: { unsent: 0, deadLettered: 0 } });
    expect(s1.disk!.freeBytes).toBeGreaterThan(0);
    expect(s1.disk!.totalBytes).toBeGreaterThanOrEqual(s1.disk!.freeBytes);
    // The cashier's id stays on the box; only the lane and its devices travel.
    // `attended` (P-08): somebody is signed in at that till now, by the box's own sessions — so a quiet lane is one to check.
    expect(s1.tills).toEqual([{ laneId: 'lane-1', reportedAt: at(0), devices: [{ kind: 'scanner', state: 'ok' }, { kind: 'printer', state: 'failed', detail: 'paper out' }], attended: true }]);
    expect(JSON.stringify(s1)).not.toContain('u-lanecash');
    // The second store, known to head office, has never reported: listed, never left out, never "fine".
    expect(live.observed.boxes.find((b) => b.storeId === 'S2')).toMatchObject({ state: 'never_reported', stale: true, canRecordSales: null });
    expect(live.observed.notObserved.join(' ')).toMatch(/S2: never reported/);
    // Judged, not unknown:
    expect(s.comp(live, 'box_disk:S1')).toMatchObject({ status: 'unknown' }); // round 14 (G8): hours left not yet known on one report — unknown with the reason, never a plain ok;
    expect(s.comp(live, 'box_disk:S1')!.detail).toMatch(/can record sales: \d+ MB free/);
    expect(Number(s.comp(live, 'box_disk:S1')!.evidence!['freeBytes'])).toBe(s1.disk!.freeBytes);
    expect(s.comp(live, 'box_queue:S1')).toMatchObject({ status: 'ok' });
    expect(s.comp(live, 'till_devices:S1')).toMatchObject({ status: 'degraded', detail: 'store S1: lane-1: printer has failed — paper out — the till still sells; a person should fix it' });
    expect(live.health.canTrade).toBe(true);
    expect(live.health.summary).toContain('lane-1: printer has failed');
    // …and it reaches the named owner (the disk rule does not fire: the disk is fine).
    expect(live.wouldRaise.map((a) => [a.alertId, a.ownerUserId, a.status])).toContainEqual(['s1-till-devices', 'u-mgr', 'degraded']);
    expect(live.wouldRaise.some((a) => a.alertId === 's1-box-disk')).toBe(false);
    const raised = await s.owner('POST', '/v1/platform/operational-health/observed/raise');
    expect(raised.status).toBe(200);
    expect((raised.body as { alerts: { alertId: string }[] }).alerts.map((a) => a.alertId)).toContain('s1-till-devices');

    // OB-54: the report named no store; head office stamped the credential's store, and kept the stamp on its record.
    const stamps = await s.owner('GET', '/v1/store-computers/stamps');
    expect((stamps.body as { stamps: { store: string; field: string | null; path: string }[] }).stamps)
      .toContainEqual(expect.objectContaining({ store: 'S1', field: 'storeId', path: '/v1/store-computers/health-reports' }));

    // THE LINE GOES DOWN. A sale waits on the box's disk; the box cannot report. Twenty minutes pass.
    s.cut.on = true;
    travel(5);
    await s.saleOnDisk('S1-SALE-1', at(5));
    await s.stop(box);
    box = await s.boot(); // the sale on disk is re-queued; the box trades on
    travel(21);
    await box.syncOnce!();
    expect(box.agent!.health().unsentCount).toBe(1);
    expect(await box.reportBoxHealth!()).toBe(false);
    const quiet = await s.observed();
    const q1 = quiet.observed.boxes.find((b) => b.storeId === 'S1')!;
    // Shown STALE with its last values and how old — never "ok" on twenty-minute-old news (P-08).
    expect(q1).toMatchObject({ stale: true, lastReportAt: at(1), canRecordSales: true });
    for (const name of ['box_disk:S1', 'box_queue:S1', 'till_devices:S1']) {
      expect(s.comp(quiet, name), name).toMatchObject({ status: 'unknown' });
      expect(s.comp(quiet, name)!.detail, name).toMatch(/^STALE — store S1's computer last reported 20 min ago/);
    }
    expect(quiet.observed.signals.localStoreWritable).toBeUndefined();
    expect(quiet.observed.notObserved.join(' ')).toMatch(new RegExp(`S1: stale, last ${at(1).replace(/[.]/g, '\\.')}`));
    // A stale box raises nothing as if it were known — the alert rules fire on judged states only.
    expect(quiet.wouldRaise.some((a) => a.alertId === 's1-till-devices')).toBe(false);

    // A second head-office instance (a restart, another replica) tells the owner the same — it is on the record.
    if (again !== undefined) {
      const other = await s.observed(again());
      expect(other.observed.boxes.find((b) => b.storeId === 'S1')).toMatchObject({ stale: true, lastReportAt: at(1) });
    }

    // THE LINE COMES BACK. The waiting sale goes up, the box reports, and it is fresh again.
    s.cut.on = false;
    travel(22);
    await box.syncOnce!();
    expect(box.agent!.health().unsentCount).toBe(0);
    expect(await box.reportBoxHealth!()).toBe(true);
    const back = await s.observed();
    expect(back.observed.boxes.find((b) => b.storeId === 'S1')).toMatchObject({ stale: false, lastReportAt: at(22), queue: { unsent: 0, deadLettered: 0 } });
    expect(s.comp(back, 'box_disk:S1')).toMatchObject({ status: 'unknown' });
    // Round 13 (verifier B5 · P-08): the box is fresh, but the till has not re-reported its devices since at(0) — 22 minutes:
    // that lane is STALE, judged by the till's OWN report time, so the devices are unknown, never ok and never a fresh alarm.
    expect(s.comp(back, 'till_devices:S1')).toMatchObject({ status: 'unknown' });
    expect(s.comp(back, 'till_devices:S1')!.detail).toContain(`STALE — till lane-1 last reported its devices 22 min ago (${at(0)}), then saying lane-1: printer has failed — paper out`);
    expect(back.wouldRaise.some((a) => a.alertId === 's1-till-devices')).toBe(false);

    // A box whose disk can no longer take a sale, by its own rule (the log plus the reserve no longer fits): head office
    // says `down`, the shop "cannot trade", and the summary names the store.
    await s.stop(box);
    box = await s.boot('1048576');
    travel(23);
    await box.syncOnce!();
    expect(await box.reportBoxHealth!()).toBe(true);
    const full = await s.observed();
    expect(s.comp(full, 'box_disk:S1')).toMatchObject({ status: 'down' });
    expect(s.comp(full, 'box_disk:S1')!.detail).toMatch(/^store S1's computer CANNOT record another sale/);
    expect(full.observed.signals.localStoreWritable).toBe(false);
    expect(full.health.canTrade).toBe(false);
    expect(s.comp(full, 'local_store')).toMatchObject({ status: 'down' });
    expect(full.health.summary).toContain("store S1's computer CANNOT record another sale");
    expect(full.wouldRaise.map((a) => a.alertId)).toContain('s1-box-disk');
  } finally {
    await s.done();
  }
}

/**
 * Round 13 (verifier B5, probe P3 · P-08): each till is judged by ITS OWN report time. The box relays each till's LAST
 * report, so a fresh box report can carry a till that went quiet long ago: that lane is STALE — unknown, never "ok".
 */
async function aQuietTillIsStaleNotOk(h: ApiHarness, tenant: string): Promise<void> {
  const s = await scene(h, tenant);
  try {
    const disk = { freeBytes: 5_000_000, totalBytes: 9_000_000, salesLogUsedBytes: 10, salesLogCapacityBytes: 10_485_760, reserveBytes: 1_048_576 };
    const report = async (minute: number, tills: unknown[]) => {
      travel(minute);
      const r = await h.request({ method: 'POST', path: '/v1/store-computers/health-reports', userId: 'u-box1', tenantId: tenant, branchId: 'S1', idempotencyKey: `bh-${minute}`,
        body: { observedAt: at(minute), disk, queue: { unsent: 0, deadLettered: 0 }, tills } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return s.comp(await s.observed(), 'till_devices:S1')!;
    };
    const ok = [{ kind: 'scanner', state: 'ok' }, { kind: 'printer', state: 'ok' }];
    // Probe P3: a fresh box report carrying a till report from a DAY ago, saying "ok" — stale, unknown.
    const dayOld = new Date(T0 + 1_440 * 60_000 - 86_400_000).toISOString();
    const p3 = await report(1_440, [{ laneId: 'lane-1', reportedAt: dayOld, devices: ok }]);
    expect(p3.status).toBe('unknown');
    expect(p3.detail).toBe(`STALE — till lane-1 last reported its devices 24h 0m ago (${dayOld}): not heard from since, so its devices are not known now`);
    expect(p3.evidence).toMatchObject({ staleTills: 1, notWorking: 0, staleLanes: `lane-1@${dayOld}` });
    // One till fresh and working, another quiet for 16 minutes: still unknown — the quiet one is named.
    const two = await report(1_460, [{ laneId: 'lane-1', reportedAt: at(1_444), devices: ok }, { laneId: 'lane-2', reportedAt: at(1_459), devices: ok }]);
    expect(two.status).toBe('unknown');
    expect(two.detail).toBe(`every till device at store S1 that reported recently said it was working. STALE — till lane-1 last reported its devices 16 min ago (${at(1_444)}): not heard from since, so its devices are not known now`);
    // A FRESH failure on one till is known now (degraded), with the quiet till still named stale.
    const bad = await report(1_461, [{ laneId: 'lane-1', reportedAt: at(1_444), devices: ok }, { laneId: 'lane-2', reportedAt: at(1_460), devices: [{ kind: 'printer', state: 'failed', detail: 'paper out' }] }]);
    expect(bad.status).toBe('degraded');
    expect(bad.detail).toContain('store S1: lane-2: printer has failed — paper out');
    expect(bad.detail).toContain('STALE — till lane-1 last reported its devices 17 min ago');
    // Every till reported within the threshold and working: ok — the only way to read ok.
    const fresh = await report(1_462, [{ laneId: 'lane-1', reportedAt: at(1_461), devices: ok }, { laneId: 'lane-2', reportedAt: at(1_462), devices: ok }]);
    expect(fresh).toMatchObject({ status: 'ok', detail: 'every till device at store S1 that reported recently said it was working' });
    // Just under the threshold is fresh; at the threshold it is stale (the same 15-minute rule as the box's own report).
    expect((await report(1_476, [{ laneId: 'lane-1', reportedAt: new Date(T0 + 1_476 * 60_000 - 899_000).toISOString(), devices: ok }])).status).toBe('ok');
    expect((await report(1_477, [{ laneId: 'lane-1', reportedAt: at(1_462), devices: ok }])).status).toBe('unknown');
    // P-08: the box says whether anybody is signed in at a quiet till. Signed in and quiet: still unknown, and a till to
    // check (a signed-in till re-sends every 5 minutes); `attended` that is not true/false is refused.
    const checkIt = await report(1_478, [{ laneId: 'lane-1', reportedAt: at(1_462), devices: ok, attended: true }]);
    expect(checkIt.status).toBe('unknown');
    expect(checkIt.detail).toBe(`STALE — till lane-1 last reported its devices 16 min ago (${at(1_462)}) — a cashier IS signed in there, so it should still be re-sending every few minutes: check that till: not heard from since, so its devices are not known now`);
    travel(1_479);
    const garbled = await h.request({ method: 'POST', path: '/v1/store-computers/health-reports', userId: 'u-box1', tenantId: tenant, branchId: 'S1', idempotencyKey: 'bh-attended-garbled',
      body: { observedAt: at(1_479), disk, queue: { unsent: 0, deadLettered: 0 }, tills: [{ laneId: 'lane-1', reportedAt: at(1_479), devices: ok, attended: 'yes' }] } });
    expect(garbled.status).toBe(400);
    expect(JSON.stringify(garbled.body)).toContain('tills[0].attended must be true or false when given');
  } finally {
    await s.done();
  }
}

async function onlyItsOwnComputerReportsIt(h: ApiHarness, tenant: string): Promise<void> {
  const s = await scene(h, tenant);
  try {
    travel(0);
    const good = { observedAt: at(0), disk: { freeBytes: 5_000_000, totalBytes: 9_000_000, salesLogUsedBytes: 10, salesLogCapacityBytes: 10_485_760, reserveBytes: 1_048_576 }, queue: { unsent: 2, deadLettered: 0 }, tills: [] };
    const post = (who: string, branchId: string | undefined, body: unknown, key: string) =>
      h.request({ method: 'POST', path: '/v1/store-computers/health-reports', userId: who, tenantId: tenant, ...(branchId === undefined ? {} : { branchId }), idempotencyKey: key, body });
    const count = async (): Promise<number> => (await boxHealthAdapter({ store: h.store }).records(tenant)).length;

    // OB-54: S1's computer may not speak for S2 — refused at the door, by name, and nothing recorded.
    const forged = await post('u-box1', 'S1', { ...good, storeId: 'S2' }, 'bh-forged');
    expect(forged.status).toBe(403);
    expect(codeOf(forged)).toBe('store_computer_record_names_another_store');
    // A person — cashier, manager or owner — cannot report a store computer's health, even naming the store.
    await h.provisionRole(tenant, 'u-cash-s1', 'cashier', ['S1']);
    await h.provisionRole(tenant, 'u-mgr-s1', 'store_manager', ['S1']);
    for (const who of ['u-cash-s1', 'u-mgr-s1', OWNER]) {
      const r = await post(who, 'S1', { ...good, storeId: 'S1' }, `bh-person-${who}`);
      expect(r.status, `${who} may not report S1's box health`).toBe(403);
    }
    expect(codeOf(await post(OWNER, 'S1', { ...good, storeId: 'S1' }, 'bh-owner-2'))).toBe('not_this_stores_computer');
    // A garbled report is refused and says what it needs.
    const bad = await post('u-box1', 'S1', { observedAt: 'soon', disk: { freeBytes: -1 }, queue: {}, tills: [{ laneId: 'lane-1', reportedAt: at(0), devices: [{ kind: 'toaster', state: 'ok' }] }] }, 'bh-bad');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_box_health');
    expect(await count()).toBe(0);

    // The box itself is accepted (stamped S1); the same report sent twice is one record; a clock ahead is cut back.
    const ok1 = await post('u-box1', 'S1', good, 'bh-once');
    expect(ok1.status).toBe(200);
    expect((ok1.body as { recorded: { storeId: string; reportedBy: string } }).recorded).toMatchObject({ storeId: 'S1', reportedBy: 'u-box1' });
    expect((await post('u-box1', 'S1', good, 'bh-once')).status).toBe(200);
    expect(await count()).toBe(1);
    const ahead = await post('u-box1', 'S1', { ...good, observedAt: at(120) }, 'bh-ahead');
    expect((ahead.body as { recorded: { observedAt: string; clockAheadCorrected: boolean } }).recorded).toMatchObject({ observedAt: at(0), clockAheadCorrected: true });
    // Round 13 (verifier B5 low · hard rule #10): a DIFFERENT report stamped with the same moment is its own record — never
    // collapsed silently onto the first — and head office reads the later arrival; the reply is the record kept.
    expect(await count()).toBe(2);
    const differing = await post('u-box1', 'S1', { ...good, queue: { unsent: 7, deadLettered: 0 } }, 'bh-differing');
    expect(differing.status).toBe(200);
    expect((differing.body as { recorded: { queue: { unsent: number } } }).recorded.queue.unsent).toBe(7);
    expect(await count()).toBe(3);
    expect((await s.observed()).observed.boxes.find((b) => b.storeId === 'S1')).toMatchObject({ queue: { unsent: 7, deadLettered: 0 } });
    // The same report re-sent under a fresh key collapses, and the reply is the record kept.
    const again = await post('u-box1', 'S1', { ...good, queue: { unsent: 7, deadLettered: 0 } }, 'bh-differing-again');
    expect((again.body as { recorded: unknown }).recorded).toEqual((differing.body as { recorded: unknown }).recorded);
    expect(await count()).toBe(3);
    // A reader without the health right cannot read the judged health.
    expect((await h.request({ method: 'GET', path: '/v1/platform/operational-health/observed', userId: 'u-cash-s1', tenantId: tenant, branchId: 'S1' })).status).toBe(403);
  } finally {
    await s.done();
  }
}

describe('M35-FR-03 — the store computer\'s health reaches head office (in memory)', () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterAll(() => { vi.useRealTimers(); });

  it('disk, queue and till devices are judged at head office; a cut-off box is STALE, then fresh after reconnect; a full disk is down', async () => {
    await theBoxHealthReachesHeadOffice(apiHarness(), A);
  }, 60_000);

  it('store-locked: stamped with the credential\'s store; another store, a person, a garbled report are refused; a re-send is one', async () => {
    await onlyItsOwnComputerReportsIt(apiHarness(), A.replace(/01$/, '02'));
  }, 60_000);

  it('round 13 (P3): a till that went quiet is STALE by its own report time — never "ok" on a fresh box report', async () => {
    await aQuietTillIsStaleNotOk(apiHarness(), A.replace(/01$/, '03'));
  }, 60_000);
});

// ── on real PostgreSQL ────────────────────────────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
const PG_TENANT = `b${Date.now().toString(16).slice(-7)}-b801-4bbb-8bbb-${'b'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('M35-FR-03 box health on real PostgreSQL', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterAll(async () => { vi.useRealTimers(); await pool.end(); });
  const harness = (): ApiHarness => { const sql = pgPoolClient(pool); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };

  it('judged at head office, stale through a cut, fresh after reconnect — and a second head-office instance agrees', async () => {
    await theBoxHealthReachesHeadOffice(harness(), PG_TENANT, harness);
  }, 90_000);

  it('store-locked refusals and one record per re-sent report hold on PostgreSQL', async () => {
    await onlyItsOwnComputerReportsIt(harness(), PG_TENANT.replace(/^b/, 'c'));
  }, 90_000);

  it('round 13 (P3): a quiet till is STALE by its own report time on PostgreSQL', async () => {
    await aQuietTillIsStaleNotOk(harness(), PG_TENANT.replace(/^b/, 'd'));
  }, 90_000);
});
