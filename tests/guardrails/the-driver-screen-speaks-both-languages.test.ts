import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SENT_WORK_KINDS } from '../../apps/delivery-app/src/route-session';
import { DEVICE_ITEM_STATES } from '../../packages/sync/src/device-relay';

/**
 * **The driver's phone says where every stop outcome, the settlement and the cash handover have got to — in English AND
 * Tamil (SP-3c-ii · OA-9 · P-08).**
 *
 * Since SP-3c-ii the driver's queue reaches the store computer and head office, and the shell lists each piece of work
 * with one of the FIVE shared device states (`packages/sync/src/device-relay.ts`). A state with no word, or a word in only
 * one language, shows a driver carrying cash a blank pill at the moment it matters. So this binds the view's three
 * vocabularies to the shared list and to the session's own `SENT_WORK_KINDS`: adding a state or a kind without its words
 * fails the build. The same tripwire the warehouse and picker handhelds carry.
 *
 * NOTE: this checks PRESENCE and completeness, not translation quality — the Tamil wording is pending a native-speaker
 * review before go-live (OWNER-ACTION OA-10 in docs/OWNER-ACTION-REGISTER.md).
 */

const VIEW = readFileSync('apps/delivery-app/web/app.js', 'utf8');

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

describe('the driver\'s phone names where each sent piece of work is, in both languages (SP-3c-ii)', () => {
  it('has words in both languages for the five shared device states — long for the list, short for the badge', () => {
    bothLanguagesFor(DEVICE_ITEM_STATES, 'SENT_STATE_WORDS');
    bothLanguagesFor(DEVICE_ITEM_STATES, 'STATE_SHORT');
  });

  it('has words in both languages for each kind of work this phone sends', () => {
    bothLanguagesFor(SENT_WORK_KINDS, 'KIND_WORDS');
  });

  it('tripwire — the detector fires on a state nobody translated', () => {
    expect(() => bothLanguagesFor(['a_state_nobody_translated'], 'SENT_STATE_WORDS')).toThrow();
  });

  it('renders the list from the session, syncs to the box after every accepted action, and settles the shift before the handover', () => {
    expect(VIEW).toMatch(/real\.sentWork\(\)/);
    expect(VIEW).toMatch(/words\(SENT_STATE_WORDS, w\.state\)/);
    expect(VIEW).toMatch(/window\.driverRelay/);
    // Every accepted action hands the queue over: a delivery, a partial delivery, a failure, the handover.
    expect((VIEW.match(/void syncToBox\(\);/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // End of shift reconciles the COD (M19-FR-04) before the counted cash is handed over against it.
    const handover = VIEW.slice(VIEW.indexOf("el('handover').addEventListener"));
    expect(handover.indexOf('session.settle()')).toBeGreaterThan(-1);
    expect(handover.indexOf('session.settle()')).toBeLessThan(handover.indexOf('session.handOver('));
    // The phone's own "saved" is never shown as "sent": only the box's word says head office has it (P-08).
    expect(VIEW).toContain("t('nothingSent')");
  });
});
