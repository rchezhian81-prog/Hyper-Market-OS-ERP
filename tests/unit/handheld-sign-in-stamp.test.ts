import { describe, it, expect, afterEach } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TillOperators, STAMP_CLOCK_SLACK_MS, deviceLaneOf } from '../../edge/store-edge/src/till-operators';
import { FORGET_KEPT_PAGES_SCRIPT, phoneSignInPage } from '../../edge/store-edge/src/handheld-sign-in';
import { issueTillCredential, tillPinKey, type TillCredential } from '../../packages/identity/src/till-pin';
import { makeEvent, type DomainEvent } from '../../packages/contracts/src/event';
import {
  canonicalJson, fromHex, hmacSha256Hex, phoneStamper, readPhoneSignIn, readSignInStamp, sha256, stampMessage, stamperForPage,
  type PhoneSignIn, type SignInStamp,
} from '../../packages/sync/src/sign-in-stamp';
import { DeviceOutbox, noDeviceStore, openDeviceOutbox } from '../../packages/sync/src/device-outbox';
import { drainToBox, type FetchLike } from '../../packages/sync/src/device-drain';
import { readRelayItem } from '../../packages/sync/src/device-relay';
import { testPin } from '../support/till-operator';

/**
 * **OB-180 "A" (owner, 17 Oct 2026): a handheld stamps each record with the sign-in it was made under; the box seals it
 * for that person only while that sign-in was valid on that phone.**
 *
 * The parts, one at a time: the plain SHA-256 / HMAC the phones use (no Web Crypto on plain http) agrees with node's; the
 * stamp is read strictly; the phone stamps on the box's clock and never after its sign-in ends; the device queue stamps
 * each record once, keeps the stamp through a restart and sends it; and the box's register accepts a true stamp — also
 * after somebody else signed in, and after the box restarted — and refuses every forgery by name. The whole journey on
 * the real box is tests/integration/ob180-*.test.ts; in a real browser, tests/e2e/ob180-*.e2e.ts.
 */

const BOX_KEY = ['ob180', 'stamp', 'unit', 'key'].join('-').padEnd(48, '0');
const KEY = tillPinKey(BOX_KEY);
const PIN = { a: testPin(180), b: testPin(181) };
const JOB = 'inventory.movement.append';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const ev = (key: string, receivedBy: string, quantityMinor = 6): DomainEvent => makeEvent({
  id: `e-${key}`, type: 'ReceivingScanned', occurredAt: '2026-10-17T06:30:00.000Z', idempotencyKey: key, source: 'A-1',
  payload: { grnId: 'grn-1', commandId: key, productId: 'p-icecream', quantityMinor, receivedBy, storeId: 'store-1', note: 'ஐஸ்கிரீம் ✓' },
});

describe('the phone\'s SHA-256 and HMAC agree with the store computer\'s', () => {
  const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
  it('SHA-256 of the standard vectors and of random lengths', () => {
    expect(hex(sha256(new Uint8Array()))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const b = randomBytes(n);
      expect(hex(sha256(new Uint8Array(b)))).toBe(createHash('sha256').update(b).digest('hex'));
    }
  });
  it('HMAC-SHA256: RFC 4231 cases 1, 2 and 6, and node\'s own on Tamil text', () => {
    expect(hmacSha256Hex(new Uint8Array(20).fill(0x0b), 'Hi There')).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
    expect(hmacSha256Hex(new TextEncoder().encode('Jefe'), 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    expect(hmacSha256Hex(new Uint8Array(131).fill(0xaa), 'Test Using Larger Than Block-Size Key - Hash Key First')).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
    const key = randomBytes(32);
    const msg = stampMessage({ v: 1, ref: 'r', userId: 'u', madeAt: '2026-10-17T06:30:00.000Z' }, ev('k1', 'u'));
    expect(hmacSha256Hex(new Uint8Array(key), msg)).toBe(createHmac('sha256', key).update(msg, 'utf8').digest('hex'));
  });
  it('the record is hashed the same whatever order its fields arrive in', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    const e = ev('k1', 'u');
    const shuffled = JSON.parse(JSON.stringify({ payload: e.payload, version: e.version, source: e.source, idempotencyKey: e.idempotencyKey, occurredAt: e.occurredAt, type: e.type, id: e.id })) as DomainEvent;
    const s = { v: 1 as const, ref: 'r', userId: 'u', madeAt: '2026-10-17T06:30:00.000Z' };
    expect(stampMessage(s, shuffled)).toBe(stampMessage(s, e));
  });
});

describe('a stamp is read strictly', () => {
  const good = { v: 1, ref: 'abc', userId: 'u-a', madeAt: '2026-10-17T06:30:00.000Z', mac: 'a'.repeat(64) };
  it('absent is "no stamp"; whole is read; anything else is refused, never read as absent', () => {
    expect(readSignInStamp(undefined)).toEqual({ ok: true, stamp: undefined });
    expect(readSignInStamp(good)).toEqual({ ok: true, stamp: good });
    for (const bad of [null, 'x', { ...good, v: 2 }, { ...good, mac: 'zz' }, { ...good, mac: 'A'.repeat(64) }, { ...good, madeAt: 'yesterday' }, { ...good, userId: '' }, { ...good, ref: 'r'.repeat(200) }]) {
      expect(readSignInStamp(bad)).toEqual({ ok: false, reason: 'the record\'s sign-in stamp could not be read' });
    }
  });
  it('the box reads a relayed item\'s stamp with it, and refuses an item whose stamp is broken', () => {
    const e = ev('k1', 'u-a');
    expect(readRelayItem({ key: 'k1', event: e, stamp: good })).toMatchObject({ ok: true, item: { key: 'k1', stamp: good } });
    expect(readRelayItem({ key: 'k1', event: e })).toMatchObject({ ok: true, item: { key: 'k1' } });
    expect(readRelayItem({ key: 'k1', event: e, stamp: { ...good, mac: 1 } })).toEqual({ ok: false, key: 'k1', reason: 'the record\'s sign-in stamp could not be read' });
  });
});

describe('the phone stamps on the box\'s clock, and never after its sign-in ends', () => {
  const signIn: PhoneSignIn = { ref: 'ref-a', userId: 'u-a', signedInAt: '2026-10-17T06:00:00.000Z', expiresAt: '2026-10-17T18:00:00.000Z', key: 'ab'.repeat(32), boxNow: '2026-10-17T06:00:05.000Z' };
  it('madeAt is the phone\'s time moved by how far the phone was from the box when the page was served', () => {
    // The phone's clock is 3 hours slow: it read 03:00:05 when the box said 06:00:05.
    let phone = '2026-10-17T03:00:05.000Z';
    const stamp = phoneStamper(signIn, phone, () => phone)!;
    phone = '2026-10-17T03:20:05.000Z';
    const s = stamp(ev('k1', 'u-a'))!;
    expect(s).toMatchObject({ v: 1, ref: 'ref-a', userId: 'u-a', madeAt: '2026-10-17T06:20:05.000Z' });
    expect(s.mac).toBe(hmacSha256Hex(fromHex(signIn.key), stampMessage(s, ev('k1', 'u-a'))));
  });
  it('a page from the service worker\'s cache uses when it was kept; a page the box did not serve stamps nothing', () => {
    const now = () => '2026-10-17T09:00:00.000Z';
    const s = stamperForPage({ phoneSignIn: signIn, shellCachedAt: '2026-10-17T06:00:05.000Z' }, now)!(ev('k1', 'u-a'))!;
    expect(s.madeAt).toBe('2026-10-17T09:00:00.000Z');
    expect(stamperForPage({}, now)).toBeUndefined();
    expect(stamperForPage({ phoneSignIn: { ...signIn, key: 'not-hex' } }, now)).toBeUndefined();
    expect(readPhoneSignIn({ ...signIn, boxNow: undefined })).toBeUndefined();
  });
  it('after the sign-in\'s end the phone stamps nothing; a clock slip before it is held at the sign-in', () => {
    let phone = '2026-10-17T06:00:05.000Z';
    const stamp = phoneStamper(signIn, phone, () => phone)!;
    phone = '2026-10-17T18:00:05.000Z';
    expect(stamp(ev('k1', 'u-a'))).toBeUndefined();
    phone = '2026-10-17T05:00:00.000Z';
    expect(stamp(ev('k2', 'u-a'))!.madeAt).toBe(signIn.signedInAt);
  });
});

describe('the device queue stamps each record once, keeps it, and sends it', () => {
  const signIn: PhoneSignIn = { ref: 'ref-a', userId: 'u-a', signedInAt: '2026-10-17T06:00:00.000Z', expiresAt: '2026-10-17T18:00:00.000Z', key: 'cd'.repeat(32), boxNow: '2026-10-17T06:00:00.000Z' };
  it('stamped when queued; the same key queued again keeps its first stamp; a restart restores it; the drain sends it', async () => {
    const store = noDeviceStore();
    let phone = '2026-10-17T06:10:00.000Z';
    const q = openDeviceOutbox(store, () => {}, phoneStamper(signIn, '2026-10-17T06:00:00.000Z', () => phone));
    const first = q.enqueue(ev('k1', 'u-a'));
    expect(first.stamp).toMatchObject({ ref: 'ref-a', madeAt: '2026-10-17T06:10:00.000Z' });
    phone = '2026-10-17T07:00:00.000Z';
    expect(q.enqueue(ev('k1', 'u-a')).stamp).toEqual(first.stamp);
    // The next person's page opens the same queue with THEIR stamper: A's record keeps A's stamp.
    const other: PhoneSignIn = { ...signIn, ref: 'ref-b', userId: 'u-b', key: 'ef'.repeat(32) };
    const reopened = openDeviceOutbox(store, () => {}, phoneStamper(other, phone, () => phone));
    expect(reopened.find('k1')!.stamp).toEqual(first.stamp);
    reopened.enqueue(ev('k2', 'u-b'));
    expect(reopened.find('k2')!.stamp).toMatchObject({ ref: 'ref-b', userId: 'u-b' });
    const sent: unknown[] = [];
    const fetch: FetchLike = async (_url, init) => {
      sent.push(JSON.parse(init.body!) as unknown);
      return { status: 200, json: async () => ({ acks: [{ key: 'k1', status: 'accepted' }, { key: 'k2', status: 'accepted' }] }) };
    };
    expect(await drainToBox({ outbox: reopened, boxBase: '', source: 'warehouse', fetch })).toMatchObject({ handed: 2 });
    expect(sent[0]).toMatchObject({ items: [{ key: 'k1', stamp: first.stamp }, { key: 'k2', stamp: { userId: 'u-b' } }] });
  });
  it('a queue with no stamper stamps nothing and sends no stamp', async () => {
    const q = new DeviceOutbox(noDeviceStore());
    expect(q.enqueue(ev('k1', 'u-a')).stamp).toBeUndefined();
    const sent: unknown[] = [];
    await drainToBox({ outbox: q, boxBase: '', source: 'warehouse', fetch: async (_u, init) => { sent.push(JSON.parse(init.body!) as unknown); return { status: 200, json: async () => ({ acks: [] }) }; } });
    expect(JSON.stringify(sent)).not.toContain('stamp');
  });
});

interface World { now: string }
const credentials = (): Map<string, TillCredential> => new Map([
  ['u-a', issueTillCredential({ userId: 'u-a', pin: PIN.a, key: KEY, issuedAt: '2026-10-17T05:00:00.000Z', issuedBy: 'Store admin' })],
  ['u-b', issueTillCredential({ userId: 'u-b', pin: PIN.b, key: KEY, issuedAt: '2026-10-17T05:00:00.000Z', issuedBy: 'Store admin' })],
]);
const register = async (w: World, dir?: string): Promise<{ ops: TillOperators; dir: string }> => {
  const d = dir ?? await mkdtemp(join(tmpdir(), 'sre-ob180-'));
  if (dir === undefined) dirs.push(d);
  const creds = credentials();
  const ops = await TillOperators.open({
    dataDir: d, capacityBytes: 10_485_760, key: KEY, credentials: async () => creds,
    pack: { people: () => [{ userId: 'u-a', displayName: 'A' }, { userId: 'u-b', displayName: 'B' }], permissionsOf: () => [JOB] },
    now: () => w.now,
  });
  return { ops, dir: d };
};
const signInOn = async (ops: TillOperators, who: 'u-a' | 'u-b', deviceId = 'hh-01'): Promise<string> => {
  const out = await ops.signInOnDevice({ staffId: who, pin: who === 'u-a' ? PIN.a : PIN.b, deviceId, authority: JOB });
  if (!out.signedIn) throw new Error(out.laneMessage);
  return out.token;
};
const stampOf = (m: { ref: string; key: string }, userId: string, event: DomainEvent, madeAt: string): SignInStamp => {
  const base = { v: 1 as const, ref: m.ref, userId, madeAt };
  return { ...base, mac: hmacSha256Hex(fromHex(m.key), stampMessage(base, event)) };
};
const at = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

describe('the store computer accepts a true stamp and refuses every forgery by name', () => {
  it('A\'s stamp made while A was signed in is A\'s — also after B signed in, and after the box restarted', async () => {
    const w: World = { now: '2026-10-17T06:00:00.000Z' };
    const { ops, dir } = await register(w);
    const tokenA = await signInOn(ops, 'u-a');
    const m = ops.stampFor(tokenA, deviceLaneOf('hh-01'))!;
    expect(m).toMatchObject({ userId: 'u-a', signedInAt: w.now });
    expect(m.key).toMatch(/^[0-9a-f]{64}$/);
    expect(ops.stampFor(tokenA, deviceLaneOf('hh-02'))).toBeNull(); // only on its own phone
    const made = at(w.now, 20);
    const e = ev('k1', 'u-a');
    const s = stampOf(m, 'u-a', e, made);
    w.now = at(w.now, 30);
    await signInOn(ops, 'u-b'); // A's sign-in ends here (replaced)
    expect(ops.stampFor(tokenA, deviceLaneOf('hh-01'))).toBeNull();
    w.now = at(w.now, 60);
    expect(ops.verifyStamp(s, e, deviceLaneOf('hh-01'))).toEqual({ ok: true, userId: 'u-a', signedInAt: '2026-10-17T06:00:00.000Z' });
    // A restart: the register is folded back from its log, and the stamp is still A's.
    const again = await register(w, dir);
    expect(again.ops.verifyStamp(s, e, deviceLaneOf('hh-01'))).toMatchObject({ ok: true, userId: 'u-a' });
    // Neither the stamp key nor its reference is ever written to the log.
    const log = await readFile(join(dir, 'till-operators.log'), 'utf8');
    expect(log).not.toContain(m.key);
    expect(log).not.toContain(m.ref);
  });

  it('refused: after the sign-in ended (beyond the clock slack), before it began, in the future, on another phone, someone else\'s, altered, never made', async () => {
    const w: World = { now: '2026-10-17T06:00:00.000Z' };
    const { ops } = await register(w);
    const tokenA = await signInOn(ops, 'u-a');
    const mA = ops.stampFor(tokenA, deviceLaneOf('hh-01'))!;
    w.now = at(w.now, 60);
    const tokenB = await signInOn(ops, 'u-b'); // A ends at 07:00
    const mB = ops.stampFor(tokenB, deviceLaneOf('hh-01'))!;
    w.now = at(w.now, 120); // the box's clock is now 09:00
    const lane = deviceLaneOf('hh-01');
    const e = ev('k1', 'u-a');
    const outside = /outside u-a's sign-in on this phone \(from 2026-10-17T06:00:00.000Z to 2026-10-17T07:00:00.000Z\)/;
    // Just inside the slack after A's end: still A's (a phone's clock a minute out).
    expect(ops.verifyStamp(stampOf(mA, 'u-a', e, at('2026-10-17T07:00:00.000Z', 1)), e, lane)).toMatchObject({ ok: true });
    expect(ops.verifyStamp(stampOf(mA, 'u-a', e, at('2026-10-17T07:00:00.000Z', STAMP_CLOCK_SLACK_MS / 60_000 + 1)), e, lane)).toMatchObject({ ok: false, reason: expect.stringMatching(outside) as unknown });
    expect(ops.verifyStamp(stampOf(mA, 'u-a', e, at('2026-10-17T06:00:00.000Z', -10)), e, lane)).toMatchObject({ ok: false, reason: expect.stringMatching(outside) as unknown });
    // B's sign-in is still open; a stamp "made" an hour ahead of the box's clock is not believed.
    const eb = ev('k2', 'u-b');
    expect(ops.verifyStamp(stampOf(mB, 'u-b', eb, at(w.now, 60)), eb, lane)).toMatchObject({ ok: false, reason: expect.stringContaining('outside u-b\'s sign-in') as unknown });
    expect(ops.verifyStamp(stampOf(mB, 'u-b', eb, w.now), eb, lane)).toMatchObject({ ok: true, userId: 'u-b' });
    // Another phone.
    expect(ops.verifyStamp(stampOf(mA, 'u-a', e, '2026-10-17T06:30:00.000Z'), e, deviceLaneOf('hh-02'))).toEqual({ ok: false, reason: 'the record\'s sign-in stamp was made on another phone' });
    // B's sign-in, claiming to be A's.
    expect(ops.verifyStamp(stampOf(mB, 'u-a', e, '2026-10-17T07:30:00.000Z'), e, lane)).toEqual({ ok: false, reason: 'the record\'s sign-in stamp names u-a, but that sign-in was somebody else\'s' });
    // A's reference with B's key; and A's true stamp on a changed record.
    expect(ops.verifyStamp({ ...stampOf(mB, 'u-a', e, '2026-10-17T06:30:00.000Z'), ref: mA.ref }, e, lane)).toMatchObject({ ok: false, reason: expect.stringContaining('does not match the record') as unknown });
    const s = stampOf(mA, 'u-a', e, '2026-10-17T06:30:00.000Z');
    expect(ops.verifyStamp(s, ev('k1', 'u-a', 60), lane)).toMatchObject({ ok: false, reason: expect.stringContaining('does not match the record') as unknown });
    expect(ops.verifyStamp({ ...s, madeAt: '2026-10-17T06:31:00.000Z' }, e, lane)).toMatchObject({ ok: false, reason: expect.stringContaining('does not match the record') as unknown });
    expect(ops.verifyStamp(s, e, lane)).toMatchObject({ ok: true, userId: 'u-a' });
    // A reference nobody issued.
    expect(ops.verifyStamp({ ...s, ref: '0'.repeat(32) }, e, lane)).toEqual({ ok: false, reason: 'the record\'s sign-in stamp names a sign-in this store computer never made' });
  });

  it('a sign-out ends the window; a till session never stamps a phone\'s record', async () => {
    const w: World = { now: '2026-10-17T06:00:00.000Z' };
    const { ops } = await register(w);
    const tokenA = await signInOn(ops, 'u-a');
    const m = ops.stampFor(tokenA, deviceLaneOf('hh-01'))!;
    w.now = at(w.now, 30);
    await ops.signOut(tokenA);
    w.now = at(w.now, 30);
    const e = ev('k1', 'u-a');
    expect(ops.verifyStamp(stampOf(m, 'u-a', e, w.now), e, deviceLaneOf('hh-01'))).toMatchObject({ ok: false, reason: expect.stringContaining('to 2026-10-17T06:30:00.000Z') as unknown });
    expect(ops.verifyStamp(stampOf(m, 'u-a', e, at(w.now, -40)), e, deviceLaneOf('hh-01'))).toMatchObject({ ok: true });
    expect(ops.stampFor(tokenA, deviceLaneOf('hh-01'))).toBeNull();
  });
});

describe('the sign-in page forgets the kept handheld pages (the last person\'s stamp key)', () => {
  it('carries the one script, which deletes only the three handheld pages', () => {
    const html = phoneSignInPage({ screen: 'warehouse', action: '/device/sign-in?screen=warehouse', message: null });
    expect(html).toContain(FORGET_KEPT_PAGES_SCRIPT);
    const pattern = /if\(\/(.+?)\/\.test\(p\)\)/.exec(FORGET_KEPT_PAGES_SCRIPT)![1]!;
    const re = new RegExp(pattern);
    for (const p of ['/warehouse/', '/picker/', '/driver/', '/warehouse/index.html']) expect(re.test(p)).toBe(true);
    for (const p of ['/warehouse/app.js', '/warehouse/sre-foundation.css', '/picker/picker-app.bundle.js', '/device/sign-in', '/manager/']) expect(re.test(p)).toBe(false);
  });
});
