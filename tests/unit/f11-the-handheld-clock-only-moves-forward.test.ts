import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  TillOperators, DRIVER_PHONE_AUTHORITY, DRIVER_PHONE_SESSION_HOURS, PHONE_LATE_ARRIVAL_MS, PHONE_SESSION_HOURS, SESSION_HOURS,
  STAMP_ORDER_TOLERANCE_MS, deviceLaneOf, sessionHoursFor,
} from '../../edge/store-edge/src/till-operators';
import { HANDHELD_AUTHORITY, PHONE_HANDOVER_WINDOW_MS, phoneHolderStrip, phoneOperatorsOf, signInLockOf } from '../../edge/store-edge/src/handheld-sign-in';
import { PHONE_SIGN_IN_ROUTE } from '../../edge/store-edge/src/device-server';
import { issueTillCredential, tillPinKey, type TillCredential } from '../../packages/identity/src/till-pin';
import { makeEvent, type DomainEvent } from '../../packages/contracts/src/event';
import {
  PHONE_CLOCK_MARKS_KEY, PHONE_CLOCK_TOLERANCE_MS, fromHex, hmacSha256Hex, pageStamping, phoneStamping, signInClock, stampMessage,
  stamperForPage, type MarkStorage, type PhoneSignIn, type SignInStamp,
} from '../../packages/sync/src/sign-in-stamp';
import { noDeviceStore, openDeviceOutbox } from '../../packages/sync/src/device-outbox';
import { drainToBox, type FetchLike } from '../../packages/sync/src/device-drain';
import { testPin } from '../support/till-operator';

/**
 * **Follow-up F11: the handheld verifier's findings (verifier hh NEW-1, NEW-2, NEW-3 / OB-187, L1, L2, L3).**
 *
 *   NEW-1 — turning the phone's clock back no longer gets past the sign-in's end or the lock. The phone keeps, for each
 *           sign-in, the latest box time it has seen (beside the queue); a clock reading earlier than that, earlier than
 *           when the page was served, or running slower than the page's stopwatch, ENDS the sign-in on the phone — for
 *           good — and the strip's own script reads the same marks the same way, so it locks at that same moment. On the
 *           box, a stamp more than two minutes earlier than one already taken from the same sign-in is refused by name.
 *   NEW-2 — OB-185's twelve hours are counted from the end of the sign-in the record was MADE under: a record arriving
 *           68 hours late is refused even when the same person has signed in on that phone again.
 *   NEW-3 — OB-187 "A": the driver screen's sign-in lasts twelve hours; warehouse and picker keep four. Told apart by the
 *           job the sign-in was made for.
 *   L1    — the box's clock rides on every hand-over reply and the phone reckons from it again: a phone clock that jumped
 *           forward recovers without a reload.
 *   L2    — the record that finds the end locks the screen at once (not at the next half-minute tick).
 *   L3    — the lock stops the screen's timers and drops the stamp key from memory.
 *
 * Synthetic data only. The real box is tests/integration/f11-*.test.ts; a real browser, tests/e2e/f11-*.e2e.ts.
 */

const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.parse('2026-10-17T02:30:00.000Z'); // 08:00 in the shop
const iso = (ms: number): string => new Date(ms).toISOString();
const KEY = tillPinKey(['f11', 'clock', 'unit', 'key'].join('-').padEnd(48, '0'));
const PIN = { a: testPin(211), d: testPin(212) };
const JOB = 'inventory.movement.append';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const ev = (k: string, who = 'u-a'): DomainEvent => makeEvent({
  id: `e-${k}`, type: 'StockCounted', occurredAt: iso(T0), idempotencyKey: k, source: 'A-1', payload: { countId: k, counterId: who, countedMinor: 1 },
});
const stop = (k: string, who = 'u-d'): DomainEvent => makeEvent({
  id: `e-${k}`, type: 'DeliveryStopUpdated', occurredAt: iso(T0), idempotencyKey: k, source: 'R-1', payload: { routeId: 'R-1', stopId: k, driverId: who, state: 'delivered' },
});
const signInAt = (at: number, hours = 4, ref = 'r-a'): PhoneSignIn => ({ ref, userId: 'u-a', signedInAt: iso(at), expiresAt: iso(at + hours * H), key: 'ab'.repeat(32), boxNow: iso(at) });
/** The phone's localStorage. */
function phoneStorage(): MarkStorage & { readonly held: Map<string, string> } {
  const held = new Map<string, string>();
  return { held, getItem: (k) => held.get(k) ?? null, setItem: (k, v) => { held.set(k, v); } };
}

interface World { now: string }
const credentials = (): Map<string, TillCredential> => new Map([
  ['u-a', issueTillCredential({ userId: 'u-a', pin: PIN.a, key: KEY, issuedAt: '2026-10-01T00:00:00.000Z', issuedBy: 'Store admin' })],
  ['u-d', issueTillCredential({ userId: 'u-d', pin: PIN.d, key: KEY, issuedAt: '2026-10-01T00:00:00.000Z', issuedBy: 'Store admin' })],
]);
const register = async (w: World, dir?: string): Promise<{ ops: TillOperators; dir: string }> => {
  const d = dir ?? await mkdtemp(join(tmpdir(), 'sre-f11-'));
  if (dir === undefined) dirs.push(d);
  const creds = credentials();
  const ops = await TillOperators.open({
    dataDir: d, capacityBytes: 10_485_760, key: KEY, credentials: async () => creds,
    pack: { people: () => [{ userId: 'u-a', displayName: 'A' }, { userId: 'u-d', displayName: 'Driver' }], permissionsOf: (u) => (u === 'u-d' ? [DRIVER_PHONE_AUTHORITY] : [JOB, 'fulfilment.pack.record']) },
    now: () => w.now,
  });
  return { ops, dir: d };
};
const signInOn = async (ops: TillOperators, who: 'u-a' | 'u-d', authority = who === 'u-d' ? DRIVER_PHONE_AUTHORITY : JOB): Promise<string> => {
  const out = await ops.signInOnDevice({ staffId: who, pin: who === 'u-a' ? PIN.a : PIN.d, deviceId: 'hh-01', authority });
  if (!out.signedIn) throw new Error(out.laneMessage);
  return out.token;
};
const stampOf = (m: { ref: string; key: string }, userId: string, event: DomainEvent, madeAt: string): SignInStamp => {
  const base = { v: 1 as const, ref: m.ref, userId, madeAt };
  return { ...base, mac: hmacSha256Hex(fromHex(m.key), stampMessage(base, event)) };
};
const LANE = deviceLaneOf('hh-01');

// ── The strip's own script, run as the phone runs it (as tests/unit/ob186-*.test.ts does) ───────────────────────────

interface StripPhone { now: number; perf: number; opened: number; readonly address: string[]; readonly written: string[]; tick: (() => void) | null; readonly win: Record<string, unknown>; readonly el: { textContent: string } }
const scriptOf = (strip: string): string => {
  const start = strip.indexOf('<script>') + '<script>'.length;
  return strip.slice(start, strip.indexOf('</script>', start));
};
function stripRunning(s: PhoneSignIn, storage: MarkStorage, now: number, extra: Record<string, unknown> = {}, perf?: { value: number }): StripPhone {
  const strip = phoneHolderStrip({ displayName: 'A', signOutAction: '/device/sign-out?screen=warehouse', expiresAt: s.expiresAt, now: s.boxNow, lockTo: signInLockOf('warehouse', PHONE_SIGN_IN_ROUTE) });
  const el = { textContent: '', setAttribute() {}, style: {} as Record<string, string> };
  const win: Record<string, unknown> = { phoneSignIn: s, localStorage: storage, history: { replaceState: (_s: unknown, _t: string, url: string) => { phone.address.push(url); } }, ...extra };
  const phone: StripPhone = { now, perf: 0, opened: 0, address: [], written: [], tick: null, win, el };
  runInNewContext(scriptOf(strip), {
    window: win, isFinite, Math, JSON,
    Date: { now: () => phone.now, parse: (x: string) => Date.parse(x) },
    ...(perf === undefined ? {} : { performance: { now: () => perf.value } }),
    document: { readyState: 'complete', querySelector: () => el, open: () => { phone.opened += 1; }, write: (h: string) => { phone.written.push(h); }, close: () => undefined },
    setInterval: (fn: () => void) => { phone.tick = fn; return 7; },
    clearInterval: () => { phone.tick = null; },
  });
  return phone;
}

describe('NEW-1 on the phone: the clock only moves forward, per sign-in, kept beside the queue', () => {
  it('the verifier\'s scenario: A\'s page seen until 12:00, the clock set back to 10:00 at 14:00 — nothing is stamped and the screen locks', () => {
    const storage = phoneStorage();
    const s = signInAt(T0);
    // 08:05 the page is served (the phone's clock right). It is live until about 12:00 — the strip ticks every half minute.
    const live = stripRunning({ ...s, boxNow: iso(T0 + 5 * MIN) }, storage, T0 + 5 * MIN);
    for (let t = T0 + 5 * MIN; t <= T0 + 3 * H + 55 * MIN; t += 30_000) { live.now = t; live.tick!(); }
    expect(live.opened).toBe(0);
    expect(live.el.textContent).toMatch(/^Sign-in ends in 0 h 5 min/);
    // 14:00, offline, the browser had been frozen. B sets the clock to 10:00 and reopens the screen from the cache.
    const cached = { phoneSignIn: { ...s, boxNow: iso(T0 + 5 * MIN) }, shellCachedAt: iso(T0 + 5 * MIN) };
    const phoneClock = T0 + 2 * H + 5 * MIN;
    const stamp = stamperForPage(cached, () => iso(phoneClock), { storage })!;
    expect(stamp(ev('x'))).toBeUndefined();
    const reopened = stripRunning(cached.phoneSignIn, storage, phoneClock, { shellCachedAt: cached.shellCachedAt });
    expect(reopened.opened).toBe(1);
    expect(reopened.address).toEqual(['/device/sign-in?screen=warehouse&ended=clock']);
    expect(reopened.written[0]).toContain('clock was turned back');
    // Putting the clock right again does not bring A's sign-in back on this phone.
    expect(stamperForPage(cached, () => iso(T0 + 2 * H + 30 * MIN), { storage })!(ev('y'))).toBeUndefined();
  });

  it('the mark is a time and an end, never the stamp key; the phone\'s own stamper keeps it on every stamp', () => {
    const storage = phoneStorage();
    let phone = T0 + 10 * MIN;
    const stamping = phoneStamping(signInAt(T0), iso(T0), () => iso(phone), { storage })!;
    expect(stamping.stamp(ev('a'))!.madeAt).toBe(iso(T0 + 10 * MIN));
    const kept = JSON.parse(storage.held.get(PHONE_CLOCK_MARKS_KEY)!) as Record<string, Record<string, unknown>>;
    expect(kept).toEqual({ 'r-a': { m: T0 + 10 * MIN, x: T0 + 4 * H } });
    expect(storage.held.get(PHONE_CLOCK_MARKS_KEY)).not.toContain('abab');
    // Set back by less than the tolerance: held at the mark (madeAt never runs backwards).
    phone = T0 + 10 * MIN - PHONE_CLOCK_TOLERANCE_MS + 1000;
    expect(stamping.stamp(ev('b'))!.madeAt).toBe(iso(T0 + 10 * MIN));
    // By more: ended.
    phone = T0 + 10 * MIN - PHONE_CLOCK_TOLERANCE_MS - 1000;
    expect(stamping.stamp(ev('c'))).toBeUndefined();
    expect(stamping.clock.read()).toEqual({ ended: true, why: 'clock_set_back' });
  });

  it('a clock set back by LESS than the time since the last tick is still caught on a live page: it ran slower than the stopwatch', () => {
    const storage = phoneStorage();
    const perf = { value: 0 };
    let phone = T0;
    const clock = signInClock(signInAt(T0), iso(T0), () => iso(phone), { storage, perfNow: () => perf.value });
    expect(clock.read()).toMatchObject({ ended: false });
    // An hour passes (the stopwatch runs an hour); the clock is set back 30 minutes — still later than the last mark.
    perf.value = 1 * H;
    phone = T0 + 30 * MIN;
    expect(clock.read()).toEqual({ ended: true, why: 'clock_set_back' });
    // A phone asleep is honest: the clock runs AHEAD of the stopwatch, which stops while it sleeps.
    const honest = signInClock(signInAt(T0, 4, 'r-b'), iso(T0), () => iso(phone), { storage, perfNow: () => perf.value });
    perf.value += 10 * MIN; // ten minutes awake ...
    phone += 70 * MIN; // ... and an hour asleep
    expect(honest.read()).toMatchObject({ ended: false, boxNowMs: T0 + 100 * MIN });
  });

  it('a page reopened from the cache with the clock earlier than when it was kept is ended (no earlier mark needed)', () => {
    const cached = { phoneSignIn: { ...signInAt(T0), boxNow: iso(T0 + 1 * H) }, shellCachedAt: iso(T0 + 1 * H) };
    expect(stamperForPage(cached, () => iso(T0 + 30 * MIN), { storage: phoneStorage() })!(ev('a'))).toBeUndefined();
    // and with the clock right, the same kept page stamps on the box's clock as before
    expect(stamperForPage(cached, () => iso(T0 + 2 * H), { storage: phoneStorage() })!(ev('a'))!.madeAt).toBe(iso(T0 + 2 * H));
  });

  it('storage that throws still guards the page from memory; old sign-ins\' marks are let go after their end', () => {
    const broken: MarkStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
    let phone = T0 + 1 * H;
    const clock = signInClock(signInAt(T0), iso(T0), () => iso(phone), { storage: broken });
    expect(clock.read()).toMatchObject({ ended: false });
    phone = T0 + 30 * MIN;
    expect(clock.read()).toEqual({ ended: true, why: 'clock_set_back' });
    const storage = phoneStorage();
    storage.setItem(PHONE_CLOCK_MARKS_KEY, JSON.stringify({ old: { m: T0 - 48 * H, x: T0 - 44 * H }, recent: { m: T0 - 2 * H, x: T0 - 1 * H } }));
    signInClock(signInAt(T0), iso(T0), () => iso(T0 + MIN), { storage }).read();
    expect(Object.keys(JSON.parse(storage.held.get(PHONE_CLOCK_MARKS_KEY)!) as object).sort()).toEqual(['r-a', 'recent']);
  });

  it('the strip and the stamper read one mark the same way: either one that finds the end, the other sees it too', () => {
    // The strip ticks to 11:00; the stamper, created afterwards on a reopened page with the clock set back, sees it.
    const storage = phoneStorage();
    const s = signInAt(T0);
    const strip = stripRunning(s, storage, T0);
    strip.now = T0 + 3 * H; strip.tick!();
    expect(stamperForPage({ phoneSignIn: s, shellCachedAt: s.boxNow }, () => iso(T0 + 1 * H), { storage })!(ev('a'))).toBeUndefined();
    // The other way: the stamper finds the clock set back first; the strip's next tick locks to the clock page.
    const storage2 = phoneStorage();
    let phone = T0 + 2 * H;
    const stamp = phoneStamping(s, iso(T0), () => iso(phone), { storage: storage2 })!;
    const strip2 = stripRunning(s, storage2, T0);
    expect(stamp.stamp(ev('b'))).toBeDefined();
    phone = T0 + 1 * H;
    expect(stamp.stamp(ev('c'))).toBeUndefined();
    strip2.now = T0 + 1 * H; strip2.tick!();
    expect(strip2.address).toEqual(['/device/sign-in?screen=warehouse&ended=clock']);
    // At the expiry both say "ended" at the same reading, and the strip locks to the plain ended page.
    const storage3 = phoneStorage();
    const strip3 = stripRunning(s, storage3, T0);
    strip3.now = T0 + 4 * H; strip3.tick!();
    expect(strip3.address).toEqual(['/device/sign-in?screen=warehouse&ended=1']);
    expect(phoneStamping(s, iso(T0), () => iso(T0 + 4 * H - MIN), { storage: storage3 })!.stamp(ev('d'))).toBeUndefined();
  });
});

describe('NEW-1 on the box: a stamp running backwards against one already taken from the same sign-in is refused', () => {
  it('refused by name beyond two minutes; inside them taken; a retry of a record already taken is not refused; another sign-in is its own', async () => {
    const w = { now: iso(T0) };
    const { ops } = await register(w);
    await signInOn(ops, 'u-a');
    const m = ops.stampFor(await signInOn(ops, 'u-a'), LANE)!;
    w.now = iso(T0 + 3 * H + 30 * MIN);
    const first = ev('k1');
    const s1 = stampOf(m, 'u-a', first, iso(T0 + 3 * H));
    expect(ops.verifyStamp(s1, first, LANE)).toMatchObject({ ok: true, userId: 'u-a' });
    const slip = ev('k2');
    expect(ops.verifyStamp(stampOf(m, 'u-a', slip, iso(T0 + 3 * H - STAMP_ORDER_TOLERANCE_MS + 1000)), slip, LANE)).toMatchObject({ ok: true });
    // The verifier's set-back record: made "at 10:05" after A's 11:00 record was taken.
    const back = ev('k3');
    const s3 = stampOf(m, 'u-a', back, iso(T0 + 2 * H + 5 * MIN));
    expect(ops.verifyStamp(s3, back, LANE)).toEqual({
      ok: false,
      reason: `the record was stamped at ${iso(T0 + 2 * H + 5 * MIN)}, earlier than a record made before it under u-a's sign-in on this phone (${iso(T0 + 3 * H)}) — the phone's clock was turned back; a person must look at it`,
    });
    // The first record handed over again (a lost reply) is still that record — the relay answers "duplicate".
    expect(ops.verifyStamp(s1, first, LANE)).toMatchObject({ ok: true });
  });

  it('what the box cannot prove: a set-back stamp with nothing later from that sign-in to compare is inside the sign-in', async () => {
    const w = { now: iso(T0) };
    const { ops } = await register(w);
    const m = ops.stampFor(await signInOn(ops, 'u-a'), LANE)!;
    w.now = iso(T0 + 6 * H);
    const e = ev('only');
    expect(ops.verifyStamp(stampOf(m, 'u-a', e, iso(T0 + 2 * H)), e, LANE)).toMatchObject({ ok: true });
  });
});

describe('NEW-2: OB-185\'s twelve hours run from the end of the sign-in the record was MADE under', () => {
  it('the verifier\'s 68-hour case: S1 ended Mon 06:30, A signs in again Thu — the S1 record is refused with the OB-185 words', async () => {
    const w = { now: '2026-10-14T02:30:00.000Z' };
    const { ops } = await register(w);
    const phone = phoneOperatorsOf(ops);
    const m = ops.stampFor(await signInOn(ops, 'u-a'), LANE)!;
    const e = ev('old-1');
    const stamp = stampOf(m, 'u-a', e, '2026-10-14T03:00:00.000Z');
    w.now = '2026-10-17T03:00:00.000Z';
    await signInOn(ops, 'u-a');
    expect(phone.heldRecently('u-a', 'hh-01')).toBe(true);
    expect(phone.verifyStamp(stamp, e, 'hh-01')).toEqual({
      ok: false,
      reason: 'the record was made under u-a\'s sign-in on this phone, which ended at 2026-10-14T06:30:00.000Z, and it reached this store computer more than 12 hours later (OB-185) — too late to be taken; a person must look at it',
    });
  });

  it('taken up to twelve hours after the end — a four-hour end, or an earlier sign-out — not a moment later', async () => {
    const w = { now: iso(T0) };
    const { ops } = await register(w);
    expect(PHONE_LATE_ARRIVAL_MS).toBe(12 * H);
    expect(PHONE_HANDOVER_WINDOW_MS).toBe(PHONE_LATE_ARRIVAL_MS);
    const m = ops.stampFor(await signInOn(ops, 'u-a'), LANE)!;
    const a = ev('a'); const b = ev('b');
    const sa = stampOf(m, 'u-a', a, iso(T0 + 3 * H)); const sb = stampOf(m, 'u-a', b, iso(T0 + 3 * H));
    w.now = iso(T0 + 4 * H + 12 * H);
    expect(ops.verifyStamp(sa, a, LANE)).toMatchObject({ ok: true });
    w.now = iso(T0 + 4 * H + 12 * H + 1000);
    expect(ops.verifyStamp(sb, b, LANE)).toMatchObject({ ok: false, reason: expect.stringContaining('more than 12 hours later (OB-185)') as unknown });
    // Signed out at 1 h: the twelve hours run from the sign-out.
    w.now = iso(T0 + 20 * H);
    const token = await signInOn(ops, 'u-a');
    const m2 = ops.stampFor(token, LANE)!;
    const c = ev('c');
    const sc = stampOf(m2, 'u-a', c, iso(T0 + 20 * H + 30 * MIN));
    w.now = iso(T0 + 21 * H);
    await ops.signOut(token);
    w.now = iso(T0 + 33 * H + 1000);
    expect(ops.verifyStamp(sc, c, LANE)).toMatchObject({ ok: false, reason: expect.stringContaining(`which ended at ${iso(T0 + 21 * H)}`) as unknown });
  });

  it('visible on the phone: the drain dead-letters the record with the box\'s reason — never dropped, never silent', async () => {
    const q = openDeviceOutbox(noDeviceStore(), () => {});
    q.enqueue(ev('late'));
    const reason = 'the record was made under u-a\'s sign-in on this phone, which ended at 2026-10-14T06:30:00.000Z, and it reached this store computer more than 12 hours later (OB-185) — too late to be taken; a person must look at it';
    const fetch: FetchLike = async () => ({ status: 200, json: async () => ({ acks: [{ key: 'late', status: 'refused', reason }] }) });
    expect(await drainToBox({ outbox: q, boxBase: '', source: 'warehouse', fetch })).toMatchObject({ refused: 1 });
    expect(q.find('late')).toMatchObject({ state: 'dead_letter', reason: `refused by the store computer: ${reason}` });
  });
});

describe('NEW-3 / OB-187: the driver screen\'s sign-in lasts twelve hours; warehouse and picker four', () => {
  it('told apart by the job the sign-in is for, not by how the person signed in', () => {
    expect(HANDHELD_AUTHORITY.driver).toBe(DRIVER_PHONE_AUTHORITY);
    expect(DRIVER_PHONE_SESSION_HOURS).toBe(12);
    expect(sessionHoursFor(LANE, HANDHELD_AUTHORITY.driver)).toBe(12);
    expect(sessionHoursFor(LANE, HANDHELD_AUTHORITY.warehouse)).toBe(PHONE_SESSION_HOURS);
    expect(sessionHoursFor(LANE, HANDHELD_AUTHORITY.picker)).toBe(PHONE_SESSION_HOURS);
    expect(sessionHoursFor(LANE)).toBe(4);
    expect(sessionHoursFor('lane-1')).toBe(SESSION_HOURS);
  });

  it('a driver stamp at 11 h 59 m is the driver\'s; at 12 h 01 m refused by name; warehouse and picker stay at four hours', async () => {
    const w = { now: iso(T0) };
    const { ops, dir } = await register(w);
    const driver = await ops.signInOnDevice({ staffId: 'u-d', pin: PIN.d, deviceId: 'hh-01', authority: DRIVER_PHONE_AUTHORITY });
    expect(driver).toMatchObject({ signedIn: true, expiresAt: iso(T0 + 12 * H) });
    const m = ops.stampFor((driver as { token: string }).token, LANE)!;
    w.now = iso(T0 + 11 * H + 59 * MIN);
    expect(ops.check((driver as { token: string }).token, LANE)).toMatchObject({ ok: true, userId: 'u-d' });
    const inTime = stop('s1'); const late = stop('s2');
    expect(ops.verifyStamp(stampOf(m, 'u-d', inTime, iso(T0 + 11 * H + 59 * MIN)), inTime, LANE)).toEqual({ ok: true, userId: 'u-d', signedInAt: iso(T0) });
    w.now = iso(T0 + 12 * H + 5 * MIN);
    expect(ops.verifyStamp(stampOf(m, 'u-d', late, iso(T0 + 12 * H + 1 * MIN)), late, LANE)).toEqual({
      ok: false, reason: `the record was stamped at ${iso(T0 + 12 * H + MIN)}, outside u-d's sign-in on this phone (from ${iso(T0)} to ${iso(T0 + 12 * H)})`,
    });
    // The driver's phone page stamps up to its own twelve hours and nothing after.
    const page = { ...m, boxNow: iso(T0) };
    expect(phoneStamping(page, iso(T0), () => iso(T0 + 11 * H + 59 * MIN))!.stamp(inTime)).toBeDefined();
    expect(phoneStamping(page, iso(T0), () => iso(T0 + 12 * H + MIN))!.stamp(late)).toBeUndefined();
    // Warehouse and picker: four hours, as OB-184.
    for (const authority of [HANDHELD_AUTHORITY.warehouse, HANDHELD_AUTHORITY.picker]) {
      w.now = iso(T0 + 13 * H);
      const out = await ops.signInOnDevice({ staffId: 'u-a', pin: PIN.a, deviceId: 'hh-01', authority });
      expect(out).toMatchObject({ signedIn: true, expiresAt: iso(T0 + 17 * H) });
    }
    // After a restart the driver's twelve hours are read back as twelve (and a phone's four as four).
    w.now = iso(T0 + 13 * H);
    const reopened = (await register(w, dir)).ops;
    expect(reopened.verifyStamp(stampOf(m, 'u-d', stop('s3'), iso(T0 + 11 * H + 59 * MIN)), stop('s3'), LANE)).toMatchObject({ ok: true });
  });
});

describe('L1: the phone reckons from the box\'s clock again at each hand-over', () => {
  it('a phone clock that jumped ten minutes ahead after the page loaded is put right by the next reply, without a reload', async () => {
    const w = { now: iso(T0) };
    const { ops } = await register(w);
    const m = ops.stampFor(await signInOn(ops, 'u-a'), LANE)!;
    let phone = T0 - 10 * MIN; // ten minutes slow when the page loaded
    const stamping = phoneStamping({ ...m, boxNow: iso(T0) }, iso(phone), () => iso(phone), { storage: phoneStorage() })!;
    phone = T0 + 10 * MIN + 10_000; // auto-time put the phone right, ten seconds later
    w.now = iso(T0 + 10_000);
    const before = ev('before');
    expect(ops.verifyStamp(stamping.stamp(before)!, before, LANE)).toMatchObject({ ok: false }); // as the verifier found
    // The hand-over reply carries the box's clock: the drain tells the stamper.
    const q = openDeviceOutbox(noDeviceStore(), () => {});
    q.enqueue(ev('x'));
    const told: number[][] = [];
    const fetch: FetchLike = async () => ({ status: 200, json: async () => ({ acks: [{ key: 'x', status: 'accepted' }], boxNow: w.now }) });
    await drainToBox({ outbox: q, boxBase: '', source: 'warehouse', fetch, deviceNow: () => phone, onBoxTime: (b, p) => { told.push([b, p]); stamping.clock.learn(b, p); } });
    expect(told).toEqual([[T0 + 10_000, T0 + 10 * MIN + 10_000]]);
    phone += 20_000; w.now = iso(T0 + 30_000);
    const after = ev('after');
    const s = stamping.stamp(after)!;
    expect(s.madeAt).toBe(iso(T0 + 30_000));
    expect(ops.verifyStamp(s, after, LANE)).toMatchObject({ ok: true });
  });

  it('a "nobody is signed in" reply (401) carries the clock too; a reply without one tells nothing', async () => {
    const told: number[] = [];
    const q = openDeviceOutbox(noDeviceStore(), () => {});
    q.enqueue(ev('x'));
    await drainToBox({ outbox: q, boxBase: '', source: 'warehouse', fetch: async () => ({ status: 401, json: async () => ({ acks: [], boxNow: iso(T0) }) }), onBoxTime: (b) => told.push(b) });
    await drainToBox({ outbox: q, boxBase: '', source: 'warehouse', fetch: async () => ({ status: 200, json: async () => ({ acks: [] }) }), onBoxTime: (b) => told.push(b) });
    expect(told).toEqual([T0]);
    expect(q.find('x')).toMatchObject({ state: 'pending' });
  });

  it('the box\'s clock also ends a sign-in the phone\'s clock was hiding: a set-back page learns the truth and stops', () => {
    let phone = T0 + 1 * H; // the clock says 09:30, the box says it is 13:00
    const stamping = phoneStamping(signInAt(T0), iso(T0), () => iso(phone), { storage: phoneStorage() })!;
    expect(stamping.stamp(ev('a'))).toBeDefined();
    stamping.clock.learn(T0 + 4 * H + 30 * MIN, phone);
    phone += 1000;
    expect(stamping.stamp(ev('b'))).toBeUndefined();
  });
});

describe('L2 and L3: the record that finds the end locks the screen at once; the lock drops the key and stops the timers', () => {
  it('pageStamping: the end found by a record calls the page\'s lock once that record is saved; the record is kept, unstamped', async () => {
    const storage = phoneStorage();
    const calls: string[] = [];
    let phone = T0; // the page is served at 08:00, the phone's clock right
    const store = noDeviceStore();
    const win: Record<string, unknown> = { phoneSignIn: signInAt(T0), phoneSignInLock: (why: string) => { calls.push(`lock:${why}:${(JSON.parse(store.read() ?? '[]') as unknown[]).length}`); } };
    const q = openDeviceOutbox(store, () => {}, stamperForPage(win, () => iso(phone), { storage }));
    phone = T0 + 3 * H;
    expect(q.enqueue(ev('in')).stamp).toBeDefined();
    phone = T0 + 4 * H;
    const found = q.enqueue(ev('edge'));
    expect(found.stamp).toBeUndefined();
    expect(calls).toEqual([]); // not in the middle of the save ...
    await Promise.resolve();
    expect(calls).toEqual(['lock:expired:2']); // ... right after it, with the record on the phone
    expect(q.pending().map((i) => i.key)).toEqual(['in', 'edge']);
  });

  it('the lock\'s hooks drop the stamp key: after them the page stamps nothing even with the clock inside the sign-in', () => {
    const win: Record<string, unknown> = { phoneSignIn: signInAt(T0) };
    const stamping = pageStamping(win, () => iso(T0 + MIN), { storage: phoneStorage() })!;
    expect(stamping.stamp(ev('a'))).toBeDefined();
    for (const hook of win['phoneSignInOnLock'] as (() => void)[]) hook();
    expect(stamping.stamp(ev('b'))).toBeUndefined();
    expect(stamping.clock.read()).toEqual({ ended: true, why: 'locked' });
  });

  it('the strip\'s lock runs the page\'s hooks (the screen\'s timers), forgets window.phoneSignIn, stops its own tick — once; the queue can lock it directly', () => {
    const storage = phoneStorage();
    const s = signInAt(T0);
    const ran: string[] = [];
    const phone = stripRunning(s, storage, T0, { phoneSignInOnLock: [() => ran.push('sync timer'), () => ran.push('badge timer'), () => { throw new Error('a broken hook'); }, () => ran.push('stamp key')] });
    expect(typeof phone.win['phoneSignInLock']).toBe('function');
    (phone.win['phoneSignInLock'] as (why: string) => void)('expired');
    expect(ran).toEqual(['sync timer', 'badge timer', 'stamp key']);
    expect(phone.win['phoneSignIn']).toBeUndefined();
    expect(phone.tick).toBeNull();
    expect(phone.opened).toBe(1);
    expect(phone.address).toEqual(['/device/sign-in?screen=warehouse&ended=1']);
    (phone.win['phoneSignInLock'] as (why: string) => void)('clock_set_back');
    expect(phone.opened).toBe(1);
  });
});
