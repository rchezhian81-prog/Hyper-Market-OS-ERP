import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_ROLE, REFUSAL_WORDS, UPDATE_AUTHORITY, readUpdateCheck, requestUpdate, updatePage, type UpdateCheckView, type UpdateDeps,
} from '../../edge/store-edge/src/update-page';
import { checkIfDue } from '../../scripts/lib/store-pc-update-check.mjs';
import type { Deps } from '../../scripts/lib/store-computer.mjs';

/**
 * **CR-01 step 3c · OI-05 · OB-718 · OB-719: the owner's Update request on the store PC's Software update page.**
 *
 *   Decided in order — the owner (role `owner` at this store) → his own till PIN again (the till's PIN register, holding
 *   `platform.setup.write`) → no till shift open (OB-718) → a newer version the last check found READY (signed, checked) —
 *   and written down BEFORE the answer, every refusal too (OB-719, P-08). If it cannot be written down, nothing is
 *   requested. An accepted request is left for the updater (step 3d); the page installs nothing itself.
 */

const READY: UpdateCheckView = { checkedAt: '2026-11-12T03:00:00.000Z', running: '1.0.2005', state: 'available', latest: '1.0.2012', said: 'version 1.0.2012 is ready, signed and checked', tag: 'store-pc-v1.0.2012', commit: 'a'.repeat(40), sha256: 'b'.repeat(64) };

function deps(over: Partial<UpdateDeps> & { pinOk?: boolean; open?: number; failRecord?: boolean; failLeave?: boolean } = {}) {
  const records: Record<string, unknown>[] = [];
  const left: Record<string, unknown>[] = [];
  const pinAsked: { userId: string; pin: string; authority: string }[] = [];
  const d: UpdateDeps = {
    check: () => READY,
    openShifts: async () => Array.from({ length: over.open ?? 0 }, (_, i) => ({ tillId: `lane-${i + 1}`, custodian: `u-cash${i + 1}`, openedAt: '2026-11-12T02:00:00.000Z' })),
    rolesOf: (u) => (u === 'u-owner' ? [OWNER_ROLE] : u === 'u-mgr' ? ['store_manager'] : null),
    verifyPin: async (userId, pin, authority) => { pinAsked.push({ userId, pin, authority }); return over.pinOk === false ? { ok: false, laneMessage: 'Wrong PIN. 4 tries left.' } : { ok: true }; },
    record: async (e) => { if (over.failRecord) throw new Error('disk full'); records.push(e); },
    leaveRequest: async (r) => { if (over.failLeave) throw new Error('no room'); left.push(r); },
    now: () => '2026-11-12T04:00:00.000Z',
    ...over,
  };
  return { d, records, left, pinAsked };
}

describe('who may ask: only the owner, with his own PIN again', () => {
  it('the owner with his PIN, nothing open, a ready version: REQUESTED — written down, then left for the updater', async () => {
    const { d, records, left, pinAsked } = deps();
    const a = await requestUpdate(d, { userId: 'u-owner' }, '123456');
    expect(a).toMatchObject({ ok: true, version: '1.0.2012' });
    expect(pinAsked).toEqual([{ userId: 'u-owner', pin: '123456', authority: UPDATE_AUTHORITY }]);
    expect(records).toEqual([{ kind: 'update_request', at: '2026-11-12T04:00:00.000Z', userId: 'u-owner', outcome: 'requested', version: '1.0.2012', from: '1.0.2005' }]);
    expect(left).toEqual([{ kind: 'sre-store-pc-update-request-v1', requestedAt: '2026-11-12T04:00:00.000Z', requestedBy: 'u-owner', version: '1.0.2012', tag: 'store-pc-v1.0.2012', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), from: '1.0.2005' }]);
    expect(JSON.stringify(records)).not.toContain('123456'); // the PIN is checked and forgotten
  });

  it.each([
    ['nobody signed in', null, 'not_signed_in'],
    ['the store manager', { userId: 'u-mgr' }, 'not_the_owner'],
    ['someone the store setup does not know', { userId: 'u-x' }, 'not_the_owner'],
  ] as const)('refused: %s — and the refusal is written down; the PIN is never asked', async (_n, who, why) => {
    const { d, records, left, pinAsked } = deps();
    const a = await requestUpdate(d, who, '123456');
    expect(a).toMatchObject({ ok: false, refusedBecause: why, en: REFUSAL_WORDS[why].en, ta: REFUSAL_WORDS[why].ta });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: `refused:${why}` });
    expect(left).toHaveLength(0);
    expect(pinAsked).toHaveLength(0);
  });

  it('the owner with a wrong PIN: refused, the PIN register\'s own words, written down, nothing left', async () => {
    const { d, records, left } = deps({ pinOk: false });
    const a = await requestUpdate(d, { userId: 'u-owner' }, '000000');
    expect(a).toMatchObject({ ok: false, refusedBecause: 'pin_not_confirmed', detail: 'Wrong PIN. 4 tries left.' });
    expect(records[0]).toMatchObject({ userId: 'u-owner', outcome: 'refused:pin_not_confirmed' });
    expect(left).toHaveLength(0);
  });

  it('a PIN that is not text is checked as nothing (never trusted)', async () => {
    const { d, pinAsked } = deps({ pinOk: false });
    await requestUpdate(d, { userId: 'u-owner' }, 123456);
    expect(pinAsked[0]!.pin).toBe('');
  });
});

describe('OB-718: never while a till shift is open', () => {
  it('one open shift: refused with the tills named, written down with them, nothing left', async () => {
    const { d, records, left } = deps({ open: 2 });
    const a = await requestUpdate(d, { userId: 'u-owner' }, '123456');
    expect(a).toMatchObject({ ok: false, refusedBecause: 'shift_open', en: 'A till shift is open. Close every till first, then update.' });
    expect((a as { detail: string }).detail).toBe('Open: lane-1 (u-cash1, since 2026-11-12T02:00:00.000Z), lane-2 (u-cash2, since 2026-11-12T02:00:00.000Z).');
    expect(records[0]).toMatchObject({ outcome: 'refused:shift_open', openShifts: [{ tillId: 'lane-1' }, { tillId: 'lane-2' }] });
    expect(left).toHaveLength(0);
  });
});

describe('only a version the last check found READY', () => {
  it.each([
    ['never checked', undefined, 'not_checked'],
    ['up to date', { ...READY, state: 'up-to-date' as const }, 'nothing_to_install'],
    ['not signed', { ...READY, state: 'not-installable' as const, said: 'version 1.0.2012 is NOT SIGNED' }, 'nothing_to_install'],
    ['could not check', { ...READY, state: 'could-not-check' as const, latest: null }, 'nothing_to_install'],
    ['ready but without its fingerprint', { ...READY, sha256: undefined }, 'nothing_to_install'],
  ])('refused: %s', async (_n, check, why) => {
    const { d, records, left } = deps({ check: () => check as UpdateCheckView | undefined });
    const a = await requestUpdate(d, { userId: 'u-owner' }, '123456');
    expect(a).toMatchObject({ ok: false, refusedBecause: why });
    expect(records[0]).toMatchObject({ outcome: `refused:${why}` });
    expect(left).toHaveLength(0);
  });
});

describe('P-08: nothing is requested that is not written down', () => {
  it('the log cannot be written: NOT RECORDED, nothing left for the updater', async () => {
    const { d, left } = deps({ failRecord: true });
    expect(await requestUpdate(d, { userId: 'u-owner' }, '123456')).toMatchObject({ ok: false, refusedBecause: 'not_recorded' });
    expect(left).toHaveLength(0);
  });

  it('the request file cannot be left: the failure is written down and the answer is NOT RECORDED', async () => {
    const { d, records } = deps({ failLeave: true });
    expect(await requestUpdate(d, { userId: 'u-owner' }, '123456')).toMatchObject({ ok: false, refusedBecause: 'not_recorded' });
    expect(records.map((r) => r['outcome'])).toEqual(['requested', 'refused:not_recorded']);
  });
});

describe('the last check, as step 3b kept it', () => {
  it('reads a good file and refuses anything else as "never checked"', () => {
    const good = { kind: 'sre-store-pc-update-check-v1', checkedAt: READY.checkedAt, running: '1.0.2005', withKey: false, state: 'available', latest: '1.0.2012', tag: 'store-pc-v1.0.2012', commit: READY.commit, sha256: READY.sha256, said: READY.said };
    expect(readUpdateCheck(JSON.stringify(good))).toEqual(READY);
    for (const bad of [undefined, 'not json', '{}', JSON.stringify({ ...good, kind: 'x' }), JSON.stringify({ ...good, state: 'maybe' })]) expect(readUpdateCheck(bad)).toBeUndefined();
  });
});

describe('the page says what is known, in English and Tamil', () => {
  const view = { check: READY, isOwner: true, displayName: 'Owner', openShifts: [], updaterPending: true };
  it('ready, for the owner: the version, the PIN box, the button — and, with no updater set up on this PC, that it is not (step 3d)', () => {
    const html = updatePage(view);
    expect(html).toContain('<h1>Software update');
    expect(html).toContain('A new version is ready: 1.0.2012');
    expect(html).toContain('id="pin"');
    expect(html).toMatch(/<button type="submit" id="update-button">Update to 1\.0\.2012/);
    expect(html).toContain('id="updater-pending"');
    expect(html).toContain('lang="ta"');
  });
  it('for anyone else: no PIN box, no button — "only the owner"', () => {
    const html = updatePage({ ...view, isOwner: false });
    expect(html).not.toContain('id="pin"');
    expect(html).toContain('id="owner-only"');
  });
  it('a shift open: the tills are named and the button is disabled', () => {
    const html = updatePage({ ...view, openShifts: [{ tillId: 'lane-2', custodian: 'u-cash', openedAt: 'x' }] });
    expect(html).toContain('lane-2 — u-cash');
    expect(html).toMatch(/id="update-button" disabled/);
  });
  it.each([
    [undefined, 'has not checked for a new version yet'],
    [{ ...READY, state: 'up-to-date' as const }, 'Up to date'],
    [{ ...READY, state: 'not-installable' as const }, 'cannot be installed'],
    [{ ...READY, state: 'could-not-check' as const }, 'Could not check'],
  ])('no button unless ready (%#)', (check, words) => {
    const html = updatePage({ ...view, check });
    expect(html).toContain(words);
    expect(html).not.toContain('id="update-button"');
  });
  it('escapes what the check said', () => {
    expect(updatePage({ ...view, check: { ...READY, said: '<script>x</script>' } })).not.toContain('<script>x</script>');
  });
});

describe('the store PC checks by itself — at most every six hours, never failing the backup', () => {
  const pc = (lastCheckedAt?: string) => {
    const root = mkdtempSync(join(tmpdir(), 'cr01-3c-'));
    const statusDir = join(root, 'status');
    fs.mkdirSync(statusDir, { recursive: true });
    fs.mkdirSync(join(root, 'install'));
    writeFileSync(join(root, 'install', 'release.json'), JSON.stringify({ version: '1.0.2005' }));
    if (lastCheckedAt !== undefined) writeFileSync(join(statusDir, 'update-check.json'), JSON.stringify({ checkedAt: lastCheckedAt }));
    const asked: string[] = [];
    const said: string[] = [];
    const d = { repoRoot: join(root, 'install'), platform: 'linux', fs, dataRoot: root, now: () => new Date('2026-11-12T12:00:00Z'), say: (l: string) => said.push(l), web: async (u: string) => { asked.push(u); throw new Error('offline'); } } as unknown as Deps;
    return { d, L: { dataRoot: root, statusDir }, asked, said, statusDir };
  };
  it('asks when never checked, and when the last answer is six hours old', async () => {
    for (const last of [undefined, '2026-11-12T06:00:00Z']) {
      const p = pc(last);
      expect(await checkIfDue(p.d, p.L)).toBe('checked');
      expect(p.asked).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(p.statusDir, 'update-check.json'), 'utf8')).state).toBe('could-not-check');
    }
  });
  it('does not ask again within six hours', async () => {
    const p = pc('2026-11-12T07:00:00Z');
    expect(await checkIfDue(p.d, p.L)).toBe('not-due');
    expect(p.asked).toHaveLength(0);
  });
  it('a check that throws is said, never thrown into the backup', async () => {
    const p = pc();
    const broken = { ...(p.d as object), now: () => { throw new Error('clock broken'); } } as unknown as Deps;
    expect(await checkIfDue(broken, p.L)).toBe('failed');
  });
});
