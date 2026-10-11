// The loss-prevention investigations inbox — the store manager's review screen (M15-FR-04 · P-03
// control-by-exception · §28). A material till short (or any raised loss signal) auto-opens an
// investigation case; a case opened and then left unseen is the exact failure "control by exception"
// exists to prevent. The cloud folds the OPEN cases into a worklist (`GET /v1/loss-prevention/cases`,
// built by the tested `buildOpenCaseWorklist`), highest value first so the biggest potential loss is
// worked first. This is the screen that shows it: every open investigation to work, and the one action
// a manager takes from here — CLOSE a case with an outcome and the note that IS the record a year later.
//
// Two truths the screen must carry, both already true in the engine and re-stated here so the surface
// cannot weaken them:
//   • **It self-heals.** The worklist is re-READ from the cloud, so a closed case drops off on its own;
//     this screen never carries a "done" flag that could go stale against reality.
//   • **A close carries a name and a reason, and the hard cases carry a second name.** Closing is a
//     HUMAN write in the manager's own name; the engine refuses a "proven" outcome unless someone other
//     than the investigator signs it, with evidence on file and a chain that verifies (§28, hard rule
//     #6). The screen offers the action and surfaces the refusal — it never fakes the second signature.
//   • **A subject is an opaque reference, never a name** (P-04) — the worklist hands over `subjectRef`
//     and the screen shows exactly that.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared
// packages/ui primitives (colour is never the only signal — an icon and a word ride with every tone);
// the shell only renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import type { CaseOutcome } from '../../../packages/loss-prevention/src/cases';

/** The five first-class close outcomes (mirrors the API-05 close route's own list). "unfounded" is a
 *  real result, not a failure to prove; "proven" is the one the engine gates on §28 server-side. */
export const LP_OUTCOMES: readonly CaseOutcome[] = ['proven', 'unfounded', 'inconclusive', 'process_failure', 'referred_to_police'];

/** One open case as the worklist route hands it over — a summary, never the sealed evidence chain. */
export interface LpCaseView {
  readonly caseId: string;
  readonly subjectRef: string;
  readonly assignedTo: string;
  readonly summary: string;
  readonly valueMinor: number;
  readonly raisedFromRef: string;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly evidenceCount: number;
}

/**
 * One exception the store's rules RAISED on head office's own record today (audit PF-07 · M15-FR-01) — voids, no-sales,
 * price overrides (as discounts), refunds — as `GET /v1/loss-prevention/exceptions` hands it over. The cashier is an id,
 * never a name.
 */
export interface LpRaisedView {
  readonly exceptionId: string;
  readonly day: string;
  readonly cashierId: string;
  readonly kind: string;
  readonly breach: string;
  readonly observed: number;
  readonly limit: number;
  readonly severity: string;
  readonly linkedTxnIds: readonly string[];
  readonly raisedAt?: string;
  readonly caseId?: string;
}

/** The worklist body (`GET /v1/loss-prevention/cases`). Open cases only; a closed one is off the list. */
export interface LpWorklistData {
  readonly openCount: number;
  /** The total value at stake across the open cases — the size of the manager's open exposure. */
  readonly totalValueMinor: number;
  readonly cases: readonly LpCaseView[];
  /** PF-07: today's exceptions the rules raised on the shop's own record (absent when it was not read). */
  readonly raised?: readonly LpRaisedView[];
}

/** The outcome of a close — recorded, refused by the server (bad outcome/§28/permission), or a lost link. */
export type CloseResult = 'closed' | 'refused' | 'lost_link';

/** The authenticated POST of a manager's close decision. Injected, so the model never opens a socket
 *  itself; the server records the close in the caller's own name and applies the §28 / evidence rules. */
export interface LpCloseCasePort {
  post(input: { readonly caseId: string; readonly outcome: CaseOutcome; readonly note: string }): Promise<CloseResult>;
}

export interface LpInboxPorts {
  /** The worklist the shell last read (live from the cloud, or the injected stand-in). */
  worklist(): LpWorklistData;
  /** Whether this user may read the investigations worklist (`lp.case.read`). */
  mayRead(): boolean;
  /** Whether this user may work a case — close it (`lp.case.manage`). */
  mayManage(): boolean;
  /** Records a close. Only reached from the explicit close action, never on render. */
  closePort(): LpCloseCasePort;
}

export interface LpInboxConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'kindOpen'
  | 'openHeading' | 'openCount' | 'exposureLabel' | 'allClear'
  | 'subjectLabel' | 'valueLabel' | 'evidenceLabel' | 'assignedLabel' | 'raisedFromLabel' | 'openedByLabel'
  | 'closeHeading' | 'caseLabel' | 'outcomeLabel' | 'noteLabel' | 'notePlaceholder' | 'closeBtn'
  | 'outcomeProven' | 'outcomeUnfounded' | 'outcomeInconclusive' | 'outcomeProcessFailure' | 'outcomeReferredToPolice'
  | 'closeRecorded' | 'closeRefused' | 'closeLostLink'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData'
  | 'raisedHeading' | 'raisedNone' | 'raisedLinked' | 'raisedHasCase' | 'raisedNoCase'
  | 'kindVoid' | 'kindNoSale' | 'kindDiscount' | 'kindRefund' | 'kindCashVariance'
  | 'breachCount' | 'breachTotal' | 'breachSingle' | 'breachApprover' | 'severityEscalate' | 'severityFlag';

export const LP_INBOX_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Investigations', langName: 'தமிழ்',
    lead: 'Open loss investigations — a till that came up short, a run of voids, a suspicious refund — biggest potential loss first, so the one that matters most is worked first. Nothing is deleted: closing a case files the outcome and the note, which is what anyone reads a year from now. A "proven" outcome needs a second person to sign it, evidence on file, and a chain that checks out.',
    kindOpen: 'Open',
    openHeading: 'To investigate', openCount: 'to investigate', exposureLabel: 'Total at stake',
    allClear: 'No open investigations — nothing outstanding.',
    subjectLabel: 'Subject', valueLabel: 'Value at stake', evidenceLabel: 'Evidence on file',
    assignedLabel: 'Assigned to', raisedFromLabel: 'Raised from', openedByLabel: 'Opened by',
    closeHeading: 'Close an investigation', caseLabel: 'Which case', outcomeLabel: 'Outcome',
    noteLabel: 'What you concluded (this is the record)', notePlaceholder: 'What did you find, and why this outcome?',
    closeBtn: 'Close the case',
    outcomeProven: 'Proven', outcomeUnfounded: 'Unfounded', outcomeInconclusive: 'Inconclusive',
    outcomeProcessFailure: 'A process failed (not a person)', outcomeReferredToPolice: 'Referred to the police',
    closeRecorded: 'Case closed.',
    closeRefused: 'Could not close — a "proven" outcome needs a second approver, evidence on file and a verified chain; every close needs an outcome and a note; or you do not have permission.',
    closeLostLink: 'No connection — not saved. Try again.',
    scrReady: 'Showing the open investigations', scrEmpty: 'No open investigations — nothing outstanding.',
    stateNotPermitted: 'You do not have permission to see the investigations.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
    raisedHeading: 'Raised by the store\'s rules today', raisedNone: 'Nothing raised by the store\'s rules today.',
    raisedLinked: 'Linked bills / actions', raisedHasCase: 'Case opened', raisedNoCase: 'No case yet',
    kindVoid: 'Voids', kindNoSale: 'Drawer opened with no sale', kindDiscount: 'Price overrides', kindRefund: 'Refunds', kindCashVariance: 'Cash differences',
    breachCount: '{observed} today — the rule allows {limit}', breachTotal: '{observed} in total today — the rule allows {limit}',
    breachSingle: 'One of {observed} — the rule allows {limit} at a time', breachApprover: 'Approved by someone who may not approve it ({observed})',
    severityEscalate: 'Escalate', severityFlag: 'Flag',
  },
  ta: {
    title: 'விசாரணைகள்', langName: 'English',
    lead: 'திறந்த இழப்பு விசாரணைகள் — பணப்பெட்டியில் குறைவு, தொடர் ரத்துகள், சந்தேகத்திற்குரிய திருப்பிப்பணம் — பெரிய இழப்பு முதலில், மிக முக்கியமானது முதலில் கையாளப்படும் வகையில். எதுவும் அழிக்கப்படாது: வழக்கை மூடுவது முடிவையும் குறிப்பையும் பதிவு செய்கிறது, அதுவே ஒரு வருடத்திற்குப் பிறகு யாரும் படிப்பது. "நிரூபிக்கப்பட்டது" எனும் முடிவுக்கு இரண்டாம் நபர் கையொப்பம், ஆதாரம், சரிபார்க்கப்பட்ட சங்கிலி தேவை.',
    kindOpen: 'திறந்தது',
    openHeading: 'விசாரிக்க வேண்டியவை', openCount: 'விசாரிக்க வேண்டியவை', exposureLabel: 'மொத்த ஆபத்து',
    allClear: 'திறந்த விசாரணைகள் இல்லை — நிலுவையில் எதுவும் இல்லை.',
    subjectLabel: 'பொருள்', valueLabel: 'ஆபத்தில் உள்ள மதிப்பு', evidenceLabel: 'கோப்பில் ஆதாரம்',
    assignedLabel: 'ஒப்படைக்கப்பட்டவர்', raisedFromLabel: 'எழுப்பப்பட்டது', openedByLabel: 'திறந்தவர்',
    closeHeading: 'ஒரு விசாரணையை மூடு', caseLabel: 'எந்த வழக்கு', outcomeLabel: 'முடிவு',
    noteLabel: 'நீங்கள் முடிவு செய்தது (இதுவே பதிவு)', notePlaceholder: 'என்ன கண்டீர்கள், ஏன் இந்த முடிவு?',
    closeBtn: 'வழக்கை மூடு',
    outcomeProven: 'நிரூபிக்கப்பட்டது', outcomeUnfounded: 'ஆதாரமற்றது', outcomeInconclusive: 'முடிவில்லாதது',
    outcomeProcessFailure: 'ஒரு செயல்முறை தோல்வி (நபர் அல்ல)', outcomeReferredToPolice: 'காவல்துறைக்கு அனுப்பப்பட்டது',
    closeRecorded: 'வழக்கு மூடப்பட்டது.',
    closeRefused: 'மூட முடியவில்லை — "நிரூபிக்கப்பட்டது" முடிவுக்கு இரண்டாம் அனுமதியாளர், கோப்பில் ஆதாரம், சரிபார்க்கப்பட்ட சங்கிலி தேவை; ஒவ்வொரு மூடலுக்கும் ஒரு முடிவும் குறிப்பும் தேவை; அல்லது உங்களுக்கு அனுமதி இல்லை.',
    closeLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    scrReady: 'திறந்த விசாரணைகளைக் காட்டுகிறது', scrEmpty: 'திறந்த விசாரணைகள் இல்லை — நிலுவையில் எதுவும் இல்லை.',
    stateNotPermitted: 'விசாரணைகளைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    raisedHeading: 'இன்று கடையின் விதிகள் எழுப்பியவை', raisedNone: 'இன்று கடையின் விதிகள் எதையும் எழுப்பவில்லை.',
    raisedLinked: 'இணைந்த பில்கள் / செயல்கள்', raisedHasCase: 'வழக்கு திறக்கப்பட்டது', raisedNoCase: 'இன்னும் வழக்கு இல்லை',
    kindVoid: 'நீக்கங்கள்', kindNoSale: 'விற்பனை இல்லாமல் டிராயர் திறப்பு', kindDiscount: 'விலை மாற்றங்கள்', kindRefund: 'திரும்பப் பணம்', kindCashVariance: 'பண வேறுபாடுகள்',
    breachCount: 'இன்று {observed} — விதி அனுமதிப்பது {limit}', breachTotal: 'இன்று மொத்தம் {observed} — விதி அனுமதிப்பது {limit}',
    breachSingle: 'ஒன்று {observed} — விதி ஒரு முறைக்கு அனுமதிப்பது {limit}', breachApprover: 'அனுமதிக்க அதிகாரம் இல்லாதவர் அனுமதித்தது ({observed})',
    severityEscalate: 'உயர்த்து', severityFlag: 'கவனி',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(LP_INBOX_COPY.en) as CopyKey[]);

/** The copy key for each outcome's human label, so the screen can render the dropdown from one place. */
const OUTCOME_COPY: Readonly<Record<CaseOutcome, CopyKey>> = {
  proven: 'outcomeProven',
  unfounded: 'outcomeUnfounded',
  inconclusive: 'outcomeInconclusive',
  process_failure: 'outcomeProcessFailure',
  referred_to_police: 'outcomeReferredToPolice',
};

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedCase {
  readonly caseId: string;
  readonly subjectRef: string;
  readonly summary: string;
  /** The value at stake, formatted for reading (₹). */
  readonly value: string;
  readonly valueMinor: number;
  readonly assignedTo: string;
  readonly raisedFromRef: string;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly evidenceCount: number;
  /** Every open case needs attention (P-03) — a degraded tone with an icon and word, never colour alone. */
  readonly status: StatusPresentation;
  readonly needsAttention: boolean;
}

/** One raised exception, in the manager's words (PF-07). */
export interface PresentedRaised {
  readonly exceptionId: string;
  readonly cashierId: string;
  /** What it is about, in words ("Drawer opened with no sale"). */
  readonly what: string;
  /** How far over the rule, in words, with money as ₹ where it is money. */
  readonly breach: string;
  readonly linkedTxnIds: readonly string[];
  readonly caseId?: string;
  readonly caseLabel: string;
  /** An escalation is an error tone, a flag degraded — with an icon and a word, never colour alone. */
  readonly status: StatusPresentation;
}

export interface LpInboxView {
  readonly screenState: StatusPresentation;
  readonly open: readonly PresentedCase[];
  /** PF-07: today's exceptions raised by the store's rules on head office's own record (empty when none or not read). */
  readonly raised: readonly PresentedRaised[];
  readonly openCount: number;
  /** The open exposure across every case, formatted (₹). */
  readonly totalValue: string;
  readonly totalValueMinor: number;
  readonly nobodyNamed: boolean;
  /** Whether to offer the "close the case" action — this user holds `lp.case.manage`. */
  readonly mayManage: boolean;
}

export interface LpInboxSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): LpInboxView;
  /** The outcomes a manager can choose, each with its human label — the dropdown, from one place. */
  outcomeOptions(lang: Lang): readonly { readonly value: CaseOutcome; readonly label: string }[];
  /** Close a case, in the manager's name — a HUMAN write (hard rule #6, evidence kept). Runs only from an
   *  explicit action, never on render; refuses BEFORE any POST without permission, a valid outcome, or a
   *  note (the server also enforces §28/evidence for "proven" — the screen never fakes it). */
  close(caseId: string, outcome: string, note: string): Promise<CloseResult>;
  /** Present a close outcome as one glanceable status the shell shows after the action. */
  presentCloseResult(lang: Lang, outcome: CloseResult): StatusPresentation;
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayManage: boolean): LpInboxView => ({
  screenState, open: [], raised: [], openCount: 0, totalValue: '₹0.00', totalValueMinor: 0, nobodyNamed, mayManage,
});

const rupees = (minor: number): string =>
  `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const isOutcome = (v: string): v is CaseOutcome => (LP_OUTCOMES as readonly string[]).includes(v);

export function createLpInboxSession(config: LpInboxConfig, ports: LpInboxPorts): LpInboxSession {
  const text = (lang: Lang, key: CopyKey): string => translator(LP_INBOX_COPY, lang)(key);

  const present = (lang: Lang, c: LpCaseView): PresentedCase => {
    const t = translator(LP_INBOX_COPY, lang);
    return {
      caseId: c.caseId,
      subjectRef: c.subjectRef,
      summary: c.summary,
      value: rupees(c.valueMinor),
      valueMinor: c.valueMinor,
      assignedTo: c.assignedTo,
      raisedFromRef: c.raisedFromRef,
      openedBy: c.openedBy,
      openedAt: c.openedAt,
      evidenceCount: c.evidenceCount,
      // Every open case is work — a degraded tone that asks for a glance (P-03). Colour is never the only
      // signal: an icon and the word "Open" ride with it. Severity bands the engine does not define are
      // not invented here; the value ordering already puts the biggest exposure at the top.
      status: presentStatus({ tone: 'degraded', icon: '⚠', label: t('kindOpen'), announcement: c.summary, needsAttention: true }),
      needsAttention: true,
    };
  };

  // PF-07: a raised exception in words — the kind, how far over the rule (money as ₹), whether a case is open.
  const KIND: Readonly<Record<string, CopyKey>> = { void: 'kindVoid', no_sale: 'kindNoSale', discount: 'kindDiscount', refund: 'kindRefund', cash_variance: 'kindCashVariance' };
  const presentRaised = (lang: Lang, r: LpRaisedView): PresentedRaised => {
    const t = translator(LP_INBOX_COPY, lang);
    const money = r.breach !== 'count' && r.breach !== 'approver_without_authority';
    const fill = (template: string): string => template
      .replace('{observed}', money ? rupees(r.observed) : String(r.observed))
      .replace('{limit}', money ? rupees(r.limit) : String(r.limit));
    const breachKey: CopyKey = r.breach === 'count' ? 'breachCount' : r.breach === 'total_value' ? 'breachTotal' : r.breach === 'single_value' ? 'breachSingle' : 'breachApprover';
    const what = t(KIND[r.kind] ?? 'kindVoid');
    const escalate = r.severity === 'escalate';
    return {
      exceptionId: r.exceptionId, cashierId: r.cashierId, what, breach: fill(t(breachKey)), linkedTxnIds: r.linkedTxnIds,
      ...(r.caseId === undefined ? {} : { caseId: r.caseId }),
      caseLabel: r.caseId === undefined ? t('raisedNoCase') : `${t('raisedHasCase')}: ${r.caseId}`,
      status: presentStatus({ tone: escalate ? 'error' : 'degraded', icon: escalate ? '✕' : '⚠', label: t(escalate ? 'severityEscalate' : 'severityFlag'), announcement: `${what}: ${fill(t(breachKey))}`, needsAttention: true }),
    };
  };

  return {
    text,
    outcomeOptions: (lang) => {
      const t = translator(LP_INBOX_COPY, lang);
      return LP_OUTCOMES.map((value) => ({ value, label: t(OUTCOME_COPY[value]) }));
    },
    view: (lang) => {
      const t = translator(LP_INBOX_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayManage = ports.mayManage();

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayManage);
      }

      const worklist = ports.worklist();
      const open = worklist.cases.map((c) => present(lang, c));
      const raised = (worklist.raised ?? []).map((r) => presentRaised(lang, r));
      const state = open.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        open,
        raised,
        openCount: open.length,
        totalValue: rupees(worklist.totalValueMinor),
        totalValueMinor: worklist.totalValueMinor,
        nobodyNamed,
        mayManage,
      };
    },

    // Close a case. Refuse BEFORE any POST — no permission, an unknown outcome, or an empty note is a local
    // refusal, not a round trip. The server still applies the §28/evidence rules for a "proven" outcome and
    // records the close in the manager's own name; the screen never fabricates the second signature.
    close: async (caseId, outcome, note) => {
      if (!ports.mayManage() || !isOutcome(outcome) || note.trim() === '') return 'refused';
      return ports.closePort().post({ caseId, outcome, note: note.trim() });
    },

    presentCloseResult: (lang, outcome) => {
      const t = translator(LP_INBOX_COPY, lang);
      if (outcome === 'closed') return presentStatus({ tone: 'ok', icon: '✓', label: t('closeRecorded'), needsAttention: false });
      if (outcome === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('closeLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('closeRefused'), needsAttention: true });
    },
  };
}
