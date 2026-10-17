import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

/**
 * **OB-154 — the store-operations screens are usable, bilingual, offline-cached and permission-gated.** The food-safety
 * checks (D-6), price mismatches (D-7), store tasks and my tasks (D-8) and waste analytics (D-5) pages hold to the rules
 * every back-office screen carries:
 *   • no browser dialogs; they render from the one tested session (`window.storeOps`), never their own rules;
 *   • nothing is WRITTEN on open — every POST runs from a person's submit; the reports are GET reads only;
 *   • every status carries a word and an aria-hidden icon (colour is never the only signal), and live regions announce;
 *   • 48px tap targets; the shared bundle, the data marker and the chrome load; the service worker precaches each script;
 *   • each menu item is gated on the SAME permission its read route checks (P-04), and only the assignee's own page
 *     offers "Mark done" (OB-158) — the manager's board has no completion at all.
 */

const PAGES = ['food-safety', 'price-integrity', 'store-tasks', 'my-tasks', 'waste-analytics'] as const;
const WEB = 'apps/web-erp/web';
const html = (p: string): string => readFileSync(`${WEB}/${p}.html`, 'utf8');
const view = (p: string): string => readFileSync(`${WEB}/${p}.js`, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const SW = readFileSync(`${WEB}/sw.js`, 'utf8');

describe.each(PAGES)('the %s screen', (page) => {
  it('uses no browser dialog and renders from the tested session', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(view(page))).toBe(false);
    expect(view(page)).toMatch(/window\.storeOps/);
    expect(view(page)).toMatch(/api\.words\(lang/);
    expect(view(page)).not.toMatch(/setInterval|setTimeout/);
  });

  it('never writes on open: its only writes go through the session from a submit, and it names no verb of its own', () => {
    const v = view(page);
    expect(v).not.toMatch(/fetch\(/); // every call is the session's
    for (const write of ['session.recordCheck(', 'session.assignTask(', 'session.completeTask(']) {
      const at = v.indexOf(write);
      if (at < 0) continue;
      expect(v.lastIndexOf("addEventListener('submit'", at), `${write} outside a submit handler`).toBeGreaterThan(-1);
    }
  });

  it('carries the shell: 48px taps, the bundle, the data marker, the chrome, a labelled toggle and a live status', () => {
    const h = html(page);
    expect(h).toMatch(/--tap: 48px/);
    expect(h).toMatch(/web-erp\.bundle\.js/);
    expect(h).toContain('<!--SCREEN-DATA-->');
    expect(h).toMatch(/<script type="module" src="\.\/sre-chrome\.js"><\/script>/);
    expect(h).toMatch(/id="lang"[^>]*aria-label=/);
    expect(h).toMatch(/id="page-status" role="status" aria-live="polite"/);
  });

  it('is precached by the service worker and registers it, so it opens without a network', () => {
    expect(SW).toContain(`'./${page}.js'`);
    expect(view(page)).toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
  });
});

describe('the screens are gated on the permission their routes check (P-04)', () => {
  const need: Record<string, string> = {
    'food-safety': 'facilities.overdue.read', 'price-integrity': 'price.integrity.audit', 'store-tasks': 'workforce.task.read',
    'my-tasks': 'workforce.task.complete.own', 'waste-analytics': 'waste.view',
  };
  it('each menu item exists, opens its own page, and requires the read its route checks', () => {
    for (const page of PAGES) {
      const item = ERP_NAVIGATION.find((i) => i.id === page);
      expect(item, `${page} has no menu item`).toBeDefined();
      expect(item!.path).toBe(`/${page}`);
      expect(item!.requires).toBe(need[page]);
      expect(item!.labelTa.length).toBeGreaterThan(0);
    }
  });

  it('OB-158: only "My tasks" offers completion; the manager\'s board offers none', () => {
    expect(view('my-tasks')).toMatch(/session\.completeTask\(/);
    expect(view('store-tasks')).not.toMatch(/completeTask/);
    expect(view('store-tasks')).toMatch(/assign-section'\)\.hidden = !may\.assignTasks/);
  });

  it('a status is a word with an aria-hidden icon, never colour alone', () => {
    for (const page of ['food-safety', 'store-tasks', 'my-tasks']) {
      expect(view(page)).toMatch(/state\.setAttribute\('aria-label', words\.label\)/);
      expect(view(page)).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
    }
  });

  it('OB-163: the price page always shows the owner\'s four bands', () => {
    expect(view('price-integrity')).toMatch(/api\?\.bands \?\? \[\]\)\.map/);
  });
});
