import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SHELF_COUNT_REFUSALS } from '../../packages/merchandising/src/index';
import { MERCHANDISING_GAPS } from '../../apps/web-erp/src/browser-entry';

/**
 * **The merchandising surface, guarded — and the fault that gated the whole build.**
 *
 * `planogramCompliance` was written and tested the day the module was created, and it needs one
 * thing nothing in this system had ever produced: how many of an item are on the shelf right now.
 * Its `state?.onShelfMinor ?? 0` therefore turned every **uncounted** facing into an **empty** one,
 * which is the loudest finding the function has — *the sale is being lost with the stock in the
 * building*. On day one, before anybody had counted anything, that fired for every product in the
 * shop and sent staff to full shelves.
 *
 * An alarm that goes off on everything is one people learn to ignore, and then it is worse than no
 * alarm at all. So four things must stay true, and this file keeps them true:
 *
 *   1. **an uncounted facing raises no task and is named as uncounted**, not as empty;
 *   2. **a stale count raises no task either** — acting on Tuesday's reading on Friday wastes a
 *      walk, and enough wasted walks and the whole list stops being believed;
 *   3. **the compliance figure is over the facings actually counted**, and the screen says how much
 *      of the plan that was, above the figure rather than under it;
 *   4. **the count is taken blind** — nothing on this surface returns what a facing should hold.
 */

const SHELF = readFileSync('packages/merchandising/src/shelf.ts', 'utf8');
const COUNT = readFileSync('packages/merchandising/src/shelf-count.ts', 'utf8');
const MODEL = readFileSync('apps/web-erp/src/merchandising-session.ts', 'utf8');
const VIEW = readFileSync('apps/web-erp/web/merchandising.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/merchandising.html', 'utf8');
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
  expect(vocabulary.length, `${mapName} guards nothing`).toBeGreaterThan(1);
  for (const member of vocabulary) {
    const at = words.indexOf(`${member}: {`);
    expect(at, `"${member}" has no words in ${mapName}`).toBeGreaterThan(-1);
    const entry = words.slice(at, words.indexOf('\n  },', at));
    expect(entry, `"${member}" has no English`).toMatch(/\ben:/);
    expect(entry, `"${member}" has no Tamil`).toMatch(/\bta:/);
  }
};

describe('an uncounted shelf never becomes a refill task', () => {
  it('has no `?? 0` on a shelf quantity anywhere in the rule', () => {
    // The exact idiom, banned by name. It is one character, it reads as tidy defaulting, and it
    // converts "nobody has looked at this" into "there is nothing there".
    const found = [...code(SHELF).matchAll(/onShelfMinor\s*\?\?\s*0/g)].map((m) => m[0]);
    expect(found, 'an uncounted facing defaults to empty again').toEqual([]);
  });

  it('tripwire — the detector fires on the shape it exists to catch', () => {
    expect([...'const onShelf = state?.onShelfMinor ?? 0;'.matchAll(/onShelfMinor\s*\?\?\s*0/g)])
      .toHaveLength(1);
  });

  it('names an unobserved facing as never counted, and continues before any task', () => {
    const compliance = code(SHELF).slice(code(SHELF).indexOf('export function planogramCompliance'));
    const guard = compliance.indexOf("finding: 'never_counted'");
    const task = compliance.indexOf('tasks.push');
    expect(guard, 'an unobserved facing is not named at all').toBeGreaterThan(-1);
    expect(task, 'a task can be raised before the unobserved check').toBeGreaterThan(guard);
    expect(compliance).toMatch(/if \(state === undefined\)/);
  });

  it('refuses to act on a count that is too old, against a per-tenant window', () => {
    // A shop that counts twice a day and one that counts on Sundays need different numbers.
    expect(code(SHELF)).toMatch(/last_counted_too_long_ago/);
    expect(code(SHELF)).toMatch(/readonly staleAfterMinutes: number/);
    expect(code(SHELF), 'the freshness window is hard-coded').not.toMatch(/staleAfterMinutes\s*\?\?\s*\d/);
  });

  it('requires every observation to say WHEN somebody looked', () => {
    // A shelf quantity is an observation, not a fact: it was true when somebody looked, and the
    // shop keeps selling afterwards.
    const state = code(SHELF).slice(code(SHELF).indexOf('export interface ShelfState'));
    expect(state.slice(0, 300)).toMatch(/readonly observedAt: string;/);
    expect(state.slice(0, 300), 'the timestamp is optional, so it can be omitted').not.toMatch(/observedAt\?:/);
  });

  it('treats an unreadable observation time as stale, which is the safe direction', () => {
    expect(code(SHELF)).toMatch(/!Number\.isFinite\(age\) \|\| age > staleAfterMs/);
  });
});

describe('the compliance figure never covers more than was counted', () => {
  it('divides by the OBSERVED facings, not by the plan', () => {
    // Folding uncounted facings in — as compliant or as breaches — produces a number somebody
    // would put on a wall, and somebody would.
    expect(code(SHELF)).toMatch(/complianceBp: observed === 0 \? 0 : Math\.round\(\(compliant \* 10_000\) \/ observed\)/);
  });

  it('reports 0% rather than 100% when nothing has been counted', () => {
    // An empty plan is not a compliant shop; it is an unchecked one.
    expect(code(SHELF)).toMatch(/observed === 0 \? 0 :/);
  });

  it('carries how many were NOT observed, and whether the whole plan was', () => {
    expect(code(SHELF)).toMatch(/readonly notObserved: number/);
    expect(code(SHELF)).toMatch(/readonly wholePlanObserved: boolean/);
    expect(code(MODEL)).toMatch(/wholePlanObserved: result\.wholePlanObserved/);
  });

  it('puts the coverage ABOVE the figure on the screen, not under it', () => {
    const render = code(VIEW).slice(code(VIEW).indexOf('function renderRefill'));
    const coverage = render.indexOf("coverageFigure.textContent");
    const compliance = render.indexOf('check.complianceBp');
    expect(coverage, 'the coverage line is never rendered').toBeGreaterThan(-1);
    expect(compliance, 'the compliance figure comes before the coverage').toBeGreaterThan(coverage);
  });

  it('says in words that a partial check says nothing about the rest of the shop', () => {
    expect(code(VIEW)).toMatch(/if \(!check\.wholePlanObserved\)/);
    expect(code(VIEW)).toMatch(/t\('meansLittle'\)/);
  });

  it('says WHY it cannot check at all rather than reporting a clean shop', () => {
    // Two different nothings, and they lead to different actions: address the shelves, or publish
    // a plan. "0 issues" would read as neither.
    expect(code(MODEL)).toMatch(/this_store_has_no_shelf_map/);
    expect(code(MODEL)).toMatch(/this_store_has_never_published_a_planogram/);
    expectWordsFor(['this_store_has_no_shelf_map', 'this_store_has_never_published_a_planogram'], 'NO_PLAN_WORDS');
  });
});

describe('the count is taken blind', () => {
  it('accepts no expected quantity, so none can leak back to the screen', () => {
    // What the facing should hold is the planogram's business, applied AFTER the count.
    const record = code(COUNT).slice(code(COUNT).indexOf('export function recordShelfCount'));
    const signature = record.slice(0, record.indexOf('): ShelfCountOutcome'));
    expect(signature).not.toMatch(/expected|capacity|target|planned|shouldHold/i);
  });

  it('exports nothing that returns what a facing should hold', () => {
    for (const [name, source] of [['the rule', COUNT], ['the session', MODEL]] as const) {
      expect(code(source), `${name} can answer "what should be here?"`)
        .not.toMatch(/expectedOnShelf|capacityFor|shouldHold/i);
    }
  });

  it('renders no expected quantity next to the counting field', () => {
    // Element ids, not prose: the section's own lead SAYS "you will not be shown what it should
    // be", and the first draft of this check fired on that sentence — a guardrail tripping on its
    // own explanation is one that gets deleted rather than believed.
    const counting = HTML.slice(HTML.indexOf('id="view-count"'), HTML.indexOf('id="view-refill"'));
    const ids = [...counting.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.filter((id) => /expect|capacity|target|planned/i.test(id))).toEqual([]);
    // And nothing renders one into that section either.
    const render = code(VIEW).slice(code(VIEW).indexOf('function renderCount'), code(VIEW).indexOf("el('save-count')"));
    expect(render).not.toMatch(/capacityMinor|expected/i);
    // …and it says out loud that it is not going to.
    expect(code(VIEW)).toMatch(/You will not be shown what it should be/);
  });

  it('offers the shelves as a list rather than a free-text box', () => {
    // A typo becomes a phantom facing that nobody ever counts and the report can never explain.
    expect(HTML).toMatch(/<select id="count-location">/);
    expect(code(COUNT)).toMatch(/this_shop_has_no_such_shelf/);
    expectWordsFor(SHELF_COUNT_REFUSALS, 'COUNT_REFUSAL_WORDS');
  });

  it('keeps counts append-only — a recount is a new observation', () => {
    // "We counted it at nine and again at two" is the record that explains a variance; overwriting
    // the nine o'clock reading destroys the only evidence of what changed in between.
    expect(code(COUNT)).toMatch(/export function latestCounts/);
    for (const [name, source] of [['the rule', COUNT], ['the session', MODEL], ['the view', VIEW]] as const) {
      expect(code(source), `${name} deletes or overwrites a count`)
        .not.toMatch(/deleteCount|removeCount|splice\(/);
    }
  });

  it('puts never-counted facings above long-ago ones on the worklist', () => {
    // Those are the facings the report can say NOTHING about, and a report that covers most of the
    // shop is one people trust for the whole shop.
    expect(code(COUNT)).toMatch(/a\.lastCountedAt === null\) !== \(b\.lastCountedAt === null/);
    expect(code(VIEW)).toMatch(/row\.lastCountedAt === null/);
  });
});

describe('a range drop never makes stock invisible', () => {
  it('reads the REAL on-hand rather than letting a screen guess zero', () => {
    // Zero is the dangerous default: it turns "route to clearance" into "delete", and the stock on
    // the shelf becomes invisible — uncounted, unreplenished, eventually written off.
    expect(code(MODEL)).toMatch(/onHandMinor: ports\.onHand\(\)\[input\.productId\] \?\? 0/);
    // …and it is the port's real answer, not a figure the view passed in.
    const drop = code(MODEL).slice(code(MODEL).indexOf('drop: (input)'));
    expect(drop.slice(0, 900), 'the on-hand comes from the form').not.toMatch(/input\.onHand/);
  });

  it('has no delete on this surface at all', () => {
    expect(code(MODEL)).not.toMatch(/deleteRange|removeFromRange|purge/i);
  });

  it('says the engine’s own refusal rather than a reworded second version', () => {
    expect(code(VIEW)).toMatch(/tell\(t\('read'\), outcome\.detail\)/);
  });

  it('offers only the reasons the engine accepts', () => {
    expect(code(VIEW)).toMatch(/const DROP_REASONS/);
    for (const reason of ['poor_sales', 'supplier_discontinued', 'replaced_by_alternative']) {
      expect(code(VIEW), `${reason} is not offered`).toMatch(new RegExp(`\\b${reason}:`));
    }
  });
});

describe('a space figure is never quoted without its denominator', () => {
  it('says a ratio is not meaningful rather than returning zero', () => {
    // "0 sales per sq ft" and "we never measured this area" lead to opposite decisions.
    const space = code(readFileSync('packages/merchandising/src/space.ts', 'utf8'));
    expect(space).toMatch(/kind: 'not_meaningful'/);
    expect(code(VIEW)).toMatch(/ratio\.kind === 'per_sq_ft' \? inr\(ratio\.minorPerSqFt\) : t\('notMeaningful'\)/);
  });

  it('ranks by margin per square foot, and the screen says why', () => {
    expect(code(VIEW)).toMatch(/t\('marginPerSqFt'\)/);
    expect(code(VIEW)).toMatch(/Margin, not turnover/);
  });
});

describe('what the box did not say is said', () => {
  it('has a sentence in both languages for every gap the entry can report', () => {
    expectWordsFor(MERCHANDISING_GAPS, 'GAP_WORDS');
  });

  it('counts an absent planogram as a gap, because the check then refuses outright', () => {
    expect(code(ENTRY)).toMatch(/data\.planogram === null\) gaps\.push\('what_should_be_on_each_shelf'\)/);
  });

  it('serves the screen nothing at all without the tenant’s own thresholds', () => {
    // A screen inventing a refill level would be deciding when a shelf is empty enough to walk to.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function merchandisingPayload'));
    expect(builder).toMatch(/if \(!input\.pack\.merchandisingPolicy\.known\) return null;/);
  });

  it('serves the box’s own clock and trading day, never the tablet’s', () => {
    // A device a day out would judge every count as stale — or a three-day-old one as fresh.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function merchandisingPayload'));
    expect(builder).toMatch(/today: input\.tradingDay/);
    expect(builder).toMatch(/now: input\.now/);
  });
});

describe('the screen keeps the house rules', () => {
  it('asks its questions on the page, never with a browser dialog', () => {
    expect(code(VIEW)).not.toMatch(/\b(window\.)?(confirm|prompt|alert)\s*\(/);
  });

  it('does not fade its banner away on a timer', () => {
    expect(code(VIEW)).not.toMatch(/setTimeout|setInterval/);
  });

  it('is offered in Tamil as well as English, on every word it shows', () => {
    const en = [...code(VIEW).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]!);
    expect(en.length, 'no words were found at all').toBeGreaterThan(30);
    const ta = code(VIEW).slice(code(VIEW).indexOf('  ta: {'));
    for (const key of new Set(en)) {
      expect(ta, `"${key}" has no Tamil`).toMatch(new RegExp(`\\b${key}:`));
    }
  });

  it('declares a touch target big enough for somebody holding a tablet in an aisle', () => {
    expect(HTML).toMatch(/--tap: 5\dpx/);
  });
});
