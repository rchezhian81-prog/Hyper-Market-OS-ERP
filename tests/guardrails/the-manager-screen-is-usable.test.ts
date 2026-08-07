import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  APPROVE_REASONS,
  BLOCKER_KINDS,
  DECIDE_REFUSALS,
  REJECT_REASONS,
} from '../../apps/web-erp/src/manager-session';

/**
 * **The screen that runs the floor, guarded.**
 *
 * The manager's screen carries decisions that are easy to undo by accident: a zero where the model
 * said *not known*, a shortened list that reads as complete, an expected quantity rendered next to
 * a counting field because it seemed helpful. Every one would be invisible in review and decisive
 * in the shop.
 *
 * Three of these are **tripwires between the model and the view**: the model owns the vocabularies
 * (blocker kinds, decision reason codes) and the view owns the words. Adding to one without the
 * other fails here, rather than showing a manager a blank reason at the moment they most need one.
 *
 * Static checks on the shipped files. They cannot prove the screen is good — a person with a
 * stopwatch does that — only that the decisions made deliberately are still there.
 */

const APP = readFileSync('apps/web-erp/web/app.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/index.html', 'utf8');
const MODEL = readFileSync('apps/web-erp/src/manager-session.ts', 'utf8');

/** Comments discuss these on purpose, so only real code counts. */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** The keys of a `{ key: {...} }` object literal starting at `marker`, to its closing `};`. */
const entriesIn = (source: string, marker: string): string[] => {
  const from = source.indexOf(marker);
  expect(from, `"${marker}" is missing from the view`).toBeGreaterThan(-1);
  const block = source.slice(from, source.indexOf('\n};', from));
  return [...block.matchAll(/^ {2}(\w+):\s*\{/gm)].map((m) => m[1]!);
};

/**
 * A vocabulary the model owns must be covered by words the view owns, in both languages.
 *
 * The shape of every tripwire in this file: add a member to the union, forget the words, and a
 * manager gets a blank reason at the moment they most need one.
 */
const expectWordsFor = (vocabulary: readonly string[], mapName: string): void => {
  const words = code(APP).slice(code(APP).indexOf(`const ${mapName}`));
  expect(vocabulary.length, `${mapName} guards nothing`).toBeGreaterThan(2);
  for (const member of vocabulary) {
    const at = words.indexOf(`${member}: {`);
    expect(at, `"${member}" has no words in ${mapName}`).toBeGreaterThan(-1);
    const entry = words.slice(at, words.indexOf('\n  },', at));
    expect(entry, `"${member}" has no English`).toMatch(/\ben:/);
    expect(entry, `"${member}" has no Tamil`).toMatch(/\bta:/);
  }
};

describe('nothing here asks a question through the browser', () => {
  it('uses no prompt, confirm or alert anywhere', () => {
    const found = [...code(APP).matchAll(/\b(?:window\.)?(prompt|confirm|alert)\s*\(/g)].map((m) => m[1]);
    expect(found).toEqual([]);
  });

  it('asks with an on-screen panel instead', () => {
    expect(HTML).toContain('id="sheet"');
    expect(HTML).toContain('id="keypad"');
    expect(code(APP)).toMatch(/function ask\(/);
  });
});

describe('"not known" is never painted as a zero', () => {
  it('branches on the model\'s `known` flag before it renders a figure', () => {
    // The whole design. A screen that read `.count` unconditionally would show `undefined` at best
    // and `0` at worst, and a zero exception count is what lets somebody lock a trading day.
    expect(code(APP)).toMatch(/figure\.known/);
    expect(code(APP)).toContain("t('notKnown')");
  });

  it('shows the reason it does not know, in the model\'s own words', () => {
    // The model is the only thing that knows why. Rewording it here would put a second, untested
    // version of the message on the screen.
    expect(code(APP)).toMatch(/figure\.why/);
    expect(code(APP)).toMatch(/queue\.why/);
  });

  it('marks an unknown figure differently from a busy one, not just in colour', () => {
    expect(code(APP)).toMatch(/classList\.add\('unknown'\)/);
    expect(HTML).toContain('.tile.unknown');
    // Words, not only the red edge — one man in twelve has some colour blindness.
    expect(code(APP)).toMatch(/n\.textContent = t\('notKnown'\)/);
  });

  it('says the store link is unknown when a register could not be read', () => {
    expect(code(APP)).toContain("t('notConnected')");
  });
});

describe('the day close shows a list, and the list does not lie about its length', () => {
  it('renders each blocker\'s items, not just its count', () => {
    // "Cannot close" is useless at eleven at night.
    expect(code(APP)).toMatch(/blocker\.items/);
    expect(HTML).toContain('id="blockers"');
  });

  it('shortens the display but reports the true number of the rest', () => {
    // A shortened list that looks complete is how a manager clears three of eleven and goes home.
    expect(code(APP)).toMatch(/slice\(0, SHOWN\)/);
    expect(code(APP)).toMatch(/blocker\.items\.length - SHOWN/);
  });

  it('only offers the close button when the MODEL says nothing is in the way', () => {
    expect(code(APP)).toMatch(/el\('do-close'\)\.hidden = blockers\.length > 0/);
  });

  it('re-renders rather than reporting success when the close comes back refused', () => {
    // Something can change between the check and the tap — a sale rung on a lane, an exception
    // raised. A screen that said "closed" on a refusal would be the worst possible lie here.
    expect(code(APP)).toMatch(/if \(attempt\.closed\)/);
    expect(code(APP)).toMatch(/renderBlockers\(attempt\.blockers\)/);
  });

  it('has words for EVERY blocker kind the model can produce, in both languages', () => {
    // The tripwire. The model returns structure and never a sentence, so the words can be Tamil —
    // but only if they exist. Add a kind, forget the words, and a manager gets a blank reason.
    expectWordsFor(BLOCKER_KINDS, 'BLOCKER_WORDS');
  });

  it('tripwire — the check fires on a kind nobody translated', () => {
    // Otherwise a reader that silently matched everything would make the check above vacuous.
    expect(() => expectWordsFor(['a_kind_nobody_translated', 'x', 'y'], 'BLOCKER_WORDS')).toThrow();
  });
});

describe('a decision reason is the model\'s, never the screen\'s', () => {
  it('takes the reason catalogue from the model rather than composing one', () => {
    // A screen that wrote its own reason strings guarantees the audit trail fills up with them.
    expect(code(APP)).toMatch(/window\.managerReasons/);
    expect(code(APP)).toMatch(/decision === 'approved' \? REASONS\.approved : REASONS\.rejected/);
  });

  it('has words for every reason code in BOTH catalogues, in both languages', () => {
    // The second tripwire: the codes live in the model, the words live in the view, and adding one
    // without the other shows a manager a bare `not_enough_evidence`.
    const shown = entriesIn(code(APP), 'const REASON_WORDS = {');
    for (const codeName of [...APPROVE_REASONS, ...REJECT_REASONS]) {
      expect(shown, `"${codeName}" has no words on the screen`).toContain(codeName);
    }
    const block = code(APP).slice(code(APP).indexOf('const REASON_WORDS'), code(APP).indexOf('\n};', code(APP).indexOf('const REASON_WORDS')));
    expect([...block.matchAll(/ta: '/g)]).toHaveLength(shown.length);
  });

  it('records the code, not a sentence', () => {
    expect(code(APP)).toMatch(/reasonCode,/);
    expect(code(APP)).not.toMatch(/reason:\s*['"`]/);
  });

  it('says WHY a decision was refused, in words, in both languages', () => {
    // A manager reading `self_approval_forbidden` off a screen taps the button again, harder.
    expect(code(APP)).toMatch(/words\(REFUSAL_WORDS, outcome\.refusal\)/);
    expectWordsFor(DECIDE_REFUSALS, 'REFUSAL_WORDS');
  });

  it('offers a count reason as a choice, never as free text', () => {
    expect(code(APP)).toContain('COUNT_REASONS');
    expect(HTML).not.toMatch(/<input[^>]*reason/i);
  });
});

describe('a row the manager cannot decide says why, rather than offering a dead button', () => {
  it('renders the blocked reason instead of the action buttons', () => {
    expect(code(APP)).toMatch(/if \(row\.actionable\)/);
    expect(code(APP)).toMatch(/words\(BLOCKED_WORDS, row\.blockedReason\)/);
  });

  it('has words for each blocked reason in both languages', () => {
    const block = code(APP).slice(code(APP).indexOf('const BLOCKED_WORDS'), code(APP).indexOf('\n};', code(APP).indexOf('const BLOCKED_WORDS')));
    for (const reason of ['own_request', 'out_of_scope', 'exceeds_authority']) {
      expect(block, `"${reason}" is missing`).toContain(`${reason}: {`);
    }
    expect([...block.matchAll(/ta: '/g)]).toHaveLength(3);
  });

  it('keeps a decision inside the ≤3-tap budget by deciding on the reason tap', () => {
    // Tap Approve, tap a reason. A confirm step would make it three before anything went wrong.
    expect(code(APP)).toMatch(/closeSheet\(option\.value\)/);
  });
});

describe('the count stays blind', () => {
  it('shows no expected quantity anywhere on the counting screen', () => {
    // Shown "system says 100", people write 100 — not from dishonesty, but because a number on a
    // screen is an answer and counting is work. Same control as the till's drawer.
    const panel = HTML.slice(HTML.indexOf('id="view-count"'), HTML.indexOf('id="view-close"'));
    expect(panel).not.toMatch(/expected|system says|should be|on hand/i);
  });

  it('reads the expected figure only from the RESULT, after a count was submitted', () => {
    expect(code(APP)).toMatch(/result\.varianceMinor/);
    expect(code(APP)).not.toMatch(/session\.(?:onHand|expected|stockOnHand)/);
  });

  it('never asks the model for an on-hand quantity, because there is nothing to ask', () => {
    // Absence as the control: the model exposes no such method, so a later change cannot render one
    // early by accident.
    expect(MODEL).not.toMatch(/^\s*(?:expected|onHand)\w*\s*\(/m);
  });

  it('refuses a count it cannot value, and says so in words a manager can act on', () => {
    expect(code(APP)).toMatch(/attempt\.counted/);
    expect(code(APP)).toContain("t('cannotValue')");
  });
});

describe('what the shop must be told, it is told', () => {
  it('warns when a delivery arrived with no purchase order behind it', () => {
    // Nobody can check an invoice against a purchase order that does not exist, and the person who
    // can still fix that is the buyer, today.
    expect(code(APP)).toMatch(/received\.unmatched/);
    expect(code(APP)).toContain("t('unmatchedWarning')");
  });

  it('announces sample data instead of passing it off as the store\'s', () => {
    // A manager acting on a number that came from nowhere is worse than one with no number at all.
    expect(HTML).toContain('id="sample"');
    expect(code(APP)).toMatch(/el\('sample'\)\.hidden = real !== undefined/);
  });

  it('has a banner that does not disappear on a timer', () => {
    expect(HTML).toContain('id="banner"');
    expect(HTML).toContain('role="alert"');
    const banner = code(APP).slice(code(APP).indexOf('function tell'), code(APP).indexOf("el('banner-ok')"));
    expect(banner).not.toMatch(/setTimeout|setInterval/);
  });
});

describe('it can be read and reached', () => {
  it('states a touch target of at least 48px', () => {
    const tap = /--tap:\s*(\d+)px/.exec(HTML);
    expect(tap, 'the shell must declare a minimum touch target').not.toBeNull();
    expect(Number(tap![1])).toBeGreaterThanOrEqual(48);
  });

  it('carries Tamil for every word on the screen, not a subset', () => {
    // A half-translated screen is worse than an untranslated one: it reads as unfinished exactly
    // where somebody is relying on it.
    const source = code(APP);
    const block = (marker: string): string => {
      const from = source.indexOf(marker);
      expect(from, `the ${marker.slice(0, 2)} words are missing`).toBeGreaterThan(-1);
      return source.slice(from, source.indexOf('\n  },', from));
    };
    const keysIn = (text: string): string[] =>
      [...text.matchAll(/(?:^|[{,]\s*)(\w+):\s*'/g)].map((m) => m[1]!);

    const english = keysIn(block('en: {'));
    const tamil = new Set(keysIn(block('ta: {')));
    expect(english.length).toBeGreaterThan(30);
    for (const key of english) expect([...tamil], `"${key}" has no Tamil`).toContain(key);
  });

  it('holds no money or approval arithmetic of its own', () => {
    // The view converts and displays. A second copy of a rule on this side of the boundary is a
    // rule that is not tested.
    expect(code(APP)).not.toMatch(/authorityLimit|thresholdMinor|\*\s*1\.\d|taxBps/);
  });
});
