import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { UNSELLABLE_COPY, COPY_KEYS, UNSELLABLE_REASONS } from '../../apps/web-erp/src/unsellable-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import { SCREENS, GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { APP_SHELL } from '../../edge/store-edge/src/screen-server';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

// The "Products nobody can sell" screen (SP-8c-ii · F08 · P-08 · M03-FR-03 · M10-FR-04 · G5c). The box has excluded and
// counted the products the till cannot judge since G5c, and nobody could see the list. These are static checks on the shipped
// view + shell + box: that the screen is served and reachable, that it reads from the tested session (never re-deciding), that
// it writes nothing and fetches nothing, that every reason has words in both languages, and — the one that matters — that the
// till payload and this screen are built from the SAME function, so they can never disagree about what nobody can sell.

const RAW = readFileSync('apps/web-erp/web/unsellable.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const HTML = readFileSync('apps/web-erp/web/unsellable.html', 'utf8');
const SCREEN_DATA = readFileSync('edge/store-edge/src/screen-data.ts', 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('the screen is offered in both languages, from the session\'s own words', () => {
  it('has no gap in either language across the whole vocabulary, with a label and a what-to-do for every reason', () => {
    const gaps = bilingualGaps(UNSELLABLE_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
    for (const reason of UNSELLABLE_REASONS) {
      expect(UNSELLABLE_COPY.en[`r_${reason}`].length).toBeGreaterThan(10);
      expect(UNSELLABLE_COPY.ta[`d_${reason}`].length).toBeGreaterThan(10);
    }
  });

  it('the view takes every word from the session (session.text / session.view) and keeps none of its own beyond the sample stand-in', () => {
    expect(VIEW).toMatch(/window\.unsellableSession/);
    expect(VIEW).toMatch(/session\.view\(lang\)/);
    expect(VIEW).toMatch(/const t = \(key\) => session\.text\(lang, key\)/);
    const live = VIEW.slice(VIEW.indexOf('const session = real ?? sampleSession();'));
    expect(live).not.toMatch(/en: \{|ta: \{/);
  });
});

describe('read-only, and honest about where it came from', () => {
  it('issues no write and no read of its own — no fetch, no storage, no POST, no timer, no dialog', () => {
    expect(VIEW).not.toMatch(/\bfetch\(/);
    expect(VIEW).not.toMatch(/localStorage/);
    expect(VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? []).toEqual([]);
    expect(VIEW).not.toMatch(/setInterval\(|setTimeout\(/);
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('every group reads as a state — a tone class, an icon hidden from the reader, a word, an aria-label — and recall is grouped first by the session, not the view', () => {
    expect(VIEW).toMatch(/section\.className = `group tone-\$\{/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).not.toMatch(/sort\(/); // the order is the session's
    expect(HTML).toMatch(/<p class="state" id="state" hidden>/);
    expect(HTML).toMatch(/<div id="groups" aria-label=/);
  });

  it('shows the sample stand-in ONLY when the box gave it nothing, and says so', () => {
    expect(VIEW).toMatch(/el\('sample'\)\.hidden = real !== undefined/);
    expect(HTML).toMatch(/<p class="sample" id="sample" hidden>/);
  });
});

describe('the box and the screen cannot disagree about what nobody can sell (P-08)', () => {
  it('the till payload is built from unsellableProducts(...) — the same function the screen\'s payload reads — and no second judgement of tax / status / unit is left in the till builder', () => {
    const till = SCREEN_DATA.slice(SCREEN_DATA.indexOf('export function posPayload('), SCREEN_DATA.indexOf('export function managerPayload('));
    expect(till).toMatch(/unsellableProducts\(input\.pack, input\.cataloguePack\)/);
    expect(till).not.toMatch(/p\.taxBps === undefined \?/);
    expect(till).not.toMatch(/'no tax rate on the catalogue'/);
    const screen = SCREEN_DATA.slice(SCREEN_DATA.indexOf('export function unsellablePayload('), SCREEN_DATA.indexOf('export function posPayload('));
    expect(screen).toMatch(/unsellableProducts\(input\.pack, input\.cataloguePack\)/);
    // The judgement itself names every reason the screen has words for, and recall is judged FIRST.
    const judge = SCREEN_DATA.slice(SCREEN_DATA.indexOf('export function unsellableProducts('), SCREEN_DATA.indexOf('export function unsellablePayload('));
    const order = UNSELLABLE_REASONS.map((r) => judge.indexOf(`'${r}'`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]!);
  });

  it('is a screen the box serves, with its own global, its own shell and a menu item on the Inventory group gated on a read the routes enforce', () => {
    expect((SCREENS as readonly string[]).includes('unsellable')).toBe(true);
    expect(GLOBAL_FOR['unsellable']).toBe('unsellableData');
    expect(APP_SHELL['unsellable']).toEqual({ dir: 'web-erp', file: 'unsellable.html' });
    const item = ERP_NAVIGATION.find((i) => i.id === 'unsellable');
    expect(item).toMatchObject({ path: '/unsellable', requires: 'inventory.availability.read', group: 'Inventory' });
    expect(item?.labelTa).toMatch(/[஀-௿]/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(readFileSync('apps/web-erp/web/sw.js', 'utf8')).toContain("'./unsellable.js'");
  });
});
