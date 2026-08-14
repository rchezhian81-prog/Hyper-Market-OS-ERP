import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PAYROLL_ESS_COPY, ESS_COPY_KEYS, ESS_SENSITIVE_ACTIONS } from '../../apps/web-erp/src/payroll-ess-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { SCREENS } from '../../edge/store-edge/src/screen-data';

/**
 * **The self-service payslip is own-record only, and holds the same security bar as the admin screen.**
 *
 * The forge-proof control is that the requester identity comes from the AUTHENTICATED principal
 * (`config.requesterEmployeeId`), never a page value — so this tripwire binds to the session's plumbing and
 * the shell's posture: the session reads the requester from config; the view is online-first (no service
 * worker), stores nothing on the device, gates the export on a fresh re-auth, and is bilingual.
 */

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const SESSION = stripComments(readFileSync('apps/web-erp/src/payroll-ess-session.ts', 'utf8'));
const VIEW = stripComments(readFileSync('apps/web-erp/web/payroll-payslip.js', 'utf8'));
const HTML = readFileSync('apps/web-erp/web/payroll-payslip.html', 'utf8');

describe('own-record isolation', () => {
  it('the requester identity is read from config (the principal), never from the ports/payload', () => {
    // The session passes config.requesterEmployeeId into employeeSelfView — the forge-proof control.
    expect(SESSION).toMatch(/requesterEmployeeId:\s*config\.requesterEmployeeId/);
    // It must NOT take the requester from a port/body (a page-settable source).
    expect(SESSION).not.toMatch(/ports\.requesterEmployeeId/);
  });

  it('runs the tested own-scope engine and turns its refusal into a no-data state', () => {
    expect(SESSION).toMatch(/employeeSelfView\(/);
    expect(SESSION).toMatch(/EssAccessDenied/);
    expect(SESSION).toMatch(/not_your_record/);
  });
});

describe('same security posture as the admin payroll screen', () => {
  it('registers no service worker and writes nothing to browser storage', () => {
    expect(VIEW).not.toMatch(/serviceWorker/);
    for (const sink of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      expect(VIEW, `payslip uses ${sink}`).not.toContain(sink);
    }
  });

  it('is NOT served by the offline store box (a payslip must never be retained on a shared device)', () => {
    expect((SCREENS as readonly string[]).includes('my-payslip')).toBe(false);
    expect((SCREENS as readonly string[]).includes('payroll-payslip')).toBe(false);
  });

  it('uses no browser dialogs and gates the export on a fresh re-auth (MFA)', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
    expect(ESS_SENSITIVE_ACTIONS.includes('exportOwnPayslip')).toBe(true);
    expect(VIEW).toMatch(/payrollReauth/);
  });

  it('labels the language toggle and marks demo data', () => {
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(PAYROLL_ESS_COPY.en.demoBanner).toMatch(/DEMO DATA — NOT REAL PAYROLL/);
  });
});

describe('least-privilege navigation + bilingual copy', () => {
  it('gates the self-service item on payroll.ess.self (own-record permission), not the admin permission', () => {
    const item = ERP_NAVIGATION.find((n) => n.id === 'my-payslip');
    expect(item, 'no my-payslip nav item').toBeDefined();
    expect(item!.requires).toBe('payroll.ess.self');
  });

  it('has an English and a Tamil word for every key', () => {
    const gaps = bilingualGaps(PAYROLL_ESS_COPY, ESS_COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
});
