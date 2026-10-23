import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  sha256Hex, sha256HexOfText, bytesOfBase64, newDeliveryCode, isDeliveryCode, judgeCode, judgeProofLocation, isFix, proofRefOf, customerEta,
} from '../../packages/fulfilment/src/index';

// M19-FR-03 · OB-294 · D09-FR-05 · D08-FR-05 — the proof is captured, not typed: the 4-digit code judged at head office,
// the proof location judged against the stored coordinates (only the verdict kept), the phone's own fingerprint of an
// image, and the customer's ETA from the route. Synthetic data.

describe('the phone\'s fingerprint is the same SHA-256 head office computes', () => {
  it('agrees with node\'s own digest over many lengths, including the block edges', () => {
    for (const n of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000, 4096, 40_000]) {
      const bytes = randomBytes(n);
      expect(sha256Hex(new Uint8Array(bytes))).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(sha256HexOfText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('reads base64 exactly as Buffer does, and refuses what is not base64 rather than guessing', () => {
    for (const n of [1, 2, 3, 10, 1000]) {
      const bytes = randomBytes(n);
      expect(Buffer.from(bytesOfBase64(bytes.toString('base64'))!)).toEqual(bytes);
    }
    expect(bytesOfBase64('not base64!')).toBeUndefined();
    expect(bytesOfBase64('abc')).toBeUndefined();
    expect(bytesOfBase64('')).toBeUndefined();
  });
});

describe('the delivery code (OB-294: 4 digits, issued by head office, read out by the customer)', () => {
  it('is four digits from the random source — leading zeros kept — and nothing outside 0–9999 is accepted', () => {
    expect(newDeliveryCode(() => 42)).toBe('0042');
    expect(newDeliveryCode(() => 9999)).toBe('9999');
    expect(() => newDeliveryCode(() => 10_000)).toThrow(RangeError);
    expect(() => newDeliveryCode(() => 1.5)).toThrow(RangeError);
    for (const ok of ['0000', '0042', '9999']) expect(isDeliveryCode(ok)).toBe(true);
    for (const bad of ['42', '12345', '12a4', ' 1234', 1234, undefined]) expect(isDeliveryCode(bad)).toBe(false);
  });
  it('is judged at head office: matched, wrong, never issued, or not a code proof', () => {
    expect(judgeCode('0042', '0042')).toBe('matched');
    expect(judgeCode('0042', '0043')).toBe('wrong');
    expect(judgeCode('0042', '42')).toBe('wrong');
    expect(judgeCode(undefined, '0042')).toBe('not_issued');
    expect(judgeCode('0042', undefined)).toBe('not_given');
  });
  it('leaves the phone a reference that is not the code', () => {
    expect(proofRefOf('otp', '0042')).not.toContain('0042');
    expect(proofRefOf('photo', 'ab'.repeat(32))).toBe(`photo:sha256:${'ab'.repeat(32)}`);
  });
});

describe('the proof location (D09-FR-05) — judged against the stored coordinates; only the verdict is kept', () => {
  const STOP = { lat: 11.0168, lon: 76.9558 };
  const NEAR = { lat: 11.0170, lon: 76.9559, accuracyMetres: 12.4 }; // ~25 m
  const FAR = { lat: 11.0300, lon: 76.9700 }; // ~2 km
  it('says inside / outside the owner\'s radius, with the distance and the phone\'s accuracy — never the coordinates', () => {
    const inside = judgeProofLocation({ device: NEAR, stopAt: STOP, radiusMetres: 100 });
    expect(inside).toEqual({ result: 'inside', distanceMetres: expect.any(Number), radiusMetres: 100, accuracyMetres: 12 });
    expect((inside as { distanceMetres: number }).distanceMetres).toBeLessThan(50);
    expect(judgeProofLocation({ device: FAR, stopAt: STOP, radiusMetres: 100 }).result).toBe('outside');
    expect(JSON.stringify(inside)).not.toMatch(/lat|lon|11\.01|76\.95/);
  });
  it('decides nothing while the owner has not entered the radius — it says "radius not set" and the distance', () => {
    expect(judgeProofLocation({ device: FAR, stopAt: STOP, radiusMetres: undefined })).toEqual({ result: 'radius_not_set', distanceMetres: expect.any(Number) });
  });
  it('says so when the phone gave no location, or head office holds none for the stop — never a block, never a guess', () => {
    expect(judgeProofLocation({ device: undefined, stopAt: STOP, radiusMetres: 100 })).toEqual({ result: 'no_device_location' });
    expect(judgeProofLocation({ device: NEAR, stopAt: undefined, radiusMetres: 100 })).toEqual({ result: 'no_address_location' });
  });
  it('reads a phone fix strictly', () => {
    expect(isFix({ lat: 11, lon: 76 })).toBe(true);
    for (const bad of [null, {}, { lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: 'x', lon: 0 }, { lat: 0, lon: 0, accuracyMetres: -1 }]) expect(isFix(bad)).toBe(false);
  });
});

describe('the customer\'s ETA (D08-FR-05) — the last stamped stop, from the route; an estimate, said so', () => {
  const at = (h: number, m = 0) => `2026-10-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  const stops = [1, 2, 3, 4].map((n) => ({ stopId: `s${n}`, orderId: `O${n}`, sequence: n, plannedArrivalAt: at(5, n * 10) }));
  it('is "not on a route" until head office puts the order on one', () => {
    expect(customerEta({ orderId: 'O9', stops, stamps: [] })).toMatchObject({ state: 'not_on_a_route', estimatedArrivalAt: null, stopsOnRun: 0 });
  });
  it('before any stop is stamped: the plan\'s own time and how many stops come first', () => {
    expect(customerEta({ orderId: 'O3', stops, stamps: [] })).toMatchObject({ state: 'not_started', stopsBeforeYou: 2, estimatedArrivalAt: at(5, 30), behindPlanMinutes: 0, estimateIs: 'straight_line_estimate' });
  });
  it('moves the estimate later by how late the driver was at his last stamp — never earlier than the plan', () => {
    const late = customerEta({ orderId: 'O4', stops, stamps: [{ stopId: 's1', at: at(5, 10) }, { stopId: 's2', at: at(5, 35) }] });
    expect(late).toMatchObject({ state: 'on_the_way', stopsDone: 2, stopsBeforeYou: 1, lastStopStampedAt: at(5, 35), behindPlanMinutes: 15, estimatedArrivalAt: at(5, 55) });
    const early = customerEta({ orderId: 'O4', stops, stamps: [{ stopId: 's1', at: at(5, 2) }] });
    expect(early.estimatedArrivalAt).toBe(at(5, 40));
  });
  it('says "reached" once this customer\'s own stop is stamped, and tells nothing about any other customer', () => {
    const r = customerEta({ orderId: 'O2', stops, stamps: [{ stopId: 's2', at: at(5, 21) }, { stopId: 's2', at: at(5, 25) }] });
    expect(r).toMatchObject({ state: 'reached', estimatedArrivalAt: null, stopsDone: 1 });
    expect(JSON.stringify(customerEta({ orderId: 'O3', stops, stamps: [{ stopId: 's1', at: at(5, 10) }] }))).not.toMatch(/O1|O2|O4|s1|s2/);
  });
});
