import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LOOKUP_REFUSAL_KINDS, REFUND_REFUSAL_KINDS } from '../../apps/web-erp/src/service-session';

/**
 * **The service desk, guarded — and the control that had never been fed.**
 *
 * `commitReturn` has enforced *a line is returned at most once* since the day it was written. It
 * enforces it against `alreadyReturnedMinor`, **supplied by the caller** — and outside one unit
 * test, nothing in this system ever supplied it. Every return in the running product was therefore
 * judged against *nothing already returned*: the same receipt could be refunded today, again
 * tomorrow, and again the day after, each refund passing a rule written specifically to stop it.
 *
 * It is the same shape as the uncounted shelf and the blank shrinkage report, in the one place
 * where it is money going out of the door rather than a wrong number on a screen.
 *
 * Six things must stay true, and this file keeps them true:
 *
 *   1. **the register is projected and passed in** — the guard is never handed a bare zero;
 *   2. **the goods rule and the money rule are both enforced**, because they catch different
 *      breaches and a discounted bill can pass one while failing the other;
 *   3. **a card refund is never called refunded** — the provider has not moved the money;
 *   4. **damaged goods do not re-enter sellable stock**;
 *   5. **nothing is committed under a name nobody holds**, and a material refund needs a second;
 *   6. **a line with nothing left is shown with the reason, never hidden** — the agent has to be
 *      able to answer "why not?".
 */

const MODEL = readFileSync('apps/web-erp/src/service-session.ts', 'utf8');
const REGISTER = readFileSync('packages/returns/src/return-register.ts', 'utf8');
const RETURNS = readFileSync('packages/returns/src/returns.ts', 'utf8');
const VIEW = readFileSync('apps/web-erp/web/service.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/service.html', 'utf8');
const ENTRY = readFileSync('apps/web-erp/src/browser-entry.ts', 'utf8');
const SCREEN_DATA = readFileSync('edge/store-edge/src/screen-data.ts', 'utf8');
const TILL_VIEW = readFileSync('apps/pos/web/app.js', 'utf8');

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

// ── 1. The guard is fed ─────────────────────────────────────────────────────

describe('the at-most-once rule is given something to check against', () => {
  it('passes what has ALREADY come back, rather than a bare zero', () => {
    // The whole defect in one field. `alreadyReturnedMinor: 0` on every line is a rule that
    // always passes, and it reads as perfectly reasonable code.
    const refund = code(MODEL).slice(code(MODEL).indexOf('refund: (request)'));
    expect(refund).toMatch(/alreadyReturnedMinor: known\?\.alreadyReturnedMinor \?\? 0/);
    // …and `known` comes from the projected register, not from the request.
    expect(refund).toMatch(/returnable\.find\(\(r\) => r\.productId === line\.productId\)/);
    expect(code(MODEL)).toMatch(/returnRegister\(ports\.returns\(\)\)/);
  });

  it('tripwire — the detector fires on the shape it exists to catch', () => {
    expect('          alreadyReturnedMinor: 0,').not.toMatch(/alreadyReturnedMinor: known\?\./);
  });

  it('projects the register from BOTH the box’s log and the cloud’s history', () => {
    // The cloud alone leaves the guard blind exactly when the line is down, which is when a shop
    // is least supervised. The box alone cannot see a return taken at another branch.
    expect(code(ENTRY)).toMatch(/\.\.\.\(data\?\.returnHistory \?\? \[\]\), \.\.\.local\.returns/);
    expect(code(REGISTER)).toMatch(/seen\.has\(record\.returnId\)/);
  });

  it('counts the same return once, so an overlap cannot refuse a legitimate second return', () => {
    const register = code(REGISTER).slice(code(REGISTER).indexOf('export function returnRegister'));
    expect(register).toMatch(/const seen = new Set<string>\(\)/);
    expect(register).toMatch(/seen\.add\(record\.returnId\)/);
  });

  it('aggregates by product rather than by line index', () => {
    // A bill can carry one product on two lines. Matching a return to a line INDEX would let
    // "line 2" be returned twice while "line 1" is untouched.
    const lines = code(REGISTER).slice(code(REGISTER).indexOf('export function returnableLines'));
    expect(lines).toMatch(/sold\.set\(line\.productId/);
    expect(lines).not.toMatch(/lineIndex|lineNumber|lines\[i\]/);
  });

  it('records WHAT came back on the event, not just how many lines', () => {
    // `lineCount: 2` cannot answer "how much of this line has already come back?", so nothing
    // downstream — the cloud included — could compute the figure the guard needs.
    const event = code(RETURNS).slice(code(RETURNS).indexOf("type: 'ReturnAccepted'"));
    expect(event).toMatch(/lines: input\.lines\.map/);
    expect(event).toMatch(/quantityMinor: Math\.abs\(line\.quantityMinor\)/);
  });

  it('never offers a negative quantity to return', () => {
    expect(code(REGISTER)).toMatch(/returnableMinor: Math\.max\(0,/);
    // …but the impossible case is surfaced rather than only clamped away.
    expect(code(REGISTER)).toMatch(/export function overReturned/);
    expect(code(MODEL)).toMatch(/overReturned/);
    expect(code(VIEW)).toMatch(/overreturned/);
  });
});

// ── 2. Goods and money are different rules ──────────────────────────────────

describe('the same money cannot go out twice either', () => {
  it('caps a refund at what is LEFT of the bill, not at the bill’s total', () => {
    // A discounted bill: return one item and refund ₹400, then another and refund ₹400. The LINE
    // rule is satisfied both times — different units — and ₹800 has gone out against ₹500.
    const refund = code(MODEL).slice(code(MODEL).indexOf('refund: (request)'));
    expect(refund).toMatch(/maxRefundMinor = found\.receipt\.refundableMinor/);
    expect(code(MODEL)).toMatch(/refundableMinor: Math\.max\(0, sale\.totalMinor - already\)/);
    expect(code(MODEL)).toMatch(/alreadyRefundedMinor\(sale\.saleId, ports\.refunds\(\)\)/);
  });

  it('keeps the two guards as two functions, so neither can be mistaken for the other', () => {
    expect(code(REGISTER)).toMatch(/export function returnRegister/);
    expect(code(REGISTER)).toMatch(/export function alreadyRefundedMinor/);
  });

  it('caps a no-receipt return by value, which is the only thing left to cap it by', () => {
    expect(code(MODEL)).toMatch(/no_receipt_over_the_cap/);
    expect(code(MODEL)).toMatch(/noReceiptCapMinor/);
  });

  it('takes every limit from the tenant, never from a constant in the code', () => {
    for (const setting of [
      'returnWindowDays', 'approvalThresholdMinor', 'noReceiptCapMinor',
      'agentAuthorityMinor', 'compensationCapMinor',
    ]) {
      expect(code(MODEL), `${setting} is not per-tenant`).toMatch(new RegExp(`readonly ${setting}: number`));
      expect(code(SCREEN_DATA), `${setting} is not served by the box`).toMatch(new RegExp(setting));
    }
  });
});

// ── 3. The truth about the money ────────────────────────────────────────────

describe('a card refund is not a refund yet', () => {
  it('never tells the customer a pending reversal has been refunded', () => {
    // The provider has to move it, and offline nobody has even asked. "Refunded" makes the shop
    // responsible for a promise it has not kept, and they come back angry in three days.
    const tell = code(MODEL).slice(code(MODEL).indexOf('export function tellTheCustomer'));
    expect(tell).toMatch(/refundStatus === 'settled'/);
    expect(tell).toMatch(/NOT back on the card yet/);
  });

  it('shows the model’s sentence rather than composing one in the view', () => {
    expect(code(VIEW)).toMatch(/outcome\.tellTheCustomer/);
  });

  it('does not reach a payment provider from a browser', () => {
    // A browser has no business holding a provider credential. The reversal belongs to the
    // service that can reach it; the desk records the refund as pending and queues it.
    expect(code(MODEL)).not.toMatch(/requestReversal|ReversalProvider/);
    expect(code(VIEW)).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/);
  });
});

// ── 4. Where the goods go ───────────────────────────────────────────────────

describe('damaged goods do not go back on the shelf', () => {
  it('offers every disposition, so "back on the shelf" is a choice and not a default', () => {
    for (const disposition of ['resell', 'quarantine', 'damaged', 'scrap']) {
      expect(code(VIEW), `${disposition} cannot be chosen`).toMatch(new RegExp(`${disposition}: \\{`));
    }
    expect(code(RETURNS)).toMatch(/resell: 'on_hand'/);
    expect(code(RETURNS)).toMatch(/scrap: null/);
  });

  it('has words for every disposition in both languages', () => {
    expectWordsFor(['resell', 'quarantine', 'damaged', 'scrap'], 'DISPOSITIONS');
  });
});

// ── 5. Who may do it ────────────────────────────────────────────────────────

describe('a refund carries a name, and a big one carries two', () => {
  it('commits nothing when the box does not know who is on the desk', () => {
    const refund = code(MODEL).slice(code(MODEL).indexOf('refund: (request)'));
    const guard = refund.indexOf('config.userId === null');
    expect(guard, 'the desk no longer checks who is asking').toBeGreaterThan(-1);
    // Before anything is looked up or committed.
    expect(guard).toBeLessThan(refund.indexOf('commitReturn('));
    expect(code(MODEL)).toMatch(/readonly userId: string \| null/);
    expect(code(ENTRY)).toMatch(/userId: data\.userId === undefined \? null : data\.userId/);
    // And it is said at the top of the screen, not discovered on refusal.
    expect(HTML).toMatch(/id="nobody"/);
    expect(code(VIEW)).toMatch(/nobodyNamed/);
  });

  it('gives no compensation under a name nobody holds either', () => {
    const compensate = code(MODEL).slice(code(MODEL).indexOf('compensate: (input)'));
    expect(compensate.indexOf('config.userId === null')).toBeGreaterThan(-1);
  });

  it('leaves the second-signature rule to the domain rather than re-deciding it here', () => {
    // A second, simpler authority check written at the surface is the one that drifts, and it
    // drifts in the direction of letting more through.
    expect(code(MODEL)).toMatch(/approvalThresholdMinor: config\.approvalThresholdMinor/);
    expect(code(MODEL)).toMatch(/agentAuthorityMinor: config\.agentAuthorityMinor/);
    expect(code(MODEL)).toMatch(/ApprovalRequiredError/);
    expect(code(MODEL)).not.toMatch(/refundMinor\s*>=?\s*config\.approvalThresholdMinor/);
  });

  it('has words for every refusal it can give, in both languages', () => {
    expect(REFUND_REFUSAL_KINDS.length).toBeGreaterThan(5);
    expectWordsFor(REFUND_REFUSAL_KINDS, 'REFUND_REFUSAL_WORDS');
    expectWordsFor(LOOKUP_REFUSAL_KINDS, 'LOOKUP_REFUSAL_WORDS');
  });
});

// ── 6. The desk can always answer "why not?" ────────────────────────────────

describe('a line that cannot come back says why, rather than disappearing', () => {
  it('renders a spent line greyed out with its reason, never filtered away', () => {
    const row = code(VIEW).slice(code(VIEW).indexOf('function lineRow'));
    expect(row).toMatch(/returnableMinor === 0/);
    expect(row).toMatch(/nothingLeft/);
    expect(row, 'a spent line is filtered out of the list').not.toMatch(/\.filter\(/);
    expect(HTML).toMatch(/\.row\.spent/);
  });

  it('shows what was bought, what came back and what is left — all three', () => {
    const row = code(VIEW).slice(code(VIEW).indexOf('function lineRow'));
    for (const part of ['sold', 'returned', 'left']) {
      expect(row, `the line does not show "${part}"`).toMatch(new RegExp(`t\\('${part}'\\)`));
    }
  });

  it('says how far outside the window a bill is, rather than "computer says no"', () => {
    expect(code(MODEL)).toMatch(/days old and this shop takes returns for/);
  });

  it('tells the desk when its SLA times are the product’s defaults, not the shop’s', () => {
    expect(code(MODEL)).toMatch(/targetsAreDefaults: policy === undefined/);
    expect(code(VIEW)).toMatch(/defaultsWarning/);
  });

  it('reports satisfaction WITH its response rate, never as a bare average', () => {
    // 4.8 from six replies out of four hundred cases is six people, and the six who reply are
    // rarely the ones who left quietly.
    expect(code(VIEW)).toMatch(/responseRateBps/);
    expect(code(VIEW)).toMatch(/no_responses/);
  });
});

// ── The screen itself ───────────────────────────────────────────────────────

describe('the desk the till has been sending people to', () => {
  it('exists, at the route the till names', () => {
    // The lane says "send the customer to the service desk". Until this build there was none.
    expect(TILL_VIEW).toMatch(/service desk/i);
    const server = readFileSync('edge/store-edge/src/screen-server.ts', 'utf8');
    expect(server).toMatch(/service: \{ dir: 'web-erp', file: 'service\.html' \}/);
    expect(code(SCREEN_DATA)).toMatch(/service: 'serviceData'/);
    expect(code(SCREEN_DATA)).toMatch(/service: servicePayload/);
  });

  it('is served every bill the box holds, not just today’s', () => {
    // A receipt from last Tuesday is the ordinary case and the reason the screen exists.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function servicePayload'));
    const scope = builder.slice(0, builder.indexOf('\nexport function', 1));
    expect(scope).toMatch(/for \(const sale of input\.sales\)/);
    expect(scope, 'the desk was given only today’s bills').not.toMatch(/salesOn\(input\.sales/);
  });

  it('serves the screen nothing at all without the shop’s own limits', () => {
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function servicePayload'));
    expect(builder.slice(0, 200)).toMatch(/if \(!input\.pack\.servicePolicy\.known\) return null;/);
  });

  it('opens with no network and says where the page came from', () => {
    expect(HTML).toMatch(/<!--SCREEN-DATA-->/);
    expect(code(VIEW)).toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
    expect(code(VIEW)).toMatch(/window\.shellCachedAt/);
    expect(HTML).toMatch(/id="stale"/);
  });

  it('never interrupts anybody with a browser dialog', () => {
    expect(code(VIEW)).not.toMatch(/\b(prompt|confirm|alert)\s*\(/);
    expect(code(VIEW)).toMatch(/function tell\(/);
  });

  it('is offered in Tamil everywhere it is offered in English', () => {
    const en = code(VIEW).slice(code(VIEW).indexOf('en: {'), code(VIEW).indexOf('ta: {'));
    const ta = code(VIEW).slice(code(VIEW).indexOf('ta: {'), code(VIEW).indexOf('};'));
    const keys = (block: string): string[] => [...block.matchAll(/(\w+):\s*['"]/g)].map((m) => m[1]!);
    expect(keys(en).length).toBeGreaterThan(30);
    expect(keys(ta).length).toBe(keys(en).length);
    for (const key of keys(en)) expect(ta, `"${key}" has no Tamil`).toMatch(new RegExp(`\\b${key}:`));
  });

  it('keeps money in integer paise, never a float', () => {
    const parse = code(VIEW).slice(code(VIEW).indexOf('function paise'));
    expect(parse.slice(0, 400)).not.toMatch(/parseFloat|Number\(cleaned\)\s*\*\s*100/);
    expect(parse).toMatch(/Number\(rupees \|\| '0'\) \* 100 \+ Number\(padded\)/);
  });
});
