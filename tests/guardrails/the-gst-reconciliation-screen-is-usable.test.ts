import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GST_RECON_COPY, COPY_KEYS, CATEGORY_LABEL, ACTION_LABEL, RECOMMENDED_ACTIONS, portalActionsFor,
} from '../../apps/web-erp/src/gst-reconciliation-session';
import { QUEUE_CATEGORIES, bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The GST reconciliation screen is usable — and speaks both languages (item 3 inc2; OA-9/OA-10).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages. Unlike the older screens, this one's
 * copy lives in the TESTED session model as one `BilingualCopy`, so the tripwire binds to it directly via
 * the shared `packages/ui` check rather than a regex over the view's source: every status category and every
 * recommended action the model can emit must have a word in BOTH languages, and adding one without its words
 * fails the build. It also holds the screen to the same usability rules the manager/till screens carry — no
 * browser dialogs, and the view defers to the session rather than re-deciding anything.
 *
 * NOTE: this checks PRESENCE and completeness, not translation quality — the Tamil wording is pending a
 * native-speaker review before go-live (OWNER-ACTION OA-10).
 */

describe('the GST reconciliation copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(GST_RECON_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('has a bilingual label for EVERY queue category the registers can emit', () => {
    const missing = QUEUE_CATEGORIES.filter((c) => {
      const key = CATEGORY_LABEL[c];
      return !GST_RECON_COPY.en[key]?.trim() || !GST_RECON_COPY.ta[key]?.trim();
    });
    expect(missing, `categories without bilingual copy: ${missing.join(', ')}`).toEqual([]);
  });

  it('has a bilingual label for EVERY recommended action', () => {
    const missing = RECOMMENDED_ACTIONS.filter((a) => {
      const key = ACTION_LABEL[a];
      return !GST_RECON_COPY.en[key]?.trim() || !GST_RECON_COPY.ta[key]?.trim();
    });
    expect(missing, `actions without bilingual copy: ${missing.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...GST_RECON_COPY.en }, ta: { ...GST_RECON_COPY.ta, catMismatch: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('catMismatch');
  });
});

describe('the GST reconciliation view defers to the model and uses no browser dialogs', () => {
  const VIEW = readFileSync('apps/web-erp/web/gst-reconciliation.js', 'utf8');

  it('never calls alert / confirm / prompt (a banner, not a modal the OS owns)', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding rules', () => {
    expect(VIEW).toMatch(/window\.gstReconciliationSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('the shell loads the shared bundle and offers a language toggle', () => {
    const HTML = readFileSync('apps/web-erp/web/gst-reconciliation.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toMatch(/id="lang"/);
  });
});

describe('a portal action goes through the offline outbox, never a raw network call (item 3 inc-e; P-01, hard rule #1)', () => {
  const VIEW = readFileSync('apps/web-erp/web/gst-reconciliation.js', 'utf8');

  it('the shell fires NO raw network call — the button only commits an offline command', () => {
    // The one permitted platform call is `navigator.serviceWorker.register('./sw.js')` (offline shell); a call
    // to the portal or the API from this screen would break hard rule #1 (a user action must not block on the
    // network) and bypass the durable, idempotent outbox.
    expect(/\bfetch\s*\(/.test(VIEW), 'shell calls fetch directly').toBe(false);
    expect(/XMLHttpRequest/.test(VIEW), 'shell uses XMLHttpRequest').toBe(false);
    expect(/\.sendBeacon\s*\(/.test(VIEW), 'shell uses sendBeacon').toBe(false);
    expect(/new\s+WebSocket/.test(VIEW), 'shell opens a WebSocket').toBe(false);
    expect(/new\s+EventSource/.test(VIEW), 'shell opens an EventSource').toBe(false);
  });

  it('a click hands the intent to the session, which enqueues the command — the shell never decides', () => {
    expect(VIEW, 'button is not wired to the session').toMatch(/addEventListener\('click', \(\) => runAction/);
    expect(VIEW, 'the action does not go through requestAction').toMatch(/real\.requestAction\s*\(/);
    // The command's timestamp is the wall clock the model stamps onto the event — supplied, not invented in the model.
    expect(VIEW).toMatch(/new Date\(\)\.toISOString\(\)/);
  });

  it('a disagreement or a bad signature is NEVER given a button — a person investigates it (hard rule #10)', () => {
    // Bound in the model, not the view: even if the shell tried to draw one, the model offers no action here.
    expect(portalActionsFor('mismatch')).toEqual([]);
    expect(portalActionsFor('error')).toEqual([]);
  });
});

describe('the GST reconciliation screen is accessible (item 3 inc3, browser-free checks)', () => {
  const HTML = readFileSync('apps/web-erp/web/gst-reconciliation.html', 'utf8');
  const VIEW = readFileSync('apps/web-erp/web/gst-reconciliation.js', 'utf8');

  it('labels the language toggle and the queue list for screen readers', () => {
    expect(HTML, 'language toggle has no aria-label').toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML, 'queue list has no aria-label').toMatch(/id="rows"[^>]*aria-label=/);
  });

  it('announces the attention count in a live region, so a screen reader is told when it changes', () => {
    expect(HTML).toMatch(/aria-live=/);
  });

  it('gives every status a screen-reader announcement AND a visible word, never colour alone', () => {
    // The tone drives a CSS class; the WORD and the announcement are what a colour-blind operator,
    // or one under glare, actually reads. Both must be set on the status the view builds.
    expect(VIEW, 'status carries no aria-label').toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW, 'status shows no word').toMatch(/slabel\.textContent = r\.status\.label/);
  });

  it('hides the decorative status icon from screen readers (the word already carries the meaning)', () => {
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });
});
