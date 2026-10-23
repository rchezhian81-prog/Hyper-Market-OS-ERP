import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { RouteSession, ProofNotCapturedError, DeliveryCodeFormatError, ProofImageError, DELIVERY_PROOF_CAPTURED, DELIVERY_STOP_UPDATED } from '../../apps/delivery-app/src/route-session';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { ProofRequiredError } from '../../packages/fulfilment/src/index';

// OB-294 (owner, 23 Oct 2026) · M19-FR-03 · D09-FR-05 — on the driver's phone the proof is CAPTURED: the customer's
// 4-digit code, or a picture the camera (or the customer's finger) made. A typed reference is refused before anything is
// queued; a picture travels once, as its own record, before the stop it proves, and its fingerprint is the bytes' own;
// the phone's location rides only on a hand-over. Synthetic data.

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const at = () => '2026-10-24T05:00:00.000Z';
const route = (outbox = new SyncOutbox()) => ({
  outbox,
  r: new RouteSession('R-1', 'u-driver', [
    { stopId: 's1', orderRef: 'ORD-1', area: 'Slot 10:30–12:00', codMinor: 0 },
    { stopId: 's2', orderRef: 'ORD-2', area: 'Slot 10:30–12:00', codMinor: 250_00 },
  ], outbox, { now: at }),
});

describe('the code proof — the four digits the customer reads out', () => {
  it('takes four digits (leading zeros counted) and queues them with the hand-over for head office to check', () => {
    const { r, outbox } = route();
    r.depart('s1');
    const stop = r.deliver('s1', { kind: 'otp', code: '0042' });
    expect(stop.proof).toEqual({ kind: 'otp', ref: 'otp:code-entered' });
    const queued = outbox.pending().at(-1)!.event;
    expect(queued.type).toBe(DELIVERY_STOP_UPDATED);
    expect(queued.payload).toMatchObject({ state: 'delivered', proofKind: 'otp', proofCode: '0042', proofSha256: null, deviceFix: null });
  });
  it('refuses anything that is not four digits BEFORE anything is queued — the stop does not move', () => {
    const { r, outbox } = route();
    r.depart('s1');
    const before = outbox.pending().length;
    for (const code of ['42', '12345', 'abcd', '']) expect(() => r.deliver('s1', { kind: 'otp', code })).toThrow(DeliveryCodeFormatError);
    expect(outbox.pending()).toHaveLength(before);
    expect(r.route()[0]!.state).toBe('out_for_delivery');
  });
});

describe('the picture proof — a photo at the door, or the customer\'s signature', () => {
  it('refuses a typed reference (it proves nothing) and no proof at all — nothing is queued', () => {
    const { r, outbox } = route();
    r.depart('s1');
    const before = outbox.pending().length;
    expect(() => r.deliver('s1', { kind: 'photo', ref: 'IMG_2041.jpg' })).toThrow(ProofNotCapturedError);
    expect(() => r.deliver('s1', { kind: 'signature', ref: 'signed' })).toThrow(ProofRequiredError); // the same family of refusal
    expect(() => r.deliver('s1', undefined)).toThrow(ProofRequiredError);
    expect(outbox.pending()).toHaveLength(before);
  });
  it('refuses a picture too large to keep, and one that is not base64', () => {
    const { r } = route();
    r.depart('s1');
    expect(() => r.deliver('s1', { kind: 'photo', image: { mediaType: 'image/jpeg', contentBase64: 'A'.repeat(60_004) } })).toThrow(ProofImageError);
    expect(() => r.deliver('s1', { kind: 'photo', image: { mediaType: 'image/jpeg', contentBase64: 'not-base64!' } })).toThrow(ProofImageError);
  });
  it('queues the picture ONCE as its own record before the stop, with the bytes\' own SHA-256; the stop carries the kind and the fingerprint only', () => {
    const { r, outbox } = route();
    r.depart('s2');
    const fix = { lat: 11.0169, lon: 76.9557, accuracyMetres: 9 };
    r.deliver('s2', { kind: 'photo', image: { mediaType: 'image/jpeg', contentBase64: JPEG.toString('base64') } }, { codCollectedMinor: 250_00, codMethod: 'cash', deviceFix: fix });
    const [image, stop] = outbox.pending().slice(-2).map((i) => i.event);
    const sha = createHash('sha256').update(JPEG).digest('hex');
    expect(image!.type).toBe(DELIVERY_PROOF_CAPTURED);
    expect(image!.payload).toEqual({ routeId: 'R-1', stopId: 's2', driverId: 'u-driver', orderRef: 'ORD-2', kind: 'photo', mediaType: 'image/jpeg', contentBase64: JPEG.toString('base64'), sha256: sha, capturedAt: at() });
    expect(stop!.payload).toMatchObject({ state: 'delivered', proofKind: 'photo', proofSha256: sha, proofCode: null, deviceFix: fix, codCollectedMinor: 250_00 });
    expect(JSON.stringify(stop!.payload)).not.toContain(JPEG.toString('base64'));
    expect(r.route()[1]!.proof).toEqual({ kind: 'photo', ref: `photo:sha256:${sha}` });
  });
  it('takes the customer\'s signature as an image the same way, on a partial delivery too', () => {
    const { r, outbox } = route();
    r.depart('s1');
    r.deliverPartial('s1', { kind: 'signature', image: { mediaType: 'image/png', contentBase64: PNG.toString('base64') } });
    expect(outbox.pending().at(-2)!.event).toMatchObject({ type: DELIVERY_PROOF_CAPTURED, payload: { kind: 'signature', mediaType: 'image/png' } });
    expect(outbox.pending().at(-1)!.event.payload).toMatchObject({ state: 'partially_delivered', proofKind: 'signature' });
  });
  it('lists the picture on "Sent from this phone" by the stop it proves, never the customer', () => {
    const { r } = route();
    r.depart('s1');
    r.deliver('s1', { kind: 'photo', image: { mediaType: 'image/jpeg', contentBase64: JPEG.toString('base64') } });
    const proof = r.sentWork().find((w) => w.kind === 'proof')!;
    expect(proof).toMatchObject({ kind: 'proof', id: 's1', what: 'Slot 10:30–12:00 · ORD-1', state: 'saved_here' });
    expect(proof.detail).toMatch(/^photo · \d+ KB$/);
  });
});

describe('the phone\'s location rides only on a hand-over, and only a readable one', () => {
  it('is not on a departure or a failure, and a malformed fix is dropped rather than sent', () => {
    const { r, outbox } = route();
    r.depart('s1');
    r.fail('s1', 'nobody_home');
    r.reattempt('s1');
    r.deliver('s1', { kind: 'otp', code: '1234' }, { deviceFix: { lat: 999, lon: 0 } as never });
    for (const item of outbox.pending()) expect((item.event.payload as { deviceFix: unknown }).deviceFix).toBeNull();
  });
});
