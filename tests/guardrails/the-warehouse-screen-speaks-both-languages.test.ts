import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FEEDBACK_CODES } from '../../apps/warehouse-app/src/warehouse-session';

/**
 * **The warehouse handheld says WHY a scan was refused — in English AND Tamil (OA-9).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages. A scan-feedback code with no
 * word, or a word in only one language, shows a warehouse worker a blank or half-blank reason at the
 * exact moment a scan was refused — which is when the reason matters most. So this binds the view's
 * vocabulary to the session's own `FEEDBACK_CODES`: every code the offline `WarehouseSession` can
 * return must have a word in BOTH `en` and `ta`, and adding an outcome without its words fails the
 * build. It is the same tripwire the manager and till screens carry for their vocabularies.
 *
 * NOTE: this checks PRESENCE and completeness, not translation quality — the Tamil wording is pending
 * a native-speaker review before go-live (OWNER-ACTION OA-10 in docs/OWNER-ACTION-REGISTER.md).
 */

const VIEW = readFileSync('apps/warehouse-app/web/app.js', 'utf8');

/** Pull the `en: { … }` and `ta: { … }` blocks out of the view's WORDS object. */
const en = VIEW.slice(VIEW.indexOf('  en: {'), VIEW.indexOf('  ta: {'));
const ta = VIEW.slice(VIEW.indexOf('  ta: {'));

describe('every warehouse scan outcome has a word in both languages', () => {
  it('has an English word for every feedback code the session can return', () => {
    const missing = FEEDBACK_CODES.filter((code) => !new RegExp(`\\b${code}:`).test(en));
    expect(missing, `English is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('has a Tamil word for every feedback code the session can return', () => {
    const missing = FEEDBACK_CODES.filter((code) => !new RegExp(`\\b${code}:`).test(ta));
    expect(missing, `Tamil is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('shows the stale-shell strip in both languages, like every other screen', () => {
    expect(en).toMatch(/staleShell:/);
    expect(ta).toMatch(/staleShell:/);
  });

  it('tripwire — the detector fires on a code that is genuinely absent', () => {
    // Otherwise a regex that silently matched everything would make the checks above vacuous.
    expect(/\bnever_a_real_code:/.test(en)).toBe(false);
  });
});
