// Finance — control totals, the Tally queue, and the month close (M23-FR-01…04 · QG-07 · §28 · P-08 · ADR-0024).
//
// The roadmap's acceptance for this module is one sentence: **a CA can sign the control totals.**
// Not "the system closes the period" — a named professional puts their name to a set of figures and
// is accountable for them afterwards.
//
// ── What was here, and what was missing ─────────────────────────────────────
//
// `validateControlTotals` compares both sides exactly. `closePeriod` returns **every** blocker at
// once rather than one per attempt, because a finance team meeting obstacles one at a time on the
// last day of the month starts looking for a way round the system and finds one. `buildEvidencePack`
// writes the pack for the person signing it. All three were written, tested — and **never given a
// control total**, because nothing in this system built one. The gap analysis has said so plainly
// for weeks: *no month can close yet.*
//
// `packages/period-close/src/control-totals.ts` is that producer. This surface is where a person
// uses it.
//
// ── The rule the whole screen turns on ──────────────────────────────────────
//
// **Only a posting the accounts have actually accepted counts as received.** A posting in the queue
// is money Tally has never seen; a dead-lettered one is money Tally refused. Counting either would
// make both sides agree — the same number computed twice — and the month would close, reconciled
// and signed, with the accounts missing the lot.
//
// So the queue is reported **beside** the totals and never inside them, and a dead-lettered posting
// blocks the close outright. Nothing here can discard one (hard rule #6).
//
// ── Who closes a month, and who signs it (ADR-0024 · §28 · M23-FR-04 · audit PA-03) ─────────
//
// This screen used to "close" a month in the browser alone, and reopened one on an approver's name TYPED into a box.
// Neither reached head office, and a name in a box is not anybody's approval. Now a month is closed and reopened AT
// HEAD OFFICE, on head office's maker-checker engine, by two people:
//
//   1. the CLOSER (who holds `finance.period.close`) sees this screen's local evidence — whether the figures agree and
//      nothing is outstanding — and, when they can be signed, presses **Ask for the signature**: a `period_close`
//      request for exactly this month, in their own session;
//   2. someone who may SIGN a month (`finance.period.sign` — the accountant, the CA, the owner), never the closer,
//      approves or rejects it on their own Approvals page;
//   3. **Close the month** finds the closer's own APPROVED request for this month and posts the close naming it
//      (`approvalId`). Head office re-checks ITS OWN control totals, refuses a signer who posted into the month, and
//      spends the signature once.
//
// Reopening works the same way (`period_reopen`), for exactly the written reason: a changed reason is asked again.
// With no head office behind the page, nothing is closed or reopened at all — and the screen says so.
//
// ── And the one that follows ────────────────────────────────────────────────
//
// **A closed period is append-only.** Reopening needs a different person's approval, and a
// correction to a closed month is a compensating entry dated in the open one — never an edit. A set
// of accounts that changes after it was signed is the one thing an auditor cannot forgive.

import {
  buildControlTotals, postedSide, validateControlTotals, closePeriod,
  buildEvidencePack, deadLetters,
  type ControlTotal, type ControlTotalResult, type EvidencePack, type LedgerSide,
  type PeriodCloseResult, type PostedSide, type QueuedPosting,
} from '../../../packages/period-close/src/index';
import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import {
  presentRequestStatus,
  type ApprovalAsk, type ApprovalRequestView, type AskResult, type InboxRead, type LostLink, type Refused,
} from './approvals-session';
import { detailsOfBody, findOwnApproval, useOutcomeOfRefusal, type ApprovalUseOutcome } from './catalogue-session';

/** The approval kinds a month is closed and reopened under (head office's maker-checker engine, ADR-0024). */
export const PERIOD_CLOSE_KIND = 'period_close';
export const PERIOD_REOPEN_KIND = 'period_reopen';

/** What head office answered to a month's close or reopen: done (in its own words), its refusal, or no answer. */
export type MonthActionResult = { readonly result: 'done'; readonly detail: string } | Refused | LostLink;

/** What finance can see, and what it honestly cannot. */
export interface FinancePorts {
  /** What the shop's own append-only record says happened in the period. */
  ledger(): LedgerSide | undefined;
  /** Every posting for the period, in whatever state it reached. */
  postings(): readonly QueuedPosting[];
  /** Whether this period is already closed, and by whom. */
  periodState(): { readonly closed: boolean; readonly closedBy?: string; readonly closedAt?: string };
  /** Sales the cloud has not received. Any at all blocks the close. */
  unsentSyncCount(): number;
  /** Differences nobody has explained yet. */
  openExceptionCount(): number;
  /** Ask head office's approval engine (POST /v1/approvals/requests) in the caller's own session — the caller is the
   *  maker. Only from an explicit action. Absent when the page is not wired to head office: nothing is then asked. */
  askApproval?(ask: ApprovalAsk): Promise<AskResult>;
  /** The caller's approvals inbox (GET /v1/approvals/requests) — read only. Absent when not wired to head office. */
  approvalInbox?(): Promise<InboxRead>;
  /** Close the month at head office (POST /v1/finance/periods/:period/close, body `{ approvalId }`). Only from an
   *  explicit action. Absent when not wired: then nothing is closed. */
  closeAtHeadOffice?(input: { readonly period: string; readonly approvalId: string }): Promise<MonthActionResult>;
  /** Reopen the month at head office (POST /v1/finance/periods/:period/reopen, body `{ reason, approvalId }`). */
  reopenAtHeadOffice?(input: { readonly period: string; readonly reason: string; readonly approvalId: string }): Promise<MonthActionResult>;
}

export interface FinanceConfig {
  readonly tenantId: string;
  /** The month being closed, e.g. "2026-07". */
  readonly period: string;
  /** Who is looking. `null` means the box was not told — nothing may be closed under no name. */
  readonly userId: string | null;
  readonly now: string;
  /** The trading-day cut-off this period aligns to (M01-FR-02 / A-13). */
  readonly tradingDayCutoff: string;
  /**
   * Which journal references belong to which figure — this shop's own chart of accounts.
   *
   * Never a constant. A mapping guessed here would file a shop's takings under a heading its
   * accountant does not use, and the difference would surface as an unexplained control total.
   */
  readonly journalPrefixes: Readonly<Record<'takings' | 'tax' | 'refunds', string>>;
}

export type CloseRefusal =
  | 'nobody_is_named_at_this_desk'
  | 'the_shop_has_not_told_us_what_it_took'
  | 'blocked';

const CLOSE_REFUSAL_VALUES: Readonly<Record<CloseRefusal, CloseRefusal>> = Object.freeze({
  nobody_is_named_at_this_desk: 'nobody_is_named_at_this_desk',
  the_shop_has_not_told_us_what_it_took: 'the_shop_has_not_told_us_what_it_took',
  blocked: 'blocked',
});
export const CLOSE_REFUSAL_KINDS: readonly CloseRefusal[] = Object.freeze(Object.values(CLOSE_REFUSAL_VALUES));

/** The month as finance sees it: both sides of every figure, and what is still outstanding. */
export interface PeriodView {
  readonly period: string;
  /**
   * Both sides of every control total, or `undefined` when **the shop has not said what it took**.
   *
   * Not an empty list. An empty list of totals reconciles vacuously — nothing disagreed because
   * nothing was compared — and that is precisely how a month closes on nothing at all.
   */
  readonly totals: readonly ControlTotalResult[] | undefined;
  readonly whyNoTotals?: string;
  readonly allReconcile: boolean;
  /** The queue, reported beside the totals and never inside them. */
  readonly posted: PostedSide;
  /** Every dead-lettered posting, in full. Never summarised away, never discarded. */
  readonly deadLettered: readonly QueuedPosting[];
  readonly unsentSyncCount: number;
  readonly openExceptionCount: number;
  readonly closed: boolean;
  readonly closedBy?: string;
  readonly closedAt?: string;
  /** Who signed it — known when head office closed it from this screen just now. */
  readonly signedBy?: string;
}

/** The LOCAL check of the box's figures. It closes nothing (a month is closed at head office). */
export type CloseOutcome =
  | { readonly ok: true; readonly result: PeriodCloseResult }
  | { readonly ok: false; readonly refusal: CloseRefusal; readonly detail: string; readonly result?: PeriodCloseResult };

// ── What an approval is FOR — the engine's one rule (ADR-0024 `actionDetails`) ──────────────────────────────
//
// Head office fingerprints the details the closer asks for, and the month's route recomputes them from the body it
// receives: the body without its control fields (`approvalId` …) plus the route's path id (`period`). The body the port
// SENDS and the details the screen ASKS for come from the same functions below, so they cannot drift apart —
// tests/unit/erp-finance-month-approvals.test.ts proves them equal to the engine's own `actionDetails`.

/** The JSON body of `POST /v1/finance/periods/:period/close`: only the approval it names. Never a signer's name. */
export function periodCloseRequestBody(approvalId?: string): Record<string, unknown> {
  return approvalId === undefined ? {} : { approvalId };
}

/** What a `period_close` approval is for: the close body (nothing) plus the month from the route's path — `{ period }`. */
export function periodCloseDetails(period: string): Record<string, unknown> {
  return detailsOfBody(periodCloseRequestBody(), { period });
}

/** The JSON body of `POST /v1/finance/periods/:period/reopen`: why, and the approval it names. Never an approver's name. */
export function periodReopenRequestBody(reason: string, approvalId?: string): Record<string, unknown> {
  return { reason, ...(approvalId === undefined ? {} : { approvalId }) };
}

/** What a `period_reopen` approval is for: exactly the reopen body plus the month — `{ reason, period }`. */
export function periodReopenDetails(reason: string, period: string): Record<string, unknown> {
  return detailsOfBody(periodReopenRequestBody(reason), { period });
}

// ── The two-person flow's outcomes ──────────────────────────────────────────────────────────────────────────

/** Which month action an approval is for. */
export type MonthAction = 'close' | 'reopen';

/** The screen refused before anything was sent to head office. */
export type MonthLocalRefusal =
  | { readonly kind: 'nobody_named' }
  | { readonly kind: 'not_connected' }
  /** Close: this screen's own evidence says the figures cannot be signed (every blocker is on the page). */
  | { readonly kind: 'blocked'; readonly refusal: Exclude<CloseRefusal, 'nobody_is_named_at_this_desk'>; readonly detail: string }
  /** Reopen: the month is not closed, so there is nothing to reopen. */
  | { readonly kind: 'not_closed' }
  /** Reopen: no written reason. */
  | { readonly kind: 'needs_why' };

/** The outcome of pressing "Ask for the signature" / "Ask for approval". Nothing is closed or reopened by asking. */
export type MonthAskOutcome =
  | { readonly kind: 'asked'; readonly request: ApprovalRequestView }
  | MonthLocalRefusal
  | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };

/** Head office's own refusals of a month's close or reopen — each said in plain words. */
export const MONTH_REFUSAL_CODES = Object.freeze([
  'not_signed', 'closed_by_whoever_posted', 'control_total_does_not_agree', 'nothing_was_checked',
  'both_sides_from_the_same_place', 'already_closed',
  'reopen_needs_approval', 'reopen_refused', 'reopen_needs_a_reason',
] as const);
export type MonthRefusalCode = (typeof MONTH_REFUSAL_CODES)[number];

/** The outcome of pressing "Close the month" / "Reopen the month". */
export type MonthUseOutcome =
  | { readonly kind: 'done'; readonly detail: string; readonly approvedBy: string | null }
  | MonthLocalRefusal
  | { readonly kind: 'head_office_refused'; readonly code: MonthRefusalCode; readonly whatHappened: string }
  | Exclude<ApprovalUseOutcome, { readonly kind: 'done' } | { readonly kind: 'cannot_check' }>;

/** Where the caller's own newest requests for this month stand (a read of their inbox). */
export interface MonthRequestsView {
  readonly state: 'read' | 'refused' | 'lost_link' | 'not_connected';
  /** The newest close request for this month, in words — or null (none, or already used). */
  readonly close: StatusPresentation | null;
  readonly reopen: StatusPresentation | null;
  /** True when a close request for this month is waiting or approved — "Close the month" is then the next step. */
  readonly closeAsked: boolean;
  /** The reason of the newest reopen request still in play (waiting or approved) — what "Reopen the month" sends. */
  readonly reopenReason: string | null;
}

// ── The words: ONE bilingual object for the month's two-person flow ─────────────────────────────────────────

export type MonthCopyKey =
  | 'notClosed' | 'notReopened' | 'someone'
  | 'summaryClose' | 'summaryReopen' | 'closeReasonDefault'
  | 'askedClose' | 'askedReopen' | 'askNobody' | 'askNoLedger' | 'askBlocked' | 'askNotClosed' | 'askNeedsWhy'
  | 'askRefused' | 'askRefusedNoWords' | 'askLostLink' | 'notConnected'
  | 'closedDone' | 'reopenedDone'
  | 'useNobody' | 'useNoLedger' | 'useBlocked' | 'useNotClosed' | 'useNeedsWhy'
  | 'notAskedClose' | 'notAskedReopen' | 'waiting' | 'rejected' | 'rejectedNoName' | 'expired' | 'used'
  | 'changedClose' | 'changedReopen' | 'checkerMayNot' | 'namedNotApproved' | 'refused' | 'refusedNoWords' | 'lostLink'
  | 'hoNotSigned' | 'hoPostedIntoIt' | 'hoTotalsDisagree' | 'hoNothingChecked' | 'hoSamePlace' | 'hoAlreadyClosed'
  | 'hoReopenNeedsApproval' | 'hoReopenRefused' | 'hoReopenNeedsReason';

/** Every word the month's two-person flow says, in English and Tamil. `{not}` is "Not closed" / "Not reopened". */
export const FINANCE_MONTH_COPY: BilingualCopy<MonthCopyKey> = {
  en: {
    notClosed: 'Not closed', notReopened: 'Not reopened', someone: 'the second person',
    summaryClose: 'Close and sign {month}', summaryReopen: 'Reopen {month}',
    closeReasonDefault: 'The figures agree exactly and nothing is outstanding.',
    askedClose: 'Asked. Waiting for someone who may sign a month — the accountant or the CA, not you — to approve it on their Approvals page. Nothing is closed yet.',
    askedReopen: 'Asked. Waiting for someone who may sign a month — the accountant or the CA, not you — to approve it on their Approvals page. The month stays closed until then.',
    askNobody: 'This store computer has not been told who is using this screen, so nothing was asked and nothing was changed.',
    askNoLedger: 'Nothing was asked — the shop has not said what it took this month, so there is nothing to check the accounts against.',
    askBlocked: 'Nothing was asked — these figures cannot be signed yet. Everything stopping it is listed under “What is stopping this month closing”.',
    askNotClosed: 'Nothing was asked — this month is not closed, so there is nothing to reopen.',
    askNeedsWhy: 'Write why the month needs reopening — the person approving reads it, and so will the auditor. Nothing was asked.',
    askRefused: 'Not asked:', askRefusedNoWords: 'Not asked — head office refused the request.',
    askLostLink: 'No connection to head office — nothing was asked. Try again.',
    notConnected: 'Closing and reopening a month happen at head office, with a second person’s approval — and this screen is not connected to head office. Nothing was changed.',
    closedDone: 'Closed and signed. {who} signed it, and that approval has now been used. A closed month is never edited — a correction is a new entry in the open month.',
    reopenedDone: 'Reopened. {who} approved it, and that approval has now been used. The month is open again, and it must be closed and signed again.',
    useNobody: '{not} — this store computer has not been told who is using this screen. Nothing was changed.',
    useNoLedger: '{not} — the shop has not said what it took this month, so there is nothing to check the accounts against. Nothing was sent.',
    useBlocked: '{not} — these figures cannot be signed yet. Everything stopping it is listed under “What is stopping this month closing”. Nothing was sent.',
    useNotClosed: '{not} — this month is not closed, so there is nothing to reopen.',
    useNeedsWhy: '{not} — write why the month needs reopening, exactly as you wrote it when you asked.',
    notAskedClose: '{not} — nobody has been asked to sign it yet. Press “Ask for the signature” first.',
    notAskedReopen: '{not} — nobody has been asked to approve exactly this yet. Write why and press “Ask for approval” first.',
    waiting: '{not} — still waiting for someone who may sign a month (the accountant or the CA — not you) to approve it on their Approvals page.',
    rejected: '{not} — {who} rejected it: “{reason}”. Settle what they said and ask again.',
    rejectedNoName: '{not} — it was rejected: {reason} Settle what they said and ask again.',
    expired: '{not} — the approval ran out of time before it was used. Ask again.',
    used: '{not} — that approval was already used once. One approval allows one close or one reopen; ask again.',
    changedClose: '{not} — this is not exactly what was approved. Ask for the signature again.',
    changedReopen: '{not} — this reason is not the one that was approved (it changed after you asked). Ask for approval again with this reason.',
    checkerMayNot: '{not} — the person who approved it may no longer sign a month, so their approval does not count. Ask again.',
    namedNotApproved: '{not} — naming a person is not their approval. Ask for approval, and wait for a second person to approve it on their Approvals page.',
    refused: '{not}: {words}', refusedNoWords: '{not} — head office refused it.',
    lostLink: '{not} — no connection to head office. Nothing was changed. Try again.',
    hoNotSigned: '{not} — head office has no signature for this month. Ask for the signature, and wait for the accountant or the CA to approve it.',
    hoPostedIntoIt: '{not} — the person who signed also posted entries into this month, and cannot also certify that it is right. Ask again, and have someone else who may sign a month — who did not post into it — approve it.',
    hoTotalsDisagree: '{not} — head office’s own figures for this month do not agree. Settle the difference, then close it.',
    hoNothingChecked: '{not} — head office has no figures to check for this month, so it cannot be signed.',
    hoSamePlace: '{not} — at head office both sides of a figure come from the same place, which proves nothing. That figure needs a second, independent source before the month can be signed.',
    hoAlreadyClosed: '{not} — head office already has this month closed and signed. To change it, reopen it with a second person’s approval.',
    hoReopenNeedsApproval: '{not} — reopening needs a second person’s approval. Write why and press “Ask for approval” first.',
    hoReopenRefused: '{not} — head office does not have this month as closed, so there is nothing to reopen.',
    hoReopenNeedsReason: '{not} — reopening needs a written reason. Write why and ask again.',
  },
  ta: {
    notClosed: 'மூடப்படவில்லை', notReopened: 'மீண்டும் திறக்கப்படவில்லை', someone: 'இரண்டாம் நபர்',
    summaryClose: '{month} மாதத்தை மூடிக் கையெழுத்திடுதல்', summaryReopen: '{month} மாதத்தை மீண்டும் திறத்தல்',
    closeReasonDefault: 'எண்கள் சரியாகப் பொருந்துகின்றன, நிலுவை எதுவும் இல்லை.',
    askedClose: 'கேட்கப்பட்டது. மாதத்திற்குக் கையெழுத்திடக்கூடியவர் — கணக்காளர் அல்லது பட்டயக் கணக்காளர் (CA), நீங்கள் அல்ல — தனது அனுமதிகள் பக்கத்தில் அனுமதிக்கக் காத்திருக்கிறது. இன்னும் எதுவும் மூடப்படவில்லை.',
    askedReopen: 'கேட்கப்பட்டது. மாதத்திற்குக் கையெழுத்திடக்கூடியவர் — கணக்காளர் அல்லது பட்டயக் கணக்காளர் (CA), நீங்கள் அல்ல — தனது அனுமதிகள் பக்கத்தில் அனுமதிக்கக் காத்திருக்கிறது. அதுவரை மாதம் மூடியபடியே இருக்கும்.',
    askNobody: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை, எனவே எதுவும் கேட்கப்படவில்லை, எதுவும் மாற்றப்படவில்லை.',
    askNoLedger: 'எதுவும் கேட்கப்படவில்லை — இந்த மாதம் கடை என்ன வசூலித்தது என்று சொல்லவில்லை, எனவே கணக்குகளை எதனுடன் ஒப்பிடுவது என்பதே இல்லை.',
    askBlocked: 'எதுவும் கேட்கப்படவில்லை — இந்த எண்களுக்கு இன்னும் கையெழுத்திட முடியாது. தடையாக உள்ள அனைத்தும் “இந்த மாதம் மூட எது தடையாக உள்ளது” என்பதன் கீழ் உள்ளன.',
    askNotClosed: 'எதுவும் கேட்கப்படவில்லை — இந்த மாதம் மூடப்படவில்லை, எனவே மீண்டும் திறக்க எதுவும் இல்லை.',
    askNeedsWhy: 'மாதத்தை ஏன் மீண்டும் திறக்க வேண்டும் என்று எழுதுங்கள் — அனுமதிப்பவரும் தணிக்கையாளரும் அதைப் படிப்பார்கள். எதுவும் கேட்கப்படவில்லை.',
    askRefused: 'கேட்கப்படவில்லை:', askRefusedNoWords: 'கேட்கப்படவில்லை — தலைமை அலுவலகம் கோரிக்கையை ஏற்கவில்லை.',
    askLostLink: 'தலைமை அலுவலகத்துடன் இணைப்பு இல்லை — எதுவும் கேட்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    notConnected: 'மாதத்தை மூடுவதும் மீண்டும் திறப்பதும் தலைமை அலுவலகத்தில், இரண்டாம் நபரின் அனுமதியுடன் நடக்கும் — இந்தத் திரை தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை. எதுவும் மாற்றப்படவில்லை.',
    closedDone: 'மூடிக் கையெழுத்திடப்பட்டது. {who} கையெழுத்திட்டார்; அந்த அனுமதி இப்போது பயன்படுத்தப்பட்டுவிட்டது. மூடிய மாதம் ஒருபோதும் திருத்தப்படாது — திருத்தம் என்பது திறந்த மாதத்தில் ஒரு புதிய பதிவு.',
    reopenedDone: 'மீண்டும் திறக்கப்பட்டது. {who} அனுமதித்தார்; அந்த அனுமதி இப்போது பயன்படுத்தப்பட்டுவிட்டது. மாதம் மீண்டும் திறந்துள்ளது; அதை மீண்டும் மூடிக் கையெழுத்திட வேண்டும்.',
    useNobody: '{not} — இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை. எதுவும் மாற்றப்படவில்லை.',
    useNoLedger: '{not} — இந்த மாதம் கடை என்ன வசூலித்தது என்று சொல்லவில்லை, எனவே கணக்குகளை எதனுடன் ஒப்பிடுவது என்பதே இல்லை. எதுவும் அனுப்பப்படவில்லை.',
    useBlocked: '{not} — இந்த எண்களுக்கு இன்னும் கையெழுத்திட முடியாது. தடையாக உள்ள அனைத்தும் “இந்த மாதம் மூட எது தடையாக உள்ளது” என்பதன் கீழ் உள்ளன. எதுவும் அனுப்பப்படவில்லை.',
    useNotClosed: '{not} — இந்த மாதம் மூடப்படவில்லை, எனவே மீண்டும் திறக்க எதுவும் இல்லை.',
    useNeedsWhy: '{not} — அனுமதி கேட்டபோது எழுதிய அதே காரணத்தை, மாதத்தை ஏன் மீண்டும் திறக்க வேண்டும் என்று எழுதுங்கள்.',
    notAskedClose: '{not} — இன்னும் யாரிடமும் கையெழுத்து கேட்கப்படவில்லை. முதலில் “கையெழுத்து கேள்” அழுத்தவும்.',
    notAskedReopen: '{not} — இதற்கே இன்னும் யாரிடமும் அனுமதி கேட்கப்படவில்லை. ஏன் என்று எழுதி, முதலில் “அனுமதி கேள்” அழுத்தவும்.',
    waiting: '{not} — மாதத்திற்குக் கையெழுத்திடக்கூடியவர் (கணக்காளர் அல்லது CA — நீங்கள் அல்ல) தனது அனுமதிகள் பக்கத்தில் அனுமதிக்க இன்னும் காத்திருக்கிறது.',
    rejected: '{not} — {who} மறுத்தார்: “{reason}”. அவர் சொன்னதைச் சரிசெய்து மீண்டும் கேளுங்கள்.',
    rejectedNoName: '{not} — மறுக்கப்பட்டது: {reason} அவர் சொன்னதைச் சரிசெய்து மீண்டும் கேளுங்கள்.',
    expired: '{not} — பயன்படுத்தும் முன்பே அனுமதியின் நேரம் முடிந்துவிட்டது. மீண்டும் கேளுங்கள்.',
    used: '{not} — அந்த அனுமதி ஏற்கனவே ஒருமுறை பயன்படுத்தப்பட்டது. ஒரு அனுமதியால் ஒரு முறை மூடலாம் அல்லது ஒரு முறை திறக்கலாம்; மீண்டும் கேளுங்கள்.',
    changedClose: '{not} — அனுமதிக்கப்பட்டது சரியாக இது அல்ல. மீண்டும் கையெழுத்து கேளுங்கள்.',
    changedReopen: '{not} — இந்தக் காரணம் அனுமதிக்கப்பட்ட காரணம் அல்ல (நீங்கள் கேட்ட பிறகு மாறிவிட்டது). இந்தக் காரணத்துடன் மீண்டும் அனுமதி கேளுங்கள்.',
    checkerMayNot: '{not} — அனுமதித்தவருக்கு இப்போது மாதத்திற்குக் கையெழுத்திடும் அதிகாரம் இல்லை, எனவே அவரது அனுமதி செல்லாது. மீண்டும் கேளுங்கள்.',
    namedNotApproved: '{not} — ஒருவரின் பெயரைக் குறிப்பிடுவது அவரது அனுமதி ஆகாது. அனுமதி கேட்டு, இரண்டாம் நபர் தனது அனுமதிகள் பக்கத்தில் அனுமதிக்கும் வரை காத்திருங்கள்.',
    refused: '{not}: {words}', refusedNoWords: '{not} — தலைமை அலுவலகம் ஏற்கவில்லை.',
    lostLink: '{not} — தலைமை அலுவலகத்துடன் இணைப்பு இல்லை. எதுவும் மாற்றப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    hoNotSigned: '{not} — இந்த மாதத்திற்குத் தலைமை அலுவலகத்தில் கையெழுத்து இல்லை. கையெழுத்து கேட்டு, கணக்காளர் அல்லது CA அனுமதிக்கும் வரை காத்திருங்கள்.',
    hoPostedIntoIt: '{not} — கையெழுத்திட்டவரே இந்த மாதத்தில் பதிவுகள் செய்துள்ளார்; அவரே அது சரி என்று சான்றளிக்க முடியாது. மீண்டும் கேட்டு, இந்த மாதத்தில் பதிவு செய்யாத, கையெழுத்திடக்கூடிய வேறொருவரை அனுமதிக்கச் சொல்லுங்கள்.',
    hoTotalsDisagree: '{not} — இந்த மாதத்திற்கான தலைமை அலுவலகத்தின் சொந்த எண்கள் பொருந்தவில்லை. வித்தியாசத்தைச் சரிசெய்து, பிறகு மூடுங்கள்.',
    hoNothingChecked: '{not} — இந்த மாதத்திற்குச் சரிபார்க்க தலைமை அலுவலகத்திடம் எண்கள் எதுவும் இல்லை, எனவே கையெழுத்திட முடியாது.',
    hoSamePlace: '{not} — தலைமை அலுவலகத்தில் ஒரு எண்ணின் இரு பக்கங்களும் ஒரே இடத்திலிருந்து வருகின்றன; அது எதையும் நிரூபிக்காது. மாதத்திற்குக் கையெழுத்திடும் முன் அந்த எண்ணுக்கு இரண்டாவது, தனியான ஆதாரம் தேவை.',
    hoAlreadyClosed: '{not} — இந்த மாதம் தலைமை அலுவலகத்தில் ஏற்கனவே மூடிக் கையெழுத்திடப்பட்டுள்ளது. மாற்ற வேண்டுமானால், இரண்டாம் நபரின் அனுமதியுடன் மீண்டும் திறக்கவும்.',
    hoReopenNeedsApproval: '{not} — மீண்டும் திறக்க இரண்டாம் நபரின் அனுமதி தேவை. ஏன் என்று எழுதி, முதலில் “அனுமதி கேள்” அழுத்தவும்.',
    hoReopenRefused: '{not} — தலைமை அலுவலகத்தில் இந்த மாதம் மூடப்பட்டதாக இல்லை, எனவே மீண்டும் திறக்க எதுவும் இல்லை.',
    hoReopenNeedsReason: '{not} — மீண்டும் திறக்க எழுத்தில் ஒரு காரணம் தேவை. ஏன் என்று எழுதி மீண்டும் கேளுங்கள்.',
  },
};

export const MONTH_COPY_KEYS: readonly MonthCopyKey[] = Object.freeze(Object.keys(FINANCE_MONTH_COPY.en) as MonthCopyKey[]);

/** Head office's month refusals, each with its words. */
const MONTH_REFUSAL_COPY: Readonly<Record<MonthRefusalCode, MonthCopyKey>> = Object.freeze({
  not_signed: 'hoNotSigned',
  closed_by_whoever_posted: 'hoPostedIntoIt',
  control_total_does_not_agree: 'hoTotalsDisagree',
  nothing_was_checked: 'hoNothingChecked',
  both_sides_from_the_same_place: 'hoSamePlace',
  already_closed: 'hoAlreadyClosed',
  reopen_needs_approval: 'hoReopenNeedsApproval',
  reopen_refused: 'hoReopenRefused',
  reopen_needs_a_reason: 'hoReopenNeedsReason',
});

const MONTH_NAMES: Readonly<Record<Lang, readonly string[]>> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ta: ['ஜனவரி', 'பிப்ரவரி', 'மார்ச்', 'ஏப்ரல்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆகஸ்ட்', 'செப்டம்பர்', 'அக்டோபர்', 'நவம்பர்', 'டிசம்பர்'],
};

/** "2026-09" → "September 2026" (or the Tamil month): how a person names a month. Anything else is shown as it is. */
export function monthName(lang: Lang, period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  const name = m === null ? undefined : MONTH_NAMES[lang][Number(m[2]) - 1];
  return m === null || name === undefined ? period : `${name} ${m[1]}`;
}

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

/** A refusal from the month's route: head office's month codes in plain words, the engine's approval codes the same
 *  way every screen reads them (`useOutcomeOfRefusal`), anything else in head office's own words. */
export function monthOutcomeOfRefusal(code: string, whatHappened: string): MonthUseOutcome {
  if ((MONTH_REFUSAL_CODES as readonly string[]).includes(code)) {
    return { kind: 'head_office_refused', code: code as MonthRefusalCode, whatHappened };
  }
  const o = useOutcomeOfRefusal(code, whatHappened);
  // `useOutcomeOfRefusal` never answers "done" or "cannot check"; a refusal is never read as success.
  if (o.kind === 'done' || o.kind === 'cannot_check') return { kind: 'refused', code, whatHappened };
  return o;
}

/** Where an ask stands, in words — tone + icon + words, never colour alone. */
export function presentMonthAsk(lang: Lang, action: MonthAction, o: MonthAskOutcome): StatusPresentation {
  const t = translator(FINANCE_MONTH_COPY, lang);
  const err = (label: string): StatusPresentation => presentStatus({ tone: 'error', icon: '✕', label, needsAttention: true });
  switch (o.kind) {
    // Waiting is a pending state — a person has to come back to it — with its own icon and words.
    case 'asked': return presentScreenState({ state: 'pending', label: `${t(action === 'close' ? 'askedClose' : 'askedReopen')} ${o.request.summary}` });
    case 'nobody_named': return err(t('askNobody'));
    case 'not_connected': return err(t('notConnected'));
    case 'blocked': return err(t(o.refusal === 'the_shop_has_not_told_us_what_it_took' ? 'askNoLedger' : 'askBlocked'));
    case 'not_closed': return err(t('askNotClosed'));
    case 'needs_why': return err(t('askNeedsWhy'));
    case 'refused': return err(o.whatHappened.trim() === '' ? t('askRefusedNoWords') : `${t('askRefused')} ${o.whatHappened.trim()}`);
    case 'lost_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('askLostLink'), needsAttention: true });
  }
}

/** Where closing / reopening stands, in words. */
export function presentMonthUse(lang: Lang, action: MonthAction, o: MonthUseOutcome): StatusPresentation {
  const t = translator(FINANCE_MONTH_COPY, lang);
  const not = t(action === 'close' ? 'notClosed' : 'notReopened');
  const say = (key: MonthCopyKey, values: Readonly<Record<string, string>> = {}): string => fill(t(key), { not, ...values });
  const err = (label: string): StatusPresentation => presentStatus({ tone: 'error', icon: '✕', label, needsAttention: true });
  const warn = (label: string): StatusPresentation => presentStatus({ tone: 'degraded', icon: '⚠', label, needsAttention: true });
  const who = (name: string | null): string => (name === null || name.trim() === '' ? t('someone') : name);
  switch (o.kind) {
    case 'done':
      return presentStatus({ tone: 'ok', icon: '✓', needsAttention: false,
        label: say(action === 'close' ? 'closedDone' : 'reopenedDone', { who: who(o.approvedBy) }) });
    case 'nobody_named': return err(say('useNobody'));
    case 'not_connected': return err(t('notConnected'));
    case 'blocked': return err(say(o.refusal === 'the_shop_has_not_told_us_what_it_took' ? 'useNoLedger' : 'useBlocked'));
    case 'not_closed': return err(say('useNotClosed'));
    case 'needs_why': return err(say('useNeedsWhy'));
    case 'not_asked': return warn(say(action === 'close' ? 'notAskedClose' : 'notAskedReopen'));
    case 'waiting': return presentScreenState({ state: 'pending', label: say('waiting') });
    case 'rejected': {
      const reason = o.reason.trim() === '' ? '—' : o.reason.trim();
      return err(o.decidedBy === null || o.decidedBy.trim() === ''
        ? say('rejectedNoName', { reason })
        : say('rejected', { who: o.decidedBy, reason }));
    }
    case 'expired': return warn(say('expired'));
    case 'used': return warn(say('used'));
    case 'changed': return warn(say(action === 'close' ? 'changedClose' : 'changedReopen'));
    case 'checker_may_not_approve': return err(say('checkerMayNot'));
    case 'named_not_approved': return err(say('namedNotApproved'));
    case 'head_office_refused': return err(say(MONTH_REFUSAL_COPY[o.code]));
    case 'refused': return err(o.whatHappened.trim() === '' ? say('refusedNoWords') : say('refused', { words: o.whatHappened.trim() }));
    case 'lost_link': return warn(say('lostLink'));
  }
}

export interface FinanceSession {
  /** The month, both sides of every figure, and what is outstanding. */
  period(): PeriodView;
  /** The pack a CA signs — or the same pack marked NOT signable, saying why. */
  evidence(): EvidencePack | { readonly signable: false; readonly why: string };
  /**
   * The LOCAL check of this box's figures: would this month close? Returns every blocker at once. It closes NOTHING —
   * a month is closed at head office, with a second person's signature (`closeWithApproval`).
   */
  close(): CloseOutcome;
  /** True when this screen is wired to head office (its approval engine and the month routes). */
  readonly connected: boolean;
  /** The closer asks for the month's signature (`period_close`, details `{ period }`) in their own session. Refused
   *  locally — nothing asked — with nobody named, with no head office behind the page, or when the figures here cannot
   *  be signed. `note` is optional: what the signer reads. */
  askToClose(lang: Lang, note: string): Promise<MonthAskOutcome>;
  /** Close the month at head office, naming the closer's own APPROVED `period_close` request for this month. Not
   *  asked, waiting, rejected (who and why), expired, used — each is said plainly, and nothing is sent. */
  closeWithApproval(): Promise<MonthUseOutcome>;
  /** Ask a second person to approve reopening this month for exactly this reason (`period_reopen`, details
   *  `{ reason, period }`). Refused locally without a reason, when the month is not closed, or when not wired. */
  askToReopen(lang: Lang, reason: string): Promise<MonthAskOutcome>;
  /** Reopen at head office with this reason, naming the caller's own APPROVED request for exactly it. A changed reason
   *  is asked again. Never a typed approver. */
  reopenWithApproval(reason: string): Promise<MonthUseOutcome>;
  /** Where the caller's own newest requests for this month stand (a GET — read only). */
  yourRequests(lang: Lang): Promise<MonthRequestsView>;
  presentAskOutcome(lang: Lang, action: MonthAction, outcome: MonthAskOutcome): StatusPresentation;
  presentUseOutcome(lang: Lang, action: MonthAction, outcome: MonthUseOutcome): StatusPresentation;
}

export function createFinanceSession(config: FinanceConfig, ports: FinancePorts): FinanceSession {
  const NO_LEDGER =
    'this store box has not told finance what the shop took in this period, so there is nothing to check the accounts against. A month cannot close on one side of a comparison.';

  /** What head office did from THIS screen just now (closed or reopened the month) — the box's word catches up later. */
  let atHeadOffice: { readonly closed: boolean; readonly closedBy?: string; readonly signedBy?: string } | undefined;
  const stateNow = (): { readonly closed: boolean; readonly closedBy?: string; readonly closedAt?: string; readonly signedBy?: string } =>
    atHeadOffice ?? ports.periodState();

  const connected = ports.askApproval !== undefined && ports.approvalInbox !== undefined
    && ports.closeAtHeadOffice !== undefined && ports.reopenAtHeadOffice !== undefined;

  const totalsNow = (): readonly ControlTotal[] | undefined => {
    const ledger = ports.ledger();
    if (ledger === undefined) return undefined;
    return buildControlTotals({
      period: config.period,
      ledger,
      postings: ports.postings(),
      journalPrefixes: config.journalPrefixes,
    });
  };

  const view = (): PeriodView => {
    const built = totalsNow();
    const state = stateNow();
    const postings = ports.postings();
    const validated = built === undefined ? undefined : validateControlTotals(built);
    return {
      period: config.period,
      totals: validated?.results,
      ...(built === undefined ? { whyNoTotals: NO_LEDGER } : {}),
      // **Not true when there are no totals.** "Everything reconciles" about nothing is the
      // sentence this whole module exists to prevent.
      allReconcile: validated?.allReconcile ?? false,
      posted: postedSide(postings),
      deadLettered: deadLetters(postings),
      unsentSyncCount: ports.unsentSyncCount(),
      openExceptionCount: ports.openExceptionCount(),
      closed: state.closed,
      ...(state.closedBy === undefined ? {} : { closedBy: state.closedBy }),
      ...(state.closedAt === undefined ? {} : { closedAt: state.closedAt }),
      ...(state.signedBy === undefined ? {} : { signedBy: state.signedBy }),
    };
  };

  const close = (): CloseOutcome => {
    if (config.userId === null) {
      return {
        ok: false,
        refusal: CLOSE_REFUSAL_VALUES.nobody_is_named_at_this_desk,
        detail: 'this store box has not been told who is using this screen. A month close carries the name of whoever closed it, and a CA signs after them.',
      };
    }
    const built = totalsNow();
    if (built === undefined) {
      // The refusal that matters most, and the one an empty list would have hidden: with no
      // ledger side there is nothing to compare, and `closePeriod` over an empty list of totals
      // would find nothing that disagrees and close the month.
      return {
        ok: false,
        refusal: CLOSE_REFUSAL_VALUES.the_shop_has_not_told_us_what_it_took,
        detail: NO_LEDGER,
      };
    }

    const postings = ports.postings();
    const result = closePeriod(
      {
        period: config.period,
        tenantId: config.tenantId,
        totals: built,
        deadLetteredCount: deadLetters(postings).length,
        unsentSyncCount: ports.unsentSyncCount(),
        openExceptionCount: ports.openExceptionCount(),
        tradingDayCutoff: config.tradingDayCutoff,
        closedBy: config.userId,
        at: config.now,
      },
      stateNow().closed ? 'closed' : 'open',
    );

    return result.closed
      ? { ok: true, result }
      : { ok: false, refusal: CLOSE_REFUSAL_VALUES.blocked, detail: result.detail, result };
  };

  /** The checks every close step makes before anything reaches head office: who, wired, and this box's own evidence. */
  const beforeClosing = (): MonthLocalRefusal | null => {
    if (config.userId === null) return { kind: 'nobody_named' };
    if (!connected) return { kind: 'not_connected' };
    const local = close();
    if (!local.ok) {
      // `nobody_is_named_at_this_desk` was answered above; what is left is the figures themselves.
      const refusal = local.refusal === 'the_shop_has_not_told_us_what_it_took' ? local.refusal : 'blocked';
      return { kind: 'blocked', refusal, detail: local.detail };
    }
    return null;
  };

  /** The checks every reopen step makes before anything reaches head office. */
  const beforeReopening = (reason: string): MonthLocalRefusal | null => {
    if (config.userId === null) return { kind: 'nobody_named' };
    if (!connected) return { kind: 'not_connected' };
    if (!stateNow().closed) return { kind: 'not_closed' };
    if (reason.trim() === '') return { kind: 'needs_why' };
    return null;
  };

  const ask = async (request: ApprovalAsk): Promise<MonthAskOutcome> => {
    const port = ports.askApproval;
    if (port === undefined) return { kind: 'not_connected' };
    const asked = await port(request);
    if (asked.result === 'asked') return { kind: 'asked', request: asked.request };
    if (asked.result === 'lost_link') return { kind: 'lost_link' };
    return { kind: 'refused', code: asked.code, whatHappened: asked.whatHappened };
  };

  return {
    period: view,

    evidence: () => {
      const built = totalsNow();
      if (built === undefined) return { signable: false, why: NO_LEDGER };
      return buildEvidencePack({
        period: config.period,
        tenantId: config.tenantId,
        totals: built,
        tradingDayCutoff: config.tradingDayCutoff,
        // The pack names who prepared it. An unnamed pack is one nobody can be asked about.
        preparedBy: config.userId ?? 'nobody named',
        at: config.now,
        deadLetteredCount: deadLetters(ports.postings()).length,
      });
    },

    close,
    connected,

    // The CLOSER's step: ask for the signature of exactly this month. Nothing is closed by asking.
    askToClose: async (lang, note) => {
      const refused = beforeClosing();
      if (refused !== null) return refused;
      const t = translator(FINANCE_MONTH_COPY, lang);
      return ask({
        kind: PERIOD_CLOSE_KIND, subjectRef: config.period,
        // EXACTLY what the close route fingerprints: its body (nothing but the approval) plus the month — `{ period }`.
        details: periodCloseDetails(config.period), valueMinor: null,
        summary: fill(t('summaryClose'), { month: monthName(lang, config.period) }),
        reason: note.trim() === '' ? t('closeReasonDefault') : note.trim(),
      });
    },

    // The close, naming the closer's own APPROVED request for this month. Never a typed signer.
    closeWithApproval: async () => {
      const refused = beforeClosing();
      if (refused !== null) return refused;
      const found = await findOwnApproval(ports.approvalInbox, PERIOD_CLOSE_KIND, config.period, periodCloseDetails(config.period), null);
      if (!('requestId' in found)) return found.kind === 'done' || found.kind === 'cannot_check' ? { kind: 'not_asked' } : found;
      const r = await ports.closeAtHeadOffice!({ period: config.period, approvalId: found.requestId });
      if (r.result === 'lost_link') return { kind: 'lost_link' };
      if (r.result === 'refused') return monthOutcomeOfRefusal(r.code, r.whatHappened);
      atHeadOffice = {
        closed: true,
        ...(config.userId === null ? {} : { closedBy: config.userId }),
        ...(found.decidedBy === null ? {} : { signedBy: found.decidedBy }),
      };
      return { kind: 'done', detail: r.detail, approvedBy: found.decidedBy };
    },

    // Ask a second person to approve reopening for exactly this reason. Nothing is reopened by asking.
    askToReopen: async (lang, reason) => {
      const refused = beforeReopening(reason);
      if (refused !== null) return refused;
      const t = translator(FINANCE_MONTH_COPY, lang);
      const why = reason.trim();
      return ask({
        kind: PERIOD_REOPEN_KIND, subjectRef: config.period,
        // EXACTLY what the reopen route fingerprints: its body less the approval, plus the month — `{ reason, period }`.
        details: periodReopenDetails(why, config.period), valueMinor: null,
        summary: fill(t('summaryReopen'), { month: monthName(lang, config.period) }),
        reason: why,
      });
    },

    // The reopen, naming the caller's own APPROVED request for exactly this reason. Never a typed approver.
    reopenWithApproval: async (reason) => {
      const refused = beforeReopening(reason);
      if (refused !== null) return refused;
      const why = reason.trim();
      const found = await findOwnApproval(ports.approvalInbox, PERIOD_REOPEN_KIND, config.period, periodReopenDetails(why, config.period), null);
      if (!('requestId' in found)) return found.kind === 'done' || found.kind === 'cannot_check' ? { kind: 'not_asked' } : found;
      const r = await ports.reopenAtHeadOffice!({ period: config.period, reason: why, approvalId: found.requestId });
      if (r.result === 'lost_link') return { kind: 'lost_link' };
      if (r.result === 'refused') return monthOutcomeOfRefusal(r.code, r.whatHappened);
      atHeadOffice = { closed: false };
      return { kind: 'done', detail: r.detail, approvedBy: found.decidedBy };
    },

    yourRequests: async (lang) => {
      const none = (state: MonthRequestsView['state']): MonthRequestsView => ({ state, close: null, reopen: null, closeAsked: false, reopenReason: null });
      if (!connected || ports.approvalInbox === undefined) return none('not_connected');
      const read = await ports.approvalInbox();
      if (read.result !== 'read') return none(read.result);
      const newest = (kind: string): ApprovalRequestView | undefined => read.inbox.mine
        .filter((r) => r.kind === kind && r.subjectRef === config.period)
        .slice().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
      const inPlay = (r: ApprovalRequestView | undefined): boolean => r !== undefined && (r.status === 'waiting' || r.status === 'approved');
      // A used request is history — the action it allowed is done — so it is not shown as where things stand.
      const shown = (r: ApprovalRequestView | undefined): StatusPresentation | null =>
        (r === undefined || r.status === 'used' ? null : presentRequestStatus(lang, r));
      const closeRow = newest(PERIOD_CLOSE_KIND);
      const reopenRow = newest(PERIOD_REOPEN_KIND);
      const reason = reopenRow?.details['reason'];
      return {
        state: 'read', close: shown(closeRow), reopen: shown(reopenRow), closeAsked: inPlay(closeRow),
        reopenReason: inPlay(reopenRow) && typeof reason === 'string' && reason.trim() !== '' ? reason : null,
      };
    },

    presentAskOutcome: (lang, action, outcome) => presentMonthAsk(lang, action, outcome),
    presentUseOutcome: (lang, action, outcome) => presentMonthUse(lang, action, outcome),
  };
}
