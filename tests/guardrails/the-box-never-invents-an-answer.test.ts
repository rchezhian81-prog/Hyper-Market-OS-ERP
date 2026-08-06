import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCREENS, GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { APP_DIR, DATA_MARKER } from '../../edge/store-edge/src/screen-server';

/**
 * **The one-character rule, guarded on the box's side of the socket.**
 *
 * Six screens spent three sessions being built to distinguish *"there is nothing"* from *"I have
 * not been told"*. The manager's day close refuses the second and proceeds on the first, and that
 * is the whole reason a trading day cannot be locked on a page that never spoke to the store.
 *
 * All of it can be undone by `?? []` in one payload builder. It reads as tidy defaulting, it makes
 * every test pass, and it converts "the cloud has never mentioned approvals" into "no approvals are
 * waiting" — silently, at the one moment somebody is deciding whether to lock a day.
 *
 * So the shape is banned in the file that builds the payloads, and the ban is checked here.
 */

const SCREEN_DATA = readFileSync('edge/store-edge/src/screen-data.ts', 'utf8');
const STORE_PACK = readFileSync('edge/store-edge/src/store-pack.ts', 'utf8');
const READ_MODEL = readFileSync('edge/store-edge/src/read-model.ts', 'utf8');
const SCREEN_SERVER = readFileSync('edge/store-edge/src/screen-server.ts', 'utf8');
const EDGE_MAIN = readFileSync('edge/store-edge/src/main.ts', 'utf8');
const ROUTING = readFileSync('packages/fulfilment/src/routing.ts', 'utf8');

/** Comments discuss these on purpose, so only real code counts. */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('a missing section is never served as an empty one', () => {
  it('has no `?? []` or `?? {}` anywhere in the payload builders', () => {
    // The exact idiom, banned by name. Anything a section genuinely may default to is written as
    // an explicit branch with a comment saying why, so it has to be argued for rather than typed.
    const found = [...code(SCREEN_DATA).matchAll(/\?\?\s*(\[\]|\{\})/g)].map((m) => m[0]);
    expect(found).toEqual([]);
  });

  it('guards every optional section with `known` before it serves it', () => {
    // Each `payload['x'] = …` for a pack-derived section must sit under a `.known` check.
    const assignments = [...code(SCREEN_DATA).matchAll(/payload\['(\w+)'\]/g)].map((m) => m[1]!);
    expect(assignments).toContain('approvals');
    expect(assignments).toContain('tasks');
    for (const section of ['approvals', 'checklist', 'products']) {
      expect(code(SCREEN_DATA), `${section} is served without a known check`)
        .toMatch(new RegExp(`input\\.pack\\.${section}\\.known`));
    }
  });

  it('tripwire — the detector fires on the shape it exists to catch', () => {
    // Otherwise a regex that silently matched nothing would make the check above vacuous.
    const knownBad = "payload['approvals'] = input.pack.approvals.value ?? [];";
    expect([...knownBad.matchAll(/\?\?\s*(\[\]|\{\})/g)]).toHaveLength(1);
  });

  it('starts every section of an unheard-of pack as NOT KNOWN', () => {
    // `emptyPack()` is the state a freshly installed box is really in, and it must not be a
    // convenience shape that quietly answers zero to everything.
    const empty = code(STORE_PACK).slice(code(STORE_PACK).indexOf('export function emptyPack'));
    expect(empty).not.toMatch(/known\(\[\]\)|known\(\{\}\)/);
    expect((empty.match(/notKnown\(/g) ?? []).length).toBeGreaterThanOrEqual(9);
  });

  it('keeps a section the pack did not carry as NOT KNOWN when reading it', () => {
    expect(code(STORE_PACK)).toMatch(/raw\[name\] === undefined/);
    expect(code(STORE_PACK)).toMatch(/notKnown\(`the pack from the cloud carried no/);
  });
});

describe('the box never invents a figure it cannot work out', () => {
  it('excludes an uncostable sale rather than costing it at zero', () => {
    // Zero cost reports a 100% margin, which is a lie that reads as very good news and would be
    // believed. The sale is left out of the margin figures and counted instead.
    expect(code(READ_MODEL)).toMatch(/costable = false/);
    expect(code(READ_MODEL)).toMatch(/uncostableSales/);
    expect(code(READ_MODEL)).not.toMatch(/unitCostMinor\s*\?\?\s*0/);
  });

  it('names the products that caused it, for the person who can fix them', () => {
    expect(code(READ_MODEL)).toMatch(/productsWithoutCost/);
    expect(code(SCREEN_DATA)).toMatch(/products: day\.productsWithoutCost/);
  });

  it('still reports the takings, because the money came in either way', () => {
    expect(code(READ_MODEL)).toMatch(/takenMinor/);
  });

  it('says whether the loss-prevention rules were known, so empty is never read as clean', () => {
    // Zero exceptions with no rules is not a clean shop; it is a shop nobody is watching.
    expect(code(READ_MODEL)).toMatch(/rulesKnown/);
    expect(code(SCREEN_DATA)).toMatch(/if \(day\.rulesKnown\)/);
  });

  it('drops a record it cannot parse and counts it, rather than filling in the gaps', () => {
    expect(code(READ_MODEL)).toMatch(/unreadable \+= 1/);
    expect(code(SCREEN_DATA)).toMatch(/unreadableRecords > 0/);
  });
});

describe('the screens socket is loopback, and reads only', () => {
  it('binds to 127.0.0.1 and nothing else', () => {
    // The bind address is the entire security control, and this socket carries the day's takings,
    // the exception register and the price list. On the shop network, any phone could read them.
    expect(code(SCREEN_SERVER)).toMatch(/SCREEN_HOST = '127\.0\.0\.1'/);
    expect(code(SCREEN_SERVER)).toMatch(/server\.listen\(input\.port, SCREEN_HOST/);
    expect(code(SCREEN_SERVER)).not.toMatch(/0\.0\.0\.0|::/);
  });

  it('serves GET and refuses every other method', () => {
    expect(code(SCREEN_SERVER)).toMatch(/req\.method !== 'GET'/);
  });

  it('decodes a path before checking it, because %2e%2e is not .. until decoded', () => {
    const guard = code(SCREEN_SERVER).slice(code(SCREEN_SERVER).indexOf('export function safeFile'));
    const decode = guard.indexOf('decodeURIComponent');
    const check = guard.indexOf("startsWith('..')");
    expect(decode).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(decode);
  });

  it('escapes the payload so a product name cannot close the script element', () => {
    // A product name is text somebody typed into a spreadsheet and it reaches the page verbatim.
    expect(code(SCREEN_SERVER)).toMatch(/replace\(\/<\/g, '\\\\u003c'\)/);
  });

  it('sends no-store and refuses to be framed', () => {
    expect(code(SCREEN_SERVER)).toMatch(/'x-frame-options': 'DENY'/);
    expect(code(SCREEN_SERVER)).toMatch(/'cache-control': 'no-store'/);
  });
});

describe('the box and the screens cannot drift apart', () => {
  it('every screen has a folder, a global and a shell that carries the marker', () => {
    // Rename a global on one side and the screen silently gets nothing — which every screen would
    // then render, correctly and uselessly, as "I have been told nothing".
    for (const screen of SCREENS) {
      const dir = APP_DIR[screen];
      expect(dir, `${screen} has no app folder`).toBeTruthy();
      expect(GLOBAL_FOR[screen], `${screen} has no global`).toBeTruthy();

      const html = readFileSync(`apps/${dir}/web/index.html`, 'utf8');
      expect(html, `apps/${dir}/web/index.html has no data marker`).toContain(DATA_MARKER);

      // The marker must sit ABOVE the bundle: the bundle reads its global while it evaluates, and
      // a payload injected after it would arrive too late to be read at all.
      expect(html.indexOf(DATA_MARKER), `${screen}: marker is below the bundle`)
        .toBeLessThan(html.indexOf('.bundle.js'));
    }
  });

  it('the global each shell reads is the one the box writes', () => {
    // The lane socket once looked for `saleId` where the record carried `id`, and refused every
    // real sale. Same class of fault, checked rather than hoped for.
    for (const screen of SCREENS) {
      const entry = readFileSync(`apps/${APP_DIR[screen]}/src/browser-entry.ts`, 'utf8');
      expect(entry, `${screen}'s entry never reads window.${GLOBAL_FOR[screen]}`)
        .toMatch(new RegExp(`\\b${GLOBAL_FOR[screen]}\\b`));
    }
  });
});

describe('the box starts without a pack, and says so', () => {
  it('does not refuse to start when the pack is missing or unreadable', () => {
    // A box that would not boot over a report would take the lanes down with it (P-01).
    expect(code(EDGE_MAIN)).toMatch(/no store pack is configured/);
    expect(code(EDGE_MAIN)).toMatch(/could not be read/);
  });

  it('falls back to a pack that knows nothing, never to one that answers zero', () => {
    expect(code(EDGE_MAIN)).toMatch(/let pack: StorePack = emptyPack\(\)/);
  });

  it('rebuilds the day per request, so a screen is never shown the state at boot', () => {
    // A projection frozen at start-up reports a shop that has taken nothing all day.
    expect(code(EDGE_MAIN)).toMatch(/void reread\(\)/);
  });
});

describe('the route planner never loses a stop, and never claims a map', () => {
  it('says its distances are straight-line, in the RESULT and not only in a comment', () => {
    // There is no map here and no road network. Any screen that shows one of these distances has
    // to acknowledge which kind it is, so the fact travels with the plan.
    expect(code(ROUTING)).toMatch(/distancesAre: 'straight_line'/);
    expect(code(ROUTING)).toMatch(/readonly distancesAre: 'straight_line'/);
  });

  it('accounts for every order — routed or refused by name', () => {
    // A dropped stop is not an inefficiency; it is a customer who ordered, paid, waited and was
    // told nothing, and they find out by nothing arriving.
    expect(code(ROUTING)).toMatch(/accountedFor: routes\.reduce/);
    expect(code(ROUTING)).toMatch(/unplanned\.push/);
  });

  it('has no path that discards an order without recording it', () => {
    // Every `continue` in the triage and assignment loops must be preceded by an `unplanned.push`.
    // A bare `continue` is exactly how a stop disappears.
    const body = code(ROUTING).slice(code(ROUTING).indexOf('export function planDispatch'));
    const lines = body.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!/^\s*continue;/.test(line)) continue;
      const before = lines.slice(Math.max(0, i - 12), i).join('\n');
      expect(before, `a stop is dropped without a reason near line ${i}`).toMatch(/unplanned\.push|routable\.push|if \(carrying/);
    }
  });

  it('re-plans rather than patching when a driver goes off the road', () => {
    // Patching appends their stops to the end of another run in whatever order they were in, and
    // the last customer of the day pays for it.
    expect(code(ROUTING)).toMatch(/export function reassign/);
    expect(code(ROUTING)).toMatch(/return planDispatch\(/);
  });

  it('reuses the one distance function rather than adding a third', () => {
    // Two answers to "how far is that" is one of them being wrong, and the disagreement is only
    // found by the person driving it.
    expect(code(ROUTING)).toMatch(/import \{ metresBetween \}/);
    expect(code(ROUTING)).not.toMatch(/Math\.asin|6_371_000/);
  });

  it('plans on the BOX, so a dead router does not stop the vans', () => {
    expect(code(readFileSync('edge/store-edge/src/screen-data.ts', 'utf8'))).toMatch(/planDispatch\(/);
  });

  it('serves nothing rather than an empty route when it was told no orders', () => {
    const data = code(readFileSync('edge/store-edge/src/screen-data.ts', 'utf8'));
    expect(data).toMatch(/!input\.pack\.deliveries\.known/);
    expect(data).toMatch(/return null;/);
  });
});
