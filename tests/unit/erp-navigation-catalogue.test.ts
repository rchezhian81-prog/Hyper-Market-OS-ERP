import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ERP_NAVIGATION, NAV_GROUP_LABELS, RETIRED_NAV_ITEMS } from '../../apps/web-erp/src/navigation';
import { APP_SHELL, screenOfPath } from '../../edge/store-edge/src/screen-server';
import { SCREENS, type ScreenName } from '../../edge/store-edge/src/screen-data';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **The menu catalogue agrees with the store computer and with the server (Stage G slice 5b · §27 role surfaces ·
 * P-04 · P-07).** Before this slice the catalogue named eighteen permissions no route checked and no role granted —
 * a menu drawn from it would have shown nobody the Overview, Catalogue, Purchasing or Trading sections — and
 * seventeen screens the box serves had no item at all. This file keeps three things true: every screen the box
 * serves has a door; every door is gated on a word the screen or its route actually enforces and some role actually
 * holds; and nothing was dropped without its reason on the record.
 */

const BOX_SCREENS = (SCREENS as readonly ScreenName[]).filter((s) => APP_SHELL[s].dir === 'web-erp');
const boxItems = ERP_NAVIGATION.filter((i) => (i.served ?? 'box') === 'box');

/** Every `permission: '<word>'` a cloud route declares, read from the services' own source. */
function routePermissions(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === 'node_modules' || name === 'dist') continue;
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      for (const m of readFileSync(full, 'utf8').matchAll(/permission:\s*'([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)'/g)) found.add(m[1]!);
    }
  };
  walk('services');
  return found;
}
/** The gates the ERP screens themselves apply (their browser-entry constants and session models). */
const SCREEN_SOURCE = readdirSync('apps/web-erp/src').filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join('apps/web-erp/src', f), 'utf8')).join('\n');
const granted = new Set(ROLE_CATALOGUE.flatMap((r) => r.permissions));
const TAMIL = /[஀-௿]/;

describe('the catalogue is whole', () => {
  it('ids are unique, and no retired id is still an item', () => {
    const ids = ERP_NAVIGATION.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RETIRED_NAV_ITEMS) expect(ids, `${r.id} is retired AND present`).not.toContain(r.id);
  });

  it('every item has a Tamil label in Tamil script, and every group a heading in both languages', () => {
    for (const i of ERP_NAVIGATION) {
      expect(i.labelTa, `${i.id} has no Tamil label`).toMatch(TAMIL);
      expect(NAV_GROUP_LABELS[i.group], `${i.id}: group ${i.group} has no heading pair`).toBeDefined();
      expect(NAV_GROUP_LABELS[i.group]!.ta).toMatch(TAMIL);
    }
  });

  it('every retired item names why, and the item that covers it today', () => {
    const ids = new Set(ERP_NAVIGATION.map((i) => i.id));
    expect(RETIRED_NAV_ITEMS.length).toBe(8);
    for (const r of RETIRED_NAV_ITEMS) {
      expect(r.reason.length).toBeGreaterThan(20);
      expect(ids, `${r.id} points at ${r.insteadUse}, which is not an item`).toContain(r.insteadUse);
    }
  });
});

describe('every screen the store computer serves has a door, and every door opens a served screen', () => {
  it('each of the box\'s ERP screens is reached by at least one item', () => {
    const reached = new Set(boxItems.map((i) => screenOfPath(i.path)));
    const missing = BOX_SCREENS.filter((s) => !reached.has(s));
    expect(missing, 'box screens no menu item opens').toEqual([]);
  });

  it('each box item\'s path resolves — through the box\'s own router and redirects — to a screen it serves', () => {
    for (const i of boxItems) expect(screenOfPath(i.path), `${i.id} → ${i.path} opens nothing on the box`).not.toBeNull();
  });

  it('an unserved or unbuilt item opens nothing on the box — and the unserved ones are exactly the pages nothing serves yet', () => {
    const notBox = ERP_NAVIGATION.filter((i) => (i.served ?? 'box') !== 'box');
    for (const i of notBox) expect(screenOfPath(i.path), `${i.id} is marked ${i.served} but the box serves it`).toBeNull();
    // The pages in apps/web-erp/web the box does not serve. Four have an item (marked unserved); the other two —
    // the owner's company report and the DPO's erasure console — have no item yet (docs/STATUS.md, G5c). Approvals
    // (ADR-0024) is built and has its item; the store computer does not serve it yet.
    const servedFiles = new Set(BOX_SCREENS.map((s) => APP_SHELL[s].file));
    const unservedPages = readdirSync('apps/web-erp/web').filter((f) => f.endsWith('.html') && !servedFiles.has(f)).sort();
    expect(unservedPages).toEqual(['approvals.html', 'company-report.html', 'erasure-console.html', 'payroll-payslip.html', 'payroll.html', 'setup.html']);
    expect(notBox.filter((i) => i.served === 'unserved').map((i) => i.id).sort()).toEqual(['approval-requests', 'my-payslip', 'payroll', 'store-setup']);
    // `suppliers` left this list at SP-7d (30 Sep 2026): the Suppliers screen is built and served by the box.
    expect(notBox.filter((i) => i.served === 'unbuilt').map((i) => i.id).sort()).toEqual(['reconciliation', 'settings']);
  });
});

describe('every door is gated on a word somebody enforces and somebody holds (P-04, default deny with a purpose)', () => {
  const enforced = routePermissions();

  it('each box item\'s permission is checked by a cloud route or by the screen\'s own gate', () => {
    for (const i of boxItems) {
      const byRoute = enforced.has(i.requires);
      const byScreen = SCREEN_SOURCE.includes(`'${i.requires}'`);
      expect(byRoute || byScreen, `${i.id} requires "${i.requires}", which no route and no screen checks`).toBe(true);
    }
  });

  it('each box item\'s permission is granted by at least one role in the role catalogue — a door nobody holds the key to is a dead door', () => {
    for (const i of boxItems) expect(granted.has(i.requires), `${i.id} requires "${i.requires}", which no role grants`).toBe(true);
  });

  it('the words nobody enforced are gone from every served item (supplier.view left the list at SP-7c, when the supplier routes began to enforce it)', () => {
    const phantoms = ['admin.settings.manage', 'admin.users.manage', 'approval.decide', 'audit.view', 'cash.view', 'catalogue.view', 'erp.dashboard.view', 'exception.view', 'finance.view', 'grn.view', 'po.view', 'price.view', 'promotion.view', 'reconciliation.view', 'return.view', 'sales.view', 'stock.view'];
    expect(enforced.has('supplier.view')).toBe(true);
    for (const i of boxItems) expect(phantoms, `${i.id} still gates on ${i.requires}`).not.toContain(i.requires);
  });

  it('Approvals (ADR-0024) is a door for every signed-in person: gated on the word its routes check, which the role catalogue grants', () => {
    const item = ERP_NAVIGATION.find((i) => i.id === 'approval-requests')!;
    expect(item).toBeDefined();
    expect(item.requires).toBe('identity.self.read');
    expect(enforced.has('identity.self.read')).toBe(true);
    expect(SCREEN_SOURCE).toContain(`'identity.self.read'`);
    expect(granted.has('identity.self.read')).toBe(true);
    expect(item.labelTa).toMatch(TAMIL);
  });

  it('tripwire — the route-permission reader finds the words the routes declare', () => {
    expect(enforced.has('till.dayclose.read')).toBe(true);
    expect(enforced.has('inventory.availability.read')).toBe(true);
    expect(enforced.has('erp.dashboard.view')).toBe(false);
  });
});
