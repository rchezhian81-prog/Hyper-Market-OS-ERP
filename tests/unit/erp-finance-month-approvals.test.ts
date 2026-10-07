import { describe, it, expect, afterEach } from 'vitest';
import {
  createFinanceSession, monthName, monthOutcomeOfRefusal, periodCloseDetails, periodCloseRequestBody,
  periodReopenDetails, periodReopenRequestBody, presentMonthAsk, presentMonthUse,
  FINANCE_MONTH_COPY, MONTH_COPY_KEYS, MONTH_REFUSAL_CODES, PERIOD_CLOSE_KIND, PERIOD_REOPEN_KIND,
  type FinanceConfig, type FinancePorts, type MonthActionResult, type MonthAskOutcome, type MonthUseOutcome,
} from '../../apps/web-erp/src/finance-session';
import type { ApprovalAsk, ApprovalRequestView, AskResult, InboxRead } from '../../apps/web-erp/src/approvals-session';
import { APPROVAL_REFUSAL_CODES } from '../../apps/web-erp/src/catalogue-session';
import { bootFinance, FINANCE_HEAD_OFFICE } from '../../apps/web-erp/src/browser-entry';
import { actionDetails, fingerprintOf, takeApproval, type ApprovalState } from '../../services/identity/src/approval-requests';
import { bilingualGaps } from '../../packages/ui/src/index';
import type { QueuedPosting } from '../../packages/period-close/src/index';

/**
 * **A month is closed and reopened at head office, by two people (M23-FR-04 · ADR-0024 · §28 · audit PA-03).**
 *
 * The Finance screen used to "close" a month in the browser alone — nothing reached head office — and reopened one on
 * an approver's name TYPED into a box. A name in a box is not anybody's approval. Now:
 *
 *   1. the closer, seeing this screen's local evidence say the figures can be signed, presses **Ask for the
 *      signature**: head office's engine records a `period_close` request for exactly this month (`{ period }`);
 *   2. someone who may sign a month (the accountant, the CA) approves or rejects it on their own Approvals page;
 *   3. **Close the month** finds the closer's OWN APPROVED request for this month and posts the close naming it — and
 *      when it is not asked, waiting, rejected, expired or used, says so in plain words (English and Tamil) and sends
 *      nothing. Head office's own refusals (not signed, signer posted into the month, figures that do not agree…)
 *      read in plain words too.
 *
 * Reopening is the same (`period_reopen`, details `{ reason, period }`), for exactly the written reason. With no head
 * office behind the page, nothing is closed or reopened — and nobody's name is accepted anywhere.
 */

const PERIOD = '2026-09';
const NOW = '2026-10-07T05:00:00.000Z';
const PREFIXES = { takings: 'SALES', tax: 'GST', refunds: 'REFUND' } as const;
const LEDGER = { takingsMinor: 100_000_00, taxMinor: 5_000_00, refundsMinor: 2_000_00, billCount: 412 };

const posting = (over: Partial<QueuedPosting> = {}): QueuedPosting => ({
  postingId: 'P-1', idempotencyKey: 'k-1', period: PERIOD, journalRef: 'SALES-001',
  debitMinor: 100_000_00, creditMinor: 100_000_00, state: 'posted', attempts: 1,
  queuedAt: '2026-09-30T23:00:00.000Z',
  ...over,
});
/** Both sides agree exactly: the figures can be signed. */
const CLEAN: QueuedPosting[] = [
  posting({ postingId: 'P-1', journalRef: 'SALES-001', debitMinor: 100_000_00 }),
  posting({ postingId: 'P-2', journalRef: 'GST-001', debitMinor: 5_000_00 }),
  posting({ postingId: 'P-3', journalRef: 'REFUND-001', debitMinor: 2_000_00 }),
];

const CONFIG: FinanceConfig = { tenantId: 't1', period: PERIOD, userId: 'u-owner', now: NOW, tradingDayCutoff: '02:00', journalPrefixes: PREFIXES };

/** A request as head office's inbox hands it back (JSON round-tripped, like the wire). */
const row = (over: Omit<Partial<ApprovalRequestView>, 'details'> & Pick<ApprovalRequestView, 'requestId'> & { readonly details?: object }): ApprovalRequestView => ({
  kind: PERIOD_CLOSE_KIND, label: 'Close and sign an accounting month', subjectRef: PERIOD, valueMinor: null,
  summary: 'Close and sign September 2026', reason: 'The figures agree exactly and nothing is outstanding.',
  requestedBy: 'u-owner', requestedAt: '2026-10-07T04:00:00.000Z', status: 'waiting',
  ...over,
  details: JSON.parse(JSON.stringify(over.details ?? { period: PERIOD })) as Record<string, unknown>,
});

/** A stub head office: the approval engine (ask + inbox) and the month's two routes, recording what each was sent. */
function office(opts: { mine?: ApprovalRequestView[]; inbox?: InboxRead; ask?: AskResult; close?: MonthActionResult; reopen?: MonthActionResult } = {}) {
  const asks: ApprovalAsk[] = [];
  const closeCalls: { period: string; approvalId: string }[] = [];
  const reopenCalls: { period: string; reason: string; approvalId: string }[] = [];
  let inboxReads = 0;
  const ports: Partial<FinancePorts> = {
    askApproval: async (ask) => {
      asks.push(ask);
      return opts.ask ?? { result: 'asked', request: row({ requestId: 'areq-new', kind: ask.kind, subjectRef: ask.subjectRef, details: ask.details, summary: ask.summary, reason: ask.reason }) };
    },
    approvalInbox: async () => { inboxReads += 1; return opts.inbox ?? { result: 'read', inbox: { waitingForMe: [], mine: opts.mine ?? [], asAt: null } }; },
    closeAtHeadOffice: async (input) => { closeCalls.push({ ...input }); return opts.close ?? { result: 'done', detail: `${PERIOD} closed, 3 control total(s) agreed, signed by u-accountant` }; },
    reopenAtHeadOffice: async (input) => { reopenCalls.push({ ...input }); return opts.reopen ?? { result: 'done', detail: `${PERIOD} reopened` }; },
  };
  return { ports, asks, closeCalls, reopenCalls, inboxReads: () => inboxReads };
}

function ports(over: Partial<FinancePorts> = {}): FinancePorts {
  return {
    ledger: () => LEDGER,
    postings: () => CLEAN,
    periodState: () => ({ closed: false }),
    unsentSyncCount: () => 0,
    openExceptionCount: () => 0,
    ...over,
  };
}

const finance = (over: Partial<FinancePorts> = {}, config: Partial<FinanceConfig> = {}) => createFinanceSession({ ...CONFIG, ...config }, ports(over));
const closedMonth = { periodState: () => ({ closed: true, closedBy: 'u-owner', closedAt: '2026-10-01T10:00:00.000Z' }) };

const APPROVED_CLOSE = row({ requestId: 'areq-1', status: 'approved', decidedBy: 'u-accountant', decisionReason: 'checked the bank and Tally', expiresAt: '2026-10-08T04:30:00.000Z' });
const REASON = 'supplier credit note for August arrived late';
const reopenRow = (over: Omit<Partial<ApprovalRequestView>, 'details'> & Pick<ApprovalRequestView, 'requestId'> & { readonly details?: object }) => row({
  kind: PERIOD_REOPEN_KIND, label: 'Reopen a signed accounting month', summary: 'Reopen September 2026', reason: REASON,
  details: { reason: REASON, period: PERIOD }, ...over,
});

// ── What the approval is FOR is exactly what the route will fingerprint ──────────────────────────────────────

describe('the details asked for are exactly what the month routes fingerprint (ADR-0024 actionDetails)', () => {
  it('a close: the body carries nothing but the approval; the details are the month from the route\'s path', () => {
    expect(periodCloseRequestBody()).toEqual({});
    expect(periodCloseRequestBody('areq-1')).toEqual({ approvalId: 'areq-1' });
    expect(periodCloseDetails(PERIOD)).toEqual({ period: PERIOD });
    const sent = JSON.parse(JSON.stringify(periodCloseRequestBody('areq-1'))) as unknown;
    expect(fingerprintOf(actionDetails(sent, { period: PERIOD }))).toBe(fingerprintOf(periodCloseDetails(PERIOD)));
  });

  it('a reopen: the body is why and the approval; the details are exactly the reason and the month', () => {
    expect(periodReopenRequestBody(REASON, 'areq-2')).toEqual({ reason: REASON, approvalId: 'areq-2' });
    expect(periodReopenDetails(REASON, PERIOD)).toEqual({ reason: REASON, period: PERIOD });
    const sent = JSON.parse(JSON.stringify(periodReopenRequestBody(REASON, 'areq-2'))) as unknown;
    expect(fingerprintOf(actionDetails(sent, { period: PERIOD }))).toBe(fingerprintOf(periodReopenDetails(REASON, PERIOD)));
    // A different reason is a different action — the approval does not carry over.
    expect(fingerprintOf(periodReopenDetails(`${REASON}.`, PERIOD))).not.toBe(fingerprintOf(periodReopenDetails(REASON, PERIOD)));
  });

  it('no body this screen sends names a signer or an approver', () => {
    for (const body of [periodCloseRequestBody('areq-1'), periodReopenRequestBody(REASON, 'areq-2')]) {
      for (const typed of ['signedBy', 'approvedBy', 'approval', 'rationale']) expect(body).not.toHaveProperty(typed);
    }
  });

  it('names the month as a person does, in both languages', () => {
    expect(monthName('en', '2026-09')).toBe('September 2026');
    expect(monthName('ta', '2026-09')).toBe('செப்டம்பர் 2026');
    expect(monthName('en', '2026-13')).toBe('2026-13');
    expect(monthName('en', 'Q3')).toBe('Q3');
  });
});

describe('through the REAL browser ports: what the screen asked for, the engine accepts from what the screen sent', () => {
  const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  afterEach(() => {
    if (originalFetch === undefined) delete (globalThis as { fetch?: typeof fetch }).fetch;
    else (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  const stateFor = (asked: ApprovalAsk, requestId: string): ApprovalState => ({
    request: {
      requestId, kind: asked.kind, subjectRef: asked.subjectRef, valueMinor: asked.valueMinor,
      fingerprint: fingerprintOf(asked.details), details: asked.details, summary: asked.summary, reason: asked.reason,
      requestedBy: 'u-owner', requestedAt: '2026-10-07T04:00:00.000Z',
    },
    decision: { requestId, decision: 'approved', decidedBy: 'u-accountant', reason: 'fine', decidedAt: '2026-10-07T04:30:00.000Z', expiresAt: '2026-10-08T04:30:00.000Z' },
  });

  it('close: the POST goes to the month\'s route with only { approvalId }, and the engine accepts it', async () => {
    const sent: { url: string; init: { method?: string; headers?: Record<string, string>; credentials?: string; body?: string } }[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (url: string, init: { body?: string }) => {
      sent.push({ url, init });
      return { status: 200, json: async () => ({ closed: `${PERIOD} closed, 3 control total(s) agreed, signed by u-accountant` }) };
    };
    let asked: ApprovalAsk | undefined;
    const s = createFinanceSession(CONFIG, ports({
      askApproval: async (ask) => { asked = ask; return { result: 'asked', request: row({ requestId: 'areq-1', details: ask.details }) }; },
      approvalInbox: async () => ({ result: 'read', inbox: { waitingForMe: [], mine: [row({ requestId: 'areq-1', details: asked!.details, status: 'approved', decidedBy: 'u-accountant' })], asAt: null } }),
      closeAtHeadOffice: FINANCE_HEAD_OFFICE.closeAtHeadOffice,
      reopenAtHeadOffice: FINANCE_HEAD_OFFICE.reopenAtHeadOffice,
    }));
    expect((await s.askToClose('en', '')).kind).toBe('asked');
    const done = await s.closeWithApproval();
    expect(done).toEqual({ kind: 'done', detail: `${PERIOD} closed, 3 control total(s) agreed, signed by u-accountant`, approvedBy: 'u-accountant' });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('/v1/finance/periods/2026-09/close');
    expect(sent[0]!.init.method).toBe('POST');
    expect(sent[0]!.init.credentials).toBe('same-origin');
    expect(sent[0]!.init.headers?.['idempotency-key'], 'a write carries an idempotency key').toBeTruthy();
    const body = JSON.parse(sent[0]!.init.body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({ approvalId: 'areq-1' });
    const decision = await takeApproval({
      state: stateFor(asked!, 'areq-1'), kind: 'period_close', subjectRef: PERIOD, details: actionDetails(body, { period: PERIOD }),
      valueMinor: null, maker: 'u-owner', usedBy: `period-close:${PERIOD}`, now: NOW, checkerHolds: () => true,
    });
    expect(decision.decidedBy).toBe('u-accountant');
  });

  it('reopen: the POST carries { reason, approvalId } — the reason exactly as approved — and the engine accepts it', async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (url: string, init: { body?: string }) => {
      sent.push({ url, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
      return { status: 200, json: async () => ({ period: PERIOD, state: 'open', reopenedBy: 'u-owner', approvedBy: 'u-accountant', detail: `${PERIOD} reopened` }) };
    };
    let asked: ApprovalAsk | undefined;
    const s = createFinanceSession(CONFIG, ports({
      ...closedMonth,
      askApproval: async (ask) => { asked = ask; return { result: 'asked', request: reopenRow({ requestId: 'areq-2', details: ask.details }) }; },
      approvalInbox: async () => ({ result: 'read', inbox: { waitingForMe: [], mine: [reopenRow({ requestId: 'areq-2', details: asked!.details, status: 'approved', decidedBy: 'u-accountant' })], asAt: null } }),
      closeAtHeadOffice: FINANCE_HEAD_OFFICE.closeAtHeadOffice,
      reopenAtHeadOffice: FINANCE_HEAD_OFFICE.reopenAtHeadOffice,
    }));
    expect((await s.askToReopen('en', `  ${REASON}  `)).kind).toBe('asked');
    expect((await s.reopenWithApproval(`  ${REASON} `)).kind).toBe('done');
    expect(sent[0]!.url).toBe('/v1/finance/periods/2026-09/reopen');
    expect(sent[0]!.body).toEqual({ reason: REASON, approvalId: 'areq-2' });
    const decision = await takeApproval({
      state: stateFor(asked!, 'areq-2'), kind: 'period_reopen', subjectRef: PERIOD, details: actionDetails(sent[0]!.body, { period: PERIOD }),
      valueMinor: null, maker: 'u-owner', usedBy: `period-reopen:${PERIOD}`, now: NOW, checkerHolds: () => true,
    });
    expect(decision.decidedBy).toBe('u-accountant');
  });

  it('a refusal comes back as head office said it; a dropped link is a lost link, never "done"', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => ({ status: 422, json: async () => ({ error: { code: 'closed_by_whoever_posted', whatHappened: 'u-accountant posted into 2026-09 and cannot also certify that it is right' } }) });
    expect(await FINANCE_HEAD_OFFICE.closeAtHeadOffice({ period: PERIOD, approvalId: 'areq-1' }))
      .toEqual({ result: 'refused', code: 'closed_by_whoever_posted', whatHappened: 'u-accountant posted into 2026-09 and cannot also certify that it is right' });
    (globalThis as { fetch?: unknown }).fetch = async () => { throw new Error('offline'); };
    expect(await FINANCE_HEAD_OFFICE.reopenAtHeadOffice({ period: PERIOD, reason: REASON, approvalId: 'areq-2' })).toEqual({ result: 'lost_link' });
  });
});

// ── Closing ───────────────────────────────────────────────────────────────────────────────────────────────

describe('Ask for the signature — the closer\'s own request, for exactly this month; nothing is closed', () => {
  it('kind period_close, about the month, details { period }, no amount, a plain summary and the note', async () => {
    const o = office();
    const outcome = await finance(o.ports).askToClose('en', '  bank reconciled on the 3rd  ');
    expect(outcome.kind).toBe('asked');
    expect(o.asks).toEqual([{
      kind: 'period_close', subjectRef: PERIOD, details: { period: PERIOD }, valueMinor: null,
      summary: 'Close and sign September 2026', reason: 'bank reconciled on the 3rd',
    }]);
    expect(o.closeCalls, 'asking closes nothing').toEqual([]);
  });

  it('the note is optional: without one, the signer reads that the figures agree; the summary is in the reader\'s language', async () => {
    const o = office();
    await finance(o.ports).askToClose('en', '   ');
    await finance(o.ports).askToClose('ta', '');
    expect(o.asks[0]?.reason).toBe('The figures agree exactly and nothing is outstanding.');
    expect(o.asks[1]?.summary).toBe('செப்டம்பர் 2026 மாதத்தை மூடிக் கையெழுத்திடுதல்');
    expect(o.asks[1]?.reason).toBe('எண்கள் சரியாகப் பொருந்துகின்றன, நிலுவை எதுவும் இல்லை.');
  });

  it('says it is waiting for someone who may sign a month — the accountant or the CA — in English and Tamil', async () => {
    const o = office();
    const outcome = await finance(o.ports).askToClose('en', '');
    expect(presentMonthAsk('en', 'close', outcome).label).toBe('Asked. Waiting for someone who may sign a month — the accountant or the CA, not you — to approve it on their Approvals page. Nothing is closed yet. Close and sign September 2026');
    expect(presentMonthAsk('en', 'close', outcome).tone).not.toBe('ok');
    expect(presentMonthAsk('ta', 'close', outcome).label).toMatch(/^கேட்கப்பட்டது\. .*கணக்காளர்/);
  });

  it('refuses locally — nothing asked — when the figures here cannot be signed (every blocker is on the page)', async () => {
    const o = office();
    const blocked: MonthAskOutcome[] = [
      await finance({ ...o.ports, ledger: () => ({ ...LEDGER, takingsMinor: 100_000_01 }) }).askToClose('en', ''),
      await finance({ ...o.ports, postings: () => [...CLEAN, posting({ postingId: 'P-D', journalRef: 'SALES-9', state: 'dead_lettered' })] }).askToClose('en', ''),
      await finance({ ...o.ports, unsentSyncCount: () => 2 }).askToClose('en', ''),
      await finance({ ...o.ports, openExceptionCount: () => 1 }).askToClose('en', ''),
    ];
    for (const b of blocked) expect(b).toMatchObject({ kind: 'blocked', refusal: 'blocked' });
    const noLedger = await finance({ ...o.ports, ledger: () => undefined }).askToClose('en', '');
    expect(noLedger).toMatchObject({ kind: 'blocked', refusal: 'the_shop_has_not_told_us_what_it_took' });
    expect(presentMonthAsk('en', 'close', noLedger).label).toBe('Nothing was asked — the shop has not said what it took this month, so there is nothing to check the accounts against.');
    expect(presentMonthAsk('en', 'close', blocked[0]!).label).toBe('Nothing was asked — these figures cannot be signed yet. Everything stopping it is listed under “What is stopping this month closing”.');
    expect(o.asks).toEqual([]);
  });

  it('refuses locally with nobody named at the desk, and says head office\'s words when it refuses the ask', async () => {
    const o = office();
    expect(await finance(o.ports, { userId: null }).askToClose('en', '')).toEqual({ kind: 'nobody_named' });
    expect(o.asks).toEqual([]);
    const refused = office({ ask: { result: 'refused', code: 'not_permitted_for_this_approval', whatHappened: 'u-cashier may not close and sign an accounting month, so cannot ask for it to be approved.' } });
    const r = await finance(refused.ports).askToClose('en', '');
    expect(presentMonthAsk('en', 'close', r).label).toBe('Not asked: u-cashier may not close and sign an accounting month, so cannot ask for it to be approved.');
    const lost = await finance(office({ ask: { result: 'lost_link' } }).ports).askToClose('en', '');
    expect(presentMonthAsk('en', 'close', lost).label).toBe('No connection to head office — nothing was asked. Try again.');
  });
});

describe('Close the month — only with the closer\'s own APPROVED request for this month', () => {
  it('posts the close naming that approval, and the month then reads as closed and signed', async () => {
    const o = office({ mine: [APPROVED_CLOSE] });
    const s = finance(o.ports);
    const outcome = await s.closeWithApproval();
    expect(outcome).toEqual({ kind: 'done', detail: `${PERIOD} closed, 3 control total(s) agreed, signed by u-accountant`, approvedBy: 'u-accountant' });
    expect(o.closeCalls).toEqual([{ period: PERIOD, approvalId: 'areq-1' }]);
    expect(presentMonthUse('en', 'close', outcome).label).toBe('Closed and signed. u-accountant signed it, and that approval has now been used. A closed month is never edited — a correction is a new entry in the open month.');
    expect(presentMonthUse('en', 'close', outcome).tone).toBe('ok');
    const view = s.period();
    expect(view.closed).toBe(true);
    expect(view.closedBy).toBe('u-owner');
    expect(view.signedBy).toBe('u-accountant');
    // The local check now agrees there is nothing left to close.
    const again = s.close();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.result?.blockers.some((b) => b.kind === 'already_closed')).toBe(true);
  });

  it('uses only the caller\'s own request of kind period_close about THIS month', async () => {
    const otherMonth = row({ requestId: 'areq-aug', subjectRef: '2026-08', details: { period: '2026-08' }, status: 'approved', decidedBy: 'u-accountant' });
    const aReopen = reopenRow({ requestId: 'areq-r', status: 'approved', decidedBy: 'u-accountant' });
    const o = office({ mine: [otherMonth, aReopen] });
    expect(await finance(o.ports).closeWithApproval()).toEqual({ kind: 'not_asked' });
    expect(o.closeCalls).toEqual([]);
  });

  it('not asked / waiting / rejected (who and why) / expired / used: plain words, and nothing is sent', async () => {
    const cases: [ApprovalRequestView[], MonthUseOutcome, string][] = [
      [[], { kind: 'not_asked' }, 'Not closed — nobody has been asked to sign it yet. Press “Ask for the signature” first.'],
      [[row({ requestId: 'a' })], { kind: 'waiting' }, 'Not closed — still waiting for someone who may sign a month (the accountant or the CA — not you) to approve it on their Approvals page.'],
      [[row({ requestId: 'a', status: 'rejected', decidedBy: 'u-accountant', decisionReason: 'the cash count for the 14th is missing' })],
        { kind: 'rejected', decidedBy: 'u-accountant', reason: 'the cash count for the 14th is missing' },
        'Not closed — u-accountant rejected it: “the cash count for the 14th is missing”. Settle what they said and ask again.'],
      [[row({ requestId: 'a', status: 'expired', decidedBy: 'u-accountant' })], { kind: 'expired' }, 'Not closed — the approval ran out of time before it was used. Ask again.'],
      [[row({ requestId: 'a', status: 'used', decidedBy: 'u-accountant' })], { kind: 'used' }, 'Not closed — that approval was already used once. One approval allows one close or one reopen; ask again.'],
    ];
    for (const [mine, expected, words] of cases) {
      const o = office({ mine });
      const outcome = await finance(o.ports).closeWithApproval();
      expect(outcome).toEqual(expected);
      expect(presentMonthUse('en', 'close', outcome).label).toBe(words);
      expect(presentMonthUse('ta', 'close', outcome).label, `${expected.kind} in Tamil`).toMatch(/^மூடப்படவில்லை/);
      expect(o.closeCalls, `${expected.kind} must not send a close`).toEqual([]);
    }
  });

  it('a newer approved request is used over an older one; a rejection says who and why in Tamil too', async () => {
    const older = row({ requestId: 'areq-old', status: 'approved', decidedBy: 'u-ca', requestedAt: '2026-10-06T04:00:00.000Z' });
    const o = office({ mine: [older, APPROVED_CLOSE] });
    await finance(o.ports).closeWithApproval();
    expect(o.closeCalls[0]?.approvalId).toBe('areq-1');
    const rejected: MonthUseOutcome = { kind: 'rejected', decidedBy: 'u-accountant', reason: 'cash count missing' };
    expect(presentMonthUse('ta', 'close', rejected).label).toBe('மூடப்படவில்லை — u-accountant மறுத்தார்: “cash count missing”. அவர் சொன்னதைச் சரிசெய்து மீண்டும் கேளுங்கள்.');
  });

  it('refuses locally — nothing read, nothing sent — with nobody named, or when the figures here cannot be signed', async () => {
    const o = office({ mine: [APPROVED_CLOSE] });
    expect(await finance(o.ports, { userId: null }).closeWithApproval()).toEqual({ kind: 'nobody_named' });
    expect(await finance({ ...o.ports, unsentSyncCount: () => 3 }).closeWithApproval()).toMatchObject({ kind: 'blocked' });
    expect(o.inboxReads()).toBe(0);
    expect(o.closeCalls).toEqual([]);
  });
});

describe('head office\'s own refusals, in plain words', () => {
  it('every month refusal code has its own words in English and Tamil — never the raw code', () => {
    for (const code of MONTH_REFUSAL_CODES) {
      const o = monthOutcomeOfRefusal(code, 'head office detail');
      expect(o).toEqual({ kind: 'head_office_refused', code, whatHappened: 'head office detail' });
      for (const lang of ['en', 'ta'] as const) {
        for (const action of ['close', 'reopen'] as const) {
          const p = presentMonthUse(lang, action, o);
          expect(p.label, `${code} ${lang}`).not.toContain(code);
          expect(p.label, `${code} ${lang}`).not.toMatch(/\{\w+\}/);
          expect(p.icon.trim()).not.toBe('');
          if (lang === 'ta') expect(p.label).toMatch(/[஀-௿]/);
        }
      }
    }
    expect(presentMonthUse('en', 'close', monthOutcomeOfRefusal('not_signed', ''))).toMatchObject({
      label: 'Not closed — head office has no signature for this month. Ask for the signature, and wait for the accountant or the CA to approve it.',
    });
    expect(presentMonthUse('en', 'close', monthOutcomeOfRefusal('closed_by_whoever_posted', '')).label)
      .toBe('Not closed — the person who signed also posted entries into this month, and cannot also certify that it is right. Ask again, and have someone else who may sign a month — who did not post into it — approve it.');
    expect(presentMonthUse('en', 'close', monthOutcomeOfRefusal('control_total_does_not_agree', '')).label)
      .toBe('Not closed — head office’s own figures for this month do not agree. Settle the difference, then close it.');
    expect(presentMonthUse('en', 'reopen', monthOutcomeOfRefusal('reopen_refused', '')).label)
      .toBe('Not reopened — head office does not have this month as closed, so there is nothing to reopen.');
  });

  it('the engine\'s approval codes read the way every screen reads them; anything else in head office\'s own words', async () => {
    const expected: Record<string, MonthUseOutcome['kind']> = {
      approval_unknown: 'not_asked', approval_does_not_match: 'changed', approval_still_waiting: 'waiting', approval_rejected: 'rejected',
      approval_expired: 'expired', approval_already_used: 'used', checker_may_not_approve: 'checker_may_not_approve',
      approver_named_without_approval: 'named_not_approved',
    };
    for (const code of APPROVAL_REFUSAL_CODES) {
      const o = office({ mine: [APPROVED_CLOSE], close: { result: 'refused', code, whatHappened: 'x' } });
      expect((await finance(o.ports).closeWithApproval()).kind, code).toBe(expected[code]);
    }
    const unknown = await finance(office({ mine: [APPROVED_CLOSE], close: { result: 'refused', code: 'forbidden', whatHappened: 'u-owner does not hold finance.period.close.' } }).ports).closeWithApproval();
    expect(unknown).toEqual({ kind: 'refused', code: 'forbidden', whatHappened: 'u-owner does not hold finance.period.close.' });
    expect(presentMonthUse('en', 'close', unknown).label).toBe('Not closed: u-owner does not hold finance.period.close.');
    expect(presentMonthUse('en', 'close', { kind: 'refused', code: 'http_500', whatHappened: '' }).label).toBe('Not closed — head office refused it.');
    const lost = await finance(office({ mine: [APPROVED_CLOSE], close: { result: 'lost_link' } }).ports).closeWithApproval();
    expect(presentMonthUse('en', 'close', lost).label).toBe('Not closed — no connection to head office. Nothing was changed. Try again.');
  });

  it('a refused close leaves the month open on the screen', async () => {
    const s = finance(office({ mine: [APPROVED_CLOSE], close: { result: 'refused', code: 'not_signed', whatHappened: '' } }).ports);
    await s.closeWithApproval();
    expect(s.period().closed).toBe(false);
  });
});

// ── Reopening ─────────────────────────────────────────────────────────────────────────────────────────────

describe('Reopening — a second person\'s own approval, for exactly the written reason', () => {
  it('asks with kind period_reopen and details { reason, period } — exactly the reopen body', async () => {
    const o = office();
    const outcome = await finance({ ...o.ports, ...closedMonth }).askToReopen('en', `  ${REASON}  `);
    expect(outcome.kind).toBe('asked');
    expect(o.asks).toEqual([{
      kind: 'period_reopen', subjectRef: PERIOD, details: { reason: REASON, period: PERIOD }, valueMinor: null,
      summary: 'Reopen September 2026', reason: REASON,
    }]);
    expect(presentMonthAsk('en', 'reopen', outcome).label).toBe('Asked. Waiting for someone who may sign a month — the accountant or the CA, not you — to approve it on their Approvals page. The month stays closed until then. Reopen September 2026');
    expect(o.reopenCalls).toEqual([]);
  });

  it('refuses locally — nothing asked — without a reason, or when the month is not closed', async () => {
    const o = office();
    const noWhy = await finance({ ...o.ports, ...closedMonth }).askToReopen('en', '   ');
    expect(noWhy).toEqual({ kind: 'needs_why' });
    expect(presentMonthAsk('en', 'reopen', noWhy).label).toBe('Write why the month needs reopening — the person approving reads it, and so will the auditor. Nothing was asked.');
    expect(await finance(o.ports).askToReopen('en', REASON)).toEqual({ kind: 'not_closed' });
    expect(await finance({ ...o.ports, ...closedMonth }, { userId: null }).askToReopen('en', REASON)).toEqual({ kind: 'nobody_named' });
    expect(o.asks).toEqual([]);
  });

  it('reopens with the caller\'s own approved request for exactly this reason; the month is then open again', async () => {
    const o = office({ mine: [reopenRow({ requestId: 'areq-2', status: 'approved', decidedBy: 'u-accountant' })] });
    const s = finance({ ...o.ports, ...closedMonth });
    const outcome = await s.reopenWithApproval(REASON);
    expect(outcome).toEqual({ kind: 'done', detail: `${PERIOD} reopened`, approvedBy: 'u-accountant' });
    expect(o.reopenCalls).toEqual([{ period: PERIOD, reason: REASON, approvalId: 'areq-2' }]);
    expect(presentMonthUse('en', 'reopen', outcome).label).toBe('Reopened. u-accountant approved it, and that approval has now been used. The month is open again, and it must be closed and signed again.');
    expect(s.period().closed).toBe(false);
  });

  it('a changed reason is not what was approved: it says ask again, and nothing is sent', async () => {
    const o = office({ mine: [reopenRow({ requestId: 'areq-2', status: 'approved', decidedBy: 'u-accountant' })] });
    const outcome = await finance({ ...o.ports, ...closedMonth }).reopenWithApproval(`${REASON} and a GST correction`);
    expect(outcome).toEqual({ kind: 'changed' });
    expect(presentMonthUse('en', 'reopen', outcome).label).toBe('Not reopened — this reason is not the one that was approved (it changed after you asked). Ask for approval again with this reason.');
    expect(o.reopenCalls).toEqual([]);
  });

  it('waiting / rejected / not asked / empty reason / not closed — plain words, nothing sent', async () => {
    const waiting = office({ mine: [reopenRow({ requestId: 'a' })] });
    expect(await finance({ ...waiting.ports, ...closedMonth }).reopenWithApproval(REASON)).toEqual({ kind: 'waiting' });
    const rejected = office({ mine: [reopenRow({ requestId: 'a', status: 'rejected', decidedBy: 'u-ca', decisionReason: 'post a credit note in October instead' })] });
    const r = await finance({ ...rejected.ports, ...closedMonth }).reopenWithApproval(REASON);
    expect(presentMonthUse('en', 'reopen', r).label).toBe('Not reopened — u-ca rejected it: “post a credit note in October instead”. Settle what they said and ask again.');
    const none = office();
    const notAsked = await finance({ ...none.ports, ...closedMonth }).reopenWithApproval(REASON);
    expect(presentMonthUse('en', 'reopen', notAsked).label).toBe('Not reopened — nobody has been asked to approve exactly this yet. Write why and press “Ask for approval” first.');
    expect(await finance({ ...none.ports, ...closedMonth }).reopenWithApproval('  ')).toEqual({ kind: 'needs_why' });
    expect(await finance(none.ports).reopenWithApproval(REASON)).toEqual({ kind: 'not_closed' });
    for (const o of [waiting, rejected, none]) expect(o.reopenCalls).toEqual([]);
  });

  it('head office refusing the reopen reads in plain words', async () => {
    const o = office({ mine: [reopenRow({ requestId: 'areq-2', status: 'approved', decidedBy: 'u-accountant' })], reopen: { result: 'refused', code: 'reopen_refused', whatHappened: '2026-09 is not closed' } });
    const s = finance({ ...o.ports, ...closedMonth });
    const outcome = await s.reopenWithApproval(REASON);
    expect(outcome).toEqual({ kind: 'head_office_refused', code: 'reopen_refused', whatHappened: '2026-09 is not closed' });
    expect(s.period().closed, 'a refused reopen changes nothing on the screen').toBe(true);
  });
});

// ── Not wired to head office ──────────────────────────────────────────────────────────────────────────────

describe('a screen not connected to head office closes and reopens nothing — and never on a typed name', () => {
  it('every step says closing and reopening happen at head office, with a second person, and nothing changed', async () => {
    const local = finance();
    expect(local.connected).toBe(false);
    const outcomes = [await local.askToClose('en', ''), await local.closeWithApproval()];
    const closed = finance(closedMonth);
    outcomes.push(await closed.askToReopen('en', REASON), await closed.reopenWithApproval(REASON));
    for (const o of outcomes) expect(o).toEqual({ kind: 'not_connected' });
    const words = 'Closing and reopening a month happen at head office, with a second person’s approval — and this screen is not connected to head office. Nothing was changed.';
    expect(presentMonthAsk('en', 'close', { kind: 'not_connected' }).label).toBe(words);
    expect(presentMonthUse('en', 'reopen', { kind: 'not_connected' }).label).toBe(words);
    expect(presentMonthUse('ta', 'close', { kind: 'not_connected' }).label).toMatch(/தலைமை அலுவலகத்தில்.*எதுவும் மாற்றப்படவில்லை\.$/);
    expect(finance().period().closed).toBe(false);
    expect(finance(closedMonth).period().closed).toBe(true);
  });

  it('has no way to take a typed approver: the old reopen-on-a-name is gone', () => {
    const s = finance();
    expect('reopen' in s, 'the typed-approver reopen is still on the session').toBe(false);
    expect(s.reopenWithApproval.length, 'reopenWithApproval takes the reason only').toBe(1);
  });

  it('the box\'s boot is local-only unless head office is given; the browser wires head office', () => {
    const data = { userId: 'u-owner', period: PERIOD, journalPrefixes: PREFIXES, ledger: LEDGER, postings: CLEAN };
    expect(bootFinance(data)!.connected).toBe(false);
    expect(bootFinance(data, FINANCE_HEAD_OFFICE)!.connected).toBe(true);
    expect(bootFinance(undefined, FINANCE_HEAD_OFFICE)).toBeNull();
  });
});

// ── Where the person's own requests stand ─────────────────────────────────────────────────────────────────

describe('your requests for this month — a read only', () => {
  it('shows the newest close and reopen request for this month, in words, and what is still in play', async () => {
    const o = office({
      mine: [
        row({ requestId: 'c-old', status: 'rejected', decidedBy: 'u-ca', decisionReason: 'no', requestedAt: '2026-10-06T04:00:00.000Z' }),
        row({ requestId: 'c-new', status: 'approved', decidedBy: 'u-accountant', expiresAt: '2026-10-08T04:30:00.000Z' }),
        reopenRow({ requestId: 'r-1' }),
        row({ requestId: 'other-month', subjectRef: '2026-08', details: { period: '2026-08' }, status: 'rejected', decidedBy: 'u-ca' }),
      ],
    });
    const mine = await finance(o.ports).yourRequests('en');
    expect(mine.state).toBe('read');
    expect(mine.close?.label).toBe('Approved by u-accountant — use it before 08-10-2026 10:00');
    expect(mine.reopen?.label).toBe('Waiting for a second person');
    expect(mine.closeAsked).toBe(true);
    expect(mine.reopenReason).toBe(REASON);
    expect(o.asks).toEqual([]);
    expect(o.closeCalls).toEqual([]);
  });

  it('a used request is history, not where things stand; nothing in play means nothing to send', async () => {
    const o = office({ mine: [row({ requestId: 'c', status: 'used', decidedBy: 'u-accountant' }), reopenRow({ requestId: 'r', status: 'used', decidedBy: 'u-accountant' })] });
    expect(await finance(o.ports).yourRequests('en')).toEqual({ state: 'read', close: null, reopen: null, closeAsked: false, reopenReason: null });
  });

  it('reads nothing when not connected, and says so when the read fails', async () => {
    expect((await finance().yourRequests('en')).state).toBe('not_connected');
    expect((await finance(office({ inbox: { result: 'lost_link' } }).ports).yourRequests('ta')).state).toBe('lost_link');
  });
});

// ── The words ─────────────────────────────────────────────────────────────────────────────────────────────

describe('every word the month\'s two-person flow says exists in English and Tamil', () => {
  it('the copy has no gaps in either language', () => {
    expect(bilingualGaps(FINANCE_MONTH_COPY, MONTH_COPY_KEYS)).toEqual({ en: [], ta: [] });
    // Every line is written in Tamil — only a pure template ("{not}: {words}") reads the same in both.
    for (const key of MONTH_COPY_KEYS) {
      if (FINANCE_MONTH_COPY.en[key].replace(/\{\w+\}/g, '').replace(/[\s:—.]/g, '') === '') continue;
      expect(FINANCE_MONTH_COPY.ta[key], key).toMatch(/[஀-௿]/);
    }
  });

  it('every ask and every use outcome carries a tone, an icon and words in both languages, with nothing left unfilled', () => {
    const request = row({ requestId: 'areq-1' });
    const asks: MonthAskOutcome[] = [
      { kind: 'asked', request }, { kind: 'nobody_named' }, { kind: 'not_connected' },
      { kind: 'blocked', refusal: 'blocked', detail: '' }, { kind: 'blocked', refusal: 'the_shop_has_not_told_us_what_it_took', detail: '' },
      { kind: 'not_closed' }, { kind: 'needs_why' }, { kind: 'refused', code: 'x', whatHappened: 'y' }, { kind: 'refused', code: 'x', whatHappened: '' }, { kind: 'lost_link' },
    ];
    const uses: MonthUseOutcome[] = [
      { kind: 'done', detail: '', approvedBy: 'u-accountant' }, { kind: 'done', detail: '', approvedBy: null },
      { kind: 'nobody_named' }, { kind: 'not_connected' }, { kind: 'blocked', refusal: 'blocked', detail: '' },
      { kind: 'blocked', refusal: 'the_shop_has_not_told_us_what_it_took', detail: '' }, { kind: 'not_closed' }, { kind: 'needs_why' },
      { kind: 'not_asked' }, { kind: 'waiting' }, { kind: 'rejected', decidedBy: 'u-ca', reason: 'no' }, { kind: 'rejected', decidedBy: null, reason: '' },
      { kind: 'expired' }, { kind: 'used' }, { kind: 'changed' }, { kind: 'checker_may_not_approve' }, { kind: 'named_not_approved' },
      { kind: 'head_office_refused', code: 'not_signed', whatHappened: '' }, { kind: 'refused', code: 'x', whatHappened: 'y' }, { kind: 'lost_link' },
    ];
    for (const lang of ['en', 'ta'] as const) {
      for (const action of ['close', 'reopen'] as const) {
        for (const o of asks) {
          const p = presentMonthAsk(lang, action, o);
          expect(p.icon.trim(), `${lang} ask ${o.kind}`).not.toBe('');
          expect(p.label.trim(), `${lang} ask ${o.kind}`).not.toBe('');
          expect(p.label, `${lang} ask ${o.kind}`).not.toMatch(/\{\w+\}/);
        }
        for (const o of uses) {
          const p = presentMonthUse(lang, action, o);
          expect(p.icon.trim(), `${lang} use ${o.kind}`).not.toBe('');
          expect(p.label.trim(), `${lang} use ${o.kind}`).not.toBe('');
          expect(p.label, `${lang} use ${o.kind}`).not.toMatch(/\{\w+\}/);
          if (o.kind === 'done') expect(p.tone).toBe('ok');
          else expect(p.tone, `${lang} ${o.kind} must not read as success`).not.toBe('ok');
        }
      }
    }
  });
});
