import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **W5 · OB-684 (owner, 3 Nov 2026) · C15 · C16 · C19 · OB-208 — the chartered accountant reaches the payroll LEGAL figures
 * through their own menu item, "Payroll legal figures", on the REAL store computer (its menu gate and page serving), over
 * head office's production routes.**
 *   • the CA's role holds payroll.legal.read and payroll.legal.configure — and NOT payroll.statutory.read (anyone's pay);
 *   • the store computer serves /payroll-legal to the CA, whose menu offers it and not "Payroll"; the page shows ONLY the
 *     legal figures — no payslip, no month's check, no total, no person — every one "not confirmed" until the CA fills it;
 *     head office refuses an overtime multiplier below 2× by name, and 200% is saved and shows confirmed;
 *   • a cashier asks for the page and the store computer refuses it (403), naming none of its figures.
 * Synthetic data only.
 */

const OWNER = 'u-owner'; const CA = 'u-ca'; const TILL = 'u-till';
const wordsOf = (roleId: string): readonly string[] => ROLE_CATALOGUE.find((r) => r.id === roleId)!.permissions;

describe('OB-684: the Payroll legal figures menu item is the CA\'s', () => {
  it('asks payroll.legal.read, which the CA holds — and the CA holds no payroll.statutory.read', () => {
    expect(ERP_NAVIGATION.find((i) => i.id === 'payroll-legal')).toMatchObject({ label: 'Payroll legal figures', path: '/payroll-legal', requires: 'payroll.legal.read', group: 'People' });
    expect(wordsOf('chartered_accountant')).toEqual(expect.arrayContaining(['payroll.legal.read', 'payroll.legal.configure']));
    expect(wordsOf('chartered_accountant')).not.toContain('payroll.statutory.read');
    expect(wordsOf('cashier')).not.toContain('payroll.legal.read');
  });
});

describe.skipIf(!HAVE_BROWSER)('OB-684: the CA fills the payroll legal figures on the store computer', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'payroll-legal',
      people: [{ userId: CA, permissions: wordsOf('chartered_accountant') }, { userId: TILL, permissions: wordsOf('cashier') }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, CA, 'chartered_accountant');
        await ho.provisionRole(T, TILL, 'cashier');
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the CA opens it from the menu and sees only the legal figures; under 2× is refused by name; 200% is confirmed', async () => {
    const p = await shop.open(CA, '/payroll-legal/');
    try {
      // The store computer's own menu for the CA offers this page, and not the Payroll page (anyone's pay).
      const menu = await p.page.evaluate(() => ((globalThis as unknown as { sreNavigation?: { groups: { items: { path: string }[] }[] } }).sreNavigation?.groups ?? []).flatMap((g) => g.items.map((i) => i.path)));
      expect(menu).toContain('/payroll-legal');
      expect(menu).not.toContain('/payroll');
      await says(p.page, '#pl-figures [data-figure="overtimeMultiplierPercent"]', /not confirmed/);
      await says(p.page, '#lead', /Nobody's pay, no payslip and no total for any person is on this page/);
      // Nothing about a person or their pay is on the page at all.
      for (const sel of ['#ps-prepare', '#ps-check', '#ps-contrib', '#ps-late', '#ps-issued', '#stat-checks']) expect(await p.page.locator(sel).count(), sel).toBe(0);
      expect(await p.page.locator('main button', { hasText: /payslip|prepare|issue|approve|lock|bank/i }).allTextContents()).toEqual([]);

      await p.page.selectOption('#pl-fig-key', 'overtimeMultiplierPercent');
      await p.page.fill('#pl-fig-value', '150'); await p.page.fill('#pl-fig-source', 'Code on Wages 2019'); await p.page.fill('#pl-fig-conf', 'CA synthetic ref 1');
      await p.page.click('#pl-fig-save');
      await says(p.page, '#pl-fig-status', /^Head office refused: overtime below 2×/);
      await p.page.fill('#pl-fig-value', '200');
      await p.page.click('#pl-fig-save');
      await says(p.page, '#pl-figures [data-figure="overtimeMultiplierPercent"]', /200 .* · confirmed/);
      await says(p.page, '#pl-fig-status', /^Saved on head office\.$/);
      expect(p.writes).toEqual(['POST /v1/hr/payroll/legal-settings/overtimeMultiplierPercent', 'POST /v1/hr/payroll/legal-settings/overtimeMultiplierPercent']);
      // Nothing of payroll is kept in the browser (payroll rule: online-first) — only the menu rail's own recent-pages list.
      const kept = await p.page.evaluate(() => { const g = globalThis as unknown as { localStorage: { length: number; key(i: number): string | null; getItem(k: string): string | null }; sessionStorage: { length: number } }; const out: string[] = []; for (let i = 0; i < g.localStorage.length; i += 1) { const k = g.localStorage.key(i)!; out.push(`${k}=${g.localStorage.getItem(k) ?? ''}`); } return { local: out, session: g.sessionStorage.length }; });
      expect(kept.session).toBe(0);
      for (const entry of kept.local) { expect(entry).toMatch(/^sre\.rail\./); expect(entry).not.toMatch(/overtime|200|confirmed|CA synthetic/i); }
      await p.page.click('#lang');
      await says(p.page, '#page-h', /^ஊதியச் சட்ட எண்கள்$/);
      await says(p.page, '#pl-legal h3', /^தணிக்கையாளரின் சட்ட எண்கள்$/);
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }
    // Head office's own record: the CA filled it.
    const legal = (await shop.call('GET', '/v1/hr/payroll/legal-settings', CA)).body as { figures: { key: string; status: string; value?: number }[] };
    expect(legal.figures.find((f) => f.key === 'overtimeMultiplierPercent')).toMatchObject({ status: 'confirmed', value: 200 });
  }, 120_000);

  it('a cashier is refused the page by the store computer, which names none of its figures', async () => {
    await expect(shop.open(TILL, '/payroll-legal/')).rejects.toThrow(/the store computer answered 403/);
    // Head office refuses the cashier too.
    expect((await shop.call('GET', '/v1/hr/payroll/legal-settings', TILL)).status).toBe(403);
  }, 60_000);
});
