import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PAYROLL_COPY, COPY_KEYS } from '../../apps/web-erp/src/payroll-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { SCREENS } from '../../edge/store-edge/src/screen-data';

/**
 * **Payroll guards the most sensitive data in the shop (owner directive 14 Aug 2026; P-04; DPDP).**
 *
 * The directive's headline rule: **do NOT copy the GST screen's unrestricted offline-caching model into
 * payroll.** This tripwire keeps payroll's distinct security posture true as the code changes:
 *
 *   • online-first — the view registers NO service worker, so nothing sensitive is cached on the device;
 *   • no sensitive data in browser storage — no localStorage / sessionStorage / IndexedDB / cookies;
 *   • sensitive identifiers are shown MASKED — the view never touches a raw bank/PAN/UAN/Aadhaar field;
 *   • it is NOT served by the offline store box (shared floor devices must never retain payroll);
 *   • DEMO data is unmistakable, the screen is bilingual, and Aadhaar has no reveal on this path.
 */

// Comments discuss these rules on purpose ("there is no revealAadhaar", "do NOT add one"); strip them so
// only real code is checked and the prose does not trip its own tripwire.
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const HTML = readFileSync('apps/web-erp/web/payroll.html', 'utf8');
const code = stripComments(readFileSync('apps/web-erp/web/payroll.js', 'utf8'));
const MASK = stripComments(readFileSync('packages/payroll/src/mask.ts', 'utf8'));

describe('online-first: the payroll shell caches nothing', () => {
  it('registers no service worker', () => {
    expect(code, 'payroll registers a service worker — it must be online-first').not.toMatch(/serviceWorker/);
  });

  it('never writes payroll data to any browser storage', () => {
    for (const sink of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      expect(code, `payroll uses ${sink}`).not.toContain(sink);
    }
  });

  it('is NOT served by the offline store box (shared floor devices must never retain payroll)', () => {
    expect((SCREENS as readonly string[]).includes('payroll'), 'payroll is registered as a store-box screen').toBe(false);
  });

  it('disables the state-change buttons when offline, and re-renders on connectivity change', () => {
    // The directive: prevent final approval / bank-file release / live posting when offline. The button's
    // disabled state is bound to the live `online` flag, and the view re-renders when connectivity flips.
    expect(code).toMatch(/\.disabled = !view\.online/);
    expect(code).toMatch(/addEventListener\?\.\('offline'/);
  });
});

describe('sensitive identifiers are masked in the view', () => {
  it('reads only the MASKED forms, never a raw bank / PAN / UAN / Aadhaar field', () => {
    expect(code).toMatch(/masked\.bankAccountMasked/);
    expect(code).toMatch(/masked\.aadhaarMasked/);
    for (const raw of [/\.aadhaar\b/, /\.pan\b/, /\.uan\b/, /\.bankAccount\b/]) {
      expect(raw.test(code), `the view reaches a raw sensitive field: ${raw}`).toBe(false);
    }
  });

  it('the mask module offers no way to reveal a full Aadhaar', () => {
    expect(MASK).not.toMatch(/reveal|unmask|fullAadhaar/i);
  });
});

describe('the payroll screen is safe to look at and accessible', () => {
  it('uses no browser dialogs', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(code)).toBe(false);
  });

  it('marks DEMO data unmistakably and warns clearly when offline', () => {
    expect(HTML).toMatch(/id="demo"/);
    expect(HTML).toMatch(/id="offline"/);
    expect(PAYROLL_COPY.en.demoBanner).toMatch(/DEMO DATA — NOT REAL PAYROLL/);
  });

  it('labels the language toggle and the employee list for screen readers', () => {
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="people"[^>]*aria-label=/);
    expect(code, 'a status carries no aria-label').toMatch(/status\.setAttribute\('aria-label'/);
  });
});

describe('least-privilege navigation + bilingual copy', () => {
  it('gates the payroll menu item on the payroll permission the server enforces', () => {
    const item = ERP_NAVIGATION.find((n) => n.id === 'payroll');
    expect(item, 'no payroll nav item').toBeDefined();
    expect(item!.requires).toBe('payroll.statutory.read');
  });

  it('has an English and a Tamil word for every key the screen uses', () => {
    const gaps = bilingualGaps(PAYROLL_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
});
