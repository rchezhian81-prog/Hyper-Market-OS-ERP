import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { ERP_NAVIGATION, navigationFor, type NavItem } from '../../apps/web-erp/src/navigation';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **Every office page, rendered: one primary action at a time, and every greyed button says why (UI/UX gap audit
 * 1 Nov 2026 G3 · design system §1 rule 3 · §4 · P-07).**
 *
 * Like the audit's sweep: every menu screen the store computer serves, opened on the REAL store computer fed by the REAL
 * head office as the least-trained role that may open it (cashier, then accountant, manager, owner), at a desk, in
 * English. On each: at most ONE visible `.sre-btn-primary` outside a repeated row (an Approve per inbox item, an Open per
 * register row, a Done per task — those live inside `li`, `tr`, `.row`, `.card`, `.item`, `[data-row]` or a register);
 * every visible disabled button carries a reason a person can read (its `title`, the element its `aria-describedby`
 * names, or the `.sre-why` words beside it); no script error; the audit (contrast, targets, names, labels, one h1, no
 * sideways scroll) clean. One `it` per workspace so a failure names the page.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const ROLES: { who: string; roleId: string }[] = [
  { who: PEOPLE.cashier, roleId: 'cashier' }, { who: PEOPLE.accountant, roleId: 'accountant' },
  { who: PEOPLE.manager, roleId: 'store_manager' }, { who: PEOPLE.owner, roleId: 'owner' },
];
/** The device shells are not office pages; the other menu items the box serves are. */
const OFFICE = ERP_NAVIGATION.filter((i) => (i.served ?? 'box') === 'box' && i.group !== 'Devices');

const MEASURE = String.raw`(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const repeated = 'li, tr, .row, .card, .item, [data-row], .sre-register, .sre-datatable, .inbox-item, .sre-card, .sre-rows';
  const primaries = [...document.querySelectorAll('.sre-btn-primary')].filter(vis).filter((el) => el.closest(repeated) === null).map((el) => (el.textContent || '').trim().slice(0, 40));
  // The shared register's pager (Previous on the first page, Next on the last) is the chrome's; its why is the page count beside it.
  const greyed = [...document.querySelectorAll('button[disabled]')].filter(vis).filter((el) => el.id !== 'lang' && el.closest('.sre-datatable') === null).map((el) => {
    const by = el.getAttribute('aria-describedby');
    const named = by ? (document.getElementById(by)?.textContent || '').trim() : '';
    const beside = el.nextElementSibling && el.nextElementSibling.classList.contains('sre-why') ? (el.nextElementSibling.textContent || '').trim() : '';
    const why = (el.title || '').trim() || named || beside;
    return { text: (el.textContent || '').trim().slice(0, 40), id: el.id, why };
  }).filter((b) => b.why === '');
  return { primaries, greyed };
})()`;

function firstRole(item: NavItem): { who: string; roleId: string } | null {
  for (const r of ROLES) {
    const access = new AccessControl(ROLE_CATALOGUE as never, [{ userId: r.who, roleId: r.roleId, branchScope: 'all' }]);
    const groups = navigationFor(access, { userId: r.who, branchId: 'S1', roleIds: [r.roleId] }, OFFICE);
    if (groups.some((g) => g.items.some((i) => i.id === item.id))) return r;
  }
  return null;
}

/** Screens only a role the office harness does not seed may open (their permission is held by none of cashier, accountant,
 *  store manager, owner): the committee's annual report (the internal committee's word), the partner register and the
 *  developer guide (the platform partner's word). Their pages are held to the same rules by the static guardrail. */
const ONLY_OTHER_ROLES: Readonly<Record<string, string>> = {
  'posh-committee': 'posh.report.generate — the internal committee only',
  partners: 'platform.partner.read — the platform partner only',
  'developer-docs': 'platform.partner.read — the platform partner only',
};

describe.skipIf(!existsSync(CHROMIUM))('U1: every office page shows one primary action and explains every greyed button', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const groups = [...new Set(OFFICE.map((i) => i.group))];
  it.each(groups)('%s: at most one primary outside repeated rows, every greyed button says why, audit clean', async (group) => {
    const findings: string[] = [];
    for (const item of OFFICE.filter((i) => i.group === group)) {
      const role = firstRole(item);
      if (role === null) { if (item.id in ONLY_OTHER_ROLES) continue; findings.push(`${item.id}: no seeded role may open it`); continue; }
      const s = await shop.asPerson(role.who, DESK);
      try {
        await s.page.goto(`${shop.base}${item.path}`, { waitUntil: 'load' });
        await s.page.waitForFunction('globalThis.sreChrome !== undefined').catch(() => {});
        await s.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await s.page.waitForTimeout(400);
        const m = (await s.page.evaluate(MEASURE)) as { primaries: string[]; greyed: { text: string; id: string; why: string }[] };
        if (m.primaries.length > 1) findings.push(`${item.id} (${role.roleId}): ${m.primaries.length} primaries at once — ${m.primaries.join(' | ')}`);
        for (const g of m.greyed) findings.push(`${item.id} (${role.roleId}): greyed button "${g.text}"${g.id ? ` #${g.id}` : ''} says no why`);
        const audit = await auditPage(s.page);
        for (const f of audit.slice(0, 5)) findings.push(`${item.id} (${role.roleId}): ${f.rule} ${f.selector} ${f.detail.slice(0, 90)}`);
        for (const e of s.errors) findings.push(`${item.id} (${role.roleId}): script error ${e.slice(0, 120)}`);
      } finally { await s.context.close(); }
    }
    expect(findings).toEqual([]);
  }, 600_000);

  it('bites: a page with two primaries outside rows is reported', async () => {
    const s = await shop.asPerson(PEOPLE.owner, DESK);
    try {
      await s.page.goto(`${shop.base}/customers`, { waitUntil: 'load' });
      await s.page.waitForFunction('globalThis.sreChrome !== undefined');
      await s.page.evaluate(`(() => { const b = document.createElement('button'); b.className = 'sre-btn sre-btn-primary'; b.textContent = 'Second'; document.querySelector('main').append(b); const g = document.createElement('button'); g.className = 'sre-btn'; g.disabled = true; g.textContent = 'Greyed'; document.querySelector('main').append(g); })()`);
      const m = (await s.page.evaluate(MEASURE)) as { primaries: string[]; greyed: { text: string }[] };
      expect(m.primaries.length).toBeGreaterThan(1);
      expect(m.greyed.map((g) => g.text)).toContain('Greyed');
    } finally { await s.context.close(); }
  });
});
