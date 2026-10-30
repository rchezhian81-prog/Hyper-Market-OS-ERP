import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { prepareTillBox, signInOnPhone, pinOf } from '../support/till-operator';
import { TEST_PACK_KEY } from '../support/api-harness';
import { deviceBase as boxDoor, trustTheBoxes } from '../support/box-tls';

/**
 * **OB-606 / OB-607 (round 16, R16-A · P1): every page the store computer serves is told the shop's zone from its signed
 * store pack — the handhelds on the shop wifi and the queue till too, not only the office screens.**
 *
 * Before round 16 only the screens server (screen-server.ts) put `window.shopTimeZone` on its pages. The handheld door
 * (device-server.ts) and the queue till's door (queue-pos-door.ts) served their pages WITHOUT it, so a handheld page fell
 * back to the shop default (Asia/Kolkata) whatever the pack said — wrong for any shop whose pack names another zone. Here a
 * real box (`startEdge`, no cloud: offline) holds a pack whose zone is NOT India (Asia/Dubai), and each of the three doors
 * serves its page with that zone: the till page from the screens server, the warehouse handheld page and the queue till
 * page from the handheld door. No network call is made for it.
 */

const ZONE = 'Asia/Dubai';
const CODE = 'ZONEA-ZONEB-ZONEC-ZONED';
const PEOPLE = [
  { userId: 'u-worker', displayName: 'Worker One', permissions: ['inventory.movement.append'] },
  { userId: 'u-ravi', displayName: 'Ravi' },
];

const fetchTrusting = trustTheBoxes(globalThis.fetch);
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const zoneOn = (html: string): string | undefined => /<script>window\.shopTimeZone = (".*?");<\/script>/.exec(html)?.[1] === undefined
  ? undefined : JSON.parse(/<script>window\.shopTimeZone = (".*?");<\/script>/.exec(html)![1]!) as string;

async function box(timeZone: string | undefined): Promise<EdgeProcess> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-r16a-zone-'));
  dirs.push(dir);
  const ready = await prepareTillBox({
    dir, key: TEST_PACK_KEY, people: PEOPLE,
    pack: {
      version: 1,
      policies: { tradingDayCutoff: '00:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1', ...(timeZone === undefined ? {} : { timeZone }) },
      lossPreventionRules: [],
      warehouse: { assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: [] },
      devices: [{ deviceId: 'hh-z1', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
      rollout: { format: 'sre-rollout/1', branchId: 'store-1', switches: [
        { key: 'pos.queue_busting', branch: null, lanes: [{ laneId: 'lane-1', enabled: true, version: 1 }] },
      ] },
    },
  });
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', ...ready,
  }, () => {}))!;
  stops.push(() => edge.stop());
  return edge;
}

/** The zone each of the three doors serves its page with. */
async function zonesServed(edge: EdgeProcess): Promise<{ till: string | undefined; warehouse: string | undefined; queueTill: string | undefined }> {
  const till = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`, { headers: { accept: 'text/html' } })).text();
  const door = boxDoor(edge);
  const enrolled = await fetchTrusting(`${door}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-z1', code: CODE }) });
  expect(enrolled.status).toBe(200);
  const deviceCookie = enrolled.headers.get('set-cookie')!.split(';')[0]!;
  const warehouseCookie = await signInOnPhone(door, deviceCookie, 'u-worker', 'warehouse');
  const warehouse = await (await fetchTrusting(`${door}/warehouse/`, { headers: { accept: 'text/html', cookie: warehouseCookie } })).text();
  expect(warehouse).toContain('window.warehouseData');
  const selling = await fetchTrusting(`${door}/queue-pos/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: deviceCookie }, body: JSON.stringify({ staffId: 'u-ravi', pin: pinOf('u-ravi') }) });
  expect(selling.status, await selling.clone().text()).toBe(200);
  const queueCookie = `${deviceCookie}; ${selling.headers.get('set-cookie')!.split(';')[0]!}`;
  const queuePage = await fetchTrusting(`${door}/queue-pos/`, { headers: { accept: 'text/html', cookie: queueCookie } });
  expect(queuePage.status).toBe(200);
  const queueTill = await queuePage.text();
  expect(queueTill).toContain('window.queuePos');
  return { till: zoneOn(till), warehouse: zoneOn(warehouse), queueTill: zoneOn(queueTill) };
}

describe('every door of the store computer gives its page the shop\'s zone from the pack (OB-606/607 · R16-A)', () => {
  it('a pack naming Asia/Dubai: the till page, the warehouse handheld page and the queue till page are each served Asia/Dubai', async () => {
    expect(await zonesServed(await box(ZONE))).toEqual({ till: ZONE, warehouse: ZONE, queueTill: ZONE });
  });

  it('a pack naming no zone: each door serves the shop default (Asia/Kolkata), never the machine\'s own zone', async () => {
    expect(await zonesServed(await box(undefined))).toEqual({ till: 'Asia/Kolkata', warehouse: 'Asia/Kolkata', queueTill: 'Asia/Kolkata' });
  });
});
