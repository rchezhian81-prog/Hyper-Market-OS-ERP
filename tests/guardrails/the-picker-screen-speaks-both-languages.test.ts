import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SENT_WORK_KINDS } from '../../apps/picker-app/src/pick-session';
import { DEVICE_ITEM_STATES } from '../../packages/sync/src/device-relay';

/**
 * **The picker handheld says where every outcome and pack has got to — in English AND Tamil (SP-3c-i · OA-9 · P-08).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages. Since SP-3c-i the picker's queue reaches the
 * store computer and head office, and the shell lists each piece of work with one of the FIVE shared device states
 * (`packages/sync/src/device-relay.ts`). A state with no word, or a word in only one language, shows a picker a blank pill
 * at the moment it matters — when a refusal needs a person. So this binds the view's three vocabularies to the shared
 * list and to the session's own `SENT_WORK_KINDS`: adding a state or a kind without its words fails the build. It is the
 * same tripwire the warehouse handheld carries (`the-warehouse-screen-speaks-both-languages.test.ts`).
 *
 * NOTE: this checks PRESENCE and completeness, not translation quality — the Tamil wording is pending a native-speaker
 * review before go-live (OWNER-ACTION OA-10 in docs/OWNER-ACTION-REGISTER.md).
 */

const VIEW = readFileSync('apps/picker-app/web/app.js', 'utf8');

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

describe('the picker handheld names where each sent piece of work is, in both languages (SP-3c-i)', () => {
  it('has words in both languages for the five shared device states — long for the list, short for the badge', () => {
    bothLanguagesFor(DEVICE_ITEM_STATES, 'SENT_STATE_WORDS');
    bothLanguagesFor(DEVICE_ITEM_STATES, 'STATE_SHORT');
  });

  it('has words in both languages for each kind of work this handheld sends', () => {
    bothLanguagesFor(SENT_WORK_KINDS, 'KIND_WORDS');
  });

  it('tripwire — the detector fires on a state nobody translated', () => {
    expect(() => bothLanguagesFor(['a_state_nobody_translated'], 'SENT_STATE_WORDS')).toThrow();
  });

  it('renders the list from the session and syncs to the box after an accepted action — never from the view\'s own idea of "sent"', () => {
    expect(VIEW).toMatch(/real\.sentWork\(\)/);
    expect(VIEW).toMatch(/words\(SENT_STATE_WORDS, w\.state\)/);
    expect(VIEW).toMatch(/window\.pickerRelay/);
    // Every accepted action hands the queue over: a pick, a swap, a problem, the pack.
    expect((VIEW.match(/void syncToBox\(\);/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // The device's own "saved" is never shown as "sent": only the box's word says head office has it (P-08).
    expect(VIEW).toContain("t('nothingSent')");
  });
});
