import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CATEGORY_POLICY_COPY, COPY_KEYS, statusOf,
} from '../../apps/web-erp/src/category-policy-session';
import { presetPolicy } from '../../packages/product/src/index';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The category-rules screen is usable, bilingual, and surfaces the high-risk controls (M03-FR-01).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the same usability
 * rules the other screens carry — no browser dialogs, defers to the session — and pins the one thing this
 * screen exists to do: a controlled vertical (gold, pharmacy-lite) must read as CONTROLLED, never as OK.
 */

describe('the category-rules copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(CATEGORY_POLICY_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a genuinely absent key', () => {
    const holey = { en: { ...CATEGORY_POLICY_COPY.en }, ta: { ...CATEGORY_POLICY_COPY.ta, statusBlocked: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('statusBlocked');
  });
});

describe('the high-risk controlled verticals are never shown as ordinary', () => {
  it('gold and pharmacy-lite classify as CONTROLLED, prescription as BLOCKED, grocery as OK', () => {
    const on = '2026-08-14';
    expect(statusOf(presetPolicy('g', 'gold_jewellery', on).history[0]!.value)).toBe('controlled');
    expect(statusOf(presetPolicy('g', 'otc_pharma_lite', on).history[0]!.value)).toBe('controlled');
    expect(statusOf(presetPolicy('g', 'prescription_blocked', on).history[0]!.value)).toBe('blocked');
    expect(statusOf(presetPolicy('g', 'grocery_fmcg', on).history[0]!.value)).toBe('ok');
  });
});

describe('the category-rules view defers to the model and uses no browser dialogs', () => {
  const VIEW = readFileSync('apps/web-erp/web/category-policy.js', 'utf8');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding rules', () => {
    expect(VIEW).toMatch(/window\.categoryPolicySession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('the shell loads the shared bundle, carries the data marker, and offers a language toggle', () => {
    const HTML = readFileSync('apps/web-erp/web/category-policy.html', 'utf8');
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
