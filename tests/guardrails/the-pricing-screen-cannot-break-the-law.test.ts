import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PRICE_CHANGE_REFUSALS } from '../../packages/price-list/src/index';
import { PUBLISH_REFUSAL_KINDS, SHELF_REFUSAL_KINDS } from '../../apps/web-erp/src/catalogue-session';
import { CATALOGUE_GAPS } from '../../apps/web-erp/src/browser-entry';

/**
 * **The screen that sets what customers are charged, guarded.**
 *
 * Most mistakes in this product cost the shop money. A price above MRP costs it a prosecution: MRP
 * is a legal ceiling in India, not a shop policy, so it is the one refusal on this surface that
 * **nothing may authorise** — not an owner, not a written reason, not a "just this once" button.
 * A later change adding an override here would look like a helpful escape hatch and would be a
 * standing offer to break the law with an audit trail proving it was deliberate.
 *
 * The other three decisions guarded here are the ones that look like friction:
 *
 *   • **the limits are on the page before the price is typed** — a screen that only says "rejected"
 *     afterwards teaches people to guess, and guessing at a legal ceiling is how this goes wrong;
 *   • **a margin nobody can compute is not a margin that passed** — cost defaulted to zero makes
 *     every price look like 100% margin, so the floor check passes loudly and wrongly;
 *   • **a price change is a new entry, never an edit** — a receipt printed last Tuesday has to stay
 *     explainable, and an overwritten price explains nothing (hard rule #2).
 *
 * Static checks on the shipped files. They cannot prove the screen is good — a pricing manager with
 * a real catalogue does that — only that the decisions made deliberately are still there.
 */

const VIEW = readFileSync('apps/web-erp/web/catalogue.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/catalogue.html', 'utf8');
const MODEL = readFileSync('apps/web-erp/src/catalogue-session.ts', 'utf8');
const CHANGE = readFileSync('packages/price-list/src/price-change.ts', 'utf8');
const SCORE = readFileSync('packages/product/src/completeness.ts', 'utf8');
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

describe('nothing on this surface can authorise a price above MRP', () => {
  it('refuses it in the rule, with no approval branch at all', () => {
    const activate = code(CHANGE).slice(code(CHANGE).indexOf('export function activatePriceChange'));
    // The unauthorisable list is checked and returned BEFORE the approval is ever looked at.
    const guard = activate.indexOf('above_the_printed_mrp');
    const approval = activate.indexOf('input.approval');
    expect(guard, 'the MRP breach is not refused at all').toBeGreaterThan(-1);
    expect(approval, `an approval is consulted before the MRP check`).toBeGreaterThan(guard);
  });

  it('has no override, force or ignore function anywhere on this surface', () => {
    // Absence as a control. A helpful-looking escape hatch here is a standing offer to break the
    // law, and the only reliable way to keep it out is for it never to exist.
    for (const [name, source] of [['the rule', CHANGE], ['the session', MODEL], ['the view', VIEW]] as const) {
      expect(code(source), `${name} has an MRP escape hatch`)
        .not.toMatch(/overrideMrp|forcePrice|ignoreMrp|allowAboveMrp|skipPriceCheck/i);
    }
  });

  it('offers no approver panel for a refusal nothing can approve', () => {
    // `needsApproval` is what puts a name-picker on the screen. An MRP breach must never set it.
    const propose = code(CHANGE).slice(code(CHANGE).indexOf('export function proposePriceChange'));
    expect(propose).toMatch(/needsApproval: check\.verdict !== 'above_mrp'/);
  });

  it('reads the MRP in force TODAY, not the newest one on the record', () => {
    // A future MRP increase must not raise today's ceiling before the pack it is printed on has
    // reached the shelf. The customer is holding the old pack.
    const propose = code(MODEL).slice(code(MODEL).indexOf('proposePrice: (input)'));
    expect(propose).toMatch(/filter\(\(m\) => m\.effectiveFrom <= config\.today\)/);
  });
});

describe('a margin nobody can compute is not a margin that passed', () => {
  it('takes the cost as a register, never as a number that might be zero', () => {
    expect(code(CHANGE)).toMatch(/export type CostRegister/);
    expect(code(CHANGE)).toMatch(/cost: CostRegister/);
  });

  it('has no `?? 0` on a cost anywhere in the rule, the session or the payload', () => {
    // One character. It converts "nobody has told me what this cost" into "it cost nothing", and a
    // zero cost reports a 100% margin — which is a lie that reads as very good news.
    for (const [name, source] of [['the rule', CHANGE], ['the session', MODEL], ['the payload', SCREEN_DATA]] as const) {
      const found = [...code(source).matchAll(/(cost|Cost)\w*\s*\?\?\s*0\b/g)].map((m) => m[0]);
      expect(found, `${name} defaults a cost to zero`).toEqual([]);
    }
  });

  it('tripwire — the detector fires on the shape it exists to catch', () => {
    expect([...'const c = costMinor ?? 0;'.matchAll(/(cost|Cost)\w*\s*\?\?\s*0\b/g)]).toHaveLength(1);
  });

  it('serves only the products that HAVE a cost, rather than zero for the rest', () => {
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function cataloguePayload'));
    expect(builder).toMatch(/if \(product\.unitCostMinor !== undefined\)/);
  });

  it('turns an absent cost into a refusal that needs an approver', () => {
    expect(code(ENTRY)).toMatch(/known: false,\s*\n\s*why: `this screen has not been told what/);
    expect(PRICE_CHANGE_REFUSALS).toContain('the_cost_is_not_known_so_the_margin_was_never_checked');
  });

  it('shows a dash rather than a zero when it cannot work the floor out', () => {
    const limits = code(VIEW).slice(code(VIEW).indexOf('function renderLimits'));
    expect(limits).toMatch(/costMinor === undefined \|\| floorBps === undefined/);
    expect(limits).toMatch(/\? '—'/);
  });
});

describe('the limits are on the page before the price is typed', () => {
  it('has both of them in the shell, above the price field', () => {
    expect(HTML).toContain('id="mrp-value"');
    expect(HTML).toContain('id="floor-value"');
    expect(HTML.indexOf('id="price-limits"'), 'the limits sit below the price field')
      .toBeLessThan(HTML.indexOf('id="new-price"'));
  });

  it('fills them in as the item is typed, not after the price is submitted', () => {
    expect(code(VIEW)).toMatch(/el\('price-item'\)\.addEventListener\('input', renderLimits\)/);
  });
});

describe('a price change is a new entry, never an edit', () => {
  it('returns a fresh entry and never mutates the one it supersedes', () => {
    expect(code(CHANGE)).toMatch(/entry: \{ \.\.\.proposal\.draft, status: 'active' \}/);
    // No assignment into an existing entry anywhere in the file. `=(?!=)` so a comparison
    // (`e.status === 'active'`) does not read as a write — the first draft of this check did,
    // which would have made it fire on correct code and get deleted rather than believed.
    expect(code(CHANGE), 'an entry is written in place').not.toMatch(/\.status\s*=(?!=)/);
    expect(code(CHANGE), 'a price is written in place').not.toMatch(/\.price\s*=(?!=)/);
  });

  it('tripwire — the write detector fires on a real in-place assignment', () => {
    expect(/\.status\s*=(?!=)/.test("entry.status = 'active';")).toBe(true);
    expect(/\.status\s*=(?!=)/.test("if (entry.status === 'active') return;")).toBe(false);
  });

  it('withdraws by appending a rolled-back entry, never by deleting', () => {
    expect(code(CHANGE)).toMatch(/export function rollBackPrice/);
    expect(code(CHANGE)).toMatch(/status: 'rolled_back'/);
    for (const [name, source] of [['the rule', CHANGE], ['the session', MODEL]] as const) {
      expect(code(source), `${name} deletes a price entry`).not.toMatch(/deletePrice|removePrice|splice\(/);
    }
  });

  it('hands back a DRAFT, so a proposal left open prices nothing', () => {
    expect(code(CHANGE)).toMatch(/status: 'draft',/);
  });

  it('refuses a back-dated price, and nothing can authorise that either', () => {
    expect(code(CHANGE)).toMatch(/refusals\.push\('starts_in_the_past'\)/);
    const activate = code(CHANGE).slice(code(CHANGE).indexOf('export function activatePriceChange'));
    expect(activate).toMatch(/r === 'starts_in_the_past'/);
  });
});

describe('the completeness score is counts first, percentage second', () => {
  it('never renders a bare percentage without the counts beside it', () => {
    const parts = code(VIEW).slice(code(VIEW).indexOf('function scoreParts'));
    expect(parts).toMatch(/counts\.textContent/);
    expect(parts).toMatch(/percent\.textContent/);
    expect(parts).toMatch(/parts\.push\(percent, counts, bar\)/);
  });

  it('lists every outstanding check by name and by what is missing', () => {
    const parts = code(VIEW).slice(code(VIEW).indexOf('function scoreParts'));
    expect(parts).toMatch(/checks\.filter\(\(c\) => !c\.done\)/);
    expect(parts).toMatch(/check\.missing/);
  });

  it('rounds DOWN, so 99% never appears beside an outstanding required field', () => {
    expect(code(SCORE)).toMatch(/Math\.floor\(\(done \* 100\)/);
  });

  it('reports an unscoreable record as NOT KNOWABLE rather than zero', () => {
    // A zero reads as "somebody has filled in nothing" and sends a person to fix a finished record.
    expect(code(SCORE)).toMatch(/knowable: false/);
    expect(code(SCORE)).toMatch(/CategoryNotFoundError/);
    const list = code(VIEW).slice(code(VIEW).indexOf('function itemRow'));
    expect(list, 'an unscoreable record still shows a number').toMatch(/view\.score\.knowable\s*\n?\s*\?/);
  });

  it('takes its checks from the TENANT’s categories, never from a list of our own', () => {
    expect(code(SCORE)).toMatch(/category\?\.attributes \?\? \[\]/);
    expect(code(SCORE)).toMatch(/category\?\.regulated \?\? \[\]/);
  });
});

describe('every refusal has words, in both languages', () => {
  it('covers every price-change refusal the rule can return', () => {
    expectWordsFor(PRICE_CHANGE_REFUSALS, 'PRICE_REFUSAL_WORDS');
  });

  it('covers every publish refusal the session can return', () => {
    expectWordsFor(PUBLISH_REFUSAL_KINDS, 'PUBLISH_REFUSAL_WORDS');
  });

  it('has a sentence in both languages for every gap the entry can report', () => {
    expectWordsFor(CATALOGUE_GAPS, 'GAP_WORDS');
  });

  it('tripwire — the check fails when a member has no words', () => {
    expect(() => expectWordsFor([...PRICE_CHANGE_REFUSALS, 'invented'], 'PRICE_REFUSAL_WORDS')).toThrow();
  });
});

describe('separation of duties, on the screen and under it', () => {
  it('never offers the person setting the price as their own approver', () => {
    expect(code(VIEW)).toMatch(/approvers\(\)\.filter\(\(a\) => a !== me\(\)\)/);
  });

  it('strips them on the box too, not only on the screen that would offer them', () => {
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function cataloguePayload'));
    expect(builder).toMatch(/approvers: policy\.approvers\.filter\(\(who\) => who !== policy\.userId\)/);
  });

  it('and the rule refuses it regardless of what the screen offered', () => {
    const activate = code(CHANGE).slice(code(CHANGE).indexOf('export function activatePriceChange'));
    expect(activate).toMatch(/approval\.decidedBy === input\.setBy/);
  });

  it('makes a margin loss carry a written reason a person can read next year', () => {
    expect(code(VIEW)).toMatch(/reason\.length < 10/);
    expect(code(VIEW)).toMatch(/reasonNeeded/);
  });
});

describe('the screen keeps the house rules', () => {
  it('offers the save button only when the model says the price may be saved', () => {
    expect(code(VIEW)).toMatch(/el\('save-price'\)\.hidden = !\(proposal\.cleanToActivate \|\| proposal\.needsApproval\)/);
    expect(HTML).toMatch(/id="save-price"[^>]*hidden/);
  });

  it('asks its questions on the page, never with a browser dialog', () => {
    expect(code(VIEW)).not.toMatch(/\b(window\.)?(confirm|prompt|alert)\s*\(/);
  });

  it('does not fade its banner away on a timer', () => {
    expect(code(VIEW)).not.toMatch(/setTimeout|setInterval/);
  });

  it('reads the shop’s trading day rather than the device’s clock', () => {
    // A till whose date is a day out would otherwise activate tomorrow's price today.
    expect(code(ENTRY)).toMatch(/today: data\.today \?\? '1970-01-01'/);
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function cataloguePayload'));
    expect(builder).toMatch(/today: input\.tradingDay/);
  });

  it('is offered in Tamil as well as English, on every word it shows', () => {
    const en = [...code(VIEW).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]!);
    expect(en.length, 'no words were found at all').toBeGreaterThan(30);
    const ta = code(VIEW).slice(code(VIEW).indexOf('  ta: {'));
    for (const key of new Set(en)) {
      expect(ta, `"${key}" has no Tamil`).toMatch(new RegExp(`\\b${key}:`));
    }
  });

  it('keeps money in exact minor units and never a float', () => {
    expect(code(VIEW)).toMatch(/Math\.round\(Number\(/);
    expect(code(MODEL)).not.toMatch(/parseFloat/);
  });

  it('never merges a suspected duplicate — it only ever lists them', () => {
    // A merge is approved and reversible elsewhere (M03-FR-04), never a side-effect of looking.
    expect(code(MODEL), 'the session can merge').not.toMatch(/mergeProducts|\bmerge\(/);
    expect(code(VIEW), 'the view can merge').not.toMatch(/mergeProducts|\bmerge\(/);
  });
});

describe('the shelf map sequences the picker’s walk, and says when it did not', () => {
  const SHELF = code(readFileSync('packages/merchandising/src/shelf.ts', 'utf8'));
  const PICKER_VIEW = code(readFileSync('apps/picker-app/web/app.js', 'utf8'));
  const PICKER_HTML = readFileSync('apps/picker-app/web/index.html', 'utf8');

  it('is actually called by the box — it was written, tested and never used', () => {
    // `routeFor` existed and had unit tests from the day the module was written, and nothing
    // anywhere called it. Every wave was walked in whatever order the cloud sent, which on an
    // online grocery order is the order the customer typed: dairy, rice, back to dairy.
    expect(code(SCREEN_DATA)).toMatch(/map\.routeFor\(lines\)/);
    expect(code(SCREEN_DATA)).toMatch(/export function shelfMapFor/);
  });

  it('sorts by ZONE before position, so the chiller is collected when the store says', () => {
    // The zone comment claimed a picker collects chilled last since the day it was written, and
    // the sort never looked at it — the field was decoration and the milk was collected wherever
    // it happened to fall in aisle order.
    const route = SHELF.slice(SHELF.indexOf('routeFor<T extends'));
    const byZone = route.indexOf('zoneRank');
    const byPosition = route.indexOf('compareRoute');
    expect(byZone, 'the walk ignores the zone entirely').toBeGreaterThan(-1);
    expect(byPosition, 'the zone is compared but the position never is').toBeGreaterThan(byZone);
  });

  it('ships the zone order as a per-tenant setting with no default (OB-07)', () => {
    // The owner's answer is ambient → secure → chilled → frozen. It is SRE's answer, recorded as
    // SRE's setting — never a constant, because the next tenant has a different shop.
    const SETTINGS_SRC = code(readFileSync('packages/tenant/src/settings.ts', 'utf8'));
    expect(SETTINGS_SRC).toMatch(/PICK_ZONE_ORDER/);
    const setting = SETTINGS_SRC.slice(SETTINGS_SRC.indexOf('PICK_ZONE_ORDER'));
    expect(setting.slice(0, 260)).toMatch(/defaultValue: \[\] as readonly string\[\]/);
  });

  it('invents NO cold-chain order of its own', () => {
    // Which zones a shop has, how far apart they are and how long chilled goods may stand out are
    // questions about a licensed premises. Guessing is silent: the route looks sensible and the
    // milk is warm.
    expect(SHELF).not.toMatch(/zoneOrder\s*(\?\?|=)\s*\[/);
    expect(SHELF).toMatch(/if \(this\.zoneOrder === undefined\) return 0;/);
  });

  it('carries WHICH ordering was applied in the result, not only in a comment', () => {
    // The same discipline as the driver's route, which says whether a dispatcher wrote it by hand.
    // A picker who believes a list is sequenced when it is not walks it trusting nothing.
    expect(SHELF).toMatch(/export type WalkOrdering/);
    expect(code(SCREEN_DATA)).toMatch(/orderedBy: walk\.ordering/);
    expect(PICKER_VIEW).toMatch(/window\.pickerData\?\.orderedBy/);
    expect(PICKER_HTML).toContain('id="ordered-by"');
  });

  it('puts an unmapped line last, marks it, and never hides or drops it', () => {
    // Hiding it sends the picker back across the shop; dropping it loses the line.
    expect(SHELF).toMatch(/if \(a\.unmapped !== b\.unmapped\) return a\.unmapped \? 1 : -1;/);
    expect(PICKER_VIEW).toMatch(/line\.unmapped === true/);
    expect(PICKER_VIEW).toMatch(/line\.shelf \?\? line\.bin/);
  });

  it('refuses a second home for one product, on the rule and on the screen', () => {
    expect(SHELF).toMatch(/an item lives in exactly one place/);
    expect(code(MODEL)).toMatch(/it_already_lives_somewhere_else/);
    expectWordsFor(SHELF_REFUSAL_KINDS, 'SHELF_REFUSAL_WORDS');
  });

  it('drops one contradictory row rather than taking the whole map down', () => {
    // Refusing everything would report every product in the shop as unmapped, which reads as the
    // shelf data having been lost rather than as one bad row.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function shelfMapFor'));
    expect(builder).toMatch(/catch \{\s*\n\s*continue;/);
  });

  it('keeps shelf addresses as NUMBERS, so A9 sorts before A10', () => {
    // As text "A10" sorts before "A9" and the picker walks the aisle twice, never knowing why.
    expect(SHELF).toMatch(/readonly aisle: number;/);
    expect(SHELF).toMatch(/readonly position: number;/);
  });

  it('shows the walk on the maintenance screen, so the order can be SEEN changing', () => {
    expect(code(VIEW)).toMatch(/function renderShelf/);
    expect(code(VIEW)).toMatch(/session\.walk\(\)/);
    expect(HTML).toContain('id="walk-list"');
  });
});
