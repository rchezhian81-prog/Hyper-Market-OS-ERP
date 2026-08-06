import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAPTURE_REFUSALS } from '../../apps/web-erp/src/buying-session';
import { BUYING_GAPS } from '../../apps/web-erp/src/browser-entry';

/**
 * **The screen where the money leaves, guarded.**
 *
 * Every other screen in this product can be wrong and be corrected. This one pays suppliers. A
 * capture that wrote seventy-seven of eighty lines is an invoice matching no piece of paper
 * anywhere; a capture that wrote all eighty without anybody checking them is the same invoice with
 * nobody's name on it; and a capture of an invoice already captured is a supplier owed the money
 * twice. All three are ordinary-looking code.
 *
 * The decisions guarded here are the ones a later change would remove because they look like
 * friction:
 *
 *   • **the preview comes before the write**, and the save button does not exist until it passes
 *   • **both control totals are on the page**, side by side, because a single "does not reconcile"
 *     line at the foot of a form is a message people learn to click past
 *   • **the refusals have words**, in both languages, for every member of the model's union
 *   • **what the box did not say is said**, because a refusal for the wrong reason is not honest
 *
 * Static checks on the shipped files. They cannot prove the screen is good — a buyer with a real
 * supplier invoice does that — only that the decisions made deliberately are still there.
 */

const VIEW = readFileSync('apps/web-erp/web/buying.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/buying.html', 'utf8');
const MODEL = readFileSync('apps/web-erp/src/buying-session.ts', 'utf8');
const ENTRY = readFileSync('apps/web-erp/src/browser-entry.ts', 'utf8');
const SCREEN_DATA = readFileSync('edge/store-edge/src/screen-data.ts', 'utf8');

/** Comments discuss these on purpose, so only real code counts. */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** A vocabulary the model owns must be covered by words the view owns, in both languages. */
const expectWordsFor = (vocabulary: readonly string[], mapName: string): void => {
  const from = code(VIEW).indexOf(`const ${mapName}`);
  expect(from, `${mapName} is missing from the view`).toBeGreaterThan(-1);
  const words = code(VIEW).slice(from);
  expect(vocabulary.length, `${mapName} guards nothing`).toBeGreaterThan(2);
  for (const member of vocabulary) {
    const at = words.indexOf(`${member}: {`);
    expect(at, `"${member}" has no words in ${mapName}`).toBeGreaterThan(-1);
    const entry = words.slice(at, words.indexOf('\n  },', at));
    expect(entry, `"${member}" has no English`).toMatch(/\ben:/);
    expect(entry, `"${member}" has no Tamil`).toMatch(/\bta:/);
  }
};

describe('nothing is written before somebody has seen what is wrong', () => {
  it('offers the save button only when the model says the file may be saved', () => {
    // Not `disabled` — absent. A disabled button is a thing to keep clicking; an absent one sends
    // the buyer back to the preview, which is where the answer is.
    expect(code(VIEW)).toMatch(/el\('capture'\)\.hidden = !preview\.readyToApprove/);
  });

  it('starts the flow hidden in the shell, so a page that never previewed cannot save', () => {
    // If the markup shipped it visible, a first render before any preview would offer it.
    expect(HTML).toMatch(/id="capture"[^>]*hidden/);
  });

  it('never calls capture from the preview button', () => {
    const preview = code(VIEW).slice(
      code(VIEW).indexOf("el('preview').addEventListener"),
      code(VIEW).indexOf('function renderPreview'),
    );
    expect(preview.length, 'the preview handler was not found').toBeGreaterThan(50);
    expect(preview, 'the preview button writes').not.toMatch(/captureInvoice|raisePurchaseOrder/);
  });

  it('asks somebody else before it captures, and the model refuses a self-approval anyway', () => {
    const capture = code(VIEW).slice(code(VIEW).indexOf("el('capture').addEventListener"));
    const asked = capture.indexOf('askApprover');
    const wrote = capture.indexOf('captureInvoice');
    expect(asked, 'nobody is asked before a capture').toBeGreaterThan(-1);
    expect(wrote, 'nothing is captured').toBeGreaterThan(asked);
    // Belt and braces: the screen may only offer the list, never be the control.
    expect(code(MODEL)).toMatch(/approved_by_the_person_who_captured_it/);
  });

  it('commits atomically, or not at all', () => {
    // Seventy-seven of eighty lines written is an invoice matching no piece of paper anywhere, and
    // nobody can say which three are missing.
    expect(code(MODEL)).toMatch(/commitImport\(/);
    expect(code(MODEL), 'the capture writes line by line').not.toMatch(/for \(const line of .*\) \{[\s\S]{0,80}captured\.push/);
  });
});

describe('the two figures that must agree are both on the page', () => {
  it('shows what the file adds up to AND what the paper says', () => {
    // The declared total is the only figure in this flow that does not come from the file, which
    // is exactly why it can catch a line the file is missing — every remaining line can be
    // perfect and only the total notices.
    for (const key of ['fileSays', 'paperSays']) {
      expect(code(VIEW), `${key} is never rendered`).toMatch(new RegExp(`t\\('${key}'\\)`));
    }
    expect(code(VIEW)).toMatch(/preview\.sumMinor/);
    expect(code(VIEW)).toMatch(/preview\.declaredTotalMinor/);
  });

  it('does not rely on colour alone to say which one is wrong', () => {
    // A coloured number with no label is unreadable to a red-green colour-blind buyer, and this
    // one decides whether a supplier gets paid (WCAG 2.2 AA, 1.4.1).
    const compare = code(VIEW).slice(code(VIEW).indexOf("compare.className = 'compare'"));
    expect(compare).toMatch(/t\('fileSays'\)/);
    expect(compare).toMatch(/doesNotAddUp/);
  });

  it('asks the buyer for the printed total before it will preview anything', () => {
    expect(code(VIEW)).toMatch(/needTotal/);
    expect(HTML).toMatch(/id="declared-total"/);
  });

  it('checks each line’s own arithmetic and names the line number to look at', () => {
    // A mistyped quantity is invisible in a column of numbers and obvious the moment quantity,
    // unit price and line total are multiplied together.
    expect(code(MODEL)).toMatch(/export function lineArithmeticErrors/);
    expect(code(MODEL)).toMatch(/quantity \* unit === total/);
    expect(code(VIEW)).toMatch(/t\('line'\)\} \$\{problem\.line\}/);
  });
});

describe('every refusal has words, in both languages', () => {
  it('covers every CaptureRefusal the model can return', () => {
    expectWordsFor(CAPTURE_REFUSALS, 'REFUSAL_WORDS');
  });

  it('tripwire — the check fails when a refusal has no words', () => {
    // Otherwise a lookup that silently matched nothing would make the check above vacuous.
    expect(() => expectWordsFor([...CAPTURE_REFUSALS, 'invented_refusal'], 'REFUSAL_WORDS')).toThrow();
  });

  it('says the model’s own sentence about a match rather than rewording it', () => {
    // The model already distinguishes "checked and clean" from "not checked". A second, untested
    // version of that distinction on the screen is how the two come to disagree.
    expect(code(VIEW)).toMatch(/action\.textContent = result\.ownerAction/);
  });
});

describe('what the box did not say is said', () => {
  it('has a sentence in both languages for every gap the entry can report', () => {
    expectWordsFor(BUYING_GAPS, 'GAP_WORDS');
  });

  it('renders them, and hides the strip only when there are none', () => {
    expect(code(VIEW)).toMatch(/el\('gaps'\)\.hidden = gaps\.length === 0/);
    expect(HTML).toMatch(/id="gaps"/);
  });

  it('counts an empty approver list as a gap, because it stops the same work', () => {
    // Nobody to approve is indistinguishable in effect from never having been told: either way the
    // buyer cannot save anything, and a blank panel with only a Cancel button reads as a bug.
    expect(code(ENTRY)).toMatch(/approvers === undefined \|\| data\.approvers\.length === 0/);
    expect(code(VIEW)).toMatch(/people\.length === 0/);
  });

  it('never lets the screen invent who may approve', () => {
    const list = code(VIEW).slice(code(VIEW).indexOf('const approvers ='));
    expect(list.slice(0, 120)).toMatch(/window\.buyingData\?\.approvers/);
  });
});

describe('the box strips the buyer out of their own approver list', () => {
  it('filters the buyer server-side, not on the screen that would offer them', () => {
    // Separation of duties enforced only by the list somebody was shown is not enforced at all.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function buyingPayload'));
    expect(builder).toMatch(/approvers: policy\.approvers\.filter\(\(who\) => who !== policy\.buyerId\)/);
  });

  it('serves the buyer’s screen nothing at all when it has no buying policy', () => {
    // A screen inventing its own match tolerances would be deciding, on its own authority, how big
    // a price difference is worth nobody's attention.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function buyingPayload'));
    expect(builder).toMatch(/if \(!input\.pack\.buyingPolicy\.known\) return null;/);
  });

  it('accumulates repeat deliveries against one order instead of overwriting them', () => {
    // Half the order on Monday and the rest on Thursday is an ordinary week. Last-write-wins would
    // report that only Thursday's half arrived, and the match would withhold payment for goods
    // sitting on the shelf.
    expect(code(SCREEN_DATA)).toMatch(/function foldByReference/);
    expect(code(SCREEN_DATA)).toMatch(/qty: into\.qty \+ next\.qty/);
  });
});

describe('the buyer’s screen keeps the house rules', () => {
  it('asks its questions on the page, never with a browser dialog', () => {
    // A `confirm()` is unstyled, untranslatable and looks like the browser asking, not the shop.
    expect(code(VIEW)).not.toMatch(/\b(window\.)?(confirm|prompt|alert)\s*\(/);
  });

  it('does not fade its banner away on a timer', () => {
    // The buyer may be looking at the paper invoice rather than the screen when it appears.
    expect(code(VIEW)).not.toMatch(/setTimeout|setInterval/);
  });

  it('is offered in Tamil as well as English, on every word it shows', () => {
    const en = [...code(VIEW).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]!);
    expect(en.length, 'no words were found at all').toBeGreaterThan(20);
    const ta = code(VIEW).slice(code(VIEW).indexOf('  ta: {'));
    for (const key of new Set(en)) {
      expect(ta, `"${key}" has no Tamil`).toMatch(new RegExp(`\\b${key}:`));
    }
  });

  it('keeps money in exact minor units and never a float', () => {
    expect(code(VIEW)).toMatch(/Math\.round\(Number\(/);
    expect(code(MODEL)).not.toMatch(/parseFloat/);
  });
});

describe('the back office actually opens without a network (§31, P-01)', () => {
  const SW = readFileSync('apps/web-erp/web/sw.js', 'utf8');
  const MANAGER_VIEW = readFileSync('apps/web-erp/web/app.js', 'utf8');

  it('registers its service worker — it existed for weeks and nothing ever did', () => {
    // A cache nothing installs is a cache. Goods-in is the worst wifi in the building.
    for (const [name, source] of [['the buyer', VIEW], ['the manager', MANAGER_VIEW]] as const) {
      expect(code(source), `${name}'s shell never registers the service worker`)
        .toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
    }
  });

  it('caches both shells and the bundle they share', () => {
    // Without the bundle the screens open offline into their SAMPLE stand-in — which says so on
    // the page, but is not the shop's data and is not what "works offline" means.
    for (const file of ['./index.html', './buying.html', './buying.js', './web-erp.bundle.js']) {
      expect(SW, `${file} is not cached`).toContain(file);
    }
  });

  it('falls a failed page back to the RIGHT shell of the two', () => {
    // Falling back to `index.html` regardless would hand a day close to somebody who opened the
    // goods-in screen — the confusion the box's routing avoids, reintroduced when the wifi drops.
    expect(code(SW)).toMatch(/includes\('buying'\) \? '\.\/buying\.html' : '\.\/index\.html'/);
  });

  it('never answers a missing script with a page', () => {
    // HTML served as JavaScript is a syntax error, and the screen then boots into its sample
    // stand-in for a reason nobody can see.
    expect(code(SW)).toMatch(/request\.mode !== 'navigate'/);
  });
});
