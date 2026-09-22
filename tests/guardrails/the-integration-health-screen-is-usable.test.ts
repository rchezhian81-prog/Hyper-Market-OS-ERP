import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  INTEGRATION_HEALTH_COPY, COPY_KEYS, createIntegrationHealthSession,
  type IntegrationHealthData,
} from '../../apps/web-erp/src/integration-health-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The integration-health desk (M32-FR-04 · API-11 · P-03 · P-08 · hard rule #1) is READ-ONLY: it surfaces which
// of the shop's outside connections have gone quiet and reassures the till never stops, and changes nothing.
// These are static checks on the shipped view + shell — that it reads from the tested session (never re-deciding),
// issues NO write verb, shows every exception as a word+icon (never colour alone), and is offered in both
// languages. They cannot prove the screen is good — an admin with a real shop does that — only that the deliberate
// decisions are still there.

const RAW = readFileSync('apps/web-erp/web/integration-health.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // comments discuss on purpose
const HTML = readFileSync('apps/web-erp/web/integration-health.html', 'utf8');

const withSilent: IntegrationHealthData = {
  adapters: [{ adapterId: 'tally', category: 'accounting', state: 'silent', minutesSinceLastSuccess: 'never', consecutiveFailures: 0, shopKeepsTrading: true, detail: 'Tally has never reported a success' }],
  posUnaffected: true, asAt: '2026-09-22T10:00:00Z',
};
const session = (data: IntegrationHealthData, mayRead = true) =>
  createIntegrationHealthSession({ userId: 'u-admin' }, { health: () => data, mayRead: () => mayRead });

describe('the integration-health screen is offered in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(INTEGRATION_HEALTH_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...INTEGRATION_HEALTH_COPY.en }, ta: { ...INTEGRATION_HEALTH_COPY.ta, title: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('title');
  });
});

describe('every exception reads as a state, never colour alone', () => {
  it('a silent connection carries a tone AND a non-blank icon AND a non-blank word', () => {
    const a = session(withSilent).view('en').attention[0]!;
    expect(a.status.tone).toBe('error');
    expect(a.status.needsAttention).toBe(true);
    expect(a.status.label.length).toBeGreaterThan(0);
    expect(a.status.icon.trim().length).toBeGreaterThan(0);
    expect((a.status.announcement ?? '').length).toBeGreaterThan(0);
  });

  it('a reader without platform.health.read gets a not-permitted state and nothing else', () => {
    const view = session(withSilent, false).view('en');
    expect(view.attention).toEqual([]);
    expect(view.calm).toEqual([]);
    expect(view.screenState.tone).toBe('error');
  });
});

describe('the view renders from the tested session and re-decides nothing', () => {
  it('reads window.integrationHealthSession and calls session.view()', () => {
    expect(VIEW).toMatch(/window\.integrationHealthSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('issues NO write verb — this screen is read-only (it changes no connection)', () => {
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

  it('labels the language toggle and the connection lists', () => {
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="attention"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="calm"[^>]*aria-label=/);
  });
});
