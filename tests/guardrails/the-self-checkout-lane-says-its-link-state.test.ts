import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { WORDS } from '../../apps/self-checkout/src/self-checkout-lane';

/**
 * **The self-checkout lane says whether the store computer is there and how many baskets are unsent (U0 · G19 of the
 * UI/UX gap audit, 1 Nov 2026 · design system §1 rule 4 · P-08).** While it ran, the lane showed no connection state at
 * all — only a strip when the whole page had come from the cache. Now a badge in the header asks the lane socket every
 * ten seconds, as the till's does, and says "not checked yet" / connected / not answering with the unsent count — "not
 * known" until the store computer has answered, never 0 — in both languages. And the colleague's "It has not answered"
 * outcome says what happened, that the basket is recorded and NOT counted as paid, and what to do next (§1 rule 5).
 */

const HTML = readFileSync('apps/self-checkout/web/index.html', 'utf8');
const APP = readFileSync('apps/self-checkout/web/app.js', 'utf8');
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('the self-checkout lane says its link state', () => {
  it('has a badge in the header with the store icon beside its words (never colour alone)', () => {
    expect(HTML).toMatch(/<header>[\s\S]*<span class="box" id="box" role="status"><span data-sre-icon="store"[^>]*><\/span><span id="box-text">/);
  });

  it('asks the lane socket for its sync status every ten seconds and paints what the box said', () => {
    const src = code(APP);
    expect(src).toMatch(/fetch\(`\$\{laneBase\(\)\}\/lane\/sync-status`/);
    expect(src).toMatch(/setInterval\(\(\) => \{ void refreshBox\(\); \}, 10_000\)/);
    expect(src).toMatch(/function paintBox\(\)/);
    expect(src).toMatch(/render\(\) \{[\s\S]*paintBox\(\);/);
  });

  it('says "not known" until the box answers — never a 0 — and names all three states in both languages', () => {
    expect(code(APP)).toMatch(/unsent === null \? t\('unsentNotKnown'\)/);
    for (const key of ['boxNotAsked', 'boxUp', 'boxDown', 'unsent', 'unsentNotKnown']) {
      const en = new RegExp(`en: \\{[\\s\\S]*?\\b${key}: '[^']+'[\\s\\S]*?\\},\\n  ta:`);
      const ta = new RegExp(`ta: \\{[\\s\\S]*?\\b${key}: '[^']*[\\u0B80-\\u0BFF][^']*'`);
      expect(APP, `${key} in English`).toMatch(en);
      expect(APP, `${key} in Tamil`).toMatch(ta);
    }
  });

  it('the colleague\'s "no answer" outcome carries what happened, saved-or-not, and the next safe action', () => {
    expect(WORDS.noAnswerRecorded.en).toMatch(/did not answer/);
    expect(WORDS.noAnswerRecorded.en).toMatch(/recorded on the store computer and is NOT counted as paid/);
    expect(WORDS.noAnswerRecorded.en).toMatch(/Check the machine's slip/);
    expect(WORDS.noAnswerRecorded.ta).toMatch(/[஀-௿]/);
    expect(readFileSync('apps/self-checkout/src/self-checkout-lane.ts', 'utf8')).toMatch(/outcome === 'no_answer'\) return \{ ok: false, words: WORDS\.noAnswerRecorded/);
  });
});
