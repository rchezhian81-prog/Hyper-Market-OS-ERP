import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * **The confirm sheet is in the chrome, and it is never a browser dialog (OB-626 · design system §1.3 · §27.1).**
 *
 * Before money, stock, a price or a privilege moves, a page asks `sreOffice.confirm(spec)` and sends only on
 * `{ ok: true }`. The sheet lives in the one chrome every office page loads (precached, so it works with no internet),
 * with its words in both languages, the safe answer holding the focus, and an opt-out on Escape. A `window.confirm`
 * would be unstyled, blocked by kiosk browsers and unreadable across a counter, so the chrome may never use one.
 * The rendered behaviour is proven in tests/e2e/u1-the-confirm-sheet-asks-before-it-acts.e2e.ts.
 */

const CHROME = readFileSync('apps/web-erp/web/sre-chrome.js', 'utf8');
const FOUNDATION = readFileSync('packages/ui/web/sre-foundation.css', 'utf8');
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('the chrome carries the confirm sheet', () => {
  it('exports sreOffice.confirm, built on the shared sheet with the safe answer focused and Escape as go back', () => {
    expect(CHROME).toMatch(/confirm: officeConfirm,/);
    expect(CHROME).toMatch(/function officeConfirm\(spec\)/);
    expect(CHROME).toContain("sheet.className = 'sre-sheet sre-confirm'");
    expect(CHROME).toContain("sheet.setAttribute('role', 'dialog')");
    expect(CHROME).toContain("sheet.setAttribute('aria-modal', 'true')");
    expect(CHROME).toMatch(/back\.focus\(\);/);
    expect(CHROME).toMatch(/if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); finish\(false\);/);
  });

  it('says Go back and Confirm in both languages', () => {
    for (const key of ['beforeThis', 'goBack', 'confirm', 'reasonShort']) {
      expect(CHROME.match(new RegExp(`\\b${key}: '`, 'g'))?.length, `${key} in en and ta`).toBe(2);
    }
    expect(CHROME).toContain("goBack: 'பின் செல்'");
  });

  it('never asks through a browser dialog', () => {
    const found = [...code(CHROME).matchAll(/(?<![.\w])(?:window\.)?(prompt|confirm|alert)\s*\(/g)].map((m) => m[1]);
    expect(found).toEqual([]);
  });

  it('the foundation draws the sheet above the drawer and the menu, with a 48px confirm button', () => {
    expect(FOUNDATION).toMatch(/\.sre-confirm \{ z-index: 45; \}/);
    expect(FOUNDATION).toMatch(/\.sre-confirm-actions \.sre-btn-primary, \.sre-confirm-actions \.sre-btn-danger \{ min-height: 48px; \}/);
  });

  it('bites: the chrome before OB-626 had no confirm sheet', () => {
    const before = execFileSync('git', ['show', '7fb2406:apps/web-erp/web/sre-chrome.js'], { encoding: 'utf8' });
    expect(before).not.toMatch(/confirm: officeConfirm,/);
  });
});
