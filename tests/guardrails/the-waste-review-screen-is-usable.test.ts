import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  WASTE_REVIEW_COPY, COPY_KEYS, LOSS_LABEL, LOSS_TYPES,
  createWasteReviewSession, type WriteOffRow,
} from '../../apps/web-erp/src/waste-review-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The waste review screen is usable, bilingual, and surfaces the material losses (M28-FR-01).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check: every loss-type label must have a word in BOTH
 * languages. It also holds the screen to the same usability rules the other screens carry — no browser
 * dialogs, defers to the session — and pins the one thing this screen exists to do: a MATERIAL loss (one that
 * needed a second person's approval) must read as ATTENTION, never as an ordinary line (P-03).
 */

describe('the waste-review copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(WASTE_REVIEW_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('has a bilingual label for EVERY loss type the engine can record', () => {
    const missing = LOSS_TYPES.filter((l) => {
      const key = LOSS_LABEL[l];
      return !WASTE_REVIEW_COPY.en[key]?.trim() || !WASTE_REVIEW_COPY.ta[key]?.trim();
    });
    expect(missing, `loss types without bilingual copy: ${missing.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...WASTE_REVIEW_COPY.en }, ta: { ...WASTE_REVIEW_COPY.ta, lossDamage: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('lossDamage');
  });
});

describe('a material loss is never shown as an ordinary line (P-03 control by exception)', () => {
  const one = (over: Partial<WriteOffRow>): WriteOffRow => ({
    id: 'wo', productId: 'X', lossType: 'damage', qtyRemoved: 1, valueMinor: 100, requiredApproval: false, ...over,
  });
  const view = (row: WriteOffRow) =>
    createWasteReviewSession({ userId: 'u' }, { rows: () => [row], mayRead: () => true }).view('en');

  it('a loss that needed approval reads as attention with the error tone; one that did not, does not', () => {
    const material = view(one({ requiredApproval: true, valueMinor: 500_000 })).rows[0];
    expect(material?.needsAttention).toBe(true);
    expect(material?.status.tone).toBe('error');
    const ordinary = view(one({ requiredApproval: false })).rows[0];
    expect(ordinary?.needsAttention).toBe(false);
  });
});

describe('the waste-review view defers to the model and uses no browser dialogs', () => {
  const VIEW = readFileSync('apps/web-erp/web/waste.js', 'utf8');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding materiality', () => {
    expect(VIEW).toMatch(/window\.wasteSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('records nothing — a read-only review surface has no write action (no fetch/XHR/outbox)', () => {
    expect(/\bfetch\s*\(/.test(VIEW), 'a review screen must not call the network').toBe(false);
    expect(/XMLHttpRequest/.test(VIEW)).toBe(false);
    expect(/\.enqueue\s*\(/.test(VIEW), 'a review screen records no write-off').toBe(false);
  });

  it('the shell loads the shared bundle, carries the data marker, and offers a language toggle', () => {
    const HTML = readFileSync('apps/web-erp/web/waste.html', 'utf8');
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
