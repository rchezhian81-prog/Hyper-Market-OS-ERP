import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLOSE_REFUSAL_KINDS, REOPEN_REFUSAL_KINDS } from '../../apps/web-erp/src/finance-session';
import { buildControlTotals, closePeriod } from '../../packages/period-close/src/index';

/**
 * **The month close, guarded — and the producer that never existed.**
 *
 * The roadmap's acceptance for M23 is one sentence: *a CA can sign the control totals.*
 * `validateControlTotals` compares both sides exactly and `closePeriod` refuses on any difference.
 * Both were written and tested the day the module was created, and **neither was ever given a
 * control total**, because nothing in this system built one. The gap analysis said so in as many
 * words for weeks: *no month can close yet.*
 *
 * Now that one exists, four things must stay true, and each of them is a way a month could close
 * on nothing while looking perfectly reconciled:
 *
 *   1. **the two sides are computed independently** — if both came from the postings they would
 *      always agree and the whole check would be theatre;
 *   2. **only a posting the accounts ACCEPTED counts as received** — counting a queued one makes
 *      both sides the same number computed twice;
 *   3. **no ledger side means no comparison**, and no comparison is never "everything agrees";
 *   4. **a refused posting blocks the close and is never discarded**, and a closed month is
 *      append-only.
 */

const TOTALS = readFileSync('packages/period-close/src/control-totals.ts', 'utf8');
const PERIOD = readFileSync('packages/period-close/src/period.ts', 'utf8');
const MODEL = readFileSync('apps/web-erp/src/finance-session.ts', 'utf8');
const VIEW = readFileSync('apps/web-erp/web/finance.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/finance.html', 'utf8');
const ENTRY = readFileSync('apps/web-erp/src/browser-entry.ts', 'utf8');
const SCREEN_DATA = readFileSync('edge/store-edge/src/screen-data.ts', 'utf8');

const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

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

const posting = (over: Record<string, unknown> = {}) => ({
  postingId: 'P-1', idempotencyKey: 'k-1', period: '2026-07', journalRef: 'SALES-001',
  debitMinor: 100_00, creditMinor: 100_00, state: 'posted', attempts: 1,
  queuedAt: '2026-07-31T23:00:00.000Z', ...over,
});
const PREFIXES = { takings: 'SALES', tax: 'GST', refunds: 'REFUND' } as const;
const LEDGER = { takingsMinor: 100_00, taxMinor: 0, refundsMinor: 0, billCount: 4 };

// ── 1 & 2. Two sides, and only what was accepted ────────────────────────────

describe('the two sides of a control total are genuinely two sides', () => {
  it('counts only postings the accounts ACCEPTED', () => {
    // The failure this file exists for: count a queued posting as received and both sides become
    // the same number computed twice, so the month closes with the accounts empty.
    const built = code(TOTALS).slice(code(TOTALS).indexOf('export function buildControlTotals'));
    expect(built).toMatch(/input\.postings\.filter\(\(p\) => p\.state === 'posted'\)/);
  });

  it('proves it: a queued posting moves neither side', () => {
    const queued = buildControlTotals({
      period: '2026-07', ledger: LEDGER, postings: [posting({ state: 'queued' })] as never,
      journalPrefixes: PREFIXES,
    });
    expect(queued.find((t) => t.name === 'Takings')?.postedMinor).toBe(0);

    const dead = buildControlTotals({
      period: '2026-07', ledger: LEDGER, postings: [posting({ state: 'dead_lettered' })] as never,
      journalPrefixes: PREFIXES,
    });
    expect(dead.find((t) => t.name === 'Takings')?.postedMinor).toBe(0);
  });

  it('never derives the ledger side from the postings', () => {
    // If both sides came from the same place they would always agree and the check is theatre.
    const built = code(TOTALS).slice(code(TOTALS).indexOf('export function buildControlTotals'));
    expect(built).toMatch(/ledgerMinor: input\.ledger\.takingsMinor/);
    expect(built, 'the ledger side is computed from the postings').not.toMatch(/ledgerMinor: sumFor/);
  });

  it('states how EACH side was derived, so a CA can re-derive it', () => {
    const totals = buildControlTotals({
      period: '2026-07', ledger: LEDGER, postings: [posting()] as never, journalPrefixes: PREFIXES,
    });
    for (const total of totals) {
      expect(total.method.length, `${total.name} does not say where it came from`).toBeGreaterThan(20);
    }
  });

  it('raises a posting it cannot classify rather than leaving it out', () => {
    const totals = buildControlTotals({
      period: '2026-07', ledger: LEDGER,
      postings: [posting({ journalRef: 'MISC-9', debitMinor: 7_00 })] as never,
      journalPrefixes: PREFIXES,
    });
    expect(totals.find((t) => t.name === 'Postings nobody can classify')?.postedMinor).toBe(7_00);
  });

  it('takes the shop’s own chart-of-accounts headings, never a constant', () => {
    expect(code(TOTALS)).toMatch(/journalPrefixes: Readonly<Record<'takings' \| 'tax' \| 'refunds', string>>/);
    expect(code(MODEL)).toMatch(/readonly journalPrefixes: Readonly<Record<'takings' \| 'tax' \| 'refunds', string>>/);
    expect(code(SCREEN_DATA)).toMatch(/journalPrefixes: policy\.journalPrefixes/);
  });
});

// ── 3. No comparison is not agreement ───────────────────────────────────────

describe('a month cannot close on nothing at all', () => {
  it('has no totals rather than an empty list when the shop has not said what it took', () => {
    // An empty list of totals reconciles vacuously — nothing disagreed because nothing was
    // compared — and `closePeriod` over it would find no blocker and close the month.
    expect(code(MODEL)).toMatch(/readonly totals: readonly ControlTotalResult\[\] \| undefined/);
    expect(code(MODEL)).toMatch(/the_shop_has_not_told_us_what_it_took/);
    const view = code(MODEL).slice(code(MODEL).indexOf('const view = ()'));
    expect(view).toMatch(/allReconcile: validated\?\.allReconcile \?\? false/);
  });

  it('tripwire — an empty list of totals really does reconcile vacuously', () => {
    // Proof the guard above is load-bearing rather than defensive decoration.
    const result = closePeriod({
      period: '2026-07', tenantId: 't1', totals: [],
      deadLetteredCount: 0, unsentSyncCount: 0, openExceptionCount: 0,
      tradingDayCutoff: '02:00', closedBy: 'u', at: '2026-08-01T00:00:00.000Z',
    });
    expect(result.closed, 'closePeriod no longer closes on an empty list — update this guard')
      .toBe(true);
  });

  it('refuses BEFORE calling closePeriod, not after', () => {
    const close = code(MODEL).slice(code(MODEL).indexOf('close: () =>'));
    expect(close.indexOf('built === undefined')).toBeLessThan(close.indexOf('closePeriod('));
  });

  it('never defaults the ledger side to a zeroed one', () => {
    // A ledger of noughts would read as a reconciliation failure when the truth is that nobody
    // told this screen what the shop took — two different problems with two different fixes.
    expect(code(ENTRY)).toMatch(/ledger: \(\) => data\?\.ledger,/);
    expect(code(ENTRY)).not.toMatch(/ledger: \(\) => data\?\.ledger \?\?/);
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function financePayload'));
    expect(builder).toMatch(/if \(input\.pack\.financeLedger\.known\) payload\['ledger'\]/);
  });

  it('serves the screen nothing at all without the shop’s own headings', () => {
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function financePayload'));
    expect(builder.slice(0, 200)).toMatch(/if \(!input\.pack\.financePolicy\.known\) return null;/);
  });
});

// ── 4. Outstanding work, and append-only ────────────────────────────────────

describe('what is outstanding blocks the close, and is never discarded', () => {
  it('reports the queue BESIDE the totals, never inside them', () => {
    expect(code(MODEL)).toMatch(/posted: postedSide\(postings\)/);
    const built = code(TOTALS).slice(code(TOTALS).indexOf('export function buildControlTotals'));
    expect(built, 'the queue was folded into a total').not.toMatch(/pendingMinor|deadLetteredMinor/);
  });

  it('lists every refused posting in full, with the reason the accounts gave', () => {
    expect(code(MODEL)).toMatch(/deadLettered: deadLetters\(postings\)/);
    expect(code(VIEW)).toMatch(/posting\.lastFailure/);
    // Nothing on this screen can throw one away (hard rule #6).
    expect(code(VIEW)).not.toMatch(/\b(delete|discard|purge|remove)Dead/i);
  });

  it('blocks the close on a refused posting, unsent sales and open exceptions', () => {
    expect(code(PERIOD)).toMatch(/'dead_lettered_postings'/);
    expect(code(PERIOD)).toMatch(/'unsent_sync_items'/);
    expect(code(PERIOD)).toMatch(/'open_exceptions'/);
    expect(code(MODEL)).toMatch(/unsentSyncCount: ports\.unsentSyncCount\(\)/);
  });

  it('returns EVERY blocker at once, not one per attempt', () => {
    // A finance team meeting obstacles one at a time on the last day of the month starts looking
    // for a way round the system, and finds one.
    expect(code(PERIOD)).toMatch(/readonly blockers: readonly \{ readonly kind: CloseBlocker/);
    const close = code(PERIOD).slice(code(PERIOD).indexOf('export function closePeriod'));
    expect(close, 'the close returns on the first blocker').not.toMatch(/return \{[^}]*closed: false[^}]*\};\s*\n\s*if \(/);
  });

  it('needs a different person to reopen, and a reason', () => {
    const reopen = code(MODEL).slice(code(MODEL).indexOf('reopen: (input)'));
    expect(reopen).toMatch(/input\.approvedBy === config\.userId/);
    expect(reopen).toMatch(/needs_a_reason/);
    expect(reopen).toMatch(/§28/);
  });

  it('offers reopening on the SCREEN, so the control is not worked around', () => {
    // A capability the session has and the screen does not is the fault this codebase keeps
    // finding. It is shown only once the month is actually closed.
    expect(HTML).toMatch(/id="reopen"/);
    expect(code(VIEW)).toMatch(/session\.reopen\(/);
    expect(code(VIEW)).toMatch(/el\('reopen-box'\)\.hidden = !session\.period\(\)\.closed/);
  });

  it('closes and reopens nothing under a name nobody holds', () => {
    expect(code(MODEL)).toMatch(/readonly userId: string \| null/);
    for (const fn of ['close: () =>', 'reopen: (input)']) {
      const body = code(MODEL).slice(code(MODEL).indexOf(fn));
      expect(body.indexOf('config.userId === null'), `${fn} does not check who is asking`)
        .toBeGreaterThan(-1);
    }
    expect(code(ENTRY)).toMatch(/userId: data\.userId === undefined \? null : data\.userId/);
    expect(HTML).toMatch(/id="nobody"/);
  });
});

// ── The screen a CA reads ───────────────────────────────────────────────────

describe('the screen somebody puts their name to', () => {
  it('shows BOTH sides of every figure, not one number and a verdict', () => {
    const row = code(VIEW).slice(code(VIEW).indexOf('function totalRow'));
    expect(row).toMatch(/total\.ledgerMinor/);
    expect(row).toMatch(/total\.postedMinor/);
    expect(row).toMatch(/total\.method/);
    expect(HTML).toMatch(/\.sides/);
  });

  it('says agrees or does not agree in words, not by colour alone', () => {
    const row = code(VIEW).slice(code(VIEW).indexOf('function totalRow'));
    expect(row).toMatch(/t\('agrees'\)/);
    expect(row).toMatch(/t\('doesNotAgree'\)/);
  });

  it('produces the pack even when it does not reconcile, marked NOT signable', () => {
    // Hiding it would only mean the conversation happens later.
    expect(code(PERIOD)).toMatch(/NOT complete for the period/);
    expect(code(VIEW)).toMatch(/pack\.signable/);
  });

  it('has words for every refusal and every blocker, in both languages', () => {
    expectWordsFor(CLOSE_REFUSAL_KINDS, 'CLOSE_REFUSAL_WORDS');
    expectWordsFor(REOPEN_REFUSAL_KINDS, 'REOPEN_REFUSAL_WORDS');
    expectWordsFor(
      ['control_totals_do_not_reconcile', 'dead_lettered_postings', 'unsent_sync_items', 'open_exceptions', 'already_closed'],
      'BLOCKER_WORDS',
    );
  });

  it('opens with no network and says where the page came from', () => {
    expect(HTML).toMatch(/<!--SCREEN-DATA-->/);
    expect(code(VIEW)).toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
    expect(code(VIEW)).toMatch(/window\.shellCachedAt/);
  });

  it('never interrupts anybody with a browser dialog', () => {
    expect(code(VIEW)).not.toMatch(/\b(prompt|confirm|alert)\s*\(/);
    expect(code(VIEW)).toMatch(/function tell\(/);
  });

  it('is offered in Tamil everywhere it is offered in English', () => {
    const en = code(VIEW).slice(code(VIEW).indexOf('en: {'), code(VIEW).indexOf('ta: {'));
    const ta = code(VIEW).slice(code(VIEW).indexOf('ta: {'), code(VIEW).indexOf('};'));
    const keys = (block: string): string[] => [...block.matchAll(/(\w+):\s*['"]/g)].map((m) => m[1]!);
    expect(keys(en).length).toBeGreaterThan(25);
    expect(keys(ta).length).toBe(keys(en).length);
    for (const key of keys(en)) expect(ta, `"${key}" has no Tamil`).toMatch(new RegExp(`\\b${key}:`));
  });
});
