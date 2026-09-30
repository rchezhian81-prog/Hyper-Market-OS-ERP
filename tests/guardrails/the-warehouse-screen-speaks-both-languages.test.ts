import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FEEDBACK_CODES, SENT_WORK_KINDS } from '../../apps/warehouse-app/src/warehouse-session';
import { DEVICE_ITEM_STATES } from '../../packages/sync/src/device-relay';
import { WAREHOUSE_EXCEPTION_KINDS, WAREHOUSE_TASK_KINDS } from '../../apps/web-erp/src/warehouse-supervisor-session';
import { APPROVE_REASONS, REJECT_REASONS } from '../../packages/approvals/src/reasons';
import { ADJUSTMENT_REASON_CODES } from '../../packages/adjustment/src/adjustment';

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


  it('tripwire — the detector fires on a code that is genuinely absent', () => {
    // Otherwise a regex that silently matched everything would make the checks above vacuous.
    expect(/\bnever_a_real_code:/.test(en)).toBe(false);
  });

  /** The keys of a `{ key: { en, ta } }` map in the view, each with both languages. */
  const bothLanguagesFor = (vocabulary: readonly string[], mapName: string): void => {
    const from = VIEW.indexOf(`const ${mapName}`);
    expect(from, `${mapName} is missing from the view`).toBeGreaterThan(-1);
    const block = VIEW.slice(from, VIEW.indexOf('\n};', from));
    for (const member of vocabulary) {
      const at = block.indexOf(`${member}: {`);
      expect(at, `"${member}" has no words in ${mapName}`).toBeGreaterThan(-1);
      const entry = block.slice(at, block.indexOf('},', at));
      expect(entry, `"${member}" has no English`).toMatch(/\ben:/);
      expect(entry, `"${member}" has no Tamil`).toMatch(/\bta:/);
    }
  };

  it('has words in both languages for where each sent scan is — the five shared device states — and for each kind of work sent (SP-3a)', () => {
    bothLanguagesFor(DEVICE_ITEM_STATES, 'STATE_WORDS');
    bothLanguagesFor(DEVICE_ITEM_STATES, 'STATE_SHORT');
    bothLanguagesFor(SENT_WORK_KINDS, 'KIND_WORDS');
    expect(() => bothLanguagesFor(['a_state_nobody_translated'], 'STATE_WORDS')).toThrow();
  });

  it('has words in both languages for every adjustment reason the handheld may raise (SP-3b · W3 · M08-FR-03)', () => {
    bothLanguagesFor(ADJUSTMENT_REASON_CODES, 'REASON_WORDS');
    // The buttons are built from the words map, so a reason with no words is a reason nobody can raise.
    expect(VIEW).toMatch(/Object\.keys\(REASON_WORDS\)\.map/);
  });
});

// The supervisor screen (web-erp/warehouse.js) — its own vocabulary, the same rule.
const SUP = readFileSync('apps/web-erp/web/warehouse.js', 'utf8');
const supEn = SUP.slice(SUP.indexOf('  en: {'), SUP.indexOf('  ta: {'));
const supTa = SUP.slice(SUP.indexOf('  ta: {'));

describe('the warehouse supervisor screen names every exception in both languages', () => {
  it('has an English word for every exception kind the supervisor session can raise', () => {
    const missing = WAREHOUSE_EXCEPTION_KINDS.filter((k) => !new RegExp(`\\b${k}:`).test(supEn));
    expect(missing, `English is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('has a Tamil word for every exception kind the supervisor session can raise', () => {
    const missing = WAREHOUSE_EXCEPTION_KINDS.filter((k) => !new RegExp(`\\b${k}:`).test(supTa));
    expect(missing, `Tamil is missing: ${missing.join(', ')}`).toEqual([]);
  });


  it('has both languages for every approval decision reason code (§28 audit vocabulary)', () => {
    const codes = [...APPROVE_REASONS, ...REJECT_REASONS];
    const missingEn = codes.filter((c) => !new RegExp(`\\b${c}:`).test(supEn));
    const missingTa = codes.filter((c) => !new RegExp(`\\b${c}:`).test(supTa));
    expect(missingEn, `English is missing: ${missingEn.join(', ')}`).toEqual([]);
    expect(missingTa, `Tamil is missing: ${missingTa.join(', ')}`).toEqual([]);
  });

  it('has both languages for every reason a request is not actionable', () => {
    for (const reason of ['own_request', 'out_of_scope', 'exceeds_authority']) {
      expect(supEn, `English missing ${reason}`).toMatch(new RegExp(`\\b${reason}:`));
      expect(supTa, `Tamil missing ${reason}`).toMatch(new RegExp(`\\b${reason}:`));
    }
  });

  it('has both languages for every task kind the supervisor can assign', () => {
    const missingEn = WAREHOUSE_TASK_KINDS.filter((k) => !new RegExp(`\\b${k}:`).test(supEn));
    const missingTa = WAREHOUSE_TASK_KINDS.filter((k) => !new RegExp(`\\b${k}:`).test(supTa));
    expect(missingEn, `English is missing: ${missingEn.join(', ')}`).toEqual([]);
    expect(missingTa, `Tamil is missing: ${missingTa.join(', ')}`).toEqual([]);
  });
});
