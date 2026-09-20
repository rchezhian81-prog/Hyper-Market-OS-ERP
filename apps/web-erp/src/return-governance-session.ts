// The return-governance exceptions review screen — the owner/manager/accountant's control-by-exception
// surface for refunds that reconciled with a breach (M13-FR-01/03 · M17 · §28 · P-03 · P-08 · hard rule
// #10). A refund taken at the lane with the cable out has ALREADY moved money, so the cloud records it and
// flags the breach rather than rejecting it (record-and-flag). The flags this screen exists to surface:
//   • a store-credit refund that exceeded the OWNER'S issuance cap, or was issued with no cap set
//     (`store_credit_over_cap`) — the human-facing counterpart to the cap the owner sets;
//   • a store-credit refund with no customer to credit (`store_credit_no_customer`);
//   • a material refund given with no approver, self-approved, or approved by someone without the
//     authority (§28: `given_without_approval` / `approved_by_the_processor` / `approver_lacks_authority`);
//   • more goods returned than the bill sold, or more money refunded than it was paid — a cross-lane loss
//     only the cloud can see (`over_returned_goods` / `refund_exceeds_paid`).
//
// The read route (`GET /v1/pos/return-governance-exceptions`, gated `lp.case.read`) folds the flagged
// returns; this screen shows them so a breach recorded is a breach SEEN, never a row nobody reads (P-08).
// It is READ-ONLY — a breach here is worked out of band (the money already moved), so the screen never
// pretends to "resolve" one with a write it cannot honestly make.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import type { RefundGovernanceFinding } from '../../../packages/returns/src/assess-return';

/** One flagged return as the exceptions route hands it over. A refund that reconciled with a breach. */
export interface FlaggedReturnView {
  readonly returnId: string;
  /** The bill this return was against — `null` for a no-receipt return. */
  readonly originalSaleId: string | null;
  readonly laneId: string;
  readonly processedBy: string;
  /** Who approved it at the lane, if anyone was named. */
  readonly approvedBy?: string;
  /** The customer the credit belongs to, if one was captured. */
  readonly customerRef?: string;
  readonly reasonCode: string;
  readonly refundMinor: number;
  readonly refundTender: string;
  readonly processedAt: string;
  readonly governanceFlags: readonly RefundGovernanceFinding[];
}

/** The exceptions body (`GET /v1/pos/return-governance-exceptions`). Flagged returns only. */
export interface ReturnGovernanceData {
  readonly exceptionCount: number;
  /** The total refunded across the flagged returns — the money at stake in the exceptions. */
  readonly totalRefundMinor: number;
  readonly exceptions: readonly FlaggedReturnView[];
}

export interface ReturnGovernancePorts {
  /** The exceptions the shell last read (live from the cloud, or the injected stand-in). */
  exceptions(): ReturnGovernanceData;
  /** Whether this user may read the governance exceptions (`lp.case.read` — owner/manager/accountant). */
  mayRead(): boolean;
}

export interface ReturnGovernanceConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'kindException'
  | 'listHeading' | 'exceptionCount' | 'exposureLabel' | 'allClear'
  | 'returnLabel' | 'saleLabel' | 'noSale' | 'laneLabel' | 'amountLabel' | 'tenderLabel'
  | 'processedByLabel' | 'approvedByLabel' | 'noneNamed' | 'customerLabel' | 'noCustomer'
  | 'reasonLabel' | 'whenLabel' | 'flagsLabel'
  | 'flagGivenWithoutApproval' | 'flagApprovedByProcessor' | 'flagApproverLacksAuthority'
  | 'flagOverReturnedGoods' | 'flagRefundExceedsPaid' | 'flagStoreCreditOverCap' | 'flagStoreCreditNoCustomer'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const RETURN_GOVERNANCE_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Refund exceptions', langName: 'தமிழ்',
    lead: 'Refunds that went through with a rule broken — a store credit above your cap or with no cap set, a credit with no customer, a refund with no approver or the wrong one, or more sent back than the bill sold or was paid. These happened at the lane, so the money already moved: nothing here is rejected, it is recorded and shown for you to work. Biggest refund first.',
    kindException: 'Exception',
    listHeading: 'To review', exceptionCount: 'to review', exposureLabel: 'Total refunded',
    allClear: 'No refund exceptions — every refund followed the rules.',
    returnLabel: 'Return', saleLabel: 'Original bill', noSale: 'No receipt', laneLabel: 'Lane',
    amountLabel: 'Refunded', tenderLabel: 'As',
    processedByLabel: 'Given by', approvedByLabel: 'Approved by', noneNamed: 'Nobody named',
    customerLabel: 'Customer', noCustomer: 'No customer captured',
    reasonLabel: 'Reason', whenLabel: 'When', flagsLabel: 'What broke',
    flagGivenWithoutApproval: 'Given without an approver',
    flagApprovedByProcessor: 'Approved by the person who gave it',
    flagApproverLacksAuthority: 'Approver does not hold refund authority',
    flagOverReturnedGoods: 'More goods returned than the bill sold',
    flagRefundExceedsPaid: 'More refunded than the bill was paid',
    flagStoreCreditOverCap: 'Store credit above your cap (or no cap set)',
    flagStoreCreditNoCustomer: 'Store credit with no customer to credit',
    scrReady: 'Showing the refund exceptions', scrEmpty: 'No refund exceptions — every refund followed the rules.',
    stateNotPermitted: 'You do not have permission to see the refund exceptions.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'திருப்பிப்பணம் விதிமீறல்கள்', langName: 'English',
    lead: 'விதி மீறப்பட்டு நடந்த திருப்பிப்பணங்கள் — உங்கள் வரம்பை மீறிய அல்லது வரம்பே அமைக்கப்படாத கடைக்கடன், வாடிக்கையாளர் இல்லாத கடன், அனுமதியாளர் இல்லாத அல்லது தவறான அனுமதியாளர் கொண்ட திருப்பிப்பணம், அல்லது பில் விற்றதை/பெற்றதைவிட அதிகம் திரும்பியது. இவை பணப்பெட்டியில் நடந்துவிட்டன, பணம் ஏற்கனவே நகர்ந்துவிட்டது: இங்கு எதுவும் நிராகரிக்கப்படவில்லை, பதிவு செய்யப்பட்டு நீங்கள் கையாள காட்டப்படுகிறது. பெரிய திருப்பிப்பணம் முதலில்.',
    kindException: 'விதிமீறல்',
    listHeading: 'பரிசீலிக்க வேண்டியவை', exceptionCount: 'பரிசீலிக்க வேண்டியவை', exposureLabel: 'மொத்தத் திருப்பிப்பணம்',
    allClear: 'திருப்பிப்பண விதிமீறல்கள் இல்லை — ஒவ்வொரு திருப்பிப்பணமும் விதிகளைப் பின்பற்றியது.',
    returnLabel: 'திருப்பம்', saleLabel: 'அசல் பில்', noSale: 'ரசீது இல்லை', laneLabel: 'பாதை',
    amountLabel: 'திருப்பியது', tenderLabel: 'வகை',
    processedByLabel: 'வழங்கியவர்', approvedByLabel: 'அனுமதித்தவர்', noneNamed: 'யாரும் குறிப்பிடப்படவில்லை',
    customerLabel: 'வாடிக்கையாளர்', noCustomer: 'வாடிக்கையாளர் பதிவு இல்லை',
    reasonLabel: 'காரணம்', whenLabel: 'எப்போது', flagsLabel: 'என்ன மீறப்பட்டது',
    flagGivenWithoutApproval: 'அனுமதியாளர் இன்றி வழங்கப்பட்டது',
    flagApprovedByProcessor: 'வழங்கியவரே அனுமதித்தார்',
    flagApproverLacksAuthority: 'அனுமதியாளருக்கு திருப்பிப்பண அதிகாரம் இல்லை',
    flagOverReturnedGoods: 'பில் விற்றதைவிட அதிகப் பொருட்கள் திரும்பியது',
    flagRefundExceedsPaid: 'பில் பெற்றதைவிட அதிகம் திருப்பப்பட்டது',
    flagStoreCreditOverCap: 'உங்கள் வரம்பை மீறிய கடைக்கடன் (அல்லது வரம்பு இல்லை)',
    flagStoreCreditNoCustomer: 'கடன் வழங்க வாடிக்கையாளர் இல்லை',
    scrReady: 'திருப்பிப்பண விதிமீறல்களைக் காட்டுகிறது', scrEmpty: 'திருப்பிப்பண விதிமீறல்கள் இல்லை — ஒவ்வொரு திருப்பிப்பணமும் விதிகளைப் பின்பற்றியது.',
    stateNotPermitted: 'திருப்பிப்பண விதிமீறல்களைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(RETURN_GOVERNANCE_COPY.en) as CopyKey[]);

/** The copy key for each governance flag's human label — one place, and exhaustive over the union so a new
 *  finding in the engine cannot ship without a label here (the type forces it). */
const FLAG_COPY: Readonly<Record<RefundGovernanceFinding, CopyKey>> = {
  given_without_approval: 'flagGivenWithoutApproval',
  approved_by_the_processor: 'flagApprovedByProcessor',
  approver_lacks_authority: 'flagApproverLacksAuthority',
  over_returned_goods: 'flagOverReturnedGoods',
  refund_exceeds_paid: 'flagRefundExceedsPaid',
  store_credit_over_cap: 'flagStoreCreditOverCap',
  store_credit_no_customer: 'flagStoreCreditNoCustomer',
};

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedFlag {
  readonly code: RefundGovernanceFinding;
  readonly label: string;
}

export interface PresentedException {
  readonly returnId: string;
  readonly originalSaleId: string | null;
  readonly laneId: string;
  /** The refund amount, formatted for reading (₹). */
  readonly amount: string;
  readonly amountMinor: number;
  readonly refundTender: string;
  readonly processedBy: string;
  /** The named approver, or the "nobody named" copy when none was carried. */
  readonly approvedBy: string;
  /** The captured customer, or the "no customer" copy when none was captured. */
  readonly customerRef: string;
  readonly reasonCode: string;
  readonly processedAt: string;
  readonly flags: readonly PresentedFlag[];
  /** Every exception needs attention (P-03) — a degraded tone with an icon and word, never colour alone. */
  readonly status: StatusPresentation;
  readonly needsAttention: boolean;
}

export interface ReturnGovernanceView {
  readonly screenState: StatusPresentation;
  readonly exceptions: readonly PresentedException[];
  readonly exceptionCount: number;
  /** The total refunded across the flagged returns, formatted (₹). */
  readonly totalRefunded: string;
  readonly totalRefundedMinor: number;
  readonly nobodyNamed: boolean;
}

export interface ReturnGovernanceSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): ReturnGovernanceView;
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean): ReturnGovernanceView => ({
  screenState, exceptions: [], exceptionCount: 0, totalRefunded: '₹0.00', totalRefundedMinor: 0, nobodyNamed,
});

const rupees = (minor: number): string =>
  `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function createReturnGovernanceSession(config: ReturnGovernanceConfig, ports: ReturnGovernancePorts): ReturnGovernanceSession {
  const text = (lang: Lang, key: CopyKey): string => translator(RETURN_GOVERNANCE_COPY, lang)(key);

  const present = (lang: Lang, r: FlaggedReturnView): PresentedException => {
    const t = translator(RETURN_GOVERNANCE_COPY, lang);
    const flags = r.governanceFlags.map((code) => ({ code, label: t(FLAG_COPY[code]) }));
    return {
      returnId: r.returnId,
      originalSaleId: r.originalSaleId,
      laneId: r.laneId,
      amount: rupees(r.refundMinor),
      amountMinor: r.refundMinor,
      refundTender: r.refundTender,
      processedBy: r.processedBy,
      approvedBy: r.approvedBy === undefined || r.approvedBy.trim() === '' ? t('noneNamed') : r.approvedBy,
      customerRef: r.customerRef === undefined || r.customerRef.trim() === '' ? t('noCustomer') : r.customerRef,
      reasonCode: r.reasonCode,
      processedAt: r.processedAt,
      flags,
      // Every exception is work — a degraded tone that asks for a glance (P-03). Colour is never the only
      // signal: an icon and the word "Exception" ride with it, and the announcement names what broke.
      status: presentStatus({
        tone: 'degraded', icon: '⚠', label: t('kindException'),
        announcement: flags.map((f) => f.label).join('; '), needsAttention: true,
      }),
      needsAttention: true,
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(RETURN_GOVERNANCE_COPY, lang);
      const nobodyNamed = config.userId === null;

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed);
      }

      const data = ports.exceptions();
      const exceptions = data.exceptions.map((r) => present(lang, r));
      const state = exceptions.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        exceptions,
        exceptionCount: exceptions.length,
        totalRefunded: rupees(data.totalRefundMinor),
        totalRefundedMinor: data.totalRefundMinor,
        nobodyNamed,
      };
    },
  };
}
