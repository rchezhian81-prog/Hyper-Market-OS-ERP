import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { makeEvent } from '../../packages/contracts/src/event';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';

/**
 * **A picker handheld's outcomes and pack reach head office through the store box's DEVICE socket — enrolled once, durable at
 * every hop, exactly once, every refusal visible (SP-3c-i · ADR-0019 · F11's picker half · M19-FR-01 · M19-FR-02 · D09 · §28 ·
 * §31 · hard rules #1/#2/#4/#6/#10).**
 *
 * Until SP-3c-i the picker's durable queue reached NOBODY: its event types were on no allow-list and had no cloud route (F11).
 * The REAL box (`startEdge` with a device socket, its fsync'd device-events log, its enrolment register, its sync agent)
 * against the REAL cloud (the API harness behind a `fetch` the test can cut or make lose a reply):
 *
 *   • the handheld is turned away from `/picker/` to the enrolment page WITH where it was going; the one-time code enrols it
 *     and sends it back to the picker shell, served with its wave and a same-origin write base; without the cookie the socket
 *     serves nothing; with it a batch is on the box's disk before the device hears `accepted`;
 *   • one sync pass makes a line's outcome head office's fact on the wave register — the PICKER re-verified from their grants,
 *     the box recorded as the relay — and the status route says `posted`; the same batch again is `duplicate` before AND after
 *     a box restart, and nothing is re-sent;
 *   • an outcome whose cloud reply is lost is retried and settles to ONE record;
 *   • the wave's PACK is checked against the line outcomes head office already holds: agreeing → no flags; a crate that
 *     disagrees, or sealed with no temperature, is recorded WITH the disagreement said — never silently accepted, never dropped;
 *   • a picker head office does not know is flagged, not refused; a payload head office cannot read is a visible dead-letter on
 *     the box, with the code in its reason, that survives a restart — and recorded nothing;
 *   • a picker's batch cannot ride as `warehouse`, and a warehouse type cannot ride as `picker`;
 *   • a box with no cloud holds the outcomes, counts them, and will not close the day over them.
 *
 * Nothing here moves stock: an online order's stock was reserved at order time. Synthetic data only (hard rule #7).
 */

const KEY = ['picker', 'handheld', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
const AT = '2026-10-01T10:00:00.000Z';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const packJson = (deviceStatus = 'registered'): string => JSON.stringify({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privilegedActions: [] },
  lossPreventionRules: [],
  wave: {
    waveId: 'W-1', pickerId: 'u-picker',
    lines: [
      { lineId: 'l1', orderRef: 'ORD-1', productId: 'p-rice', description: 'Rice 5kg', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPriceMinor: 100_00 },
      { lineId: 'l2', orderRef: 'ORD-1', productId: 'p-milk', description: 'Milk 1L', bin: 'B-04', requiredQty: 1, uom: 'ea', unitPriceMinor: 60_00 },
    ],
  },
  devices: [{ deviceId: 'hh-02', kind: 'handheld', status: deviceStatus, label: 'Aisle picker', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
});

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A line outcome as the picker handheld queues it (`PickSession.replace`): the wave, the line, the state, who picked. */
const resolved = (lineId: string, state: string, over: Record<string, unknown> = {}, waveId = 'W-1') => makeEvent({
  id: `${waveId}:${lineId}:${state}`, type: 'PickLineResolved', occurredAt: AT, idempotencyKey: `pick:${waveId}:${lineId}:${state}`, source: waveId,
  payload: {
    waveId, lineId, orderRef: 'ORD-1', productId: lineId === 'l1' ? 'p-rice' : 'p-milk', state,
    pickedQty: state === 'picked' ? (lineId === 'l1' ? 2 : 1) : 0, uom: 'ea',
    finalPriceMinor: state === 'picked' ? (lineId === 'l1' ? 200_00 : 60_00) : 0, currency: 'INR',
    substituted: state === 'substituted', note: null, pickedBy: 'u-picker', ...over,
  },
});
/** The wave's pack as the handheld queues it (`PickSession.pack`). */
const packedWave = (over: Record<string, unknown> = {}, waveId = 'W-1') => makeEvent({
  id: `${waveId}:packed`, type: 'WavePacked', occurredAt: AT, idempotencyKey: `pack:${waveId}`, source: waveId,
  payload: { waveId, packedBy: 'u-picker', lineCount: 2, totalValueMinor: 260_00, currency: 'INR', temperatureC: 4, tamperSealRef: 'SEAL-7', ...over },
});
const item = (e: ReturnType<typeof makeEvent>) => ({ key: e.idempotencyKey, event: e });

const deviceBase = (edge: EdgeProcess): string => `http://127.0.0.1:${edge.devices!.port}`;
const enrol = async (edge: EdgeProcess, code = CODE, deviceId = 'hh-02', next?: string): Promise<{ status: number; cookie: string | undefined; body: Record<string, unknown> }> => {
  const res = await savedFetch(`${deviceBase(edge)}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, code, ...(next === undefined ? {} : { next }) }) });
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], body: (await res.json()) as Record<string, unknown> };
};
const postBatch = async (edge: EdgeProcess, cookie: string | undefined, items: unknown[], source = 'picker'): Promise<{ status: number; acks: DeviceAck[]; body: Record<string, unknown> }> => {
  const res = await savedFetch(`${deviceBase(edge)}/lane/outbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify({ source, items }),
  });
  const body = (await res.json()) as Record<string, unknown> & { acks?: DeviceAck[] };
  return { status: res.status, acks: body.acks ?? [], body };
};
const statusOf = async (edge: EdgeProcess, cookie: string, keys: string[]): Promise<BoxItemStatus[]> => {
  const res = await savedFetch(`${deviceBase(edge)}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`, { headers: { cookie } });
  return ((await res.json()) as { items: BoxItemStatus[] }).items;
};
const recordsOn = async (edge: EdgeProcess): Promise<{ idempotencyKey: string; type: string }[]> =>
  (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => { const p = JSON.parse(r.ok ? r.record : '{}') as { idempotencyKey: string; type: string }; return { idempotencyKey: p.idempotencyKey, type: p.type }; });

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

const EDGE_ENV = { EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps' };

async function boxWithoutCloud(dir?: string): Promise<EdgeProcess> {
  const d = dir ?? await tempDir('sre-picker-handheld-nocloud-');
  const packFile = join(d, 'store-pack.json');
  await writeFile(packFile, packJson(), 'utf8');
  const edge = (await startEdge({ ...EDGE_ENV, EDGE_DATA_DIR: d, EDGE_PACK_FILE: packFile }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return edge;
}

interface Cloud { h: ApiHarness; start: (deviceStatus?: string) => Promise<EdgeProcess>; setOnline: (v: boolean) => void; loseNextReply: () => void; posts: () => number }

/** A real cloud — cast: the owner, the picker (a store manager: may pack), the box (a cashier: may relay) — behind a controllable `fetch`. */
async function cloud(): Promise<Cloud> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-picker', 'store_manager');
  await h.provisionRole(A, 'u-box', 'cashier');
  const dir = await tempDir('sre-picker-handheld-cloud-');

  let online = true;
  let lose = false;
  let posts = 0;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!online) throw new Error('ENETUNREACH');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const path = new URL(url).pathname;
    if (path.startsWith('/v1/fulfilment/') && (init.method ?? 'GET') === 'POST') posts += 1;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path,
      token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    if (lose) { lose = false; throw new Error('ECONNRESET'); }
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const start = async (deviceStatus = 'registered'): Promise<EdgeProcess> => {
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, packJson(deviceStatus), 'utf8');
    const edge = (await startEdge({
      ...EDGE_ENV, EDGE_DATA_DIR: dir, EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }),
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { h, start, setOnline: (v) => { online = v; }, loseNextReply: () => { lose = true; }, posts: () => posts };
}

interface WaveView { lines: Record<string, unknown>[]; packed: Record<string, unknown> | null; flags: string[]; crate: { lineCount: number; totalValueMinor: number } }
const waveAt = async (h: ApiHarness, waveId = 'W-1'): Promise<WaveView> =>
  (await h.request({ method: 'GET', path: `/v1/fulfilment/waves/${waveId}`, userId: 'u-owner', tenantId: A })).body as WaveView;

describe('the picker handheld: enrol → device socket → box (durable) → head office (once)', () => {
  it('is sent to enrol WITH where it was going; the code enrols it back to the picker shell; a line outcome is on the box\'s disk before accepted, reaches the wave register once with the picker re-verified, and is duplicate before and after a restart', async () => {
    const c = await cloud();
    const first = await c.start();
    const e = resolved('l1', 'picked');
    // No cookie: nothing — not the shell, not the routes; the redirect names the picker shell as where to come back to.
    expect((await postBatch(first, undefined, [item(e)])).status).toBe(403);
    const away = await savedFetch(`${deviceBase(first)}/picker/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(away.status).toBe(302);
    expect(away.headers.get('location')).toBe('/device/enrol?why=no_credential&next=%2Fpicker%2F');
    expect((await enrol(first, 'ABCDE-FGHJK-LMNPQ-RSTUW')).status).toBe(403);
    const { status: enrolStatus, cookie, body } = await enrol(first, CODE, 'hh-02', '/picker/');
    expect(enrolStatus).toBe(200);
    expect(body).toEqual({ enrolled: true, deviceId: 'hh-02', next: '/picker/' });
    expect(cookie).toMatch(/^sre_device=hh-02\./);
    // The picker shell now comes with its wave and a same-origin write base.
    const shell = await (await savedFetch(`${deviceBase(first)}/picker/`, { headers: { accept: 'text/html', cookie: cookie! } })).text();
    expect(shell).toContain('"waveId":"W-1"');
    expect(shell).toContain('"pickerId":"u-picker"');
    expect(shell).toContain('window.laneWriteBase = "";');

    const { status, acks } = await postBatch(first, cookie, [item(e)]);
    expect(status).toBe(200);
    expect(acks).toEqual([{ key: 'pick:W-1:l1:picked', status: 'accepted' }]);
    expect(await recordsOn(first)).toEqual([{ idempotencyKey: 'pick:W-1:l1:picked', type: 'PickLineResolved' }]);
    expect((await waveAt(c.h)).lines).toEqual([]); // nothing at head office yet — the box has it

    const pass = await first.syncOnce!();
    expect(pass.sent).toBe(1);
    expect(pass.dead).toBe(0);
    const wave = await waveAt(c.h);
    expect(wave.lines).toEqual([expect.objectContaining({ lineId: 'l1', state: 'picked', pickedQty: 2, finalPriceMinor: 200_00, pickedBy: 'u-picker', relayedBy: 'u-box', governanceFlags: [], outcomesRecorded: 1 })]);
    expect(wave.flags).toEqual([]);
    expect((await statusOf(first, cookie!, ['pick:W-1:l1:picked']))[0]?.state).toBe('posted');

    expect((await postBatch(first, cookie, [item(e)])).acks).toEqual([{ key: 'pick:W-1:l1:picked', status: 'duplicate' }]);
    await first.stop();
    cleanups.pop();
    // After a restart the enrolment still holds (the register is on the disk) and the record is still known.
    const second = await c.start();
    expect((await postBatch(second, cookie, [item(e)])).acks).toEqual([{ key: 'pick:W-1:l1:picked', status: 'duplicate' }]);
    await second.syncOnce!();
    expect(c.posts()).toBe(1);
    expect((await waveAt(c.h)).lines).toHaveLength(1);
    expect(second.enrolments!.enrolled().map((d) => d.deviceId)).toEqual(['hh-02']);
  });

  it('an outcome whose cloud reply is lost is retried and settles to ONE record on the register (RR-F02)', async () => {
    const c = await cloud();
    const edge = await c.start();
    const { cookie } = await enrol(edge);
    const e = resolved('l2', 'picked');
    await postBatch(edge, cookie, [item(e)]);
    c.loseNextReply();
    const first = await edge.syncOnce!();
    expect(first.sent).toBe(0);
    expect(edge.deviceEventsOutbox.find('pick:W-1:l2:picked')).toMatchObject({ state: 'pending', attempts: 1 });
    expect((await waveAt(c.h)).lines).toHaveLength(1); // the cloud DID record it; the reply was what got lost
    const second = await edge.syncOnce!();
    expect(second.sent).toBe(1);
    const wave = await waveAt(c.h);
    expect(wave.lines).toHaveLength(1);
    expect(wave.lines[0]).toMatchObject({ lineId: 'l2', outcomesRecorded: 1 }); // once
    expect(c.posts()).toBe(2);
    expect((await statusOf(edge, cookie!, ['pick:W-1:l2:picked']))[0]?.state).toBe('posted');
  });

  it('the wave\'s pack is checked against the outcomes head office holds: agreeing → no flags; a crate that disagrees or was sealed warm is recorded WITH the disagreement said; a re-sent pack is one record', async () => {
    const c = await cloud();
    const edge = await c.start();
    const { cookie } = await enrol(edge);
    // Both lines resolved: l1 picked (₹200), l2 rejected on quality — the crate head office can prove holds 1 line, ₹200.
    const l1 = resolved('l1', 'picked');
    const l2 = resolved('l2', 'quality_failed', { note: 'damaged' });
    const pack = packedWave({ lineCount: 1, totalValueMinor: 200_00 });
    const batch = await postBatch(edge, cookie, [item(l1), item(l2), item(pack)]);
    expect(batch.acks.map((a) => a.status)).toEqual(['accepted', 'accepted', 'accepted']);
    const pass = await edge.syncOnce!();
    expect(pass.sent).toBe(3);
    expect(pass.dead).toBe(0);
    const wave = await waveAt(c.h);
    expect(wave.crate).toEqual({ lineCount: 1, totalValueMinor: 200_00 });
    expect(wave.packed).toMatchObject({ packedBy: 'u-picker', relayedBy: 'u-box', lineCount: 1, totalValueMinor: 200_00, temperatureC: 4, tamperSealRef: 'SEAL-7', fromLines: { lineCount: 1, totalValueMinor: 200_00 }, governanceFlags: [] });
    expect(wave.flags).toEqual([]);
    expect((await statusOf(edge, cookie!, ['pick:W-1:l1:picked', 'pick:W-1:l2:quality_failed', 'pack:W-1'])).map((i) => i.state)).toEqual(['posted', 'posted', 'posted']);

    // The handheld re-sending the pack after a lost reply is duplicate at the box; a second pass reaches head office with nothing new.
    expect((await postBatch(edge, cookie, [item(pack)])).acks).toEqual([{ key: 'pack:W-1', status: 'duplicate' }]);
    await edge.syncOnce!();
    expect(c.posts()).toBe(3);

    // A second wave whose pack claims more than its lines support, sealed with no temperature: recorded, flagged, never refused.
    const m1 = resolved('l1', 'picked', {}, 'W-2');
    const badPack = packedWave({ lineCount: 2, totalValueMinor: 300_00, temperatureC: null }, 'W-2');
    expect((await postBatch(edge, cookie, [item(m1), item(badPack)])).acks.map((a) => a.status)).toEqual(['accepted', 'accepted']);
    const pass2 = await edge.syncOnce!();
    expect(pass2.sent).toBe(2);
    expect(pass2.dead).toBe(0);
    const w2 = await waveAt(c.h, 'W-2');
    expect(w2.packed).toMatchObject({ lineCount: 2, totalValueMinor: 300_00, temperatureC: null, fromLines: { lineCount: 1, totalValueMinor: 200_00 }, governanceFlags: ['lines_disagree', 'no_cold_chain_temperature'] });
    expect(w2.flags).toEqual(['lines_disagree', 'no_cold_chain_temperature']);
    expect((await statusOf(edge, cookie!, ['pack:W-2']))[0]?.state).toBe('posted');
  });

  it('a picker head office does not know is flagged, not refused; a payload head office cannot read is a visible dead-letter on the box with the code in its reason, survives a restart, and recorded nothing', async () => {
    const c = await cloud();
    const first = await c.start();
    const { cookie } = await enrol(first);
    const stranger = resolved('l1', 'picked', { pickedBy: 'u-stranger' });
    const unreadable = resolved('l2', 'pending'); // not an outcome — a line nobody resolved sends nothing
    expect((await postBatch(first, cookie, [item(stranger), item(unreadable)])).acks.map((a) => a.status)).toEqual(['accepted', 'accepted']);
    const pass = await first.syncOnce!();
    expect(pass.sent).toBe(1);
    expect(pass.dead).toBe(1);
    const wave = await waveAt(c.h);
    expect(wave.lines).toEqual([expect.objectContaining({ lineId: 'l1', governanceFlags: ['picker_unknown'] })]);
    expect(wave.flags).toEqual(['picker_unknown']);
    const status = await statusOf(first, cookie!, ['pick:W-1:l1:picked', 'pick:W-1:l2:pending']);
    expect(status[0]?.state).toBe('posted');
    expect(status[1]?.state).toBe('refused');
    expect(status[1]?.reason).toMatch(/not_readable_as_a_pick_outcome/);
    await first.stop();
    cleanups.pop();
    const second = await c.start();
    const after = await statusOf(second, cookie!, ['pick:W-1:l2:pending']);
    expect(after[0]?.state).toBe('refused');
    expect(after[0]?.reason).toMatch(/not_readable_as_a_pick_outcome/);
    expect((await waveAt(c.h)).lines).toHaveLength(1);
  });

  it('a picker\'s batch cannot ride as the warehouse, and a warehouse type cannot ride as the picker — refused at the box, never taken', async () => {
    const c = await cloud();
    const edge = await c.start();
    const { cookie } = await enrol(edge);
    const e = resolved('l1', 'picked');
    const asWarehouse = await postBatch(edge, cookie, [item(e)], 'warehouse');
    expect(asWarehouse.status).toBe(200);
    expect(asWarehouse.acks).toEqual([{ key: 'pick:W-1:l1:picked', status: 'refused', reason: 'PickLineResolved is not a record this box relays for warehouse' }]);
    const move = makeEvent({ id: 'wh-move-x', type: 'WarehouseMovementApplied', occurredAt: AT, idempotencyKey: 'wh-move:x', source: 'A-1', payload: { commandId: 'x', movedBy: 'u-picker', command: {} } });
    expect((await postBatch(edge, cookie, [item(move)], 'picker')).acks[0]).toMatchObject({ status: 'refused', reason: 'WarehouseMovementApplied is not a record this box relays for picker' });
    expect((await postBatch(edge, cookie, [item(e)], 'manager')).status).toBe(403);
    expect(await recordsOn(edge)).toEqual([]);
  });

  it('a box with no cloud takes the outcomes, holds them durably across a restart, counts them, and will not close the day over them', async () => {
    const dir = await tempDir('sre-picker-handheld-hold-');
    const first = await boxWithoutCloud(dir);
    const { cookie } = await enrol(first);
    const l1 = resolved('l1', 'picked');
    const pack = packedWave({ lineCount: 1, totalValueMinor: 200_00 });
    expect((await postBatch(first, cookie, [item(l1), item(pack)])).acks.map((a) => a.status)).toEqual(['accepted', 'accepted']);
    expect(first.syncStatus()).toMatchObject({ cloud: 'not_configured', unsent: 2 });
    expect((await first.closeDay({ dayCloseId: 'dc-1', closedBy: 'u-mgr' })).closed).toBe(false);
    await first.stop();
    cleanups.pop();
    const second = await boxWithoutCloud(dir);
    expect(second.deviceEventsOutbox.pending().map((i) => i.key)).toEqual(['pick:W-1:l1:picked', 'pack:W-1']);
    expect(second.syncStatus().unsent).toBe(2);
    expect((await postBatch(second, cookie, [item(pack)])).acks).toEqual([{ key: 'pack:W-1', status: 'duplicate' }]);
  });
});
