import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  STOCK_HEALTH_COPY, COPY_KEYS, createStockHealthSession,
  type StockHealthData,
} from '../../apps/web-erp/src/inventory-health-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The stock-health dashboard (M08 · API-04 · P-03 · P-08) is READ-ONLY: it shows the store's stock truth and
// changes nothing. These are static checks on the shipped view + shell — that it reads from the tested session
// (never re-deciding), issues NO write verb, shows every signal as a word+icon (never colour alone), and is
// offered in both languages. They cannot prove the screen is good — a manager with a real shop does that — only
// that the decisions made deliberately are still there.

const RAW = readFileSync('apps/web-erp/web/stock-health.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // comments discuss on purpose
const HTML = readFileSync('apps/web-erp/web/stock-health.html', 'utf8');

const withNegative: StockHealthData = {
  negative: [{ productId: 'p1', locationId: 'L1', onHandMinor: -500, detail: 'below zero', ownerAction: 'count L1' }],
};
const session = (data: StockHealthData, mayRead = true) =>
  createStockHealthSession({ userId: 'u-mgr' }, { snapshot: () => data, mayRead: () => mayRead });

describe('the stock-health screen is offered in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(STOCK_HEALTH_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...STOCK_HEALTH_COPY.en }, ta: { ...STOCK_HEALTH_COPY.ta, title: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('title');
  });
});

describe('every signal reads as a state, never colour alone', () => {
  it('a signal carries a tone AND a non-blank icon AND a non-blank word', () => {
    const signal = session(withNegative).view('en').signals[0]!;
    expect(signal.status.tone).toBe('error');
    expect(signal.status.needsAttention).toBe(true);
    expect(signal.status.label.length).toBeGreaterThan(0);
    expect(signal.status.icon.trim().length).toBeGreaterThan(0);
    expect((signal.status.announcement ?? '').length).toBeGreaterThan(0);
  });
});

describe('the view renders from the tested session and re-decides nothing', () => {
  it('reads window.stockHealthSession and calls session.view()', () => {
    expect(VIEW).toMatch(/window\.stockHealthSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('issues NO write verb — this screen is read-only (it changes no stock)', () => {
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
  });

  it('never asks its questions with a browser dialog', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('labels each status for a screen reader and hides the decorative icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });
});

describe('the shell is wired to the bundle and the injected data, and is accessible', () => {
  it('loads the shared bundle and carries the data marker', () => {
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
  });

  it('labels the language toggle and the signals list', () => {
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
