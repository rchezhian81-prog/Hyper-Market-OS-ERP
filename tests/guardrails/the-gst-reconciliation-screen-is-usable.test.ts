import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GST_RECON_COPY, COPY_KEYS, CATEGORY_LABEL, ACTION_LABEL, RECOMMENDED_ACTIONS,
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
