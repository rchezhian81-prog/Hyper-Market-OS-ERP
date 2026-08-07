import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { APPROVE_REASONS, REJECT_REASONS } from '../../packages/approvals/src/reasons';
import { DRILLABLE_KPIS, OWNER_DECIDE_REFUSALS } from '../../apps/owner-app/src/owner-session';

/**
 * **The screen the owner decides from, guarded.**
 *
 * This one is not a till with a queue behind it — it is a phone in another town, showing numbers
 * that left the shop some time ago. Everything below is a decision about that gap, and every one of
 * them is easy to undo by accident: a freshness badge that fades into decoration, a sample payload
 * that renders like the shop's own takings, a `window.alert` because a drill-through was more work.
 *
 * The version of this screen that existed before these checks did all three.
 *
 * Two are **tripwires between the model and the view**: the model owns the vocabularies (refusals,
 * reason codes, drillable figures) and the view owns the words. Adding to one without the other
 * fails here rather than showing the owner a bare `stale_data_not_acknowledged`.
 */

const APP = readFileSync('apps/owner-app/web/app.js', 'utf8');
const HTML = readFileSync('apps/owner-app/web/index.html', 'utf8');
const MODEL = readFileSync('apps/owner-app/src/owner-session.ts', 'utf8');

/** Comments discuss these on purpose, so only real code counts. */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/**
 * A vocabulary the model owns must be covered by words the view owns, in both languages.
 *
 * Add a member to the model's list, forget the words, and the owner reads a raw code off a phone.
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

describe('nothing here answers a tap with a browser dialog', () => {
  it('uses no prompt, confirm or alert anywhere', () => {
    // This screen used `window.alert('t-1\\nt-2')` for a tapped alert and `window.alert('Open: '
    // + ref)` for a tapped priority — a system dialog with a raw id in it, which is a dead end
    // wearing the clothes of an action. On a phone it is also unstyled and untranslatable.
    const found = [...code(APP).matchAll(/\b(?:window\.)?(prompt|confirm|alert)\s*\(/g)].map((m) => m[1]);
    expect(found).toEqual([]);
  });

  it('opens a real panel for a figure and for a decision instead', () => {
    expect(HTML).toContain('id="drill"');
    expect(HTML).toContain('id="decide"');
    expect(code(APP)).toMatch(/function openDrill\(/);
    expect(code(APP)).toMatch(/function openDecide\(/);
  });

  it('routes a tapped priority to the thing itself, not to a message about it', () => {
    expect(code(APP)).toMatch(/openDecide\(request\)/);
    expect(code(APP)).toMatch(/showAlert\(alert\)/);
  });
});

describe('the age of the data is put in front of the decision', () => {
  it('shows the staleness INSIDE the approve panel, not only in the header badge', () => {
    // The whole design. A badge at the top of a scrolling phone screen is not in front of anybody
    // by the time they reach the buttons; the warning has to be where the decision is made.
    expect(HTML).toContain('id="decide-stale"');
    expect(code(APP)).toMatch(/el\('decide-stale'\)\.hidden = freshness\.state === 'fresh'/);
    expect(code(APP)).toContain("t('staleWarning')");
  });

  it('passes the acknowledgement to the model rather than deciding for itself', () => {
    // The view must not be the thing that judges whether data is fresh enough to act on.
    expect(code(APP)).toMatch(/acknowledgeStale/);
    expect(code(APP)).not.toMatch(/ageSeconds\s*[<>]/);
  });

  it('offers NO reason buttons at all when nothing has ever synced', () => {
    // `missing` is not old data, it is no data. An acknowledgement of nothing is not informed
    // consent, so there is nothing to tap through.
    expect(code(APP)).toMatch(/freshness\.state === 'missing' \? \[\]/);
    expect(code(APP)).toContain("t('cannotDecideNoData')");
  });

  it('says the age in words a person reads, not in seconds', () => {
    // A phone showing "39600s" has a freshness indicator nobody reads, which is the same as not
    // having one.
    expect(code(APP)).toMatch(/function ageInWords\(/);
    expect(code(APP)).toContain("t('hoursAgo')");
  });

  it('never uses colour alone for freshness', () => {
    expect(code(APP)).toContain("t('notLive')");
    expect(code(APP)).toContain("t('neverSynced')");
    expect(code(APP)).toMatch(/text\.className = freshness\.state/);
  });
});

describe('a decision that went out of date comes back to the owner (§31.1)', () => {
  it('renders the re-check list from the model\'s reconciliation', () => {
    expect(code(APP)).toMatch(/session\.reconcileQueued\(\)/);
    expect(HTML).toContain('id="recheck-section"');
  });

  it('shows what the owner said AND what the request now says', () => {
    // A ₹40,000 approval quietly applying to a ₹90,000 request is the exact failure a
    // maker-checker exists to prevent, so both numbers have to be on screen together.
    expect(code(APP)).toContain("t('youSaid')");
    expect(code(APP)).toContain("t('itNowSays')");
    expect(code(APP)).toMatch(/item\.nowIs/);
  });

  it('only discards after it has been shown, and only on an explicit tap', () => {
    const discard = code(APP).slice(code(APP).indexOf('function renderRecheck'), code(APP).indexOf('// ── Deciding'));
    expect(discard).toMatch(/addEventListener\('click', \(\) => \{ session\.discardQueued/);
    // Nothing may drop a queued decision as a side effect of rendering.
    expect(code(APP)).not.toMatch(/discardQueued\([^)]*\);\s*\n\s*(?:for|while)/);
  });

  it('shows the unsent count, because a decision nobody sent is not a decision made', () => {
    expect(code(APP)).toMatch(/session\.queued\(\)/);
    expect(code(APP)).toContain("t('willSend')");
  });

  it('says when the phone could not save a decision, rather than swallowing it', () => {
    expect(HTML).toContain('id="queue-problem"');
    expect(code(APP)).toMatch(/window\.ownerQueueProblem/);
  });
});

describe('a figure drills to every sale behind it, never a sample', () => {
  it('has a tile for each drillable KPI the model offers', () => {
    // The tripwire: add a KPI to the model and the screen must gain a tile, or the figure exists
    // with no way to see what it is made of.
    const tiles = [...code(APP).matchAll(/\{ kpi: '(\w+)'/g)].map((m) => m[1]!);
    expect([...tiles].sort()).toEqual([...DRILLABLE_KPIS].sort());
  });

  it('renders every line the model returns, with no slicing', () => {
    const from = code(APP).indexOf('function openDrill');
    const drill = code(APP).slice(from, code(APP).indexOf("el('drill-close').addEventListener", from));
    expect(from, 'openDrill is missing').toBeGreaterThan(-1);
    expect(drill).toMatch(/drill\.lines\.map/);
    expect(drill).not.toMatch(/\.slice\(/);
  });

  it('says which figure the count answers rather than showing money for a bill count', () => {
    expect(code(APP)).toMatch(/drill\.countIsTheAnswer/);
    expect(code(APP)).toContain("t('countIsAnswer')");
  });

  it('holds no KPI arithmetic of its own', () => {
    // The view converts and displays. A second copy of a margin rule here is a rule nobody tests,
    // and the disagreement only ever surfaces in front of the person being asked to act.
    expect(code(APP)).not.toMatch(/cogsMinor|netMinor|marginPctBps|\/ 1\.\d/);
  });
});

describe('a decision reason is the model\'s, never the screen\'s', () => {
  it('takes the reason catalogue from the model rather than composing one', () => {
    expect(code(APP)).toMatch(/window\.ownerReasons/);
    expect(code(APP)).toMatch(/decision === 'approved' \? REASONS\.approved : REASONS\.rejected/);
  });

  it('has words for every reason code in BOTH catalogues, in both languages', () => {
    const shown = code(APP).slice(code(APP).indexOf('const REASON_WORDS'));
    for (const reason of [...APPROVE_REASONS, ...REJECT_REASONS]) {
      expect(shown, `"${reason}" has no words on the screen`).toContain(`${reason}: {`);
    }
  });

  it('says WHY a decision was refused, in words, in both languages', () => {
    expect(code(APP)).toMatch(/words\(REFUSAL_WORDS, outcome\.refusal\)/);
    expectWordsFor(OWNER_DECIDE_REFUSALS, 'REFUSAL_WORDS');
  });

  it('tripwire — the check fires on a refusal nobody translated', () => {
    expect(() => expectWordsFor(['a_refusal_nobody_translated', 'x', 'y'], 'REFUSAL_WORDS')).toThrow();
  });

  it('keeps a decision inside the ≤3-tap budget by deciding on the reason tap', () => {
    // Open the approval (1), tap Approve (2), tap a reason (3). A confirm step would be four.
    const panel = code(APP).slice(code(APP).indexOf('function openDecide'), code(APP).indexOf("el('decide-cancel')"));
    expect(panel).toMatch(/submit\(request, decision, code, stale\)/);
  });
});

describe('what came from nowhere says so', () => {
  it('announces sample figures instead of passing them off as the shop\'s', () => {
    // The previous version rendered a fabricated ₹413 of takings with no warning at all.
    expect(HTML).toContain('id="sample"');
    expect(code(APP)).toMatch(/el\('sample'\)\.hidden = real !== undefined/);
  });

  it('its sample deliberately shows STALE data, so the warning path is what gets reviewed', () => {
    // A demo on live numbers would never show the warning this screen exists to put in front of a
    // decision, and the warning is the part that needs a person to look at it.
    const sample = code(APP).slice(code(APP).indexOf('function sampleSession'), code(APP).indexOf('const real ='));
    expect(sample).toMatch(/state: 'stale'/);
    expect(sample).toMatch(/refusal: 'stale_data_not_acknowledged'/);
  });

  it('says it has nothing rather than rendering zeros that read as a quiet day', () => {
    expect(code(APP)).toContain("t('noDataTitle')");
    expect(code(APP)).toMatch(/real === undefined && window\.ownerData !== undefined/);
  });
});

describe('it can be read and reached on a phone', () => {
  it('states a touch target of at least 44px', () => {
    // The design system's floor for a phone held in one hand.
    const tap = /--tap:\s*(\d+)px/.exec(HTML);
    expect(tap, 'the shell must declare a minimum touch target').not.toBeNull();
    expect(Number(tap![1])).toBeGreaterThanOrEqual(44);
  });

  it('carries Tamil for every word on the screen, not a subset', () => {
    // The old language button set `document.documentElement.lang` and changed not one word — a
    // toggle that says "translated" and is not.
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

  it('actually repaints when the language changes', () => {
    const toggle = code(APP).slice(code(APP).indexOf("el('lang').addEventListener"));
    expect(toggle).toMatch(/paintChrome\(\)/);
    expect(toggle).toMatch(/render\(\)/);
  });

  it('has a banner that does not disappear on a timer', () => {
    expect(HTML).toContain('id="banner"');
    expect(HTML).toContain('role="alert"');
    const banner = code(APP).slice(code(APP).indexOf('function tell'), code(APP).indexOf("el('banner-ok')"));
    expect(banner).not.toMatch(/setTimeout|setInterval/);
  });

  it('hides the branch switcher for a single shop rather than showing a choice of one', () => {
    expect(code(APP)).toMatch(/branches\.length < 2/);
  });
});

describe('the model keeps its own house in order', () => {
  it('offers no way to ask whether data is "fresh enough" outside the decision path', () => {
    // Freshness is judged in one place. A second helper would be a second answer to the only
    // question this screen exists to get right.
    expect(MODEL).not.toMatch(/export function (?:isFresh|freshEnough|canDecide)/);
  });

  it('records the freshness into the decision, not beside it', () => {
    expect(MODEL).toMatch(/freshnessAtDecision/);
    expect(MODEL).toMatch(/acknowledgedStale/);
  });
});
