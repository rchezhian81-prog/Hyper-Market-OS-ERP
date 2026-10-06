import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TillOperators, readTillCredentials, TILL_AUTHORITY, SESSION_HOURS } from '../../edge/store-edge/src/till-operators';
import { issueTillCredential, tillPinKey, type TillCredential } from '../../packages/identity/src/till-pin';
import { testPin } from '../support/till-operator';

/**
 * **Who is at the till is decided by the store computer, offline (ADR-0020 §3–§5 · audit PF-02 · M02-FR-01).**
 *
 * Before this, the till sent whatever staff code was typed and the box wrote it as the cashier. These drive the box's
 * operator register itself: a staff ID and a till PIN against a verifier issued on this box, for a person the pack names
 * with till authority; one answer for every wrong guess; lockouts per person and per lane; a session bound to the lane
 * that ends at twelve hours, at sign-out, or the moment the person loses till authority; a log that survives a restart
 * and never holds a PIN or a token.
 */

const BOX_KEY = ['till', 'operators', 'unit', 'key'].join('-').padEnd(48, '0');
const KEY = tillPinKey(BOX_KEY);
const MEENA_PIN = testPin(101);
const RAVI_PIN = testPin(202);
const FLOOR_PIN = testPin(303);

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

interface World {
  people: { userId: string; displayName: string }[] | null;
  permissions: Record<string, string[]> | null;
  credentials: Map<string, TillCredential>;
  now: string;
}

const world = (): World => ({
  people: [{ userId: 'u-meena', displayName: 'Meena' }, { userId: 'u-ravi', displayName: 'Ravi' }, { userId: 'u-floor', displayName: 'Floor' }],
  permissions: { 'u-meena': [TILL_AUTHORITY], 'u-ravi': [TILL_AUTHORITY], 'u-floor': ['pos.exception.read'] },
  credentials: new Map([
    ['u-meena', issueTillCredential({ userId: 'u-meena', pin: MEENA_PIN, key: KEY, issuedAt: '2026-10-06T07:00:00.000Z', issuedBy: 'Store admin' })],
    ['u-ravi', issueTillCredential({ userId: 'u-ravi', pin: RAVI_PIN, key: KEY, issuedAt: '2026-10-06T07:00:00.000Z', issuedBy: 'Store admin' })],
    ['u-floor', issueTillCredential({ userId: 'u-floor', pin: FLOOR_PIN, key: KEY, issuedAt: '2026-10-06T07:00:00.000Z', issuedBy: 'Store admin' })],
  ]),
  now: '2026-10-06T09:00:00.000Z',
});

const open = async (w: World, dir?: string): Promise<{ ops: TillOperators; dir: string }> => {
  const d = dir ?? await mkdtemp(join(tmpdir(), 'sre-till-ops-'));
  if (dir === undefined) dirs.push(d);
  const ops = await TillOperators.open({
    dataDir: d, capacityBytes: 10_485_760, key: KEY,
    credentials: async () => w.credentials,
    pack: { people: () => w.people, permissionsOf: (u) => (w.permissions === null ? null : w.permissions[u] ?? []) },
    now: () => w.now,
  });
  return { ops, dir: d };
};
const later = (w: World, minutes: number): void => { w.now = new Date(Date.parse(w.now) + minutes * 60_000).toISOString(); };

describe('signing in at the till', () => {
  it('the right staff ID and PIN open a session on this lane, named as the pack names the person', async () => {
    const w = world();
    const { ops } = await open(w);
    const out = await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-1' });
    expect(out).toMatchObject({ signedIn: true, userId: 'u-meena', displayName: 'Meena', via: 'pin', expiresAt: '2026-10-06T21:00:00.000Z' });
    if (!out.signedIn) throw new Error('unreachable');
    expect(out.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ops.check(out.token, 'lane-1')).toMatchObject({ ok: true, userId: 'u-meena', displayName: 'Meena', via: 'pin' });
    expect(SESSION_HOURS).toBe(12);
  });

  it('a wrong PIN, an unknown staff ID, a person with no PIN issued and a revoked PIN all get the SAME answer', async () => {
    const w = world();
    w.people!.push({ userId: 'u-new', displayName: 'New starter' });
    w.permissions!['u-new'] = [TILL_AUTHORITY];
    w.credentials.set('u-ravi', { userId: 'u-ravi', salt: '', verifier: '', issuedAt: '2026-10-06T08:00:00.000Z', issuedBy: 'Store admin', revoked: true });
    const { ops } = await open(w);
    const answers = await Promise.all([
      ops.signIn({ staffId: 'u-meena', pin: RAVI_PIN, laneId: 'lane-1' }),
      ops.signIn({ staffId: 'u-ghost', pin: MEENA_PIN, laneId: 'lane-1' }),
      ops.signIn({ staffId: 'u-new', pin: MEENA_PIN, laneId: 'lane-1' }),
      ops.signIn({ staffId: 'u-ravi', pin: RAVI_PIN, laneId: 'lane-1' }),
    ]);
    for (const a of answers) expect(a).toEqual({ signedIn: false, refusedBecause: 'wrong_staff_id_or_pin', laneMessage: expect.stringMatching(/do not match/) });
  });

  it('a person the pack names WITHOUT till authority is refused, even with their own right PIN', async () => {
    const w = world();
    const { ops } = await open(w);
    expect(await ops.signIn({ staffId: 'u-floor', pin: FLOOR_PIN, laneId: 'lane-1' })).toMatchObject({ signedIn: false, refusedBecause: 'no_till_authority' });
  });

  it('a pack with no people or no role register signs NOBODY in (fail closed)', async () => {
    const w = world();
    w.people = null;
    const a = await open(w);
    expect(await a.ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-1' })).toMatchObject({ signedIn: false, refusedBecause: 'no_people_register' });
    const w2 = world();
    w2.permissions = null;
    const b = await open(w2);
    expect(await b.ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-1' })).toMatchObject({ signedIn: false, refusedBecause: 'no_people_register' });
  });

  it('a box never told which lane it is signs nobody in; an unreadable ID or PIN is said plainly', async () => {
    const w = world();
    const { ops } = await open(w);
    expect(await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: '' })).toMatchObject({ signedIn: false, refusedBecause: 'no_lane' });
    expect(await ops.signInVerified({ userId: 'u-meena', laneId: ' ' })).toMatchObject({ signedIn: false, refusedBecause: 'no_lane' });
    expect(await ops.signIn({ staffId: '', pin: MEENA_PIN, laneId: 'lane-1' })).toMatchObject({ signedIn: false, refusedBecause: 'not_readable' });
    expect(await ops.signIn({ staffId: 'u-meena', pin: '12', laneId: 'lane-1' })).toMatchObject({ signedIn: false, refusedBecause: 'not_readable' });
  });

  it('five wrong PINs lock that staff ID for fifteen minutes — even the right PIN is refused — then it opens again', async () => {
    const w = world();
    const { ops } = await open(w);
    for (let i = 0; i < 5; i += 1) expect(await ops.signIn({ staffId: 'u-meena', pin: RAVI_PIN, laneId: 'lane-1' })).toMatchObject({ refusedBecause: 'wrong_staff_id_or_pin' });
    expect(await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-1' })).toMatchObject({ signedIn: false, refusedBecause: 'locked' });
    // Another person on the same till is not locked out by Meena's mistakes.
    expect(await ops.signIn({ staffId: 'u-ravi', pin: RAVI_PIN, laneId: 'lane-1' })).toMatchObject({ signedIn: true });
    later(w, 16);
    expect(await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-1' })).toMatchObject({ signedIn: true });
  });

  it('twenty refusals on one lane lock that lane\'s sign-in for fifteen minutes — guessing across many staff IDs is bounded too', async () => {
    const w = world();
    const { ops } = await open(w);
    for (let i = 0; i < 20; i += 1) await ops.signIn({ staffId: `u-guess-${i}`, pin: MEENA_PIN, laneId: 'lane-1' });
    expect(await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-1' })).toMatchObject({ signedIn: false, refusedBecause: 'lane_locked' });
    // Another lane is not locked.
    expect(await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-2' })).toMatchObject({ signedIn: true });
    later(w, 16);
    expect(await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-1' })).toMatchObject({ signedIn: true });
  });
});

describe('the session every money write is checked against', () => {
  it('belongs to its lane: the same token on another till is refused', async () => {
    const w = world();
    const { ops } = await open(w);
    const out = await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-1' });
    if (!out.signedIn) throw new Error('sign-in refused');
    expect(ops.check(out.token, 'lane-2')).toMatchObject({ ok: false, refusedBecause: 'operator_on_another_lane' });
    expect(ops.check(undefined, 'lane-1')).toMatchObject({ ok: false, refusedBecause: 'operator_not_signed_in' });
    expect(ops.check('not-a-token', 'lane-1')).toMatchObject({ ok: false, refusedBecause: 'operator_not_signed_in' });
  });

  it('ends after twelve hours, and at sign-out', async () => {
    const w = world();
    const { ops } = await open(w);
    const a = await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-1' });
    const b = await ops.signIn({ staffId: 'u-ravi', pin: RAVI_PIN, laneId: 'lane-2' });
    if (!a.signedIn || !b.signedIn) throw new Error('sign-in refused');
    expect(await ops.signOut(b.token)).toBe(true);
    expect(ops.check(b.token, 'lane-2')).toMatchObject({ ok: false, refusedBecause: 'operator_not_signed_in' });
    expect(await ops.signOut(b.token)).toBe(false);
    later(w, 12 * 60);
    expect(ops.check(a.token, 'lane-1')).toMatchObject({ ok: false, refusedBecause: 'operator_session_ended' });
    expect(ops.live()).toEqual([]);
  });

  it('ends the moment the person loses till authority in the pack — a leaver\'s next write is refused', async () => {
    const w = world();
    const { ops } = await open(w);
    const out = await ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-1' });
    if (!out.signedIn) throw new Error('sign-in refused');
    w.permissions!['u-meena'] = [];
    expect(ops.check(out.token, 'lane-1')).toMatchObject({ ok: false, refusedBecause: 'operator_lost_till_authority', laneMessage: expect.stringMatching(/Nothing was saved/) });
  });

  it('survives a restart of the box — and the log holds neither the PIN nor the token', async () => {
    const w = world();
    const first = await open(w);
    const out = await first.ops.signIn({ staffId: 'u-meena', pin: MEENA_PIN, laneId: 'lane-1' });
    await first.ops.signIn({ staffId: 'u-ravi', pin: MEENA_PIN, laneId: 'lane-1' }); // a refusal, logged
    if (!out.signedIn) throw new Error('sign-in refused');
    const again = await open(w, first.dir);
    expect(again.ops.check(out.token, 'lane-1')).toMatchObject({ ok: true, userId: 'u-meena' });
    expect(again.ops.live()).toEqual([{ userId: 'u-meena', laneId: 'lane-1', via: 'pin', expiresAt: '2026-10-06T21:00:00.000Z' }]);
    expect(again.ops.unreadableRecords).toBe(0);
    const log = await readFile(join(first.dir, 'till-operators.log'), 'utf8');
    expect(log).toContain('signed_in');
    expect(log).toContain('wrong_staff_id_or_pin');
    expect(log).not.toContain(MEENA_PIN);
    expect(log).not.toContain(out.token);
  });
});

describe('the hosted copy\'s verified sign-in (ADR-0020 §6)', () => {
  it('opens a session for the person the hosted sign-in verified — still only with till authority', async () => {
    const w = world();
    const { ops } = await open(w);
    expect(await ops.signInVerified({ userId: 'u-meena', laneId: 'lane-1' })).toMatchObject({ signedIn: true, via: 'verified_sign_in', displayName: 'Meena' });
    expect(await ops.signInVerified({ userId: 'u-floor', laneId: 'lane-1' })).toMatchObject({ signedIn: false, refusedBecause: 'no_till_authority' });
    w.permissions = null;
    expect(await ops.signInVerified({ userId: 'u-meena', laneId: 'lane-1' })).toMatchObject({ signedIn: false, refusedBecause: 'no_people_register' });
  });
});

describe('reading the box\'s credentials file', () => {
  it('the latest entry per person wins: a reissue replaces, a revocation ends; an unreadable entry is left out', () => {
    const first = issueTillCredential({ userId: 'u-meena', pin: MEENA_PIN, key: KEY, issuedAt: '2026-10-01T08:00:00.000Z', issuedBy: 'Store admin' });
    const reissued = issueTillCredential({ userId: 'u-meena', pin: RAVI_PIN, key: KEY, issuedAt: '2026-10-02T08:00:00.000Z', issuedBy: 'Store admin' });
    const ravi = issueTillCredential({ userId: 'u-ravi', pin: RAVI_PIN, key: KEY, issuedAt: '2026-10-01T08:00:00.000Z', issuedBy: 'Store admin' });
    const read = readTillCredentials({
      version: 1,
      credentials: [first, ravi, reissued, { userId: 'u-ravi', revoked: true, issuedAt: '2026-10-03T08:00:00.000Z', issuedBy: 'Store admin' }, { userId: 'u-broken' }, 'nonsense'],
    });
    expect(read.get('u-meena')?.verifier).toBe(reissued.verifier);
    expect(read.get('u-ravi')?.revoked).toBe(true);
    expect(read.has('u-broken')).toBe(false);
    expect(readTillCredentials(null).size).toBe(0);
  });
});
