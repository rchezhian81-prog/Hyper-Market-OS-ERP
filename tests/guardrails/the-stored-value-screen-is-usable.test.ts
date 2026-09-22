import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  STORED_VALUE_COPY, COPY_KEYS, createStoredValueOversightSession,
  type StoredValueOversightData,
} from '../../apps/web-erp/src/stored-value-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The stored-value oversight desk (M17-FR-03/04 · API-06 · P-03 · P-04) is READ-ONLY: it surfaces the money the
// shop owes on gift cards / store credit and the ways it leaks, and changes nothing. These are static checks on
// the shipped view + shell — that it reads from the tested session (never re-deciding), issues NO write verb,
// shows every exception as a word+icon (never colour alone), and is offered in both languages. They cannot prove
// the screen is good — a manager with a real shop does that — only that the deliberate decisions are still there.

const RAW = readFileSync('apps/web-erp/web/stored-value.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // comments discuss on purpose
const HTML = readFileSync('apps/web-erp/web/stored-value.html', 'utf8');

const withLoss: StoredValueOversightData = {
  liability: null,
  doubleSpends: [{ instrumentId: 'GC-1', ownerRef: 'C1', overspentMinor: 5000, channels: ['store', 'app'], detail: 'spent twice' }],
  velocity: [], asAt: '2026-09-22T10:00:00Z',
};
const session = (data: StoredValueOversightData, mayRead = true) =>
  createStoredValueOversightSession({ userId: 'u-mgr' }, { oversight: () => data, mayRead: () => mayRead });

describe('the stored-value screen is offered in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(STORED_VALUE_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...STORED_VALUE_COPY.en }, ta: { ...STORED_VALUE_COPY.ta, title: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('title');
  });
});

describe('every exception reads as a state, never colour alone', () => {
  it('a double-spend carries a tone AND a non-blank icon AND a non-blank word', () => {
    const loss = session(withLoss).view('en').doubleSpends[0]!;
    expect(loss.status.tone).toBe('error');            // settled loss
    expect(loss.status.needsAttention).toBe(true);
    expect(loss.status.label.length).toBeGreaterThan(0);
    expect(loss.status.icon.trim().length).toBeGreaterThan(0);
    expect((loss.status.announcement ?? '').length).toBeGreaterThan(0);
  });

  it('a reader without lp.case.read gets a not-permitted state and nothing else', () => {
    const view = session(withLoss, false).view('en');
    expect(view.doubleSpends).toEqual([]);
    expect(view.screenState.tone).toBe('error');
  });
});

describe('the view renders from the tested session and re-decides nothing', () => {
  it('reads window.storedValueSession and calls session.view()', () => {
    expect(VIEW).toMatch(/window\.storedValueSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('issues NO write verb — this screen is read-only (it changes no stored value)', () => {
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
  });

  it('never asks its questions with a browser dialog', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('labels each status for a screen reader and hides the decorative icon', () => {
    expect(VIEW).toMatch(/setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });
});

describe('the shell is wired to the bundle and the injected data, and is accessible', () => {
  it('loads the shared bundle and carries the data marker', () => {
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
  });

  it('labels the language toggle and the exception lists', () => {
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="losses"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="watch"[^>]*aria-label=/);
  });
});
