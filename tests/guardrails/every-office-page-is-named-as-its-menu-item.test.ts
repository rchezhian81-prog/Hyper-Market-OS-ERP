import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { APP_SHELL, screenOfPath } from '../../edge/store-edge/src/screen-server';
import { HEAD_OFFICE_PAGES } from '../../edge/store-edge/src/head-office-pages';
import { beforeFixture } from '../support/before-fixture';

/**
 * **A page is called what the menu calls it (U0 · G12 of the UI/UX gap audit, 1 Nov 2026 · P-07 · design system §4.2).**
 *
 * The rail said "Rota", the page said "Rostering"; "Tills & devices" opened "Devices"; "Connections" opened "Integration
 * health"; "Audit log" opened "Records kept". A person who finds a screen by its plain name in the rail then lands on a
 * page called something else and wonders whether they are in the right place. So: every office page's header line (its
 * one `h1.who`, minus the `#whoami` small) is the menu item's English label — exactly, or the label without its bracketed
 * hint ("Input tax credit (GSTR-2B)" may head as "Input tax credit"). The chrome then writes the Tamil twin of that name
 * on the toggle (`paintHeading`, proven in the U0 browser test), so a page named as its item is bilingual for free.
 *
 * The exceptions are listed by id with the reason, so a new mismatch fails here by name.
 */

/** Pages whose header line is deliberately not the item's label, and why. */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  dashboard: 'the Today page\'s header line is the store workspace and the trading day, drawn by the page',
  products: 'three menu items (Products, Pricing, Promotions) open the one "Products and prices" page on its tabs',
  pricing: 'see products',
  promotions: 'see products',
  users: 'two menu items (Users & roles, Outside access) open the one "Admin and security" page on its tabs',
  'support-access': 'see users',
  reconciliation: 'Reconciliation opens the Month-end page on its payments tab',
  'warehouse-supervisor': 'the heading is the warehouse\'s own name from the store computer ("—" until told)',
};

const fileOf = (screen: string): string | null => {
  const shell = (APP_SHELL as Record<string, { dir: string; file: string }>)[screen];
  if (shell?.dir === 'web-erp') return shell.file;
  return HEAD_OFFICE_PAGES.find((p) => p.screen === screen)?.file ?? null;
};
export const headingOf = (html: string): string => {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  return (m ? m[1]! : '').replace(/<small[\s\S]*?<\/small>/, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
};
const withoutHint = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, '');

describe('every office page is named as its menu item names it', () => {
  const office = ERP_NAVIGATION.filter((i) => (i.served ?? 'box') === 'box').map((i) => ({ item: i, screen: screenOfPath(i.path.split('?')[0]!) })).filter((x) => x.screen !== null && fileOf(x.screen) !== null);

  it('there are office pages to check, and no exception names an item that does not exist', () => {
    expect(office.length).toBeGreaterThan(100);
    for (const id of Object.keys(EXCEPTIONS)) expect(ERP_NAVIGATION.some((i) => i.id === id), `exception ${id}`).toBe(true);
  });

  it('the header line of every page is its item\'s English label (or the label without its bracketed hint)', () => {
    const wrong: string[] = [];
    for (const { item, screen } of office) {
      if (item.id in EXCEPTIONS) continue;
      const heading = headingOf(readFileSync(`apps/web-erp/web/${fileOf(screen!)}`, 'utf8'));
      if (heading !== item.label && heading !== withoutHint(item.label)) wrong.push(`${item.id}: the page says "${heading}", the menu says "${item.label}"`);
    }
    expect(wrong).toEqual([]);
  });

  it('bites: the pages as they were before U0 fail it by name (git HEAD~0 of the audit day is enough to show the rule is not vacuous)', () => {
    // The rule must find at least one mismatch somewhere in history, or it tests nothing. The audit's own commit holds
    // the old headings: "Rostering" for Rota, "Integration health" for Connections.
    const old = (file: string): string => { try { return beforeFixture('be62d0a', `apps/web-erp/web/${file}`); } catch { return ''; } };
    const rostering = headingOf(old('rostering.html'));
    if (rostering === '') return; // shallow clone without that commit: nothing to compare, the rule above still holds
    expect(rostering).toBe('Rostering');
    expect(ERP_NAVIGATION.find((i) => i.id === 'rostering')!.label).toBe('Rota');
  });
});
