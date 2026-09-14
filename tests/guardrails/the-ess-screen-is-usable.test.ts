import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ESS_COPY, COPY_KEYS } from '../../apps/web-erp/src/ess-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The employee self-service (ESS) screen is usable and bilingual (M25).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check — a member of staff reads their own rota and pay
 * in the language they speak, or not at all. It also holds the screen to the same usability rules the other
 * screens carry: no browser dialogs, it defers to the tested session rather than re-deciding anything, and
 * every status carries a screen-reader announcement and an aria-hidden icon so colour is never the only signal
 * (P-07). This is a read-only, own-record-only surface; nothing here commits a change.
 */

describe('the ESS copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(ESS_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a genuinely absent key', () => {
    const holey = { en: { ...ESS_COPY.en }, ta: { ...ESS_COPY.ta, netPay: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('netPay');
  });
});

describe('the ESS view defers to the model and uses no browser dialogs', () => {
  const VIEW = readFileSync('apps/web-erp/web/ess.js', 'utf8');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding anything', () => {
    expect(VIEW).toMatch(/window\.essSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('the shell loads the shared bundle, carries the data marker, and offers a language toggle', () => {
    const HTML = readFileSync('apps/web-erp/web/ess.html', 'utf8');
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
