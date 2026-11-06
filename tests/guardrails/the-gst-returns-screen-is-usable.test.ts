import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GST_RETURNS_COPY, COPY_KEYS, STATE_LABEL, ACTION_LABEL, RETURN_ACTIONS, recommendedAction, commandActionsFor,
} from '../../apps/web-erp/src/gst-returns-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The GST-returns screen is usable, bilingual, and never says a stuck return is filed (item 3, 4th domain).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check: every lifecycle-state label and every recommended
 * action must have a word in BOTH languages. It also holds the screen to the same usability rules the other
 * screens carry — no browser dialogs, defers to the session — and pins the one thing this screen must never do:
 * present an UNKNOWN outcome as filed (a stuck return is reconciled by a person with evidence, never assumed —
 * hard rule #10).
 */

describe('the GST-returns copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(GST_RETURNS_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('has a bilingual label for EVERY lifecycle state a submission can reach', () => {
    const states = ['previewed', 'approved', 'submitting', 'filed', 'failed', 'unknown', 'cancelled'] as const;
    const missing = states.filter((s) => {
      const key = STATE_LABEL[s];
      return !GST_RETURNS_COPY.en[key]?.trim() || !GST_RETURNS_COPY.ta[key]?.trim();
    });
    expect(missing, `states without bilingual copy: ${missing.join(', ')}`).toEqual([]);
  });

  it('has a bilingual label for EVERY recommended action', () => {
    const missing = RETURN_ACTIONS.filter((a) => {
      const key = ACTION_LABEL[a];
      return !GST_RETURNS_COPY.en[key]?.trim() || !GST_RETURNS_COPY.ta[key]?.trim();
    });
    expect(missing, `actions without bilingual copy: ${missing.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...GST_RETURNS_COPY.en }, ta: { ...GST_RETURNS_COPY.ta, stFailed: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('stFailed');
  });
});

describe('a stuck return is never presented as filed (hard rule #10)', () => {
  it('an unknown outcome recommends reconcile, and a rejection recommends re-file — neither is “done”', () => {
    expect(recommendedAction('unknown')).toBe('reconcile');
    expect(recommendedAction('failed')).toBe('refile');
    // Only a genuinely terminal state recommends nothing.
    expect(recommendedAction('filed')).toBe('none');
    expect(recommendedAction('cancelled')).toBe('none');
  });
});

describe('the GST-returns view defers to the model and uses no browser dialogs', () => {
  const VIEW = readFileSync('apps/web-erp/web/gst-returns.js', 'utf8');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding the lifecycle', () => {
    expect(VIEW).toMatch(/window\.gstReturnsSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('the shell loads the shared bundle, carries the data marker, and offers a language toggle', () => {
    const HTML = readFileSync('apps/web-erp/web/gst-returns.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });
});

describe('a governance act goes to head office through the session, never from the shell (§28 · §31 · W5 route audit rows 161–167)', () => {
  const VIEW = readFileSync('apps/web-erp/web/gst-returns.js', 'utf8');

  it('the shell fires NO network call itself — the session asks head office under the person\'s own session', () => {
    // The one permitted platform call is `navigator.serviceWorker.register('./sw.js')`. Every read and act lives in the
    // tested session (gst-returns-session.ts), so the maker ≠ checker guards, the live-list rule (§31: no stale approval)
    // and the once-only key cannot be skipped by the shell.
    expect(/\bfetch\s*\(/.test(VIEW), 'shell calls fetch directly').toBe(false);
    expect(/XMLHttpRequest/.test(VIEW), 'shell uses XMLHttpRequest').toBe(false);
    expect(/\.sendBeacon\s*\(/.test(VIEW), 'shell uses sendBeacon').toBe(false);
    expect(/new\s+WebSocket/.test(VIEW), 'shell opens a WebSocket').toBe(false);
    expect(/new\s+EventSource/.test(VIEW), 'shell opens an EventSource').toBe(false);
  });

  it('a click hands the intent to the session, which re-checks and sends it — the shell never decides', () => {
    expect(VIEW, 'button is not wired to the session').toMatch(/addEventListener\('click', \(\) => runAction/);
    expect(VIEW, 'the act does not go through the session').toMatch(/real\.act\s*\(/);
    expect(VIEW, 'the list is not read through the session').toMatch(/real\.load\(\)/);
  });

  it('the page no longer queues GstReturnActionRequested — the sync agent has no route for it, so it never arrived', () => {
    const SESSION = readFileSync('apps/web-erp/src/gst-returns-session.ts', 'utf8');
    expect(SESSION).not.toMatch(/makeEvent|\.enqueue\(/);
  });

  it('only the acts head office allows are offered — a stuck one is reconciled with evidence, never one-clicked (rule #10)', () => {
    // Bound in the model, not the view.
    expect(commandActionsFor('previewed')).toEqual(['approve', 'cancel']);
    expect(commandActionsFor('approved')).toEqual(['submit', 'fileByHand', 'cancel']);
    expect(commandActionsFor('unknown')).toEqual(['reconcile']);
    expect(commandActionsFor('failed')).toEqual([]);
    expect(commandActionsFor('filed')).toEqual([]);
  });
});
