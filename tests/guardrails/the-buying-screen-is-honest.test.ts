import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAPTURE_REFUSALS } from '../../apps/web-erp/src/buying-session';
import { BUYING_GAPS } from '../../apps/web-erp/src/browser-entry';
import { DEVICE_ITEM_STATES } from '../../packages/sync/src/device-relay';

/**
 * **The screen where the money leaves, guarded.**
 *
 * Every other screen in this product can be wrong and be corrected. This one pays suppliers. A
 * capture that wrote seventy-seven of eighty lines is an invoice matching no piece of paper
 * anywhere; a capture that carries a typed "checked by" name is a check nobody can trust (the
 * check is a second person's own act at head office, under their own sign-in); and a capture of an
 * invoice already captured is a supplier owed the money twice. All three are ordinary-looking code.
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
const NAVIGATION = readFileSync('edge/store-edge/src/screen-navigation.ts', 'utf8');

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

  it('never asks the buyer for a typed checker — the check is a second person\'s own act at head office', () => {
    // Head office does not trust a name typed on the buyer's screen (it records one only as a claim and
    // flags the bill unapproved). Asking for it would be a control that controls nothing.
    const capture = code(VIEW).slice(
      code(VIEW).indexOf("el('capture').addEventListener"),
      code(VIEW).indexOf('function renderSavedInvoices'),
    );
    expect(capture, 'the capture handler was not found').toMatch(/session\.captureInvoice\(/);
    expect(capture, 'the capture asks for a typed checker').not.toMatch(/askApprover|approval|decidedBy/);
    expect(code(VIEW), 'the view still offers a list of checkers').not.toMatch(/askApprover|buyingData\?\.approvers/);
    // And the queued bill names no checker at all — only the buyer who captured it.
    expect(code(MODEL)).not.toMatch(/approvedBy|approvedAt/);
    expect(code(MODEL)).toMatch(/capturedBy: config\.buyerId/);
  });

  it('commits atomically, or not at all', () => {
    // Seventy-seven of eighty lines written is an invoice matching no piece of paper anywhere, and
    // nobody can say which three are missing. The whole previewed line set travels in ONE queued
    // event, enqueued once — never line by line.
    const capture = code(MODEL).slice(
      code(MODEL).indexOf('captureInvoice: (input) =>'),
      code(MODEL).indexOf('savedInvoices: () =>'),
    );
    expect(capture.length, 'the model\'s capture was not found').toBeGreaterThan(200);
    expect(capture.match(/outbox\.enqueue\(/g) ?? [], 'the capture is not one single write').toHaveLength(1);
    expect(capture).toMatch(/const captured: readonly InvoiceLine\[\] = Object\.freeze\(\[\.\.\.input\.preview\.lines\]\)/);
    expect(capture).toMatch(/lines: captured/);
    expect(capture, 'the capture writes line by line').not.toMatch(/\bfor \(|\.forEach\(|captured\.push/);
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
    // OB-31 (owner, 10 Oct 2026): in the product's own unit — a weighed line is grams at the per-kg price, valued once —
    // never a bare quantity × unit, which is out by 1000 for a kg line.
    expect(code(MODEL)).toMatch(/const worth = valueAtUnitCost\(quantity, code, unit\)/);
    expect(code(MODEL)).toMatch(/if \(worth === total\) return;/);
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

  it('no longer needs an approver list — the check is a second person\'s own act at head office (2b-vi-c-4)', () => {
    expect(code(ENTRY)).not.toMatch(/who_may_approve/);
  });
});

describe('the box strips the buyer out of their own approver list', () => {
  it('filters the buyer server-side, not on the screen that would offer them', () => {
    // Separation of duties enforced only by the list somebody was shown is not enforced at all. Since PA-06 part 3b the
    // buyer is the SIGNED-IN person, so the box strips them where it names them: in `asSignedInPerson`.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function buyingPayload'));
    expect(builder).toMatch(/buyerId: null,/); // the pack never names the buyer
    expect(builder).not.toMatch(/policy\.buyerId/);
    const nav = code(NAVIGATION).slice(code(NAVIGATION).indexOf('export function asSignedInPerson'));
    expect(nav).toMatch(/out\['buyerId'\] = userId;/);
    expect(nav).toMatch(/out\['approvers'\] = \(payload\['approvers'\] as unknown\[\]\)\.filter\(\(who\) => who !== userId\)/);
  });

  it('never boots a buyer under a stand-in name — no signed-in buyer, no session (PA-06 part 3b)', () => {
    expect(code(ENTRY)).not.toMatch(/buyerId: data\.buyerId \?\? 'buyer'/);
    expect(code(ENTRY)).toMatch(/if \(buyerId === undefined\) return null;/);
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

describe('a saved invoice says where it is, in both languages (SP-7a · F02)', () => {
  it('has words for the five shared device states the saved-invoice list shows', () => {
    expectWordsFor(DEVICE_ITEM_STATES, 'STATE_WORDS');
  });

  it('renders the saved list from the model\'s durable queue, and syncs it to the box after a capture', () => {
    expect(code(VIEW)).toMatch(/session\.savedInvoices\(\)/);
    expect(code(VIEW)).toMatch(/window\.buyingRelay/);
    const capture = code(VIEW).slice(code(VIEW).indexOf("el('capture').addEventListener"));
    expect(capture.indexOf('renderSavedInvoices()')).toBeGreaterThan(-1);
  });

  it('the model queues the capture before it says ok — the plain boot no longer "saves" into thin air', () => {
    expect(code(MODEL)).toMatch(/outbox\.enqueue\(makeEvent\(\{[\s\S]{0,400}type: SUPPLIER_INVOICE_CAPTURED/);
    expect(code(ENTRY)).toMatch(/openBuyingOutbox\(/);
  });
});
