// CLOSING AND REOPENING A MONTH — on head office's Month-end page only (OB-567, owner, 31 Oct 2026 · M23-FR-04 · WF-18 ·
// ADR-0024 · §28 · audit PA-03 · P-08 · hard rules #2 and #10).
//
// The owner decided that a month is closed only on head office's Month-end page. The two-person steps that used to sit on
// the office Finance page live here now, unchanged in their rules, over the SAME head-office routes:
//
//   1. the CLOSER (who holds `finance.period.close`) presses **Ask for the signature**: a `period_close` request for exactly
//      this month (`{ period }`), in their own session;
//   2. someone who may SIGN a month (`finance.period.sign` — the accountant, the CA, the owner), never the closer, approves
//      or rejects it on their own Approvals page;
//   3. **Close the month** finds the closer's own APPROVED request for this month and posts the close naming it
//      (`approvalId`). Head office checks ITS OWN control totals at that moment and refuses a month with nothing checked
//      (`nothing_was_checked`), figures that do not agree, or a signer who posted into the month — every refusal said in
//      plain words, the month left open and the signature unspent.
//
// Reopening is the same (`period_reopen`, details `{ reason, period }`), for exactly the written reason. The figures are
// head office's: the Month-end page holds no local copy of the shop's takings to judge them by, so it never refuses on a
// guess of its own — head office decides, and the page says what it said. Whether the month is closed is read from head
// office (`GET /v1/finance/periods`); when that cannot be read the page says so and offers nothing on a guess.
//
// The words, the request bodies, the approval details and the refusal mapping are the tested ones in `finance-session.ts`
// (`FINANCE_MONTH_COPY`, `periodCloseDetails`, `presentMonthUse` …) — one set, so the two pages could never say it differently.

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import { presentRequestStatus, type ApprovalAsk, type ApprovalRequestView, type AskResult, type InboxRead } from './approvals-session';
import { findOwnApproval } from './catalogue-session';
import {
  FINANCE_MONTH_COPY, PERIOD_CLOSE_KIND, PERIOD_REOPEN_KIND, monthName, monthOutcomeOfRefusal, periodCloseDetails, periodReopenDetails,
  presentMonthAsk, presentMonthUse, type MonthAction, type MonthLocalRefusal, type MonthActionResult, type MonthAskOutcome, type MonthRequestsView, type MonthUseOutcome,
} from './finance-session';

/** Head office as the Month-end page reaches it — every call in the signed-in person's OWN session. */
export interface MonthClosePorts {
  /** POST /v1/approvals/requests — the caller is the maker. */
  askApproval(ask: ApprovalAsk): Promise<AskResult>;
  /** GET /v1/approvals/requests — read only. */
  approvalInbox(): Promise<InboxRead>;
  /** POST /v1/finance/periods/:period/close, body `{ approvalId }`. */
  closeAtHeadOffice(input: { readonly period: string; readonly approvalId: string }): Promise<MonthActionResult>;
  /** POST /v1/finance/periods/:period/reopen, body `{ reason, approvalId }`. */
  reopenAtHeadOffice(input: { readonly period: string; readonly reason: string; readonly approvalId: string }): Promise<MonthActionResult>;
  /** GET /v1/finance/periods — whether head office has the month closed; `undefined` when it could not be read. */
  monthState(period: string): Promise<{ readonly closed: boolean } | undefined>;
}

export interface MonthCloseConfig {
  /** Who is looking. `null`: the store computer was not told — nothing is asked, closed or reopened under no name. */
  readonly userId: string | null;
  /** Whether they hold `finance.period.close` (the route's own word): the steps are offered only then. */
  readonly mayClose: boolean;
}

/** The route permission the steps are offered to — the same code head office checks. */
export const MONTH_CLOSE_PERMISSION = 'finance.period.close';

/** Where the month stands at head office, as the page shows it. */
export type MonthStateView =
  | { readonly known: true; readonly closed: boolean }
  | { readonly known: false };

// ── The page's own words (the steps' outcomes are FINANCE_MONTH_COPY's) ─────────────────────────────────────────────

export type MonthPageKey =
  | 'tab' | 'heading' | 'lede' | 'stateOpen' | 'stateClosed' | 'stateUnknown' | 'pickMonth' | 'mayNot'
  | 'closeTitle' | 'closeLead' | 'closeWhyLabel' | 'askClose' | 'closeMonth' | 'closeNote'
  | 'reopenTitle' | 'reopenLead' | 'reopenReasonLabel' | 'askReopen' | 'reopenIt' | 'yourRequest';

export const MONTH_PAGE_COPY: BilingualCopy<MonthPageKey> = {
  en: {
    tab: 'Close or reopen the month', heading: 'Close or reopen the month',
    lede: 'A month is closed here, at head office, and nowhere else. Closing needs the signature of someone who may sign a month — the accountant or the CA, never you — and head office checks its own figures before it closes anything. A closed month is never edited — a correction is a new entry in the open one.',
    stateOpen: 'This month is open at head office.', stateClosed: 'This month is closed and signed at head office.',
    stateUnknown: 'Head office could not be reached, so whether this month is closed is not known. Nothing is offered on a guess.',
    pickMonth: 'Choose a month first.', mayNot: 'You can see whether the month is closed, but closing or reopening a month needs the month-close permission.',
    closeTitle: 'Close and sign this month',
    closeLead: 'Press “Ask for the signature”. Once the accountant or the CA approves it on their Approvals page, press “Close the month”. Head office then checks its own figures and closes the month, or says what stops it.',
    closeWhyLabel: 'A note for the person signing (optional)', askClose: 'Ask for the signature', closeMonth: 'Close the month',
    closeNote: 'Nothing is closed until head office’s own figures agree and someone else has signed.',
    reopenTitle: 'Reopen this month',
    reopenLead: 'A signed month reopens only with the approval of someone who may sign a month — the accountant or the CA, never you. Write why and press “Ask for approval”. Once they approve it on their Approvals page, press “Reopen the month” with the same reason.',
    reopenReasonLabel: 'Why does it need reopening?', askReopen: 'Ask for approval', reopenIt: 'Reopen the month', yourRequest: 'Your request',
  },
  ta: {
    tab: 'மாதத்தை மூடு அல்லது மீண்டும் திற', heading: 'மாதத்தை மூடு அல்லது மீண்டும் திற',
    lede: 'மாதம் இங்கே, தலைமை அலுவலகத்தில் மட்டுமே மூடப்படுகிறது. மூட, மாதத்திற்குக் கையெழுத்திடக்கூடியவரின் கையெழுத்து தேவை — கணக்காளர் அல்லது பட்டயக் கணக்காளர் (CA), ஒருபோதும் நீங்கள் அல்ல — எதையும் மூடும் முன் தலைமை அலுவலகம் தனது சொந்த எண்களைச் சரிபார்க்கும். மூடிய மாதம் திருத்தப்படாது — திருத்தம் என்பது திறந்த மாதத்தில் ஒரு புதிய பதிவு.',
    stateOpen: 'இந்த மாதம் தலைமை அலுவலகத்தில் திறந்துள்ளது.', stateClosed: 'இந்த மாதம் தலைமை அலுவலகத்தில் மூடிக் கையெழுத்திடப்பட்டுள்ளது.',
    stateUnknown: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இந்த மாதம் மூடப்பட்டதா என்று தெரியவில்லை. ஊகத்தின் பேரில் எதுவும் வழங்கப்படவில்லை.',
    pickMonth: 'முதலில் ஒரு மாதத்தைத் தேர்ந்தெடுக்கவும்.', mayNot: 'மாதம் மூடப்பட்டதா என்று பார்க்கலாம், ஆனால் மாதத்தை மூட அல்லது மீண்டும் திறக்க மாத முடிப்பு அனுமதி தேவை.',
    closeTitle: 'இந்த மாதத்தை மூடிக் கையெழுத்திடு',
    closeLead: '“கையெழுத்து கேள்” அழுத்தவும். கணக்காளர் அல்லது CA தனது அனுமதிகள் பக்கத்தில் அனுமதித்ததும், “மாதத்தை மூடு” அழுத்தவும். பிறகு தலைமை அலுவலகம் தனது சொந்த எண்களைச் சரிபார்த்து மாதத்தை மூடும், அல்லது எது தடுக்கிறது என்று சொல்லும்.',
    closeWhyLabel: 'கையெழுத்திடுபவருக்கு ஒரு குறிப்பு (விருப்பமானால்)', askClose: 'கையெழுத்து கேள்', closeMonth: 'மாதத்தை மூடு',
    closeNote: 'தலைமை அலுவலகத்தின் சொந்த எண்கள் பொருந்தி, வேறொருவர் கையெழுத்திடும் வரை எதுவும் மூடப்படாது.',
    reopenTitle: 'இந்த மாதத்தை மீண்டும் திற',
    reopenLead: 'கையெழுத்திட்ட மாதம், மாதத்திற்குக் கையெழுத்திடக்கூடியவரின் அனுமதியுடன் மட்டுமே மீண்டும் திறக்கும் — கணக்காளர் அல்லது பட்டயக் கணக்காளர் (CA), ஒருபோதும் நீங்கள் அல்ல. ஏன் என்று எழுதி “அனுமதி கேள்” அழுத்தவும். அவர் தனது அனுமதிகள் பக்கத்தில் அனுமதித்ததும், அதே காரணத்துடன் “மாதத்தை மீண்டும் திற” அழுத்தவும்.',
    reopenReasonLabel: 'ஏன் மீண்டும் திறக்க வேண்டும்?', askReopen: 'அனுமதி கேள்', reopenIt: 'மாதத்தை மீண்டும் திற', yourRequest: 'உங்கள் கோரிக்கை',
  },
};

export const MONTH_PAGE_KEYS: readonly MonthPageKey[] = Object.freeze(Object.keys(MONTH_PAGE_COPY.en) as MonthPageKey[]);

export interface MonthCloseSession {
  readonly mayClose: boolean;
  text(lang: Lang, key: MonthPageKey): string;
  /** Whether head office has the month closed (a GET — read only). */
  state(period: string): Promise<MonthStateView>;
  /** The closer asks for the month's signature (`period_close`, details `{ period }`). Nothing is closed by asking. */
  askToClose(lang: Lang, period: string, note: string): Promise<MonthAskOutcome>;
  /** Close at head office, naming the closer's own APPROVED request for this month — or say plainly why not. */
  closeWithApproval(period: string): Promise<MonthUseOutcome>;
  /** Ask a second person to approve reopening for exactly this reason (`period_reopen`, details `{ reason, period }`). */
  askToReopen(lang: Lang, period: string, reason: string): Promise<MonthAskOutcome>;
  /** Reopen at head office naming the caller's own APPROVED request for exactly this reason. Never a typed approver. */
  reopenWithApproval(period: string, reason: string): Promise<MonthUseOutcome>;
  /** Where the caller's own newest requests for this month stand (a GET — read only). */
  yourRequests(lang: Lang, period: string): Promise<MonthRequestsView>;
  presentAskOutcome(lang: Lang, action: MonthAction, outcome: MonthAskOutcome): StatusPresentation;
  presentUseOutcome(lang: Lang, action: MonthAction, outcome: MonthUseOutcome): StatusPresentation;
  presentState(lang: Lang, state: MonthStateView): StatusPresentation;
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

export function createMonthCloseSession(config: MonthCloseConfig, ports: MonthClosePorts): MonthCloseSession {
  const text = (lang: Lang, key: MonthPageKey): string => translator(MONTH_PAGE_COPY, lang)(key);

  const ask = async (request: ApprovalAsk): Promise<MonthAskOutcome> => {
    const asked = await ports.askApproval(request);
    if (asked.result === 'asked') return { kind: 'asked', request: asked.request };
    if (asked.result === 'lost_link') return { kind: 'lost_link' };
    return { kind: 'refused', code: asked.code, whatHappened: asked.whatHappened };
  };
  /** Who is asking. The figures are head office's to judge — the page never refuses on a guess of its own. (The page asks
   *  for a month before any step; a value that is not a month is never sent — head office would refuse it by name.) */
  const before = (period: string): MonthLocalRefusal | null => {
    if (config.userId === null) return { kind: 'nobody_named' };
    if (!PERIOD.test(period)) return { kind: 'not_connected' };
    return null;
  };
  const beforeReopening = async (period: string, reason: string): Promise<MonthLocalRefusal | null> => {
    const refused = before(period);
    if (refused !== null) return refused;
    if (reason.trim() === '') return { kind: 'needs_why' };
    // Only head office's own word that the month is OPEN refuses here; when it cannot be read, head office decides.
    const s = await ports.monthState(period);
    if (s !== undefined && !s.closed) return { kind: 'not_closed' };
    return null;
  };
  const use = async (r: MonthActionResult, decidedBy: string | null): Promise<MonthUseOutcome> => {
    if (r.result === 'lost_link') return { kind: 'lost_link' };
    if (r.result === 'refused') return monthOutcomeOfRefusal(r.code, r.whatHappened);
    return { kind: 'done', detail: r.detail, approvedBy: decidedBy };
  };

  return {
    mayClose: config.mayClose,
    text,

    state: async (period) => {
      if (!PERIOD.test(period)) return { known: false };
      const s = await ports.monthState(period);
      return s === undefined ? { known: false } : { known: true, closed: s.closed };
    },

    askToClose: async (lang, period, note) => {
      const refused = before(period);
      if (refused !== null) return refused;
      const t = translator(FINANCE_MONTH_COPY, lang);
      return ask({
        kind: PERIOD_CLOSE_KIND, subjectRef: period,
        // EXACTLY what the close route fingerprints: its body (nothing but the approval) plus the month — `{ period }`.
        details: periodCloseDetails(period), valueMinor: null,
        summary: fill(t('summaryClose'), { month: monthName(lang, period) }),
        reason: note.trim() === '' ? t('closeReasonDefault') : note.trim(),
      });
    },

    closeWithApproval: async (period) => {
      const refused = before(period);
      if (refused !== null) return refused;
      const found = await findOwnApproval(() => ports.approvalInbox(), PERIOD_CLOSE_KIND, period, periodCloseDetails(period), null);
      if (!('requestId' in found)) return found.kind === 'done' || found.kind === 'cannot_check' ? { kind: 'not_asked' } : found;
      return use(await ports.closeAtHeadOffice({ period, approvalId: found.requestId }), found.decidedBy);
    },

    askToReopen: async (lang, period, reason) => {
      const refused = await beforeReopening(period, reason);
      if (refused !== null) return refused;
      const t = translator(FINANCE_MONTH_COPY, lang);
      const why = reason.trim();
      return ask({
        kind: PERIOD_REOPEN_KIND, subjectRef: period,
        // EXACTLY what the reopen route fingerprints: its body less the approval, plus the month — `{ reason, period }`.
        details: periodReopenDetails(why, period), valueMinor: null,
        summary: fill(t('summaryReopen'), { month: monthName(lang, period) }),
        reason: why,
      });
    },

    reopenWithApproval: async (period, reason) => {
      const refused = await beforeReopening(period, reason);
      if (refused !== null) return refused;
      const why = reason.trim();
      const found = await findOwnApproval(() => ports.approvalInbox(), PERIOD_REOPEN_KIND, period, periodReopenDetails(why, period), null);
      if (!('requestId' in found)) return found.kind === 'done' || found.kind === 'cannot_check' ? { kind: 'not_asked' } : found;
      return use(await ports.reopenAtHeadOffice({ period, reason: why, approvalId: found.requestId }), found.decidedBy);
    },

    yourRequests: async (lang, period) => {
      const none = (state: MonthRequestsView['state']): MonthRequestsView => ({ state, close: null, reopen: null, closeAsked: false, reopenReason: null });
      const read = await ports.approvalInbox();
      if (read.result !== 'read') return none(read.result);
      const newest = (kind: string): ApprovalRequestView | undefined => read.inbox.mine
        .filter((r) => r.kind === kind && r.subjectRef === period)
        .slice().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
      const inPlay = (r: ApprovalRequestView | undefined): boolean => r !== undefined && (r.status === 'waiting' || r.status === 'approved');
      // A used request is history — the action it allowed is done — so it is not shown as where things stand.
      const shown = (r: ApprovalRequestView | undefined): StatusPresentation | null => (r === undefined || r.status === 'used' ? null : presentRequestStatus(lang, r));
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
    presentState: (lang, s) => {
      const t = translator(MONTH_PAGE_COPY, lang);
      if (!s.known) return presentStatus({ tone: 'degraded', icon: '⚠', label: t('stateUnknown'), needsAttention: true });
      return s.closed
        ? presentStatus({ tone: 'ok', icon: '🔒', label: t('stateClosed'), needsAttention: false })
        : presentStatus({ tone: 'idle', icon: '○', label: t('stateOpen'), needsAttention: false });
    },
  };
}
