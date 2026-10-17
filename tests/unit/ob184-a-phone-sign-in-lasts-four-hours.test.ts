import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TillOperators, TILL_AUTHORITY, SESSION_HOURS, PHONE_SESSION_HOURS, STAMP_CLOCK_SLACK_MS, deviceLaneOf, sessionHoursFor,
} from '../../edge/store-edge/src/till-operators';
import { PHONE_HANDOVER_WINDOW_MS, phoneHolderStrip, signInLeftWords } from '../../edge/store-edge/src/handheld-sign-in';
import { openFileLog } from '../../edge/store-edge/src/file-log';
import { issueTillCredential, tillPinKey } from '../../packages/identity/src/till-pin';
import { makeEvent, type DomainEvent } from '../../packages/contracts/src/event';
import { fromHex, hmacSha256Hex, phoneStamper, stampMessage, type SignInStamp } from '../../packages/sync/src/sign-in-stamp';
import { testPin } from '../support/till-operator';

/**
 * **OB-184 "A" (owner, 17 Oct 2026, "Sign out + 4-hour limit"): a phone (handheld) sign-in lasts at most four hours; a
 * till's is unchanged (twelve).** And OB-185 "A" ("12 hours") is kept: a phone record may still reach the box up to twelve
 * hours after the sign-in it was made under ENDED — now at the latest four hours after it began.
 *
 * The box's register itself: the expiry it gives each kind of sign-in; a phone sign-in written to the log before the
 * limit read back as four hours; the OB-180 stamp window ending at the four hours (a hard edge — the phone stops stamping
 * there); the phone's own stamper stopping there; and the words the phone's screen shows. The real box is
 * tests/integration/ob184-*.test.ts; a real browser, tests/e2e/ob184-*.e2e.ts. Synthetic data only.
 */

const BOX_KEY = ['ob184', 'phone', 'unit', 'key'].join('-').padEnd(48, '0');
const KEY = tillPinKey(BOX_KEY);
const PIN = testPin(184);
const JOB = 'inventory.movement.append';
const T0 = '2026-10-17T08:00:00.000Z';
const H = 3_600_000;
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

interface World { now: string }
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const register = async (w: World, dir?: string): Promise<{ ops: TillOperators; dir: string }> => {
  const d = dir ?? await mkdtemp(join(tmpdir(), 'sre-ob184-'));
  if (dir === undefined) dirs.push(d);
  const creds = new Map([['u-a', issueTillCredential({ userId: 'u-a', pin: PIN, key: KEY, issuedAt: '2026-10-17T05:00:00.000Z', issuedBy: 'Store admin' })]]);
  const ops = await TillOperators.open({
    dataDir: d, capacityBytes: 10_485_760, key: KEY, credentials: async () => creds,
    pack: { people: () => [{ userId: 'u-a', displayName: 'A' }], permissionsOf: () => [JOB, TILL_AUTHORITY] },
    now: () => w.now,
  });
  return { ops, dir: d };
};
const onPhone = async (ops: TillOperators): Promise<{ token: string; expiresAt: string }> => {
  const out = await ops.signInOnDevice({ staffId: 'u-a', pin: PIN, deviceId: 'hh-01', authority: JOB });
  if (!out.signedIn) throw new Error(out.laneMessage);
  return out;
};
const ev = (key: string): DomainEvent => makeEvent({
  id: `e-${key}`, type: 'ReceivingScanned', occurredAt: T0, idempotencyKey: key, source: 'A-1',
  payload: { grnId: 'grn-1', commandId: key, productId: 'p-1', quantityMinor: 6, receivedBy: 'u-a', storeId: 'store-1' },
});
const stampOf = (m: { ref: string; key: string }, event: DomainEvent, madeAt: string): SignInStamp => {
  const base = { v: 1 as const, ref: m.ref, userId: 'u-a', madeAt };
  return { ...base, mac: hmacSha256Hex(fromHex(m.key), stampMessage(base, event)) };
};
const PHONE = deviceLaneOf('hh-01');

describe('OB-184: how long a sign-in lasts', () => {
  it('the constants: a phone four hours, a till twelve, told apart by the lane', () => {
    expect(PHONE_SESSION_HOURS).toBe(4);
    expect(SESSION_HOURS).toBe(12);
    expect(sessionHoursFor(PHONE)).toBe(4);
    expect(sessionHoursFor('lane-1')).toBe(12);
  });

  it('a phone sign-in ends four hours after it began — working at 3 h 59 m, ended at 4 h', async () => {
    const w: World = { now: T0 };
    const { ops } = await register(w);
    const a = await onPhone(ops);
    expect(a.expiresAt).toBe(at(4 * 60));
    w.now = at(4 * 60 - 1);
    expect(ops.check(a.token, PHONE)).toMatchObject({ ok: true, userId: 'u-a', expiresAt: at(4 * 60), authority: JOB });
    expect(ops.stampFor(a.token, PHONE)).toMatchObject({ expiresAt: at(4 * 60) });
    w.now = at(4 * 60);
    expect(ops.check(a.token, PHONE)).toMatchObject({ ok: false, refusedBecause: 'operator_session_ended' });
    expect(ops.stampFor(a.token, PHONE)).toBeNull();
    expect(ops.live()).toEqual([]);
  });

  it('a till sign-in is unchanged: twelve hours — still working at 11 h 59 m, even beside an ended phone sign-in', async () => {
    const w: World = { now: T0 };
    const { ops } = await register(w);
    const phone = await onPhone(ops);
    const till = await ops.signIn({ staffId: 'u-a', pin: PIN, laneId: 'lane-1' });
    if (!till.signedIn) throw new Error(till.laneMessage);
    expect(till.expiresAt).toBe(at(12 * 60));
    w.now = at(5 * 60);
    expect(ops.check(phone.token, PHONE)).toMatchObject({ ok: false, refusedBecause: 'operator_session_ended' });
    expect(ops.check(till.token, 'lane-1')).toMatchObject({ ok: true, userId: 'u-a' });
    w.now = at(12 * 60 - 1);
    expect(ops.check(till.token, 'lane-1')).toMatchObject({ ok: true });
    w.now = at(12 * 60);
    expect(ops.check(till.token, 'lane-1')).toMatchObject({ ok: false, refusedBecause: 'operator_session_ended' });
  });

  it('survives a restart; a phone sign-in written BEFORE the limit (twelve hours) is read back as four — the log line kept as written', async () => {
    const w: World = { now: T0 };
    const first = await register(w);
    const a = await onPhone(first.ops);
    // An older box wrote a phone sign-in with a twelve-hour expiry.
    const oldToken = 'old-phone-session-token';
    const log = await openFileLog({ dataDir: first.dir, capacityBytes: 10_485_760, fileName: 'till-operators.log' });
    await log.append(JSON.stringify({ kind: 'signed_in', at: T0, userId: 'u-a', laneId: deviceLaneOf('hh-02'), via: 'pin', tokenHash: createHash('sha256').update(oldToken, 'utf8').digest('hex'), expiresAt: at(12 * 60), authority: JOB }));
    await log.close();
    const again = await register(w, first.dir);
    expect(again.ops.check(a.token, PHONE)).toMatchObject({ ok: true, expiresAt: at(4 * 60) });
    expect(again.ops.check(oldToken, deviceLaneOf('hh-02'))).toMatchObject({ ok: true, expiresAt: at(4 * 60) });
    w.now = at(4 * 60 + 1);
    expect(again.ops.check(oldToken, deviceLaneOf('hh-02'))).toMatchObject({ ok: false, refusedBecause: 'operator_session_ended' });
  });
});

describe('OB-184 with OB-180: the stamp window follows the four hours', () => {
  it('a record stamped at 3 h 59 m is the person\'s; at 4 h and 4 h 01 m it is refused by name — the expiry has no slack', async () => {
    const w: World = { now: T0 };
    const { ops } = await register(w);
    const a = await onPhone(ops);
    const m = ops.stampFor(a.token, PHONE)!;
    w.now = at(5 * 60);
    const e = ev('k1');
    expect(ops.verifyStamp(stampOf(m, e, at(4 * 60 - 1)), e, PHONE)).toEqual({ ok: true, userId: 'u-a', signedInAt: T0 });
    const outside = `outside u-a's sign-in on this phone (from ${T0} to ${at(4 * 60)})`;
    expect(ops.verifyStamp(stampOf(m, e, at(4 * 60)), e, PHONE)).toEqual({ ok: false, reason: `the record was stamped at ${at(4 * 60)}, ${outside}` });
    expect(ops.verifyStamp(stampOf(m, e, at(4 * 60 + 1)), e, PHONE)).toEqual({ ok: false, reason: `the record was stamped at ${at(4 * 60 + 1)}, ${outside}` });
  });

  it('the clock slack still covers a sign-out the phone was not told of, and the start', async () => {
    const w: World = { now: T0 };
    const { ops } = await register(w);
    const a = await onPhone(ops);
    const m = ops.stampFor(a.token, PHONE)!;
    w.now = at(120);
    await ops.signOut(a.token);
    w.now = at(180);
    const e = ev('k1');
    const slackMin = STAMP_CLOCK_SLACK_MS / 60_000;
    expect(ops.verifyStamp(stampOf(m, e, at(120 + slackMin - 1)), e, PHONE)).toMatchObject({ ok: true });
    expect(ops.verifyStamp(stampOf(m, e, at(120 + slackMin + 1)), e, PHONE)).toMatchObject({ ok: false });
    expect(ops.verifyStamp(stampOf(m, e, at(-(slackMin - 1))), e, PHONE)).toMatchObject({ ok: true });
  });

  it('the phone\'s own stamper (from the served sign-in) stamps up to the four hours and nothing after', async () => {
    const w: World = { now: T0 };
    const { ops } = await register(w);
    const a = await onPhone(ops);
    const served = { ...ops.stampFor(a.token, PHONE)!, boxNow: T0 };
    let phoneNow = T0;
    const stamp = phoneStamper(served, T0, () => phoneNow)!;
    phoneNow = at(4 * 60 - 1);
    const s = stamp(ev('k1'));
    expect(s).toMatchObject({ userId: 'u-a', madeAt: at(4 * 60 - 1) });
    phoneNow = at(4 * 60);
    expect(stamp(ev('k2'))).toBeUndefined();
    w.now = at(4 * 60 + 30);
    expect(ops.verifyStamp(s!, ev('k1'), PHONE)).toMatchObject({ ok: true, userId: 'u-a' });
  });
});

describe('OB-184 with OB-185: a late record is judged from when the sign-in ENDED', () => {
  it('held recently up to twelve hours after the four-hour end (16 h after signing in), not a minute later', async () => {
    expect(PHONE_HANDOVER_WINDOW_MS).toBe(12 * H);
    const w: World = { now: T0 };
    const { ops } = await register(w);
    await onPhone(ops);
    w.now = at((4 + 12) * 60);
    expect(ops.heldRecently('u-a', PHONE, PHONE_HANDOVER_WINDOW_MS)).toBe(true);
    w.now = at((4 + 12) * 60 + 1);
    expect(ops.heldRecently('u-a', PHONE, PHONE_HANDOVER_WINDOW_MS)).toBe(false);
  });
});

describe('OB-184: the phone\'s screen says how long the sign-in has left, in English and Tamil', () => {
  it('the words', () => {
    expect(signInLeftWords(4 * H)).toEqual({ ended: false, text: 'Sign-in ends in 4 h 0 min · உள்நுழைவு முடிய 4 மணி 0 நிமிடம்' });
    expect(signInLeftWords(3 * H + 59 * 60_000 + 1)).toMatchObject({ text: expect.stringContaining('Sign-in ends in 4 h 0 min') as unknown });
    expect(signInLeftWords(65 * 60_000)).toMatchObject({ ended: false, text: expect.stringContaining('1 h 5 min') as unknown });
    expect(signInLeftWords(1)).toMatchObject({ ended: false, text: expect.stringContaining('0 h 1 min') as unknown });
    for (const ms of [0, -1, Number.NaN]) {
      expect(signInLeftWords(ms)).toEqual({ ended: true, text: 'Your sign-in has ended. Sign out and sign in again. · உங்கள் உள்நுழைவு முடிந்தது. வெளியேறி மீண்டும் உள்நுழைக.' });
    }
  });

  it('the strip carries them: live, then ended (as an alert); without an expiry it is as before', () => {
    const live = phoneHolderStrip({ displayName: 'A', signOutAction: '/device/sign-out?screen=warehouse', expiresAt: at(240), now: at(1) });
    expect(live).toContain('data-sign-in-left style=');
    expect(live).toContain('Sign-in ends in 3 h 59 min · உள்நுழைவு முடிய 3 மணி 59 நிமிடம்');
    expect(live).not.toContain('role="alert"');
    const ended = phoneHolderStrip({ displayName: 'A', signOutAction: '/device/sign-out?screen=warehouse', expiresAt: at(240), now: at(240) });
    expect(ended).toContain('data-sign-in-left data-ended role="alert"');
    expect(ended).toContain('Your sign-in has ended.');
    expect(phoneHolderStrip({ displayName: 'A', signOutAction: '/x' })).not.toContain('data-sign-in-left');
  });
});
