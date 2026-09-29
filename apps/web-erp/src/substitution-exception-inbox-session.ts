// The delivery-substitution EXCEPTION inbox — the supervisor's / service desk's / finance queue's work screen
// (M19-FR-01 · Item 2 · P-03 control-by-exception · §28). When a picker swaps a line and the swap leaves money
// or a promise hanging — a refund due, an adjustment to collect, a charge above the cap, a line short-picked —
// the cloud raises an EXCEPTION, routes it to the queue that owns that kind, and starts its SLA clock
// (`GET /v1/orders/substitution-exceptions`, built by the tested `ownedWorklist` / `presentWorklist`).
// An exception raised and left unseen is the exact failure "control by exception" exists to prevent. This is
// the screen that shows them: every open exception worst-first, who holds each, how old it is and whether its
// SLA is breached — and the three human acts a queue member takes from here: CLAIM one (it becomes theirs),
// RELEASE it back to the queue, or RESOLVE it with a reason and the words that ARE the record.
//
// Truths the screen carries, already true in the engine and re-stated so the surface cannot weaken them:
//   • **It self-heals.** The worklist is re-READ from the cloud after every act, so a resolved exception
//     drops off on its own; nothing here carries a "done" flag that could go stale against reality.
//   • **The picker is never the approver (§28).** The cloud refuses a picker's resolve and records the attempt;
//     this screen only offers acts to a queue member who holds `order.exception.work`, and the server decides
//     again whether the caller STAFFS that queue.
//   • **Every act is in the caller's own name, on an explicit click, never on load** (hard rule #6: the
//     exception's history is kept append-only — claim, release, resolve are appended events).
//   • **A resolve carries a reason code and the words** — a resolution with no reason is not a record.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import type { SubstitutionExceptionKind, ExceptionOwnerRole, ExceptionState } from '../../../packages/orders/src/index';

/** One exception as the worklist route hands it over — the kept ownership item with its SLA, never the swap itself. */
export interface SubExceptionView {
  readonly exceptionId: string;
  readonly orderId: string;
  readonly lineId: string;
  readonly kind: SubstitutionExceptionKind;
  readonly amountMinor: number;
  readonly detail: string;
  readonly owner: ExceptionOwnerRole;
  readonly state: ExceptionState;
  /** The named person working it; absent = sitting in the queue. */
  readonly assignedTo?: string;
  /** The picker who proposed the swap that raised this — recorded, never the approver. */
  readonly proposedBy?: string;
  readonly reasonCode: string;
  readonly raisedAt: string;
  readonly sla: { readonly ageMinutes: number; readonly dueAt: string; readonly breached: boolean };
}

/** The worklist body (`GET /v1/orders/substitution-exceptions`). Includes resolved items; `open` and `queues` do not. */
export interface SubExceptionWorklistData {
  readonly exceptions: readonly SubExceptionView[];
  readonly count: number;
  readonly atRiskMinor: number;
  readonly open: { readonly count: number; readonly atRiskMinor: number; readonly breached: number };
  readonly queues: Readonly<Record<ExceptionOwnerRole, number>>;
}

export type ExceptionAction = 'claim' | 'release' | 'resolve';
/** The outcome of an act — recorded, refused by the server (not your queue / already resolved / permission), or a lost link. */
export type ActionResult = 'done' | 'refused' | 'lost_link';

/** The authenticated POST of a queue member's act. Injected, so the model never opens a socket itself; the
 *  server appends the act to the exception's history in the caller's own name and re-checks queue rights. */
export interface SubExceptionActionPort {
  post(input: { readonly action: ExceptionAction; readonly exceptionId: string; readonly body?: Readonly<Record<string, string>> }): Promise<ActionResult>;
}

export interface SubExceptionInboxPorts {
  /** The worklist the shell last read (live from the cloud, or the injected stand-in). */
  worklist(): SubExceptionWorklistData;
  /** Whether this user may read the exceptions worklist (`order.read`). */
  mayRead(): boolean;
  /** Whether this user may work an exception — claim / release / resolve (`order.exception.work`). */
  mayWork(): boolean;
  /** Records an act. Only reached from an explicit action, never on render. */
  actionPort(): SubExceptionActionPort;
}

export interface SubExceptionInboxConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'kindRefundDue' | 'kindCollectAdjustment' | 'kindAboveCapCharge' | 'kindPolicyShortPick'
  | 'queueFulfilmentSupervisor' | 'queueCustomerServiceDesk' | 'queueFinanceReconQueue' | 'queueDutyManager'
  | 'stateOpen' | 'stateInProgress' | 'stateBreached'
  | 'openHeading' | 'openCount' | 'breachedCount' | 'atRiskLabel' | 'allClear' | 'queuesHeading'
  | 'orderLabel' | 'lineLabel' | 'queueLabel' | 'heldByLabel' | 'heldByYou' | 'inQueue' | 'ageLabel' | 'minutes' | 'proposedByLabel' | 'reasonLabel'
  | 'claimBtn'
  | 'workHeading' | 'whichLabel' | 'reasonCodeLabel' | 'reasonCodePlaceholder' | 'detailLabel' | 'detailPlaceholder' | 'resolveBtn' | 'releaseBtn' | 'nothingHeld'
  | 'claimDone' | 'releaseDone' | 'resolveDone' | 'actionRefused' | 'actionLostLink'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const SUB_EXCEPTION_INBOX_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Delivery exceptions', langName: 'தமிழ்',
    lead: 'Substitutions that left something hanging — a refund due, an adjustment to collect, a charge above the cap, a line short-picked — each routed to the queue that owns it, with an SLA clock. Biggest money first. Claim one to make it yours, release it back, or resolve it with a reason and the words that are the record. The picker who proposed the swap never approves it.',
    kindRefundDue: 'Refund due', kindCollectAdjustment: 'Adjustment to collect', kindAboveCapCharge: 'Charge above the cap', kindPolicyShortPick: 'Short-picked line',
    queueFulfilmentSupervisor: 'Fulfilment supervisor', queueCustomerServiceDesk: 'Customer service desk', queueFinanceReconQueue: 'Finance reconciliation', queueDutyManager: 'Duty manager',
    stateOpen: 'Open', stateInProgress: 'Being worked', stateBreached: 'SLA breached',
    openHeading: 'To work', openCount: 'to work', breachedCount: 'past their SLA', atRiskLabel: 'Money at stake', allClear: 'No open delivery exceptions — nothing outstanding.', queuesHeading: 'By queue',
    orderLabel: 'Order', lineLabel: 'Line', queueLabel: 'Queue', heldByLabel: 'Held by', heldByYou: 'you', inQueue: 'in the queue', ageLabel: 'Age', minutes: 'min', proposedByLabel: 'Proposed by', reasonLabel: 'Reason',
    claimBtn: 'Claim',
    workHeading: 'Work an exception you hold', whichLabel: 'Which exception', reasonCodeLabel: 'Reason code', reasonCodePlaceholder: 'e.g. REFUNDED / COLLECTED / CUSTOMER-INFORMED',
    detailLabel: 'What you did (this is the record)', detailPlaceholder: 'What was done, and why this closes it?', resolveBtn: 'Resolve', releaseBtn: 'Release back to the queue',
    nothingHeld: 'You hold nothing — claim an exception above to work it.',
    claimDone: 'Claimed — it is yours.', releaseDone: 'Released back to the queue.', resolveDone: 'Resolved.',
    actionRefused: 'Could not do that — the exception may be resolved already, this may not be your queue, a resolve needs a reason code and the words, or you do not have permission.',
    actionLostLink: 'No connection — not saved. Try again.',
    scrReady: 'Showing the open delivery exceptions', scrEmpty: 'No open delivery exceptions — nothing outstanding.',
    stateNotPermitted: 'You do not have permission to see delivery exceptions.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'டெலிவரி விதிவிலக்குகள்', langName: 'English',
    lead: 'மாற்றுப் பொருள் வழங்கலால் நிலுவையில் விடப்பட்டவை — திருப்பித் தர வேண்டிய பணம், வசூலிக்க வேண்டிய சரிசெய்தல், வரம்பை மீறிய கட்டணம், குறைவாக எடுக்கப்பட்ட வரி — ஒவ்வொன்றும் அதற்குரிய வரிசைக்கு SLA கடிகாரத்துடன் அனுப்பப்படுகிறது. பெரிய தொகை முதலில். ஒன்றை உங்களுடையதாக்க கோருங்கள், வரிசைக்குத் திருப்பி விடுங்கள், அல்லது காரணத்துடனும் பதிவாகும் வார்த்தைகளுடனும் தீர்க்குங்கள். மாற்றத்தை முன்மொழிந்த பிக்கர் அதை ஒருபோதும் அங்கீகரிக்க மாட்டார்.',
    kindRefundDue: 'திருப்பித் தர வேண்டியது', kindCollectAdjustment: 'வசூலிக்க வேண்டிய சரிசெய்தல்', kindAboveCapCharge: 'வரம்பை மீறிய கட்டணம்', kindPolicyShortPick: 'குறைவாக எடுக்கப்பட்ட வரி',
    queueFulfilmentSupervisor: 'நிறைவேற்று மேற்பார்வையாளர்', queueCustomerServiceDesk: 'வாடிக்கையாளர் சேவை மையம்', queueFinanceReconQueue: 'நிதி சரிபார்ப்பு', queueDutyManager: 'பணி மேலாளர்',
    stateOpen: 'திறந்தது', stateInProgress: 'கையாளப்படுகிறது', stateBreached: 'SLA மீறப்பட்டது',
    openHeading: 'கையாள வேண்டியவை', openCount: 'கையாள வேண்டியவை', breachedCount: 'SLA கடந்தவை', atRiskLabel: 'ஆபத்தில் உள்ள தொகை', allClear: 'திறந்த டெலிவரி விதிவிலக்குகள் இல்லை — நிலுவையில் எதுவும் இல்லை.', queuesHeading: 'வரிசை வாரியாக',
    orderLabel: 'ஆர்டர்', lineLabel: 'வரி', queueLabel: 'வரிசை', heldByLabel: 'வைத்திருப்பவர்', heldByYou: 'நீங்கள்', inQueue: 'வரிசையில்', ageLabel: 'வயது', minutes: 'நிமி', proposedByLabel: 'முன்மொழிந்தவர்', reasonLabel: 'காரணம்',
    claimBtn: 'கோரு',
    workHeading: 'நீங்கள் வைத்திருக்கும் விதிவிலக்கைக் கையாளுங்கள்', whichLabel: 'எந்த விதிவிலக்கு', reasonCodeLabel: 'காரணக் குறியீடு', reasonCodePlaceholder: 'எ.கா. REFUNDED / COLLECTED / CUSTOMER-INFORMED',
    detailLabel: 'நீங்கள் செய்தது (இதுவே பதிவு)', detailPlaceholder: 'என்ன செய்யப்பட்டது, ஏன் இது முடிகிறது?', resolveBtn: 'தீர்', releaseBtn: 'வரிசைக்குத் திருப்பி விடு',
    nothingHeld: 'நீங்கள் எதையும் வைத்திருக்கவில்லை — கையாள மேலே ஒரு விதிவிலக்கைக் கோருங்கள்.',
    claimDone: 'கோரப்பட்டது — இது உங்களுடையது.', releaseDone: 'வரிசைக்குத் திருப்பி விடப்பட்டது.', resolveDone: 'தீர்க்கப்பட்டது.',
    actionRefused: 'செய்ய முடியவில்லை — விதிவிலக்கு ஏற்கனவே தீர்க்கப்பட்டிருக்கலாம், இது உங்கள் வரிசை இல்லாமல் இருக்கலாம், தீர்வுக்குக் காரணக் குறியீடும் வார்த்தைகளும் தேவை, அல்லது உங்களுக்கு அனுமதி இல்லை.',
    actionLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    scrReady: 'திறந்த டெலிவரி விதிவிலக்குகளைக் காட்டுகிறது', scrEmpty: 'திறந்த டெலிவரி விதிவிலக்குகள் இல்லை — நிலுவையில் எதுவும் இல்லை.',
    stateNotPermitted: 'டெலிவரி விதிவிலக்குகளைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(SUB_EXCEPTION_INBOX_COPY.en) as CopyKey[]);

const KIND_COPY: Readonly<Record<SubstitutionExceptionKind, CopyKey>> = {
  refund_due: 'kindRefundDue', collect_adjustment: 'kindCollectAdjustment', above_cap_charge: 'kindAboveCapCharge', policy_short_pick: 'kindPolicyShortPick',
};
export const QUEUES: readonly ExceptionOwnerRole[] = ['fulfilment_supervisor', 'customer_service_desk', 'finance_recon_queue', 'duty_manager'];
const QUEUE_COPY: Readonly<Record<ExceptionOwnerRole, CopyKey>> = {
  fulfilment_supervisor: 'queueFulfilmentSupervisor', customer_service_desk: 'queueCustomerServiceDesk', finance_recon_queue: 'queueFinanceReconQueue', duty_manager: 'queueDutyManager',
};

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

/** What this user may do with a row from here: claim it (open, in a queue), work it (held by them), or nothing (held by someone else). */
export type RowOffer = 'claim' | 'work' | 'none';

export interface PresentedException {
  readonly exceptionId: string;
  readonly orderId: string;
  readonly lineId: string;
  readonly kind: SubstitutionExceptionKind;
  readonly kindLabel: string;
  /** The money at stake, formatted for reading (₹). */
  readonly amount: string;
  readonly amountMinor: number;
  readonly detail: string;
  readonly queue: ExceptionOwnerRole;
  readonly queueLabel: string;
  readonly state: ExceptionState;
  /** Who holds it — a user id, or null when it sits in the queue. */
  readonly heldBy: string | null;
  readonly mine: boolean;
  readonly ageMinutes: number;
  readonly dueAt: string;
  readonly breached: boolean;
  readonly proposedBy: string | null;
  readonly reasonCode: string;
  /** Breached → error; otherwise open / being worked → degraded. An icon and a word ride with every tone. */
  readonly status: StatusPresentation;
  readonly needsAttention: boolean;
  readonly offer: RowOffer;
}

export interface SubExceptionInboxView {
  readonly screenState: StatusPresentation;
  /** Every NOT-resolved exception, worst first as the cloud ordered it. */
  readonly rows: readonly PresentedException[];
  readonly openCount: number;
  readonly breachedCount: number;
  /** The money at stake across every open exception, formatted (₹). */
  readonly atRisk: string;
  readonly atRiskMinor: number;
  readonly queues: readonly { readonly queue: ExceptionOwnerRole; readonly label: string; readonly count: number }[];
  /** The rows this user holds — what the "work" form offers. */
  readonly held: readonly PresentedException[];
  readonly nobodyNamed: boolean;
  /** Whether to offer any act — this user holds `order.exception.work`. */
  readonly mayWork: boolean;
}

export interface SubExceptionInboxSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): SubExceptionInboxView;
  /** Make an OPEN exception this user's. Refuses BEFORE any POST without permission or when it is not open. */
  claim(exceptionId: string): Promise<ActionResult>;
  /** Put an exception this user is working back in its queue. Refuses BEFORE any POST unless it is being worked. */
  release(exceptionId: string, reasonCode: string): Promise<ActionResult>;
  /** Resolve an exception with a reason code and the words — a HUMAN write in the caller's own name (hard rule #6).
   *  Refuses BEFORE any POST without permission, a reason code, the words, or when it is already resolved. */
  resolve(exceptionId: string, reasonCode: string, detail: string): Promise<ActionResult>;
  /** Present an act's outcome as one glanceable status the shell shows after the action. */
  presentActionResult(lang: Lang, action: ExceptionAction, result: ActionResult): StatusPresentation;
}

const rupees = (minor: number): string =>
  `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayWork: boolean): SubExceptionInboxView => ({
  screenState, rows: [], openCount: 0, breachedCount: 0, atRisk: '₹0.00', atRiskMinor: 0, queues: [], held: [], nobodyNamed, mayWork,
});

export function createSubExceptionInboxSession(config: SubExceptionInboxConfig, ports: SubExceptionInboxPorts): SubExceptionInboxSession {
  const text = (lang: Lang, key: CopyKey): string => translator(SUB_EXCEPTION_INBOX_COPY, lang)(key);
  const find = (exceptionId: string): SubExceptionView | undefined => ports.worklist().exceptions.find((e) => e.exceptionId === exceptionId);

  const present = (lang: Lang, e: SubExceptionView, mayWork: boolean): PresentedException => {
    const t = translator(SUB_EXCEPTION_INBOX_COPY, lang);
    const heldBy = e.assignedTo ?? null;
    const mine = heldBy !== null && heldBy === config.userId;
    const kindLabel = t(KIND_COPY[e.kind]);
    // Breached is an ERROR (the customer or the money has waited past the promise); open / being worked is
    // attention (degraded). Colour is never the only signal: an icon and the state word ride with it.
    const status = e.sla.breached
      ? presentStatus({ tone: 'error', icon: '✕', label: t('stateBreached'), announcement: `${t('stateBreached')}: ${kindLabel} ${rupees(e.amountMinor)}`, needsAttention: true })
      : presentStatus({ tone: 'degraded', icon: e.state === 'in_progress' ? '●' : '⚠', label: t(e.state === 'in_progress' ? 'stateInProgress' : 'stateOpen'), announcement: `${kindLabel} ${rupees(e.amountMinor)}`, needsAttention: true });
    const offer: RowOffer = !mayWork ? 'none' : e.state === 'open' ? 'claim' : mine ? 'work' : 'none';
    return {
      exceptionId: e.exceptionId, orderId: e.orderId, lineId: e.lineId, kind: e.kind, kindLabel,
      amount: rupees(e.amountMinor), amountMinor: e.amountMinor, detail: e.detail,
      queue: e.owner, queueLabel: t(QUEUE_COPY[e.owner]), state: e.state, heldBy, mine,
      ageMinutes: e.sla.ageMinutes, dueAt: e.sla.dueAt, breached: e.sla.breached,
      proposedBy: e.proposedBy ?? null, reasonCode: e.reasonCode, status, needsAttention: true, offer,
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(SUB_EXCEPTION_INBOX_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayWork = ports.mayWork();
      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayWork);
      }
      const worklist = ports.worklist();
      // A resolved exception is off the list — the cloud re-derives; this screen never keeps a "done" of its own.
      const rows = worklist.exceptions.filter((e) => e.state !== 'resolved').map((e) => present(lang, e, mayWork));
      const state = rows.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        rows,
        openCount: rows.length,
        breachedCount: rows.filter((r) => r.breached).length,
        atRisk: rupees(worklist.open.atRiskMinor),
        atRiskMinor: worklist.open.atRiskMinor,
        queues: QUEUES.map((queue) => ({ queue, label: t(QUEUE_COPY[queue]), count: worklist.queues[queue] ?? 0 })).filter((q) => q.count > 0),
        held: rows.filter((r) => r.mine),
        nobodyNamed,
        mayWork,
      };
    },

    // Each act refuses BEFORE any POST when this user may not work exceptions or the row is not in the state the
    // act needs — a local refusal, not a round trip. The server decides again (queue rights, §28, already
    // resolved) and appends the act to the exception's history in the caller's own name.
    claim: async (exceptionId) => {
      const e = find(exceptionId);
      if (!ports.mayWork() || e === undefined || e.state !== 'open') return 'refused';
      return ports.actionPort().post({ action: 'claim', exceptionId });
    },
    release: async (exceptionId, reasonCode) => {
      const e = find(exceptionId);
      if (!ports.mayWork() || e === undefined || e.state !== 'in_progress') return 'refused';
      const reason = reasonCode.trim();
      return ports.actionPort().post({ action: 'release', exceptionId, ...(reason === '' ? {} : { body: { reasonCode: reason } }) });
    },
    resolve: async (exceptionId, reasonCode, detail) => {
      const e = find(exceptionId);
      const reason = reasonCode.trim();
      const words = detail.trim();
      if (!ports.mayWork() || e === undefined || e.state === 'resolved' || reason === '' || words === '') return 'refused';
      return ports.actionPort().post({ action: 'resolve', exceptionId, body: { reasonCode: reason, detail: words } });
    },

    presentActionResult: (lang, action, result) => {
      const t = translator(SUB_EXCEPTION_INBOX_COPY, lang);
      if (result === 'done') {
        return presentStatus({ tone: 'ok', icon: '✓', label: t(action === 'claim' ? 'claimDone' : action === 'release' ? 'releaseDone' : 'resolveDone'), needsAttention: false });
      }
      if (result === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('actionLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('actionRefused'), needsAttention: true });
    },
  };
}
