import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  readFloorDeviceRegistration, readFloorEvent, canonicalJson, deviceBatchMessage, admitBatch, rfidCountObservation, linkCameraEvents,
  FLOOR_DEVICE_SWITCH, FLOOR_EVENTS_PER_BATCH,
} from '../../packages/integration/src/floor-devices';
import { floorDevices, judgePush, type EslPush, type StoredFloorEvent } from '../../services/platform/src/device-events';
import { keyIsEd25519, verifiesWith, StandInEslVendor } from '../../services/api/src/floor-devices-adapters';

// R8-4 to R8-7 (D14-FR-05 · OB-217 · OB-316): the vendor-neutral floor-device rules, pure. Keys are made at run time.

const NOW = '2026-10-24T10:00:00.000Z';
const pem = (): { publicKey: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } => {
  const k = generateKeyPairSync('ed25519');
  return { publicKey: k.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: k.privateKey };
};

describe('registering a floor device', () => {
  const key = pem().publicKey;
  it('binds each kind to the one thing it watches, and refuses anything less by name', () => {
    expect(readFloorDeviceRegistration('esl-1', { kind: 'esl_label', branchId: 'B1', label: 'L', vendor: 'stand-in', publicKey: key, productId: 'p1', shelfAddress: 'A1-01' }))
      .toMatchObject({ ok: true, value: { binding: { kind: 'esl_label', productId: 'p1', shelfAddress: 'A1-01' } } });
    expect(readFloorDeviceRegistration('cam-1', { kind: 'cctv_source', branchId: 'B1', label: 'C', vendor: 'stand-in', publicKey: key, cameraId: 'CAM', laneIds: ['lane-2', 'lane-1', 'lane-2'] }))
      .toMatchObject({ ok: true, value: { binding: { laneIds: ['lane-1', 'lane-2'] } } });
    expect(readFloorDeviceRegistration('r-1', { kind: 'rfid_reader', branchId: 'B1', label: 'R', vendor: 'v', publicKey: key })).toMatchObject({ ok: false, code: 'device_binding_not_given' });
    expect(readFloorDeviceRegistration('i-1', { kind: 'iot_sensor', branchId: 'B1', label: 'I', vendor: 'v', publicKey: 'not a key', assetId: 'A' })).toMatchObject({ ok: false, code: 'device_key_not_given' });
    expect(readFloorDeviceRegistration('bad id!', {})).toMatchObject({ ok: false, code: 'not_a_device_id' });
    expect(readFloorDeviceRegistration('x', { kind: 'drone' })).toMatchObject({ ok: false, code: 'not_a_floor_device_kind' });
  });
  it('each kind sits behind its own rollout switch (OB-316)', () => {
    expect(FLOOR_DEVICE_SWITCH).toEqual({ esl_label: 'esl', rfid_reader: 'rfid', iot_sensor: 'iot', cctv_source: 'cctv' });
  });
  it('only an Ed25519 key is accepted, and a signature verifies only over the exact bytes', () => {
    const d = pem();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect([keyIsEd25519(d.publicKey), keyIsEd25519(rsa), keyIsEd25519('garbage')]).toEqual([true, false, false]);
    const events = [{ eventId: 'e1', type: 'esl.echo', at: NOW, productId: 'p1', displayedPriceMinor: 100 }];
    const sig = sign(null, Buffer.from(deviceBatchMessage('esl-1', events)), d.privateKey).toString('base64');
    expect(verifiesWith(d.publicKey, deviceBatchMessage('esl-1', events), sig)).toBe(true);
    // Key order does not matter (canonical); a changed value or another device id does.
    expect(verifiesWith(d.publicKey, deviceBatchMessage('esl-1', [{ displayedPriceMinor: 100, productId: 'p1', at: NOW, type: 'esl.echo', eventId: 'e1' }]), sig)).toBe(true);
    expect(verifiesWith(d.publicKey, deviceBatchMessage('esl-1', [{ ...events[0], displayedPriceMinor: 1 }]), sig)).toBe(false);
    expect(verifiesWith(d.publicKey, deviceBatchMessage('esl-2', events), sig)).toBe(false);
    expect(verifiesWith(d.publicKey, deviceBatchMessage('esl-1', events), 'not-base64!!')).toBe(false);
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
  });
});

describe('reading what a device sends', () => {
  it('keeps only the fields a kind may carry', () => {
    expect(readFloorEvent('esl_label', { eventId: 'e1', type: 'esl.echo', at: NOW, productId: 'p1', displayedPriceMinor: 4500, batteryPercent: 12 }, NOW))
      .toMatchObject({ ok: true, value: { type: 'esl.echo', displayedPriceMinor: 4500, batteryPercent: 12 } });
    expect(readFloorEvent('esl_label', { eventId: 'e1', type: 'esl.echo', at: NOW, productId: 'p1', displayedPriceMinor: 4500, colour: 'red' }, NOW)).toMatchObject({ ok: false, code: 'field_not_allowed' });
    expect(readFloorEvent('esl_label', { eventId: 'e1', type: 'rfid.read', at: NOW }, NOW)).toMatchObject({ ok: false, code: 'wrong_event_type_for_device' });
    expect(readFloorEvent('rfid_reader', { eventId: 'r1', type: 'rfid.read', at: NOW, productId: 'p1', countedUnits: -1 }, NOW)).toMatchObject({ ok: false, code: 'not_readable_as_an_rfid_read' });
    expect(readFloorEvent('iot_sensor', { eventId: 'i1', type: 'iot.reading', at: NOW, tenthsC: 3.5 }, NOW)).toMatchObject({ ok: false, code: 'not_readable_as_a_sensor_reading' });
    expect(readFloorEvent('iot_sensor', { eventId: 'i1', type: 'iot.reading', at: '2026-10-24T10:06:00.000Z', tenthsC: 35 }, NOW)).toMatchObject({ ok: false, code: 'event_in_the_future' });
    expect(readFloorEvent('iot_sensor', { eventId: 'i1', type: 'iot.reading', at: '2026-10-24T10:04:00.000Z', tenthsC: 35 }, NOW)).toMatchObject({ ok: true });
  });
  it('a camera event is metadata only: footage or anything that identifies a person is refused by name (OB-217)', () => {
    const base = { eventId: 'c1', type: 'cctv.event', at: NOW, from: '2026-10-24T09:58:00.000Z', to: NOW, eventKind: 'lane_activity' };
    expect(readFloorEvent('cctv_source', base, NOW)).toMatchObject({ ok: true, value: { eventKind: 'lane_activity' } });
    for (const f of ['video', 'image', 'snapshot', 'url', 'faceId', 'numberPlate']) {
      const r = readFloorEvent('cctv_source', { ...base, [f]: 'x' }, NOW);
      expect(r, f).toMatchObject({ ok: false, code: 'footage_or_identity_not_kept' });
      expect(!r.ok && r.detail).toContain(f);
    }
    expect(readFloorEvent('cctv_source', { ...base, from: NOW, to: '2026-10-24T09:58:00.000Z' }, NOW)).toMatchObject({ ok: false, code: 'camera_period_backwards' });
  });
  it('a batch too large, or a device sending too fast, is refused whole — nothing kept', () => {
    expect(admitBatch({ recent: [], incoming: FLOOR_EVENTS_PER_BATCH + 1, now: NOW })).toMatchObject({ admitted: false, code: 'batch_too_large' });
    const recent = Array.from({ length: 10 }, () => '2026-10-24T09:59:30.000Z');
    expect(admitBatch({ recent, incoming: 5, now: NOW, perMinute: 12 })).toMatchObject({ admitted: false, code: 'device_sending_too_fast', retryAfterSeconds: 60 });
    expect(admitBatch({ recent: Array.from({ length: 10 }, () => '2026-10-24T09:58:00.000Z'), incoming: 5, now: NOW, perMinute: 12 })).toEqual({ admitted: true });
  });
});

describe('what an event means — never a ledger edit', () => {
  it('an RFID count is compared with the book: agrees, a variance, or not comparable (said why)', () => {
    expect(rfidCountObservation(40, { known: true, units: 40 })).toMatchObject({ state: 'agrees', differenceUnits: 0 });
    expect(rfidCountObservation(37, { known: true, units: 40 })).toMatchObject({ state: 'variance', differenceUnits: -3, detail: expect.stringContaining('NOT changed') });
    expect(rfidCountObservation(5, { known: false, why: 'it is sold by kg' })).toMatchObject({ state: 'not_comparable', bookUnits: null, differenceUnits: null, detail: expect.stringContaining('sold by kg') });
  });
  it('a camera event links the exceptions at ITS lanes inside ITS period — nothing invented, nobody blamed', () => {
    const links = linkCameraEvents(
      [{ eventId: 'c1', deviceId: 'cam-1', cameraId: 'CAM', laneIds: ['lane-1'], from: '2026-10-24T09:00:00.000Z', to: '2026-10-24T09:10:00.000Z', eventKind: 'lane_activity' }],
      [
        { ref: 'a', laneId: 'lane-1', at: '2026-10-24T09:05:00.000Z', kind: 'void', cashierId: 'u1', valueMinor: 10, detail: '' },
        { ref: 'b', laneId: 'lane-2', at: '2026-10-24T09:05:00.000Z', kind: 'void', cashierId: 'u1', valueMinor: 10, detail: '' },
        { ref: 'c', laneId: 'lane-1', at: '2026-10-24T09:11:00.000Z', kind: 'no_sale', cashierId: 'u1', valueMinor: 0, detail: '' },
      ],
    );
    expect(links.map((l) => [l.eventId, l.exceptions.map((x) => x.ref)])).toEqual([['c1', ['a']]]);
    expect(links[0]!.cctvReference).toEqual({ cameraId: 'CAM', from: '2026-10-24T09:00:00.000Z', to: '2026-10-24T09:10:00.000Z' });
  });
  it('a price push is safe at the till only once every label LAST showed the new price', () => {
    const push: EslPush = { pushId: 'p', branchId: 'B1', productId: 'p1', priceMinor: 4500, because: 'price_change', sourceRef: 's', by: 'u', at: NOW, commands: [{ deviceId: 'a', accepted: true, detail: '' }, { deviceId: 'b', accepted: true, detail: '' }], adapter: 'stand-in' };
    const echo = (deviceId: string, at: string, price: number, batteryPercent?: number): StoredFloorEvent => ({
      deviceId, branchId: 'B1', kind: 'esl_label', eventId: `${deviceId}-${at}`, receivedAt: at, relayedBy: 'gw',
      event: { type: 'esl.echo', eventId: `${deviceId}-${at}`, at, productId: 'p1', displayedPriceMinor: price, ...(batteryPercent === undefined ? {} : { batteryPercent }) },
      outcome: { state: 'recorded', detail: '' },
    });
    expect(judgePush(push, [echo('a', '2026-10-24T10:01:00.000Z', 4500)])).toMatchObject({ confirmed: ['a'], unconfirmed: ['b'], safeToChangeAtTill: false });
    // An echo from BEFORE the push is not a confirmation of it.
    expect(judgePush(push, [echo('a', '2026-10-24T09:00:00.000Z', 4500), echo('b', '2026-10-24T10:01:00.000Z', 4500)])).toMatchObject({ confirmed: ['b'], unconfirmed: ['a'] });
    expect(judgePush(push, [echo('a', '2026-10-24T10:01:00.000Z', 4500), echo('b', '2026-10-24T10:01:00.000Z', 4500, 9)])).toMatchObject({ outcome: 'stale_battery', safeToChangeAtTill: true });
    // A label that later shows something else no longer confirms.
    expect(judgePush(push, [echo('a', '2026-10-24T10:01:00.000Z', 4500), echo('b', '2026-10-24T10:01:00.000Z', 4500), echo('a', '2026-10-24T10:02:00.000Z', 4000)])).toMatchObject({ unconfirmed: ['a'], safeToChangeAtTill: false });
  });
  it('the fleet folds registrations and status changes; retired is final', () => {
    const registration = { deviceId: 'd', branchId: 'B1', label: 'L', vendor: 'v', publicKey: 'k', binding: { kind: 'rfid_reader' as const, locationId: 'B1' } };
    expect(floorDevices([
      { entry: 'registered', registration, by: 'u', at: NOW },
      { entry: 'status', deviceId: 'd', status: 'retired', reason: 'old', by: 'u', at: NOW },
      { entry: 'status', deviceId: 'd', status: 'active', reason: 'try', by: 'u', at: NOW },
      { entry: 'status', deviceId: 'ghost', status: 'blocked', reason: 'x', by: 'u', at: NOW },
    ]).map((d) => [d.deviceId, d.status])).toEqual([['d', 'retired']]);
  });
  it('the stand-in vendor records commands and never reaches real hardware', async () => {
    const v = new StandInEslVendor();
    v.unreachable.add('b');
    expect(await v.push({ pushId: 'p', deviceId: 'a', vendor: 'x', productId: 'p1', shelfAddress: 'A1', priceMinor: 1 })).toMatchObject({ accepted: true, detail: expect.stringContaining('nothing was sent to real hardware') });
    expect(await v.push({ pushId: 'p', deviceId: 'b', vendor: 'x', productId: 'p1', shelfAddress: 'A1', priceMinor: 1 })).toMatchObject({ accepted: false });
    expect(v.sent).toHaveLength(1);
    expect(v.name).toContain('not verified on hardware');
  });
});
