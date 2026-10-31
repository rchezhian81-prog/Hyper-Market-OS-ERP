import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FINANCE_MONTH_COPY, MONTH_COPY_KEYS } from '../../apps/web-erp/src/finance-session';
import { buildControlTotals, closePeriod } from '../../packages/period-close/src/index';
import { closePeriod as headOfficeClosePeriod } from '../../services/finance/src/index';
import { MONTH_PAGE_COPY, MONTH_PAGE_KEYS } from '../../apps/web-erp/src/month-close-session';
import { bilingualGaps } from '../../packages/ui/src/index';

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
 *
 * And one more, since ADR-0024 (audit PA-03): **a month is closed and reopened at head office, by two
 * people** — the closer asks, someone who may sign a month approves it in their own session, and the
 * close names that approval. No name typed on any screen is ever taken as a signature or an approval.
 * Since OB-567 (owner, 31 Oct 2026) those steps live ONLY on head office's Month-end page
 * (`month-close-session.ts`, `finance-close.html|.js`), where head office's own control totals decide —
 * and a month with nothing checked is refused there, by head office. The Finance page has neither step.
 */

const TOTALS = readFileSync('packages/period-close/src/control-totals.ts', 'utf8');
const PERIOD = readFileSync('packages/period-close/src/period.ts', 'utf8');
const MODEL = readFileSync('apps/web-erp/src/finance-session.ts', 'utf8');
const VIEW = readFileSync('apps/web-erp/web/finance.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/finance.html', 'utf8');
const ENTRY = readFileSync('apps/web-erp/src/browser-entry.ts', 'utf8');
const SCREEN_DATA = readFileSync('edge/store-edge/src/screen-data.ts', 'utf8');
/** OB-567: where a month is closed and reopened — head office's Month-end page. */
const MONTH = readFileSync('apps/web-erp/src/month-close-session.ts', 'utf8');
const ME_VIEW = readFileSync('apps/web-erp/web/finance-close.js', 'utf8');
const ME_HTML = readFileSync('apps/web-erp/web/finance-close.html', 'utf8');
const ROUTE = readFileSync('services/finance/src/index.ts', 'utf8');

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
    const at = code(MODEL).indexOf('const close = (): CloseOutcome =>');
    expect(at, 'the local check is missing from the model').toBeGreaterThan(-1);
    const close = code(MODEL).slice(at);
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

  it('closes only with a signature someone else GAVE at head office, for exactly this month — on the Month-end page', () => {
    // ADR-0024 · §28: the close names the closer's own APPROVED `period_close` request, found in head office's
    // inbox for exactly `{ period }` — never a name, never the closer's own say-so.
    const close = code(MONTH).slice(code(MONTH).indexOf('closeWithApproval: async (period)'));
    expect(close).toMatch(/findOwnApproval\(\(\) => ports\.approvalInbox\(\), PERIOD_CLOSE_KIND, period, periodCloseDetails\(period\), null\)/);
    expect(close).toMatch(/ports\.closeAtHeadOffice\(\{ period, approvalId: found\.requestId \}\)/);
    expect(close.indexOf('before(period)')).toBeLessThan(close.indexOf('findOwnApproval('));
  });

  it('a month with NOTHING checked is refused by head office at the close — the page never decides it on a guess', () => {
    // The Month-end page holds no copy of the shop's takings, so the month is judged where the figures are: the route
    // passes head office's OWN control totals to the engine at that moment, and an empty list is refused by name.
    const route = code(ROUTE).slice(code(ROUTE).indexOf("path: '/v1/finance/periods/:period/close'"));
    expect(route).toMatch(/checks: await deps\.controlTotals\(ctx\.tenantId, period\)/);
    expect(headOfficeClosePeriod({ period: '2026-07', checks: [], closedBy: 'u-owner', postedBy: [], signedBy: 'u-acct' }))
      .toMatchObject({ ok: false, refusedBecause: 'nothing_was_checked' });
    // …and that refusal reads in plain words on the page, never as success.
    expect(FINANCE_MONTH_COPY.en.hoNothingChecked).toMatch(/no figures to check for this month, so it cannot be signed/);
    expect(code(MONTH)).not.toMatch(/ledger|controlTotals|allReconcile/);
  });

  it('reopens only with a DIFFERENT person\'s own approval, for exactly the written reason', () => {
    const reopen = code(MONTH).slice(code(MONTH).indexOf('reopenWithApproval: async (period, reason)'));
    expect(reopen).toMatch(/findOwnApproval\(\(\) => ports\.approvalInbox\(\), PERIOD_REOPEN_KIND, period, periodReopenDetails\(why, period\), null\)/);
    expect(reopen).toMatch(/reason: why, approvalId: found\.requestId/);
    const before = code(MONTH).slice(code(MONTH).indexOf('const beforeReopening'));
    expect(before).toMatch(/needs_why/);
    expect(before).toMatch(/not_closed/);
  });

  it('takes no typed name as a signature or an approval — anywhere on the screen', () => {
    // The typed "Who is approving it (not you)" box is gone, and nothing the screen sends names a second person.
    expect(HTML).not.toMatch(/reopen-approver/);
    expect(HTML, 'a text box someone could type a name into').not.toMatch(/<input/);
    expect(code(VIEW)).not.toMatch(/approvedBy|reopen-approver/);
    expect(code(MODEL)).not.toMatch(/readonly approvedBy: string \}/);
    const steps = code(ME_VIEW).slice(code(ME_VIEW).indexOf('const mw = '), code(ME_VIEW).indexOf('const TABS'));
    expect(steps.length).toBeGreaterThan(500);
    expect(steps).not.toMatch(/approvedBy|signedBy|reopen-approver/);
    expect(code(MONTH)).not.toMatch(/approvedBy:\s*(input|name|typed)|signedBy/);
    expect(ME_HTML).not.toMatch(/reopen-approver|signer-name/);
    // The bodies are built by the same functions the approval's details come from.
    expect(code(ENTRY)).toMatch(/periodCloseRequestBody\(approvalId\)/);
    expect(code(ENTRY)).toMatch(/periodReopenRequestBody\(reason, approvalId\)/);
  });

  it('OB-567: the Finance page closes and reopens NO month — it says both happen on head office\'s Month-end page, and links there', () => {
    // The owner (31 Oct 2026): a month is closed only on head office's Month-end page — and reopened there too, so both
    // live in one place. The Finance page keeps the month's state and its Tally files, and offers no step of its own.
    expect(HTML).not.toMatch(/id="ask-close"|id="close-month"|id="close-why"|id="close-request"|id="ask-reopen"|id="reopen"|id="reopen-reason"/);
    expect(code(VIEW)).not.toMatch(/askToClose|closeWithApproval|askToReopen|reopenWithApproval|yourRequests/);
    expect(code(MODEL)).not.toMatch(/askToClose|closeWithApproval|askToReopen|reopenWithApproval|closeAtHeadOffice|reopenAtHeadOffice/);
    expect(HTML).toMatch(/<a id="month-end-link"[^>]*href="\.\.\/finance-close\/"/);
    expect(code(VIEW)).toMatch(/closeLead: 'A month is closed and reopened on head office’s Month-end page, not on this page\./);
    expect(code(VIEW)).toMatch(/closeLead: 'மாதம் தலைமை அலுவலகத்தின் மாத இறுதி பக்கத்தில் மூடப்பட்டு மீண்டும் திறக்கப்படுகிறது/);
    expect(code(VIEW)).toMatch(/el\('month-end-link'\)\.textContent = t\('monthEndLink'\)/);
  });

  it('offers closing and reopening on the Month-end SCREEN, so the control is not worked around', () => {
    // A capability the session has and the screen does not is the fault this codebase keeps finding.
    for (const id of ['ask-close', 'close-month', 'close-why', 'ask-reopen', 'reopen', 'reopen-reason']) expect(ME_HTML).toMatch(new RegExp(`id="${id}"`));
    for (const call of ['month.askToClose(', 'month.closeWithApproval(', 'month.askToReopen(', 'month.reopenWithApproval(']) expect(code(ME_VIEW)).toContain(call);
    // Which step shows is head office's own word on the month; only a holder of the month-close word is offered either.
    expect(code(ME_VIEW)).toMatch(/\$\('close-box'\)\.hidden = !\(offer && !monthState\.closed\)/);
    expect(code(ME_VIEW)).toMatch(/\$\('reopen-box'\)\.hidden = !\(offer && monthState\.closed\)/);
    expect(code(ENTRY)).toMatch(/mayClose: \(closeViewer\.permissions \?\? \[\]\)\.includes\(MONTH_CLOSE_PERMISSION\)/);
    expect(code(MONTH)).toMatch(/MONTH_CLOSE_PERMISSION = 'finance\.period\.close'/);
  });

  it('asks, closes and reopens ONLY on a click — never at load — and the page sends no write of its own', () => {
    const view = code(ME_VIEW);
    for (const call of ['month.askToClose(', 'month.closeWithApproval(', 'month.askToReopen(', 'month.reopenWithApproval(']) {
      const at = view.indexOf(call);
      expect(view.indexOf(call, at + 1), `${call} is called twice`).toBe(-1);
      const before = view.slice(Math.max(0, at - 220), at);
      expect(before, `${call} is not inside a click handler`).toMatch(/addEventListener\('click', \(\) => busy\(\$\('[a-z-]+'\), async \(\) => \{/);
    }
    expect(view).not.toMatch(/\bfetch\(/);
    expect(code(VIEW)).not.toMatch(/\bfetch\(/);
  });

  it('wires the Month-end page to head office\'s own month routes; the Finance page only to its reads', () => {
    expect(code(ENTRY)).toMatch(/bootFinance\(browserWindow\.financeData, FINANCE_HEAD_OFFICE\)/);
    expect(code(ENTRY)).toMatch(/createMonthCloseSession\([\s\S]{0,200}MONTH_CLOSE_HEAD_OFFICE,/);
    expect(code(ENTRY)).toMatch(/\/v1\/finance\/periods\/\$\{encodeURIComponent\(period\)\}\/close/);
  });

  it('closes and reopens nothing under a name nobody holds', () => {
    expect(code(MODEL)).toMatch(/readonly userId: string \| null/);
    const close = code(MODEL).slice(code(MODEL).indexOf('const close = (): CloseOutcome =>'));
    expect(close.slice(0, 400)).toContain('config.userId === null');
    expect(code(MONTH).slice(code(MONTH).indexOf('const before = '), code(MONTH).indexOf('const before = ') + 400)).toContain('config.userId === null');
    expect(code(ENTRY)).toMatch(/userId: closeViewer\.userId \?\? null/);
    expect(code(ENTRY)).toMatch(/userId: data\.userId === undefined \? null : data\.userId/);
    expect(HTML).toMatch(/id="nobody"/);
    expect(ME_HTML).toMatch(/id="nobody"/);
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
    // Every close / reopen outcome is said by the model's presenters (tested, both languages); the Month-end page shows
    // them (OB-567), with its own words in both languages too.
    expect(bilingualGaps(FINANCE_MONTH_COPY, MONTH_COPY_KEYS)).toEqual({ en: [], ta: [] });
    expect(bilingualGaps(MONTH_PAGE_COPY, MONTH_PAGE_KEYS)).toEqual({ en: [], ta: [] });
    for (const [action, kind] of [['close', 'Ask'], ['close', 'Use'], ['reopen', 'Ask'], ['reopen', 'Use']]) {
      expect(code(ME_VIEW)).toMatch(new RegExp(`month\\.present${kind}Outcome\\(lang, '${action}'`));
    }
    expectWordsFor(
      ['control_totals_do_not_reconcile', 'dead_lettered_postings', 'unsent_sync_items', 'open_exceptions', 'already_closed'],
      'BLOCKER_WORDS',
    );
  });

  it('opens with no network and says where the page came from', () => {
    expect(HTML).toMatch(/<!--SCREEN-DATA-->/);
    expect(code(VIEW)).toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
    // The strip is the ERP chrome's (Stage G slice 5a): the page loads it, the chrome reads the stamp.
    expect(HTML).toMatch(/<script type="module" src="\.\/sre-chrome\.js"><\/script>/);
    expect(readFileSync('apps/web-erp/web/sre-chrome.js', 'utf8')).toMatch(/window\.shellCachedAt/);
  });

  it('never interrupts anybody with a browser dialog', () => {
    expect(code(VIEW)).not.toMatch(/\b(prompt|confirm|alert)\s*\(/);
    expect(code(ME_VIEW)).not.toMatch(/\b(prompt|confirm|alert)\s*\(/);
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
