import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTillPeople, issueTillPins, signInOnPhone, type TillPerson } from '../support/till-operator';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { FORGET_KEPT_PAGES_SCRIPT, SIGN_IN_CLOCK_MESSAGE, SIGN_IN_ENDED_MESSAGE, DRIVER_SIGN_IN_ENDED_MESSAGE, signInEndedMessageFor } from '../../edge/store-edge/src/handheld-sign-in';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { deviceBase as boxDoor, trustTheBoxes } from '../support/box-tls';

// OB-422: the handheld door is https; this suite trusts the box's authority as an enrolled phone does.
const fetch = trustTheBoxes(globalThis.fetch);

/**
 * **OB-186 "A" (owner, 17 Oct 2026, "Lock the screen") on the REAL store computer (`startEdge`), no head office.**
 *
 * Every handheld screen the box serves — warehouse, picker, driver — carries, inside its sign-in strip, what the screen
 * locks to when its four hours end: the sign-in page for that job, byte for byte the page the box itself serves at that
 * address (which says the sign-in has ended, and forgets the kept handheld pages). So a phone with no box in reach shows
 * exactly the page it would have been sent to. The script running on the phone is tests/unit/ob186-*.test.ts; a real
 * browser, tests/e2e/ob186-*.e2e.ts. Synthetic data only; nothing touches production (hard rule #7).
 */

const KEY = ['ob186', 'lock', 'box', 'key'].join('-').padEnd(48, '0');
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const PEOPLE: readonly TillPerson[] = [
  { userId: 'u-all', displayName: 'All Jobs', permissions: ['inventory.movement.append', 'fulfilment.pack.record', 'delivery.attempt.record'] },
];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

describe('OB-186: each handheld screen carries the sign-in page it locks to', () => {
  it('warehouse, picker and driver: the lock is the box\'s own sign-in page for that job, saying the sign-in ended', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob186-box-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(withTillPeople({
      version: 1,
      policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
      lossPreventionRules: [],
      warehouse: { assignmentId: 'A-1', workerId: 'u-all', storeId: 'store-1', bins: [{ binId: 'BIN-F', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'frozen' }] },
      devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
    }, PEOPLE)), 'utf8');
    await issueTillPins(dir, KEY, PEOPLE.map((p) => p.userId));
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    const device = boxDoor(edge);
    const enrol = await fetch(`${device}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: CODE }) });
    expect(enrol.status).toBe(200);
    const phone = enrol.headers.get('set-cookie')!.split(';')[0]!;

    for (const screen of ['warehouse', 'picker', 'driver'] as const) {
      const cookie = await signInOnPhone(device, phone, 'u-all', screen);
      const shell = await fetch(`${device}/${screen}/`, { headers: { accept: 'text/html', cookie } });
      expect(shell.status).toBe(200);
      const html = await shell.text();
      const m = /,L=(\{.*?\}),locked=false,/.exec(html);
      expect(m, `${screen} carries the lock`).not.toBeNull();
      const lock = JSON.parse(m![1]!) as { url: string; page: string; clock: { url: string; page: string } };
      expect(lock.url).toBe(`/device/sign-in?screen=${screen}&ended=1`);
      // Byte for byte the page the box serves at that address — said with the reason, forgetting the kept pages.
      const served = await (await fetch(`${device}${lock.url}`, { headers: { accept: 'text/html', cookie: phone } })).text();
      expect(lock.page).toBe(served);
      expect(served).toContain(signInEndedMessageFor(screen).split(' · ')[0]!);
      // OB-187: the driver's screen says twelve hours; warehouse and picker four (OB-184).
      expect(signInEndedMessageFor(screen)).toBe(screen === 'driver' ? DRIVER_SIGN_IN_ENDED_MESSAGE : SIGN_IN_ENDED_MESSAGE);
      expect(html).toContain(screen === 'driver' ? 'Sign-in ends in 12 h 0 min' : 'Sign-in ends in 4 h 0 min');
      // Verifier hh NEW-1: a clock turned back locks to the box's own page for that, saying so.
      expect(lock.clock.url).toBe(`/device/sign-in?screen=${screen}&ended=clock`);
      const servedClock = await (await fetch(`${device}${lock.clock.url}`, { headers: { accept: 'text/html', cookie: phone } })).text();
      expect(lock.clock.page).toBe(servedClock);
      expect(servedClock).toContain(SIGN_IN_CLOCK_MESSAGE.split(' · ')[0]!.replace(/'/g, '&#39;'));
      expect(served).toContain(FORGET_KEPT_PAGES_SCRIPT);
      expect(served).toContain(`action="/device/sign-in?screen=${screen}"`);
      // The page packed in the screen cannot break out of the script it rides in.
      expect(m![1]!).not.toContain('<');
    }
    // The plain sign-in page (no `ended`) is unchanged: no reason given.
    const plain = await (await fetch(`${device}/device/sign-in?screen=warehouse`, { headers: { accept: 'text/html', cookie: phone } })).text();
    expect(plain).not.toContain('class="notice"');
  });
});
