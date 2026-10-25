import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TillOperators, TILL_AUTHORITY, type SignInLogEntry } from '../../edge/store-edge/src/till-operators';
import { issueTillCredential, tillPinKey, type TillCredential } from '../../packages/identity/src/till-pin';
import { testPin } from '../support/till-operator';
import { readTillSignIn, lockoutEpisodes, FAILED_SIGN_IN_REASONS } from '../../services/identity/src/till-sign-in-log';
import { raiseOwnerAlerts, type ExceptionEvent } from '../../packages/owner-control/src/index';
import { THRESHOLD_KINDS, THRESHOLD_WORDS, engineThresholds } from '../../services/reporting/src/owner-exceptions';
import { ALERT_KINDS, ALERT_INPUT, ownerAlertsWords } from '../../apps/web-erp/src/owner-alerts-session';
import { EVENT_ROUTES } from '../../edge/sync-agent/src/http-transport';

/**
 * **OB-365 (owner, 24–25 Oct 2026, in writing): the store computer sends its till sign-in log to head office, so the
 * after-hours and failed-sign-in alerts work — never a PIN or its hash.**
 *
 * The box's register hands each record of its log over as a `SignInLogEntry` (who, where, when, what happened): never the
 * session token's hash, never a PIN; the same record has the same id after a restart (so it is sent and kept once); a try
 * on a locked lane is now in the log too. Head office refuses a record carrying anything secret; lockouts are counted as
 * episodes; the sixth owner alert — failed sign-ins — fires from the owner's own number (never before it is set).
 */

const KEY = tillPinKey(['ob365', 'unit', 'key'].join('-').padEnd(48, '0'));
const MEENA_PIN = testPin(365);
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const open = async (dir: string, now: () => string) => TillOperators.open({
  dataDir: dir, capacityBytes: 10_485_760, key: KEY,
  credentials: async () => new Map<string, TillCredential>([['u-meena', issueTillCredential({ userId: 'u-meena', pin: MEENA_PIN, key: KEY, issuedAt: '2026-10-06T07:00:00.000Z', issuedBy: 'Store admin' })]]),
  pack: { people: () => [{ userId: 'u-meena', displayName: 'Meena' }], permissionsOf: () => [TILL_AUTHORITY] },
  now,
});

describe('the box hands its sign-in log over without a PIN or a hash (OB-365)', () => {
  it('every record — sign-in, refusal, sign-out — as an entry; no token hash; the same ids after a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob365-'));
    dirs.push(dir);
    let t = Date.parse('2026-10-06T09:00:00.000Z');
    const now = () => new Date(t += 1_000).toISOString();
    const ops = await open(dir, now);
    const heard: SignInLogEntry[] = [];
    ops.onLogged((e) => { heard.push(e); });
    const signed = await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-1' });
    expect(signed.signedIn).toBe(true);
    const wrong = String((Number(MEENA_PIN) + 1) % 1_000_000).padStart(6, '1');
    expect((await ops.signIn({ staffId: 'u-meena', pin: wrong, laneId: 'lane-1' })).signedIn).toBe(false);
    expect(await ops.signOut(signed.signedIn ? signed.token : undefined)).toBe(true);

    expect(heard.map((e) => [e.kind, e.person, e.laneId, e.reason ?? e.via ?? null])).toEqual([
      ['signed_in', 'u-meena', 'lane-1', 'pin'], ['refused', 'u-meena', 'lane-1', 'wrong_staff_id_or_pin'], ['signed_out', 'u-meena', 'lane-1', null],
    ]);
    const text = JSON.stringify(heard);
    expect(text).not.toMatch(/tokenHash|token|verifier|salt|"pin":/i);
    expect(text).not.toContain(MEENA_PIN);
    expect(text).not.toContain(wrong);
    if (signed.signedIn) expect(text).not.toContain(signed.token);
    expect(ops.relayable()).toEqual(heard);

    // A restart: the same records, the same ids — so nothing is sent (or kept) twice.
    const again = await open(dir, now);
    expect(again.relayable()).toEqual(heard);
    expect(new Set(again.relayable().map((e) => e.entryId)).size).toBe(3);
  });

  it('a try on a LOCKED lane is written to the log (head office sees the lockout) and extends nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob365-lane-'));
    dirs.push(dir);
    let t = Date.parse('2026-10-06T09:00:00.000Z');
    const ops = await open(dir, () => new Date(t += 100).toISOString());
    for (let i = 0; i < 20; i += 1) await ops.signIn({ staffId: `u-x${i}`, pin: '123456', laneId: 'lane-2' });
    const locked = await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-2' });
    expect(locked).toMatchObject({ signedIn: false, refusedBecause: 'lane_locked' });
    const last = ops.relayable().at(-1)!;
    expect(last).toMatchObject({ kind: 'refused', reason: 'lane_locked', laneId: 'lane-2', person: 'u-meena' });
    // Fifteen minutes on, the lane opens again — the logged tries did not keep it locked.
    t += 16 * 60_000;
    expect((await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-2' })).signedIn).toBe(true);
  });

  it('the box sends it on its own synced route', () => {
    expect(EVENT_ROUTES['TillSignInLogged']).toBe('/v1/identity/till-sign-ins/:entryId/synced');
  });
});

describe('head office keeps it — never a secret — and counts lockouts as episodes (OB-365)', () => {
  const base = { entryId: 'tsl-1', kind: 'refused', at: '2026-10-06T09:00:00.000Z', laneId: 'lane-1', person: 'u-x', reason: 'wrong_staff_id_or_pin' };
  it('reads a record; refuses one carrying a PIN, a token or a hash, at any depth, by name', () => {
    expect(readTillSignIn('tsl-1', base)).toMatchObject({ ok: true, value: { entryId: 'tsl-1', kind: 'refused', reason: 'wrong_staff_id_or_pin' } });
    for (const extra of [{ pin: '123456' }, { tokenHash: 'ab' }, { pinHash: 'cd' }, { meta: { verifier: 'x' } }, { salt: 's' }]) {
      const r = readTillSignIn('tsl-1', { ...base, ...extra });
      expect(r, JSON.stringify(extra)).toMatchObject({ ok: false, secret: true });
    }
    expect(readTillSignIn('tsl-2', base)).toMatchObject({ ok: false }); // the id must match the path
    expect(readTillSignIn('tsl-1', { ...base, reason: 'because' })).toMatchObject({ ok: false });
    expect(readTillSignIn('tsl-1', { ...base, kind: 'signed_in' })).toMatchObject({ ok: false }); // a sign-in says how
    expect(readTillSignIn('tsl-1', { ...base, colour: 'red' })).toMatchObject({ ok: false });
  });
  it('a lockout is one episode however many tries it refused; two episodes when fifteen minutes apart', () => {
    const r = (id: string, at: string, reason = 'locked', person = 'u-x') => ({ entryId: id, kind: 'refused' as const, at, reason, person, laneId: 'lane-1' });
    const eps = lockoutEpisodes([
      r('a', '2026-10-06T09:00:00Z'), r('b', '2026-10-06T09:05:00Z'), r('c', '2026-10-06T09:10:00Z'),
      r('d', '2026-10-06T10:00:00Z'), r('e', '2026-10-06T09:01:00Z', 'wrong_staff_id_or_pin'), r('f', '2026-10-06T09:02:00Z', 'lane_locked', 'u-y'),
    ]);
    expect(eps.map((e) => [e.who, e.entryIds.length])).toEqual([['lane:lane-1', 1], ['u-x', 3], ['u-x', 1]]);
    expect(FAILED_SIGN_IN_REASONS).toEqual(['wrong_staff_id_or_pin', 'locked', 'lane_locked']);
  });
});

describe('the sixth owner alert: failed sign-ins (OB-365)', () => {
  const ev = (id: string, lockedOut = false): ExceptionEvent => ({ eventId: id, kind: 'failed_sign_in', at: '2026-10-06T09:00:00Z', branchId: 'S1', actorId: 'u-x', laneId: 'lane-1', valueMinor: 0, transactionRef: id, ...(lockedOut ? { lockedOut: true } : {}) });
  it('nothing fires until the owner sets his number; at it, attention; a lockout among them, urgent', () => {
    expect(raiseOwnerAlerts({ events: [ev('a'), ev('b'), ev('c')], thresholds: {} })).toEqual([]);
    const set = engineThresholds([{ kind: 'failed_sign_in', value: 3, setBy: 'u-owner', setAt: '2026-10-06T08:00:00Z' }]);
    expect(set).toEqual({ failedSignInCount: 3 });
    expect(raiseOwnerAlerts({ events: [ev('a'), ev('b')], thresholds: set })).toEqual([]);
    expect(raiseOwnerAlerts({ events: [ev('a'), ev('b'), ev('c')], thresholds: set })[0]).toMatchObject({ kind: 'failed_sign_in', severity: 'attention', count: 3, actorId: 'u-x' });
    const urgent = raiseOwnerAlerts({ events: [ev('a'), ev('b'), ev('c', true)], thresholds: set })[0]!;
    expect(urgent).toMatchObject({ severity: 'urgent' });
    expect(urgent.headline).toContain('locked out');
  });
  it('the owner\'s screen and head office both know it, in English and Tamil, typed as a count', () => {
    expect(THRESHOLD_KINDS).toContain('failed_sign_in');
    expect(THRESHOLD_WORDS.failed_sign_in.ta).toMatch(/[஀-௿]/);
    expect(ALERT_KINDS).toContain('failed_sign_in');
    expect(ALERT_INPUT.failed_sign_in).toBe('count');
    expect(ownerAlertsWords('ta', 'failed_sign_in')).toMatch(/[஀-௿]/);
    expect(ownerAlertsWords('en', 'thresholdsH')).toBe('Your six alerts');
  });
});
