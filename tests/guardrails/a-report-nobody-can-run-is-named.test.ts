import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PRODUCED, RUN_REFUSAL_KINDS } from '../../apps/web-erp/src/reporting-session';
import { REPORTS, reportCatalogue } from '../../packages/reporting/src/index';

/**
 * **The reporting surface, guarded — and the fault that nearly shipped inside it.**
 *
 * This screen exists because of one sentence: *"Waste this month: ₹0"* is a number somebody puts in
 * a board pack, and nobody reading it can tell it apart from a real one. So a report this shop
 * cannot produce is **listed and refused by name**, never run and returned as nought.
 *
 * The first cut of it judged that on the shop's records alone — and seventeen of D13's reports have
 * no code behind them here. A tenant who started recording stock counts would have opened
 * *Shrinkage*, satisfied every stated need, and been handed a page with no figures and no rows on
 * it, under the report's real name, with a real as-at stamp on nothing. An empty shrinkage report
 * reads as **no shrinkage**. That is the exact fault the screen was built to prevent, reintroduced
 * one level up from where it was being watched for.
 *
 * So five things must stay true, and this file keeps them true:
 *
 *   1. **a report is runnable only when the shop records it AND this build computes it**, and the
 *      list of what this build computes is checked against the code that computes it;
 *   2. **the two gaps are told apart** — the shop's to fix, and ours — because only one of them is
 *      something the person reading the screen can act on;
 *   3. **a report that cannot be run is listed, never hidden**, and says which;
 *   4. **an absent figure says why in the space where the number would have been** — never a zero,
 *      never a blank;
 *   5. **a field nobody declared never leaves the building**, and the export runs the SAME
 *      default-deny check that guards the action.
 */

const MODEL = readFileSync('apps/web-erp/src/reporting-session.ts', 'utf8');
const CATALOGUE = readFileSync('packages/reporting/src/catalogue.ts', 'utf8');
const VIEW = readFileSync('apps/web-erp/web/reporting.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/reporting.html', 'utf8');
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

// ── 1. Recorded by the shop AND computed by this build ──────────────────────

describe('a report opens with figures on it, or does not open at all', () => {
  it('claims exactly the reports it has a producer for, in both directions', () => {
    // A `case` missing from `PRODUCED` hides a working report, which is a nuisance. An id in
    // `PRODUCED` with no `case` opens a blank one, which is the fault. Both are caught here.
    const body = code(MODEL).slice(code(MODEL).indexOf('const produce ='), code(MODEL).indexOf('  const entries ='));
    const cases = [...body.matchAll(/^\s{6}case '([a-z_]+)':/gm)].map((m) => m[1]!);
    expect(cases.length, 'the producer switch was not found at all').toBeGreaterThan(5);
    expect([...cases].sort()).toEqual([...PRODUCED].sort());
  });

  it('names only real reports in the list of what it can produce', () => {
    for (const id of PRODUCED) {
      expect(REPORTS.some((r) => r.id === id), `PRODUCED names "${id}", which is not a report`).toBe(true);
    }
  });

  it('throws rather than returning an empty dashboard for a report with no producer', () => {
    // The shape that was there: `default: return { figures: [], rows: [] }`. It is one line, it
    // reads as a tidy fallback, and it serves nothing under a real report's name.
    const tail = code(MODEL).slice(code(MODEL).indexOf('const produce ='));
    const fallback = tail.slice(tail.indexOf('default:'), tail.indexOf('  const entries ='));
    expect(fallback, 'the producer falls back to an empty dashboard again')
      .not.toMatch(/return\s*\{\s*figures:\s*\[\s*\],\s*rows:\s*\[\s*\]\s*\}/);
    expect(fallback).toMatch(/throw new Error/);
  });

  it('tripwire — the detector fires on the shape it exists to catch', () => {
    const knownBad = "      default:\n        return { figures: [], rows: [] };";
    expect(knownBad).toMatch(/return\s*\{\s*figures:\s*\[\s*\],\s*rows:\s*\[\s*\]\s*\}/);
  });

  it('makes the build half a REQUIRED argument, not an optional one', () => {
    // Optional would default to "assume this build can compute anything", which is the same
    // optimistic absence in a friendlier costume — and it would be got wrong by omission.
    expect(code(CATALOGUE)).toMatch(/export function availability\([\s\S]*?produced: readonly string\[\],\s*\): Availability/);
    expect(code(CATALOGUE)).toMatch(/export function reportCatalogue\([\s\S]*?produced: readonly string\[\],\s*\)/);
    expect(code(CATALOGUE)).not.toMatch(/produced\?:/);
  });

  it('proves it end to end: a shop recording everything still cannot run everything', () => {
    const all = [...new Set(REPORTS.flatMap((r) => r.needs))];
    const catalogue = reportCatalogue(all, PRODUCED);
    expect(catalogue.filter((e) => e.availability.available)).toHaveLength(PRODUCED.length);
    expect(catalogue.length).toBeGreaterThan(PRODUCED.length);
  });

  it('never puts a report this build cannot compute on the owner’s backlog', () => {
    // He would do the work the screen asked for, open the report, and find it blank.
    expect(code(CATALOGUE).slice(code(CATALOGUE).indexOf('export function whatWouldUnlockMost')))
      .toMatch(/\.filter\(\(report\) => produced\.includes\(report\.id\)\)/);
  });
});

// ── 2. Two gaps, two owners ─────────────────────────────────────────────────

describe('the shop is never blamed for our gap, or the other way round', () => {
  it('carries which of the two it is, rather than one flat "not available"', () => {
    expect(code(CATALOGUE)).toMatch(/readonly blockedBy: Blocker/);
    expect(code(CATALOGUE)).toMatch(/'the_shop_does_not_record_it'/);
    expect(code(CATALOGUE)).toMatch(/'this_version_cannot_produce_it'/);
  });

  it('asks nothing of a shop that has already done its part', () => {
    // `missing` is what the shop must start recording. On our gap there is nothing to name, and a
    // producer listed there would send somebody to record something they already record.
    const ours = code(CATALOGUE).slice(code(CATALOGUE).indexOf("blockedBy: 'this_version_cannot_produce_it'"));
    expect(ours.slice(0, 200)).toMatch(/missing: \[\]/);
  });

  it('refuses with a distinct code the view has distinct words for', () => {
    expect(RUN_REFUSAL_KINDS).toContain('this_version_cannot_produce_that_yet');
    expect(RUN_REFUSAL_KINDS).toContain('this_shop_does_not_record_that_yet');
    expectWordsFor(RUN_REFUSAL_KINDS, 'RUN_REFUSAL_WORDS');
  });

  it('shows the two apart on the screen, not by colour alone', () => {
    // Colour is how they differ at a glance; the sentence under each is how they differ to the one
    // man in twelve who cannot tell the two borders apart.
    expect(code(VIEW)).toMatch(/blockedBy === 'this_version_cannot_produce_it'/);
    expect(HTML).toMatch(/\.row\.ours/);
    expect(code(VIEW)).toMatch(/entry\.availability\.why/);
  });

  it('does not read an empty backlog as "every report works"', () => {
    // True today for this shop: everything the nine producers need is already recorded, and
    // seventeen reports are still unrunnable. "Nothing else needs recording" would be a lie.
    expect(code(VIEW)).toMatch(/nothingYouCanDo/);
    const en = code(VIEW).slice(code(VIEW).indexOf('en: {'), code(VIEW).indexOf('ta: {'));
    expect(en).toMatch(/nothingYouCanDo:.*waiting on us/);
  });
});

// ── 3. Listed, never hidden ─────────────────────────────────────────────────

describe('a report nobody can run is on the screen anyway', () => {
  it('lists every report D13 names, whatever the shop records', () => {
    expect(reportCatalogue([], PRODUCED)).toHaveLength(REPORTS.length);
    expect(reportCatalogue([...new Set(REPORTS.flatMap((r) => r.needs))], PRODUCED)).toHaveLength(REPORTS.length);
  });

  it('gives them a section of their own in the shell, not a footnote', () => {
    expect(HTML).toMatch(/id="view-blocked"/);
    expect(HTML).toMatch(/id="tab-blocked"/);
    expect(HTML).toMatch(/id="blocked-list"/);
  });

  it('renders the blocked list rather than filtering it away', () => {
    const render = code(VIEW).slice(code(VIEW).indexOf('function renderCatalogue'));
    expect(render).toMatch(/const blocked = all\.filter\(\(e\) => !e\.availability\.available\)/);
    expect(render).toMatch(/el\('blocked-list'\)\.replaceChildren/);
  });

  it('says which fact is missing in the shop’s own words, not as tables', () => {
    for (const entry of reportCatalogue([], PRODUCED)) {
      if (entry.availability.available) continue;
      expect(entry.availability.why).not.toMatch(/stream|table|producer|_events|null|undefined/);
      expect(entry.availability.why.length).toBeGreaterThan(20);
    }
  });
});

// ── 4. Absent, never zero, never blank ──────────────────────────────────────

describe('a figure that cannot be worked out says so where the number would be', () => {
  it('puts the reason in the value slot, not beside it', () => {
    const box = code(VIEW).slice(code(VIEW).indexOf('function figureBox'));
    expect(box).toMatch(/value\.className = 'value none'/);
    // The reason is the value's own text, in one string with the label — not appended to some
    // other element where it can be styled small and skimmed past.
    expect(box).toMatch(/value\.textContent = `\$\{t\('notAvailable'\)\}[^`]*\$\{f\.notAvailableBecause\}`/);
    // And the branch is taken on the value being absent, not on it being falsy — a real ₹0 taken
    // on a quiet morning is a fact, and it must print as ₹0.00.
    expect(box).toMatch(/f\.valueMinor === undefined/);
    expect(box).not.toMatch(/!f\.valueMinor/);
  });

  it('stamps every figure with the moment it was true', () => {
    // Structural in `figure()`; this keeps the screen's own helper from routing around it.
    const at = code(MODEL).slice(code(MODEL).indexOf('const at = ('), code(MODEL).indexOf('const byKey'));
    expect(at).toMatch(/asAt: config\.now/);
    // The value is spread in only when it exists, so an absent one cannot arrive as a zero.
    expect(at).toMatch(/valueMinor === undefined \? \{\} : \{ valueMinor \}/);
  });

  it('shows the as-at in words as well as in colour, on every figure', () => {
    const box = code(VIEW).slice(code(VIEW).indexOf('function figureBox'));
    expect(box).toMatch(/asat\.textContent/);
    expect(box).toMatch(/STALENESS_WORDS/);
  });

  it('has words for every staleness state, in both languages', () => {
    expectWordsFor(['live', 'lagging', 'stale'], 'STALENESS_WORDS');
  });

  it('never turns an unknown basket size into a basket of nothing', () => {
    // Zero is a real basket size a shop can have, so an unknown one must not arrive as one.
    expect(code(SCREEN_DATA)).toMatch(/lines === undefined \? \{\} : \{ units: basketUnits\(lines\) \}/);
    expect(code(MODEL)).toMatch(/Bills with no readable lines/);
  });

  it('costs a sold line ONCE, in the read model, and not again in the payload', () => {
    // The copy that lived here divided by a thousand unconditionally, which is right for weighed
    // goods and wrong for everything countable. It reported a margin of 99.92% on a real cost
    // price — the exact "100% margin reads as very good news" lie, arrived at from the other side.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function reportingPayload'));
    expect(builder).toMatch(/cogs \+= lineCostMinor\(unit, line\)/);
    expect(builder, 'the payload works the cost out for itself again').not.toMatch(/quantityMinor\) \/ 1000/);

    // And the one implementation branches on the UOM, which is the thing the copy dropped.
    const read = readFileSync('edge/store-edge/src/read-model.ts', 'utf8');
    const helper = code(read).slice(code(read).indexOf('export function lineCostMinor'));
    expect(helper.slice(0, 300)).toMatch(/uom === 'kg' \|\| line\.uom === 'g'/);
  });

  it('tripwire — the detector fires on the shape it exists to catch', () => {
    expect('        cogs += Math.round((unit * line.quantityMinor) / 1000);')
      .toMatch(/quantityMinor\) \/ 1000/);
  });
});

// ── 5. Nothing undeclared leaves, and the same lock guards the door ─────────

describe('an export cannot widen itself, and cannot skip the permission check', () => {
  it('refuses the whole file when a report produces a column nobody declared', () => {
    // Dropping it quietly gives somebody a narrower file they reconcile against and cannot explain.
    const exp = code(MODEL).slice(code(MODEL).indexOf('export: (reportId)'));
    expect(exp).toMatch(/undeclaredColumns\(rows, declared\)/);
    expect(exp).toMatch(/undeclared\.length > 0/);
    expect(exp).toMatch(/return \{\s*\n?\s*ok: false/);
  });

  it('never derives the column list from the rows it happens to have', () => {
    expect(code(MODEL)).not.toMatch(/Object\.keys\(rows\[0\]\)/);
    expect(code(CATALOGUE)).toMatch(/readonly columns\?: readonly ReportColumn\[\]/);
  });

  it('hands the shop’s OWN access control to the exporter, not a list of strings', () => {
    // A second, simpler permission check written here is the one that drifts, and it drifts in the
    // direction of letting more out.
    expect(code(MODEL)).toMatch(/access\(\): AccessControl/);
    expect(code(MODEL)).toMatch(/exportDomain\(spec, rows, ports\.access\(\), context\)/);
    expect(code(MODEL)).toMatch(/AccessDeniedError/);
    expect(code(ENTRY)).toMatch(/new AccessControl\(/);
  });

  it('asks for a permission named per family, so roles can be written at all', () => {
    expect(code(MODEL)).toMatch(/requires: exportPermission\(entry\.report\)/);
    expect(code(CATALOGUE)).toMatch(/return `reporting\.\$\{report\.family\}\.export`/);
  });

  it('writes nothing out under a name nobody holds', () => {
    // The audit record of an export names who took the data and is the only evidence of it
    // afterwards. A default id there would pass or fail the check on a made-up person, and on the
    // day somebody asks who exported the customer list the answer would be a word this code chose.
    expect(code(MODEL)).toMatch(/readonly userId: string \| null;/);
    const exp = code(MODEL).slice(code(MODEL).indexOf('export: (reportId)'));
    const guard = exp.indexOf('userId === null');
    expect(guard, 'the export no longer checks that the box knows who is asking').toBeGreaterThan(-1);
    // Before the report is even looked up: it is not a permission failure and must not read as one.
    expect(guard).toBeLessThan(exp.indexOf('entries()'));
    expect(exp).toMatch(/has not been told who is using this screen/);

    // And nothing downstream re-invents it.
    expect(code(ENTRY)).not.toMatch(/userId: data\.userId \?\? 'report/);
    expect(code(ENTRY)).toMatch(/userId: data\.userId === undefined \? null : data\.userId/);
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function reportingPayload'));
    expect(builder).toMatch(/if \(policy\.userId !== undefined\) payload\['userId'\] = policy\.userId;/);
  });

  it('tripwire — the detector fires on the shape it exists to catch', () => {
    expect("      userId: data.userId ?? 'reporting',").toMatch(/userId: data\.userId \?\? 'report/);
  });
});

// ── One trading day, not every day the box has ever seen ────────────────────

describe('a figure about today is about today', () => {
  it('slices the log to the trading day in every builder that means "today"', () => {
    // `sales.log` is append-only and never rotated, so `input.sales` is every sale this box has
    // ever committed. Handing that to a builder that means today is a defect that compounds
    // daily and never announces itself: the owner's phone reported the WEEK's takings as the
    // day's, and the manager's exception register — which the day close gates on — counted a
    // refund from last Tuesday against today's limit, so a clean day could not be closed.
    for (const builder of ['managerPayload', 'ownerPayload', 'reportingPayload']) {
      const body = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf(`export function ${builder}`));
      const end = body.indexOf('\nexport function', 1);
      const scope = end === -1 ? body : body.slice(0, end);
      expect(scope, `${builder} does not slice the log to one trading day`)
        .toMatch(/salesOn\(input\.sales, input\.tradingDay\)/);
      // And nothing inside it still costs, counts or judges the whole log.
      expect(scope, `${builder} still reads the whole log as today`)
        .not.toMatch(/(costTheDay|activityFrom)\(input\.sales/);
    }
  });

  it('tripwire — the detector fires on the shape it exists to catch', () => {
    expect('  const day = costTheDay(input.sales, products);').toMatch(/(costTheDay|activityFrom)\(input\.sales/);
    expect('  const day = exceptionsFor(activityFrom(input.sales), rules);').toMatch(/(costTheDay|activityFrom)\(input\.sales/);
  });

  it('keeps the whole log where the whole log is the right answer', () => {
    // The range check asks "has this shop EVER sold something it does not range?", and an item
    // that sold last Tuesday is exactly as much evidence as one that sold this morning. Slicing
    // it to today would be the same mistake in the other direction.
    const merch = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function merchandisingPayload'));
    expect(merch.slice(0, merch.indexOf('\nexport function', 1))).toMatch(/for \(const sale of input\.sales\)/);
  });

  it('puts a sale with no trading day in nobody’s figures, and names it', () => {
    // Including it puts another day's money in today's takings; dropping it silently loses real
    // takings from a total somebody reconciles against the till roll.
    const read = readFileSync('edge/store-edge/src/read-model.ts', 'utf8');
    const helper = code(read).slice(code(read).indexOf('export function salesOn'));
    expect(helper.slice(0, 400)).toMatch(/tradingDay === undefined.*undated \+= 1/s);
    expect(code(SCREEN_DATA)).toMatch(/edge:undated-sales/);
    expect(code(SCREEN_DATA)).toMatch(/undatedSales/);
  });

  it('never measures today against a day the box does not hold', () => {
    // A comparison against a day that is not there reports the shop as having doubled overnight,
    // against a nought nobody put in. And a future-dated sale from a lane with a wrong clock must
    // not become "the day before" — hence strictly earlier, not merely "the next one down".
    const cmp = code(MODEL).slice(code(MODEL).indexOf("case 'day_on_day'"));
    expect(cmp).toMatch(/d\.tradingDay < config\.tradingDay/);
    expect(cmp).toMatch(/no earlier trading day/);
    expect(code(ENTRY), 'the day list is defaulted somewhere else').not.toMatch(/dayTotals: \(\) => data\?\.dayTotals \?\? \[\{/);
  });

  it('reports what sells by department in UNITS, because the log has no money per line', () => {
    // Rebuilding department revenue from list prices makes a bill with a promotion on it produce
    // a department total that does not add up to the day's takings. A figure that NEARLY
    // reconciles is worse than one that is honestly a count.
    const report = REPORTS.find((r) => r.id === 'units_by_category')!;
    expect(report.answers).toMatch(/how many items/);
    expect(report.columns?.map((c) => c.name)).toEqual(['department', 'units']);
    expect(report.needs).toContain('departments_on_the_catalogue');
    // An item the catalogue places nowhere is counted apart, never folded into a department.
    expect(code(MODEL)).toMatch(/Items in no department/);
    expect(code(SCREEN_DATA)).toMatch(/unitsWithNoCategory/);
  });
});

// ── The box, and the screen it feeds ────────────────────────────────────────

describe('the box tells this screen the truth, including that it knows nothing', () => {
  it('serves the screen nothing at all rather than inventing staleness thresholds', () => {
    // A screen deciding for itself how old a number may be before somebody should stop making
    // decisions on it is a screen deciding that on its own authority.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function reportingPayload'));
    expect(builder.slice(0, 200)).toMatch(/if \(!input\.pack\.reportingPolicy\.known\) return null;/);
  });

  it('guards every optional section with a known check before serving it', () => {
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function reportingPayload'));
    for (const section of ['reportingRecords', 'roles', 'roleAssignments']) {
      expect(builder, `${section} is served without a known check`)
        .toMatch(new RegExp(`if \\(input\\.pack\\.${section}\\.known\\)`));
    }
  });

  it('carries NO cost rather than a zero cost for a basket it cannot price', () => {
    // Zero cost reports a 100% margin, which is a lie that reads as very good news.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function reportingPayload'));
    expect(builder).toMatch(/costable \? \{ cogsMinor: cogs \} : \{\}/);
  });

  it('opens with no network and says where the page came from', () => {
    expect(HTML).toMatch(/<!--SCREEN-DATA-->/);
    expect(code(VIEW)).toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
    expect(code(VIEW)).toMatch(/window\.shellCachedAt/);
    expect(HTML).toMatch(/id="stale"/);
  });

  it('never interrupts anybody with a browser dialog', () => {
    // They stop the page, they cannot be read in Tamil, and they cannot be tested.
    expect(code(VIEW)).not.toMatch(/\b(prompt|confirm|alert)\s*\(/);
    expect(code(VIEW)).toMatch(/function tell\(/);
  });

  it('is offered in Tamil everywhere it is offered in English', () => {
    const en = code(VIEW).slice(code(VIEW).indexOf('en: {'), code(VIEW).indexOf('ta: {'));
    const ta = code(VIEW).slice(code(VIEW).indexOf('ta: {'), code(VIEW).indexOf('};'));
    // Every key, including the second and third on a shared line — matching only the first per
    // line is how a word gets added in English and quietly never translated.
    const keys = (block: string): string[] => [...block.matchAll(/(\w+):\s*'/g)].map((m) => m[1]!);
    expect(keys(en).length).toBeGreaterThan(30);
    expect(keys(ta).length).toBe(keys(en).length);
    for (const key of keys(en)) expect(ta, `"${key}" has no Tamil`).toMatch(new RegExp(`\\b${key}:`));
  });
});
