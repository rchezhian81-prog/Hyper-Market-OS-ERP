import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OFFICE_ROLE_IDS, OFFICE_SESSION_MINUTES, OfficeSessions, officeCookie, officeTokenOf, readSignInForm, safeNext, signInPage, type PinCheck,
} from '../../edge/store-edge/src/office-sign-in';
import { OPEN_SCREENS, permissionForScreen } from '../../edge/store-edge/src/screen-server';

/**
 * OB-259 — the office gate's own rules, with its clock in hand: a sign-in lasts 30 minutes and no longer; a person whose
 * office role is taken away is signed out at their next page; only the office roles open it; the cookie, the form and the
 * page say what they should and never carry a PIN.
 */

const pins = (good: Record<string, string>): PinCheck => ({
  verifyPerson: async ({ staffId, pin }) => (good[staffId] === pin ? { ok: true, userId: staffId, displayName: staffId } : { ok: false, refusedBecause: 'wrong_staff_id_or_pin', laneMessage: '' }),
});

describe('the office gate (OB-259)', () => {
  it('a sign-in lasts 30 minutes, ends at a role taken away, and is refused to a role that is not an office one', async () => {
    let now = Date.parse('2026-10-20T10:00:00.000Z');
    const roles: Record<string, string[]> = { 'u-m': ['store_manager'], 'u-c': ['cashier'] };
    const gate = await OfficeSessions.open({
      dataDir: await mkdtemp(join(tmpdir(), 'office-unit-')), capacityBytes: 1_000_000,
      pins: pins({ 'u-m': '111111', 'u-c': '222222' }), officeRolesOf: (u) => roles[u] ?? [], displayNameOf: (u) => u, now: () => new Date(now).toISOString(),
    });
    expect(await gate.signIn({ staffId: 'u-c', pin: '222222' })).toEqual({ ok: false, refusedBecause: 'not_an_office_role' });
    expect(await gate.signIn({ staffId: 'u-m', pin: '000000' })).toEqual({ ok: false, refusedBecause: 'wrong_staff_id_or_pin' });
    const ok = await gate.signIn({ staffId: 'u-m', pin: '111111' });
    if (!ok.ok) throw new Error('no sign-in');
    expect(ok.expiresAt).toBe('2026-10-20T10:30:00.000Z');
    now += (OFFICE_SESSION_MINUTES * 60_000) - 1;
    expect((await gate.check(ok.token)).ok).toBe(true);
    now += 1;
    expect(await gate.check(ok.token)).toEqual({ ok: false, refusedBecause: 'session_ended' });

    const again = await gate.signIn({ staffId: 'u-m', pin: '111111' });
    if (!again.ok) throw new Error('no sign-in');
    roles['u-m'] = ['cashier'];
    expect(await gate.check(again.token)).toEqual({ ok: false, refusedBecause: 'not_an_office_role' });
    roles['u-m'] = ['store_manager'];
    expect(await gate.check(again.token)).toEqual({ ok: false, refusedBecause: 'not_signed_in' }); // ended, not paused
    expect(await gate.check(undefined)).toEqual({ ok: false, refusedBecause: 'not_signed_in' });
  });

  it('only the owner, the manager and the accountants are office roles; only the till stays open', () => {
    expect(OFFICE_ROLE_IDS).toEqual(['owner', 'store_manager', 'accountant', 'chartered_accountant']);
    expect(OPEN_SCREENS).toEqual(['pos']);
    expect(permissionForScreen('manager')).toBe('till.dayclose.read');
    expect(permissionForScreen('migration')).toBe('migration.cleaning.read');
  });

  it('the cookie, the form and the page', () => {
    const token = 'A'.repeat(43);
    expect(officeTokenOf(`a=b; sre_office=${token}; c=d`)).toBe(token);
    expect(officeTokenOf('sre_office=<script>')).toBeUndefined();
    expect(officeCookie(token)).toBe(`sre_office=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800`);
    expect(officeCookie(undefined)).toContain('Max-Age=0');
    expect(readSignInForm('staffId=u-m&pin=123456&next=%2Fmigration%2F')).toEqual({ staffId: 'u-m', pin: '123456', next: '/migration/' });
    expect(readSignInForm('x'.repeat(5000)).staffId).toBe('');
    expect(safeNext('//evil.invalid/')).toBe('/manager/');
    expect(safeNext('/../x')).toBe('/manager/');
    expect(safeNext('/catalogue/?tab=price')).toBe('/catalogue/?tab=price');
    const page = signInPage({ next: '/x"/><script>', problem: 'wrong_staff_id_or_pin' });
    expect(page).toContain('Enter your PIN');
    expect(page).toContain('உங்கள் PIN-ஐ உள்ளிடுங்கள்');
    expect(page).not.toContain('"/><script>');
    expect(page).toContain('type="password"');
  });
});
