import { describe, it, expect } from 'vitest';
import { FRONT_DOOR, safeNext, signInPage, tillOnlyPage, OFFICE_WORDS } from '../../edge/store-edge/src/office-sign-in';
import { SHORTCUTS } from '../../scripts/lib/store-computer-setup.mjs';

/**
 * CR-01 step 4f · OB-795 "A for login" (owner, in writing): the store PC's one sign-in front door for everybody. Its page
 * is the office's own staff ID + PIN form under the shop's name; a till-only PIN is told where its work is; a screen's own
 * gate still asks "Enter your PIN" as before. No PIN is ever written into a page.
 */
describe('CR-01 step 4f: the front door\'s pages', () => {
  it('the front door is a plain path on this box, kept as the sign-in\'s "next"', () => {
    expect(FRONT_DOOR).toBe('/office/');
    expect(safeNext(FRONT_DOOR)).toBe(FRONT_DOOR);
  });

  it('asked through the front door, the sign-in page names the shop and everybody it is for, in both languages', () => {
    const html = signInPage({ next: FRONT_DOOR });
    expect(html).toContain('<title>Sign in — SRE Hyper Market</title>');
    expect(html).toContain('owner, manager and staff');
    expect(html).toContain('உள்நுழைக');
    expect(html).toContain('name="next" value="/office/"');
    expect(html).toContain('id="office-staff"');
    expect(html).toContain('type="password"');
  });

  it('a screen\'s own gate is unchanged: "Enter your PIN", and back to that screen after', () => {
    const html = signInPage({ next: '/approvals/' });
    expect(html).toContain('<title>Enter your PIN — office screens</title>');
    expect(html).not.toContain('owner, manager and staff');
    expect(html).toContain('name="next" value="/approvals/"');
  });

  it('a till-only PIN is told the work is on the till, with the way there and back — and the gate\'s words stay', () => {
    const html = tillOnlyPage();
    expect(html).toContain('Your work is on the till');
    expect(html).toContain('உங்கள் வேலை விற்பனை முனையத்தில்');
    expect(html).toContain('href="/pos/"');
    expect(html).toContain('href="/office/"');
    expect(html).not.toMatch(/name="pin"/);
    expect(OFFICE_WORDS.not_an_office_role.en).toMatch(/^This PIN opens the till only\./);
  });

  it('the "SRE Office" shortcut is still one of the three the setup offers', () => {
    expect(SHORTCUTS.office).toBe('SRE Office.url');
  });
});
