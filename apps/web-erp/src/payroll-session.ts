// Payroll — the operator screen's session model (owner directive 14 Aug 2026; WP3; §28; P-04; DPDP).
// docs/design/screens/payroll.md is the governing spec.
//
// Payroll moves money to real people and holds the most sensitive data in the shop — salary, bank, PAN, UAN,
// Aadhaar. So this screen is built to a HIGHER bar than the rest, and this model is where that bar lives:
//
//   • **Least privilege.** Only a payroll-permitted user sees anything; without it the view leaks NOTHING —
//     not a name, not a count. Default-deny.
//   • **Sensitive identifiers are masked, always.** Bank account, PAN, UAN and Aadhaar are shown as their
//     last few characters only (`packages/payroll` mask). Aadhaar is never returned in full on this path.
//   • **Maker ≠ checker.** The person who submits a run may never approve it — enforced here AND in the
//     engine (`evaluatePayRunTransition`). A locked run is FINAL: corrected by a visible reversal, never a
//     silent edit.
//   • **Online-first.** A run is not submitted, approved, locked, reversed or disbursed while the screen is
//     offline — the one place we would be acting on data we cannot trust to be current (the directive:
//     "prevent final approval, bank-file release or live posting when required validations cannot be
//     completed"). The shell is deliberately NOT cached (no service worker), so nothing sensitive is ever
//     persisted in the browser.
//   • **Negative net pay is refused.** An employee whose deductions exceed pay cannot be disbursed; it is a
//     blocking exception a person must resolve before the run is submitted (the bank file refuses it too).
//
// Like every screen the rules live here, DOM-free and tested; the shell only renders what this hands over.
// Nothing here writes to a database or commits a transition — it decides whether one is ALLOWED and returns
// the outcome, exactly as the finance screen does; the actual commit is the audited API path.

import {
  evaluatePayRunTransition, maskIdentifiers, buildPayrollJournal, InvalidPayrollJournal,
  computeSettlement, InvalidStatutorySchedule,
  type PayRunAggregate, type PayRunState, type PayRunAction, type PayRunRefusalReason, type MaskedIdentifiers,
  type PayrollTotals, type SettlementInput, type SettlementLine, type GratuityResult,
} from '../../../packages/payroll/src/index';
import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

/** A blocking problem with an employee's pay that stops the run being submitted or disbursed. */
export type ExceptionKind = 'negative_or_zero_net' | 'missing_bank_account';
export const EXCEPTION_KINDS: readonly ExceptionKind[] = ['negative_or_zero_net', 'missing_bank_account'];

/** A retrospective / recovery flag on a money line, so an adjustment is NEVER a silent edit to base pay. */
export type LineFlag = 'arrears' | 'loan_recovery' | 'advance_recovery';
export const LINE_FLAGS: readonly LineFlag[] = ['arrears', 'loan_recovery', 'advance_recovery'];

/** One money line on a payslip preview (an earning, a deduction, or a statutory item with its explanation). */
export interface MoneyLine {
  readonly label: string;
  readonly amountMinor: number;
  /** Present on statutory lines: how the figure was worked out, so a reviewer can re-derive it. */
  readonly explanation?: string;
  /** An arrears / loan / advance adjustment — surfaced as a badge, so it is visible, never folded silently. */
  readonly flag?: LineFlag;
}

/** One employee's row as the box hands it over. Sensitive identifiers are RAW here and masked on the way out. */
export interface EmployeeInput {
  readonly employeeId: string;
  readonly name: string;
  readonly department: string;
  readonly grossMinor: number;
  readonly totalDeductionsMinor: number;
  readonly netPayMinor: number;
  readonly earnings?: readonly MoneyLine[];
  readonly deductions?: readonly MoneyLine[];
  readonly statutory?: readonly MoneyLine[];
  // Sensitive — masked before display; the server SHOULD also pre-mask (defence in depth).
  readonly bankAccount?: string | null;
  readonly bankIfsc?: string | null;
  readonly pan?: string | null;
  readonly uan?: string | null;
  readonly aadhaar?: string | null;
}

export interface PayrollPorts {
  /** Whether this user may see payroll at all (`payroll.statutory.read`). */
  mayView(): boolean;
  /** The pay run's lifecycle aggregate (state, maker, checker), or undefined when none is drafted. */
  run(): PayRunAggregate | undefined;
  /** The employees in this run, with their raw money and identifiers. */
  employees(): readonly EmployeeInput[];
  /** The run's aggregated statutory money (the journal input + statutory report). Absent → both hidden. */
  totals(): PayrollTotals | undefined;
  /** A leaver's full-and-final settlement inputs, or undefined when this is an ordinary pay run. */
  settlement(): SettlementInput | undefined;
  /** The net of the PREVIOUS version of this run, for a draft/version comparison. Undefined → no prior. */
  previousNetMinor(): number | undefined;
  /**
   * Whether the screen has a live connection RIGHT NOW. Read fresh on every render and every action, because
   * it changes under the user's feet and offline blocks every state change — a function, never a snapshot.
   */
  online(): boolean;
  /**
   * How many seconds ago the user last re-authenticated (MFA), or `undefined` if never this session. Read
   * live: the sensitive actions (approve, lock, reverse, bank file, bulk payslip download, export) require a
   * FRESH re-auth, so a token that was fresh a minute ago must be able to go stale before the next action.
   */
  reauthAgeSeconds(): number | undefined;
  readonly payPeriod: string;
}

export interface PayrollConfig {
  /** Who is looking. `null` means the box was not told — nothing may be submitted or approved under no name. */
  readonly userId: string | null;
  /** True when this is sample/demo data — the shell shows "DEMO DATA — NOT REAL PAYROLL". */
  readonly demo: boolean;
  /** How fresh a re-auth must be to permit a sensitive action, in seconds (e.g. 120). */
  readonly reauthFreshWithinSeconds: number;
}

/** A sensitive action moves money or exposes/exports sensitive data, so it needs a fresh re-auth (MFA). */
export type SensitiveScreenAction = 'generateBankFile' | 'bulkPayslipDownload' | 'export' | 'releaseSettlement';
export type PayrollAction = PayRunAction | SensitiveScreenAction;

/**
 * The actions that require a fresh re-authentication (owner directive: "Re-authentication/MFA for approval,
 * locking, bank-file generation, payslip bulk download and sensitive exports" — and a settlement pays a
 * leaver, so its release is the same kind of act). `submit` and `reject` are not on the list — they prepare
 * or send back, they do not release money or data.
 */
export const SENSITIVE_ACTIONS: readonly PayrollAction[] = ['approve', 'lock', 'reverse', 'generateBankFile', 'bulkPayslipDownload', 'export', 'releaseSettlement'];
const SENSITIVE = new Set<PayrollAction>(SENSITIVE_ACTIONS);
/** The ones that also require a LOCKED run (they are artifacts OF a locked run). */
const LOCKED_RUN_ACTIONS = new Set<PayrollAction>(['generateBankFile', 'bulkPayslipDownload', 'export']);

// ── the copy: ONE bilingual object for the whole screen (a guardrail binds to it) ────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName' | 'demoBanner' | 'offlineBanner'
  | 'colEmployee' | 'colDepartment' | 'colGross' | 'colDeductions' | 'colNet'
  | 'sensitiveTitle' | 'bank' | 'ifsc' | 'pan' | 'uan' | 'aadhaar' | 'maskedNote'
  | 'earnings' | 'deductions' | 'statutory'
  | 'statusOk' | 'statusNegativeNet' | 'statusMissingBank'
  | 'stageNone' | 'stageDraft' | 'stageSubmitted' | 'stageApproved' | 'stageLocked' | 'stageReversed'
  | 'maker' | 'checker' | 'submit' | 'approve' | 'reject' | 'lock' | 'reverse' | 'reverseReason'
  | 'departmentSummary' | 'totals' | 'blockingCount' | 'allClear'
  | 'stateReady' | 'stateEmpty' | 'stateNotPermitted' | 'stateAwaiting' | 'stateLocked' | 'stateReversed'
  | 'nobodyNamed'
  | 'lockedTitle' | 'bankFileTitle' | 'bankFileRecords' | 'bankFileTotal' | 'bankFileReconciled' | 'bankFileNotReconciled'
  | 'journalTitle' | 'journalDebit' | 'journalCredit' | 'journalBalanced' | 'journalNotBalanced' | 'journalUnavailable'
  | 'actGenerateBankFile' | 'actBulkPayslip' | 'actExport' | 'reauthNeeded' | 'reauthFresh'
  | 'statutoryTitle' | 'stPf' | 'stEsi' | 'stPt' | 'stTds' | 'stEmployee' | 'stEmployer' | 'stTotalEmployee' | 'stTotalEmployer' | 'confirmWithCa'
  | 'flagArrears' | 'flagLoanRecovery' | 'flagAdvanceRecovery'
  | 'settlementTitle' | 'settlementEarnings' | 'settlementRecoveries' | 'settlementNet' | 'settlementPayable' | 'settlementRecoverable'
  | 'settlementGratuity' | 'settlementGratuityIneligible' | 'settlementUnavailable' | 'actReleaseSettlement'
  | 'versionDeltaTitle' | 'versionNoChange' | 'reversedBy'
  | 'rOffline' | 'rNotPermitted' | 'rBlocking' | 'rSelfApproval' | 'rNoRun' | 'rNotDraft' | 'rNotSubmitted'
  | 'rNotApproved' | 'rNotLocked' | 'rReasonRequired' | 'rNeedsReauth' | 'rNoSettlement';

export const PAYROLL_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Payroll', langName: 'தமிழ்',
    lead: 'Review the month, resolve every exception, then submit it for a second person to approve. Nothing is final until it is locked; a locked run is corrected by a reversal, never a silent edit. Sensitive details are masked.',
    demoBanner: 'DEMO DATA — NOT REAL PAYROLL',
    offlineBanner: 'You are offline. Payroll needs a live connection — nothing is stored on this device. You can look, but you cannot submit, approve, lock or release a bank file until you are back online.',
    colEmployee: 'Employee', colDepartment: 'Department', colGross: 'Gross', colDeductions: 'Deductions', colNet: 'Net pay',
    sensitiveTitle: 'Payment details', bank: 'Bank account', ifsc: 'IFSC', pan: 'PAN', uan: 'UAN', aadhaar: 'Aadhaar',
    maskedNote: 'Masked. Only the last few characters are shown.',
    earnings: 'Earnings', deductions: 'Deductions', statutory: 'Statutory',
    statusOk: 'Ready to pay', statusNegativeNet: 'Net pay is zero or negative — cannot be paid',
    statusMissingBank: 'No bank account on file — cannot be paid',
    stageNone: 'No run drafted', stageDraft: 'Draft', stageSubmitted: 'Awaiting approval', stageApproved: 'Approved — awaiting lock',
    stageLocked: 'Locked (final)', stageReversed: 'Reversed — issue a corrected run',
    maker: 'Submitted by', checker: 'Approved by',
    submit: 'Submit for approval', approve: 'Approve', reject: 'Send back', lock: 'Lock the run', reverse: 'Reverse (locked)',
    reverseReason: 'Why is this being reversed?',
    departmentSummary: 'By department', totals: 'Totals', blockingCount: 'need attention before this run can be submitted',
    allClear: 'Every employee is ready to pay.',
    stateReady: 'Draft — review and submit', stateEmpty: 'No pay run has been drafted for this period yet.',
    stateNotPermitted: 'You do not have permission to see payroll.',
    stateAwaiting: 'Awaiting a second person', stateLocked: 'Locked — this run is final', stateReversed: 'Reversed — a corrected run is needed',
    nobodyNamed: 'This screen has not been told who is using it, so nothing can be submitted or approved.',
    lockedTitle: 'Locked-run outputs', bankFileTitle: 'Bank file',
    bankFileRecords: 'Payments', bankFileTotal: 'Total to disburse',
    bankFileReconciled: 'Agrees with the run total', bankFileNotReconciled: 'DOES NOT agree with the run total — do not release',
    journalTitle: 'Accounting journal', journalDebit: 'Total debits', journalCredit: 'Total credits',
    journalBalanced: 'Balances — debits equal credits', journalNotBalanced: 'DOES NOT balance — the books would be wrong; do not post',
    journalUnavailable: 'The run totals needed for the journal have not been provided.',
    actGenerateBankFile: 'Generate bank file', actBulkPayslip: 'Download all payslips', actExport: 'Export',
    reauthNeeded: 'Confirm your identity (MFA) to release this', reauthFresh: 'Identity confirmed',
    statutoryTitle: 'Statutory deductions', stPf: 'Provident Fund (PF)', stEsi: 'ESI', stPt: 'Professional Tax', stTds: 'Income tax (TDS)',
    stEmployee: 'From employee', stEmployer: 'Employer’s share', stTotalEmployee: 'Total from employees', stTotalEmployer: 'Total employer contribution',
    confirmWithCa: 'These rates are to be confirmed with your CA before filing.',
    flagArrears: 'ARREARS', flagLoanRecovery: 'LOAN RECOVERY', flagAdvanceRecovery: 'ADVANCE RECOVERY',
    settlementTitle: 'Full-and-final settlement', settlementEarnings: 'Earnings', settlementRecoveries: 'Recoveries', settlementNet: 'Net settlement',
    settlementPayable: 'Payable to the employee', settlementRecoverable: 'Recoverable FROM the employee',
    settlementGratuity: 'Gratuity', settlementGratuityIneligible: 'Not eligible for gratuity',
    settlementUnavailable: 'The settlement figures could not be worked out from what was provided.',
    actReleaseSettlement: 'Release settlement',
    versionDeltaTitle: 'Change from the previous version', versionNoChange: 'No change from the previous version', reversedBy: 'Reversed —',
    rOffline: 'You are offline — this cannot be done until you are back online.',
    rNotPermitted: 'You do not have permission to do this.',
    rBlocking: 'Resolve every exception first — an employee cannot be paid zero, a negative amount, or with no bank account.',
    rSelfApproval: 'The person who submitted a run cannot approve it — a second, different person must.',
    rNoRun: 'There is no pay run to act on — draft one first.',
    rNotDraft: 'Only a draft run can be submitted.', rNotSubmitted: 'Only a submitted run can be approved or sent back.',
    rNotApproved: 'Only an approved run can be locked.', rNotLocked: 'Only a locked run can be reversed, and a bank file / payslips / export come from a locked run.',
    rReasonRequired: 'A reversal needs a reason.',
    rNeedsReauth: 'Confirm your identity (MFA) again before releasing this — your last confirmation is too old.',
    rNoSettlement: 'There is no settlement to release.',
  },
  ta: {
    title: 'ஊதியம்', langName: 'English',
    lead: 'மாதத்தை சரிபார்த்து, ஒவ்வொரு விதிவிலக்கையும் தீர்த்து, பின்னர் இரண்டாவது நபர் அனுமதிக்க சமர்ப்பிக்கவும். பூட்டப்படும் வரை எதுவும் இறுதியல்ல; பூட்டிய பட்டியல் மாற்றப்படாது — திரும்பப்பெறல் மூலம் மட்டுமே சரிசெய்யப்படும். முக்கியத் தகவல்கள் மறைக்கப்பட்டுள்ளன.',
    demoBanner: 'மாதிரித் தகவல் — உண்மையான ஊதியம் அல்ல',
    offlineBanner: 'நீங்கள் ஆஃப்லைனில் உள்ளீர்கள். ஊதியத்திற்கு நேரடி இணைப்பு தேவை — இந்தச் சாதனத்தில் எதுவும் சேமிக்கப்படவில்லை. பார்க்கலாம், ஆனால் மீண்டும் ஆன்லைனில் வரும் வரை சமர்ப்பிக்க, அனுமதிக்க, பூட்ட அல்லது வங்கிக் கோப்பை வெளியிட முடியாது.',
    colEmployee: 'ஊழியர்', colDepartment: 'துறை', colGross: 'மொத்தம்', colDeductions: 'பிடித்தம்', colNet: 'நிகர ஊதியம்',
    sensitiveTitle: 'கட்டண விவரங்கள்', bank: 'வங்கிக் கணக்கு', ifsc: 'IFSC', pan: 'PAN', uan: 'UAN', aadhaar: 'ஆதார்',
    maskedNote: 'மறைக்கப்பட்டது. கடைசி சில எழுத்துகள் மட்டுமே காட்டப்படுகின்றன.',
    earnings: 'வருமானம்', deductions: 'பிடித்தங்கள்', statutory: 'சட்டப்பூர்வம்',
    statusOk: 'செலுத்தத் தயார்', statusNegativeNet: 'நிகர ஊதியம் பூஜ்ஜியம் அல்லது எதிர்மறை — செலுத்த முடியாது',
    statusMissingBank: 'வங்கிக் கணக்கு இல்லை — செலுத்த முடியாது',
    stageNone: 'வரைவு இல்லை', stageDraft: 'வரைவு', stageSubmitted: 'அனுமதிக்காத்திருக்கிறது', stageApproved: 'அனுமதிக்கப்பட்டது — பூட்ட காத்திருக்கிறது',
    stageLocked: 'பூட்டப்பட்டது (இறுதி)', stageReversed: 'திரும்பப்பெறப்பட்டது — திருத்திய பட்டியல் தேவை',
    maker: 'சமர்ப்பித்தவர்', checker: 'அனுமதித்தவர்',
    submit: 'அனுமதிக்கு சமர்ப்பி', approve: 'அனுமதி', reject: 'திரும்ப அனுப்பு', lock: 'பட்டியலைப் பூட்டு', reverse: 'திரும்பப்பெறு (பூட்டியது)',
    reverseReason: 'ஏன் திரும்பப்பெறப்படுகிறது?',
    departmentSummary: 'துறை வாரியாக', totals: 'மொத்தங்கள்', blockingCount: 'இந்தப் பட்டியல் சமர்ப்பிக்கு முன் கவனம் தேவை',
    allClear: 'ஒவ்வொரு ஊழியரும் செலுத்தத் தயார்.',
    stateReady: 'வரைவு — சரிபார்த்து சமர்ப்பி', stateEmpty: 'இந்தக் காலத்திற்கு இன்னும் ஊதியப் பட்டியல் வரையப்படவில்லை.',
    stateNotPermitted: 'ஊதியத்தைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    stateAwaiting: 'இரண்டாவது நபருக்குக் காத்திருக்கிறது', stateLocked: 'பூட்டப்பட்டது — இது இறுதி', stateReversed: 'திரும்பப்பெறப்பட்டது — திருத்திய பட்டியல் தேவை',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று தெரியவில்லை, எனவே எதையும் சமர்ப்பிக்கவோ அனுமதிக்கவோ முடியாது.',
    lockedTitle: 'பூட்டிய பட்டியலின் வெளியீடுகள்', bankFileTitle: 'வங்கிக் கோப்பு',
    bankFileRecords: 'கட்டணங்கள்', bankFileTotal: 'மொத்தம் வழங்க வேண்டியது',
    bankFileReconciled: 'பட்டியல் மொத்தத்துடன் பொருந்துகிறது', bankFileNotReconciled: 'பட்டியல் மொத்தத்துடன் பொருந்தவில்லை — வெளியிட வேண்டாம்',
    journalTitle: 'கணக்குப் பதிவு', journalDebit: 'மொத்த பற்று', journalCredit: 'மொத்த வரவு',
    journalBalanced: 'சமநிலை — பற்றும் வரவும் சமம்', journalNotBalanced: 'சமநிலை இல்லை — கணக்குகள் தவறாகும்; பதிவு செய்ய வேண்டாம்',
    journalUnavailable: 'கணக்குப் பதிவுக்குத் தேவையான மொத்தங்கள் வழங்கப்படவில்லை.',
    actGenerateBankFile: 'வங்கிக் கோப்பை உருவாக்கு', actBulkPayslip: 'அனைத்து ஊதியச் சீட்டுகளையும் பதிவிறக்கு', actExport: 'ஏற்றுமதி',
    reauthNeeded: 'இதை வெளியிட உங்கள் அடையாளத்தை உறுதிப்படுத்தவும் (MFA)', reauthFresh: 'அடையாளம் உறுதிப்படுத்தப்பட்டது',
    statutoryTitle: 'சட்டப்பூர்வப் பிடித்தங்கள்', stPf: 'வருங்கால வைப்பு நிதி (PF)', stEsi: 'ESI', stPt: 'தொழில் வரி', stTds: 'வருமான வரி (TDS)',
    stEmployee: 'ஊழியரிடமிருந்து', stEmployer: 'முதலாளியின் பங்கு', stTotalEmployee: 'ஊழியர்களிடமிருந்து மொத்தம்', stTotalEmployer: 'முதலாளி பங்களிப்பு மொத்தம்',
    confirmWithCa: 'இந்த விகிதங்களை தாக்கல் செய்வதற்கு முன் உங்கள் CA உடன் உறுதிப்படுத்தவும்.',
    flagArrears: 'நிலுவை', flagLoanRecovery: 'கடன் மீட்பு', flagAdvanceRecovery: 'முன்பணம் மீட்பு',
    settlementTitle: 'முழு இறுதித் தீர்வு', settlementEarnings: 'வருமானம்', settlementRecoveries: 'மீட்புகள்', settlementNet: 'நிகரத் தீர்வு',
    settlementPayable: 'ஊழியருக்குச் செலுத்த வேண்டியது', settlementRecoverable: 'ஊழியரிடமிருந்து மீட்க வேண்டியது',
    settlementGratuity: 'பணிக்கொடை', settlementGratuityIneligible: 'பணிக்கொடைக்குத் தகுதியில்லை',
    settlementUnavailable: 'வழங்கப்பட்டதிலிருந்து தீர்வுத் தொகைகளைக் கணக்கிட முடியவில்லை.',
    actReleaseSettlement: 'தீர்வை வெளியிடு',
    versionDeltaTitle: 'முந்தைய பதிப்பிலிருந்து மாற்றம்', versionNoChange: 'முந்தைய பதிப்பிலிருந்து மாற்றம் இல்லை', reversedBy: 'திரும்பப்பெறப்பட்டது —',
    rOffline: 'நீங்கள் ஆஃப்லைனில் உள்ளீர்கள் — மீண்டும் ஆன்லைனில் வரும் வரை இதைச் செய்ய முடியாது.',
    rNotPermitted: 'இதைச் செய்ய உங்களுக்கு அனுமதி இல்லை.',
    rBlocking: 'முதலில் ஒவ்வொரு விதிவிலக்கையும் தீர்க்கவும் — ஒரு ஊழியருக்கு பூஜ்ஜியம், எதிர்மறை அல்லது வங்கிக் கணக்கு இல்லாமல் செலுத்த முடியாது.',
    rSelfApproval: 'பட்டியலைச் சமர்ப்பித்தவர் அதை அனுமதிக்க முடியாது — வேறு இரண்டாவது நபர் அனுமதிக்க வேண்டும்.',
    rNoRun: 'செயல்பட ஊதியப் பட்டியல் இல்லை — முதலில் ஒன்றை வரையவும்.',
    rNotDraft: 'வரைவுப் பட்டியலை மட்டுமே சமர்ப்பிக்க முடியும்.', rNotSubmitted: 'சமர்ப்பித்த பட்டியலை மட்டுமே அனுமதிக்கவோ திரும்ப அனுப்பவோ முடியும்.',
    rNotApproved: 'அனுமதிக்கப்பட்ட பட்டியலை மட்டுமே பூட்ட முடியும்.', rNotLocked: 'பூட்டிய பட்டியலை மட்டுமே திரும்பப்பெற முடியும்; வங்கிக் கோப்பு / ஊதியச் சீட்டு / ஏற்றுமதி பூட்டிய பட்டியலிலிருந்து வரும்.',
    rReasonRequired: 'திரும்பப்பெற ஒரு காரணம் தேவை.',
    rNeedsReauth: 'இதை வெளியிடும் முன் உங்கள் அடையாளத்தை (MFA) மீண்டும் உறுதிப்படுத்தவும் — உங்கள் கடைசி உறுதிப்படுத்தல் மிகவும் பழையது.',
    rNoSettlement: 'வெளியிட எந்தத் தீர்வும் இல்லை.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(PAYROLL_COPY.en) as CopyKey[]);

const EXCEPTION_LABEL: Readonly<Record<ExceptionKind, CopyKey>> = {
  negative_or_zero_net: 'statusNegativeNet',
  missing_bank_account: 'statusMissingBank',
};

/** Every refusal the screen can give for an action. Engine reasons plus the screen's own gates. */
export type PayrollRefusal =
  | 'offline' | 'not_permitted' | 'nobody_named' | 'has_blocking_exceptions' | 'needs_reauth' | 'no_settlement'
  | PayRunRefusalReason;

const REFUSAL_LABEL: Readonly<Record<PayrollRefusal, CopyKey>> = {
  offline: 'rOffline', not_permitted: 'rNotPermitted', nobody_named: 'nobodyNamed', has_blocking_exceptions: 'rBlocking',
  needs_reauth: 'rNeedsReauth', no_settlement: 'rNoSettlement',
  self_approval: 'rSelfApproval', no_pay_run: 'rNoRun', not_in_draft: 'rNotDraft', not_submitted: 'rNotSubmitted',
  not_approved: 'rNotApproved', not_locked: 'rNotLocked', reason_required: 'rReasonRequired',
};

/** An arrears / loan / advance flag → its copy key, so the badge is bilingual. */
export const LINE_FLAG_LABEL: Readonly<Record<LineFlag, CopyKey>> = {
  arrears: 'flagArrears', loan_recovery: 'flagLoanRecovery', advance_recovery: 'flagAdvanceRecovery',
};

// ── presented shapes ─────────────────────────────────────────────────────────────────────────────────

export interface PresentedEmployee {
  readonly employeeId: string;
  readonly name: string;
  readonly department: string;
  readonly grossMinor: number;
  readonly totalDeductionsMinor: number;
  readonly netPayMinor: number;
  readonly masked: MaskedIdentifiers; // bank/pan/uan/aadhaar — never raw
  readonly ifsc?: string;
  readonly earnings: readonly MoneyLine[];
  readonly deductions: readonly MoneyLine[];
  readonly statutory: readonly MoneyLine[];
  readonly exceptions: readonly ExceptionKind[];
  readonly status: StatusPresentation; // ok / blocking, with icon + word + announcement
  readonly needsAttention: boolean;
}

export interface DepartmentSummary {
  readonly department: string;
  readonly count: number;
  readonly grossMinor: number;
  readonly netMinor: number;
}

/** The bank-file SUMMARY — count + total, and whether it agrees with the run. NO account numbers here: the
 *  file itself (with full accounts) is generated server-side under re-auth, never in the browser. */
export interface BankFileSummary {
  readonly recordCount: number;
  readonly totalNetMinor: number;
  /** True when the total to disburse equals the run's net total — the control-total check before release. */
  readonly reconciledWithRun: boolean;
}

/** The accounting journal's balance check — total debits vs total credits (the reconciliation invariant). */
export interface JournalCheck {
  readonly available: boolean;
  readonly balanced: boolean;
  readonly totalDebitMinor: number;
  readonly totalCreditMinor: number;
  readonly detail: string;
}

/** What a LOCKED run produces: the bank-file summary, the journal balance, and whether everything reconciles. */
export interface LockedArtifacts {
  readonly bankFile: BankFileSummary;
  readonly journal: JournalCheck;
  /** All three agree (bank total = run net, journal balances) — the go/no-go for release. */
  readonly reconciled: boolean;
}

/** The statutory deduction totals for the period — employee + employer shares, for the returns. CONFIRM-WITH-CA. */
export interface StatutoryReport {
  readonly pfEmployeeMinor: number;
  readonly pfEmployerMinor: number;
  readonly esiEmployeeMinor: number;
  readonly esiEmployerMinor: number;
  readonly professionalTaxMinor: number;
  readonly tdsMinor: number;
  readonly totalEmployeeMinor: number;
  readonly totalEmployerMinor: number;
  readonly confirmWithCa: true;
}

/** A leaver's full-and-final settlement, presented. Negative net is EXPECTED here (recoverable), not a fault. */
export interface PresentedSettlement {
  readonly available: boolean;
  readonly earnings: readonly SettlementLine[];
  readonly recoveries: readonly SettlementLine[];
  readonly grossEarningsMinor: number;
  readonly totalRecoveriesMinor: number;
  /** Signed: positive is payable to the employee, negative is recoverable FROM them. */
  readonly netSettlementMinor: number;
  readonly payableToEmployee: boolean;
  readonly gratuity: GratuityResult;
  readonly detail: string;
}

export interface PayrollView {
  readonly demo: boolean;
  readonly online: boolean;
  readonly mayView: boolean;
  readonly nobodyNamed: boolean;
  /** Whether the user has a FRESH re-auth right now — drives the MFA prompt on sensitive actions. */
  readonly reauthFresh: boolean;
  readonly payPeriod: string;
  readonly stage: PayRunState | 'none';
  readonly stageLabelKey: CopyKey;
  readonly submittedBy?: string;
  readonly approvedBy?: string;
  readonly employees: readonly PresentedEmployee[];
  readonly departments: readonly DepartmentSummary[];
  readonly totals: { readonly count: number; readonly grossMinor: number; readonly totalDeductionsMinor: number; readonly netMinor: number };
  readonly blockingExceptionCount: number;
  /** Present only when the run is LOCKED — the bank-file summary + journal reconciliation. */
  readonly lockedArtifacts?: LockedArtifacts;
  /** The period's statutory deduction totals, when the run totals are known. */
  readonly statutory?: StatutoryReport;
  /** A leaver's full-and-final settlement, when this screen is showing one. */
  readonly settlement?: PresentedSettlement;
  /** How this version's net differs from the previous version, when there is a prior to compare. */
  readonly versionDeltaMinor?: number;
  /** Why a reversed run was reversed — surfaced, so a correction is never invisible. */
  readonly reversedReason?: string;
  readonly screenState: StatusPresentation;
}

export interface ActionOutcome {
  readonly ok: boolean;
  readonly detail: string;
  readonly refusal?: PayrollRefusal;
  readonly refusalLabelKey?: CopyKey;
  readonly resultingState?: PayRunState;
}

export interface PayrollSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): PayrollView;
  /** May `actor` (the signed-in user) take this action right now? Returns the refusal without taking it. */
  can(action: PayrollAction, opts?: { readonly reason?: string }): ActionOutcome;
}

const STAGE_LABEL: Readonly<Record<PayRunState | 'none', CopyKey>> = {
  none: 'stageNone', draft: 'stageDraft', submitted: 'stageSubmitted', approved: 'stageApproved',
  locked: 'stageLocked', reversed: 'stageReversed',
};

export function createPayrollSession(config: PayrollConfig, ports: PayrollPorts): PayrollSession {
  const text = (lang: Lang, key: CopyKey): string => translator(PAYROLL_COPY, lang)(key);

  const exceptionsFor = (e: EmployeeInput): ExceptionKind[] => {
    const out: ExceptionKind[] = [];
    // The bank file refuses net ≤ 0 (bank-file.ts); surface it here so it is caught before submission.
    if (e.netPayMinor <= 0) out.push('negative_or_zero_net');
    if ((e.bankAccount ?? '').trim() === '') out.push('missing_bank_account');
    return out;
  };

  const presentEmployee = (lang: Lang, e: EmployeeInput): PresentedEmployee => {
    const t = translator(PAYROLL_COPY, lang);
    const exceptions = exceptionsFor(e);
    const needsAttention = exceptions.length > 0;
    // The first exception drives the status label; colour is never alone (icon + word + announcement).
    const label = needsAttention ? t(EXCEPTION_LABEL[exceptions[0]!]) : t('statusOk');
    const status = presentStatus({
      tone: needsAttention ? 'error' : 'ok',
      icon: needsAttention ? '✕' : '✓',
      label,
      announcement: `${e.name}: ${label}`,
      needsAttention,
    });
    return {
      employeeId: e.employeeId,
      name: e.name,
      department: e.department,
      grossMinor: e.grossMinor,
      totalDeductionsMinor: e.totalDeductionsMinor,
      netPayMinor: e.netPayMinor,
      // The single place raw identifiers become display strings. Nothing downstream ever sees them whole.
      masked: maskIdentifiers({ bankAccount: e.bankAccount, pan: e.pan, uan: e.uan, aadhaar: e.aadhaar }),
      ...(e.bankIfsc == null || e.bankIfsc.trim() === '' ? {} : { ifsc: e.bankIfsc.trim() }),
      earnings: e.earnings ?? [],
      deductions: e.deductions ?? [],
      statutory: e.statutory ?? [],
      exceptions,
      status,
      needsAttention,
    };
  };

  const screenStateFor = (lang: Lang, stage: PayRunState | 'none', mayView: boolean): StatusPresentation => {
    const t = translator(PAYROLL_COPY, lang);
    if (!mayView) return presentScreenState({ state: 'error', label: t('stateNotPermitted') });
    switch (stage) {
      case 'none': return presentScreenState({ state: 'empty', label: t('stateEmpty') });
      case 'draft': return presentScreenState({ state: 'ready', label: t('stateReady') });
      case 'submitted': case 'approved': return presentScreenState({ state: 'pending', label: t('stateAwaiting') });
      case 'locked': return presentScreenState({ state: 'locked', label: t('stateLocked') });
      case 'reversed': return presentScreenState({ state: 'recovery', label: t('stateReversed') });
    }
  };

  /** A fresh re-auth: the user re-authenticated within the configured window, and not never. */
  const reauthFresh = (): boolean => {
    const age = ports.reauthAgeSeconds();
    return age !== undefined && age >= 0 && age <= config.reauthFreshWithinSeconds;
  };

  /** The bank-file summary + journal balance for a LOCKED run — the reconciliation before release. */
  const lockedArtifactsFor = (employees: readonly PresentedEmployee[], runNetMinor: number): LockedArtifacts => {
    // Bank-file SUMMARY only — count of payable lines and their total. No account numbers here; the file
    // itself is generated server-side under re-auth. Every payable line has net > 0 (a locked run's
    // blocking exceptions were resolved before submission).
    const payable = employees.filter((e) => e.netPayMinor > 0);
    const totalNetMinor = payable.reduce((s, e) => s + e.netPayMinor, 0);
    const bankFile: BankFileSummary = {
      recordCount: payable.length,
      totalNetMinor,
      reconciledWithRun: totalNetMinor === runNetMinor,
    };

    // The journal balances iff debits === credits — computed by the tested engine. It carries no PII, so it
    // is safe to run in the browser. Absent totals → unavailable; a total set that does not balance → the
    // engine throws and we surface a reconciliation FAILURE rather than a silent pass.
    const totals = ports.totals();
    let journal: JournalCheck;
    if (totals === undefined) {
      journal = { available: false, balanced: false, totalDebitMinor: 0, totalCreditMinor: 0, detail: 'no totals' };
    } else {
      try {
        const j = buildPayrollJournal({ payRunState: 'locked', payPeriod: ports.payPeriod, totals });
        journal = { available: true, balanced: true, totalDebitMinor: j.totalDebitMinor, totalCreditMinor: j.totalCreditMinor, detail: j.detail };
      } catch (err) {
        const detail = err instanceof InvalidPayrollJournal ? err.message : 'journal could not be built';
        journal = { available: true, balanced: false, totalDebitMinor: totals.grossMinor + totals.pfEmployerMinor + totals.esiEmployerMinor, totalCreditMinor: totals.netMinor + totals.pfEmployeeMinor + totals.pfEmployerMinor + totals.esiEmployeeMinor + totals.esiEmployerMinor + totals.professionalTaxMinor + totals.tdsMinor, detail };
      }
    }
    return { bankFile, journal, reconciled: bankFile.reconciledWithRun && journal.available && journal.balanced };
  };

  /** The statutory report from the run's totals — employee + employer shares, for the returns. */
  const statutoryFor = (totals: PayrollTotals): StatutoryReport => ({
    pfEmployeeMinor: totals.pfEmployeeMinor,
    pfEmployerMinor: totals.pfEmployerMinor,
    esiEmployeeMinor: totals.esiEmployeeMinor,
    esiEmployerMinor: totals.esiEmployerMinor,
    professionalTaxMinor: totals.professionalTaxMinor,
    tdsMinor: totals.tdsMinor,
    totalEmployeeMinor: totals.pfEmployeeMinor + totals.esiEmployeeMinor + totals.professionalTaxMinor + totals.tdsMinor,
    totalEmployerMinor: totals.pfEmployerMinor + totals.esiEmployerMinor,
    confirmWithCa: true,
  });

  /** Run the tested settlement engine over a leaver's inputs. A bad input → available:false, never a guess. */
  const settlementFor = (input: SettlementInput): PresentedSettlement => {
    try {
      const s = computeSettlement(input);
      return {
        available: true, earnings: s.earnings, recoveries: s.recoveries,
        grossEarningsMinor: s.grossEarningsMinor, totalRecoveriesMinor: s.totalRecoveriesMinor,
        // Signed net is expected to go negative here (recoverable) — that is NOT a blocking exception.
        netSettlementMinor: s.netSettlementMinor, payableToEmployee: s.payableToEmployee,
        gratuity: s.gratuity, detail: s.detail,
      };
    } catch (err) {
      const detail = err instanceof InvalidStatutorySchedule ? err.message : 'settlement could not be computed';
      return {
        available: false, earnings: [], recoveries: [], grossEarningsMinor: 0, totalRecoveriesMinor: 0,
        netSettlementMinor: 0, payableToEmployee: false,
        gratuity: { eligible: false, gratuityMinor: 0, cappedAtCeiling: false, detail: 'n/a' }, detail,
      };
    }
  };

  return {
    text,

    view: (lang) => {
      const mayView = ports.mayView();
      const run = ports.run();
      const stage: PayRunState | 'none' = run?.state ?? 'none';
      if (!mayView) {
        // Nothing leaks: no employees, no totals, no names.
        return {
          demo: config.demo, online: ports.online(), mayView: false, nobodyNamed: config.userId === null, reauthFresh: false,
          payPeriod: ports.payPeriod, stage: 'none', stageLabelKey: STAGE_LABEL.none,
          employees: [], departments: [],
          totals: { count: 0, grossMinor: 0, totalDeductionsMinor: 0, netMinor: 0 },
          blockingExceptionCount: 0, screenState: screenStateFor(lang, 'none', false),
        };
      }

      const employees = ports.employees().map((e) => presentEmployee(lang, e));
      const totals = ports.totals();
      const settlementInput = ports.settlement();
      const previousNet = ports.previousNetMinor();
      const byDept = new Map<string, DepartmentSummary>();
      let grossMinor = 0, totalDeductionsMinor = 0, netMinor = 0;
      for (const e of employees) {
        grossMinor += e.grossMinor; totalDeductionsMinor += e.totalDeductionsMinor; netMinor += e.netPayMinor;
        const d = byDept.get(e.department) ?? { department: e.department, count: 0, grossMinor: 0, netMinor: 0 };
        byDept.set(e.department, { department: e.department, count: d.count + 1, grossMinor: d.grossMinor + e.grossMinor, netMinor: d.netMinor + e.netPayMinor });
      }
      // The ones needing attention first, then a stable order.
      const ordered = [...employees].sort((a, b) => {
        if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
        return a.employeeId.localeCompare(b.employeeId);
      });
      return {
        demo: config.demo, online: ports.online(), mayView: true, nobodyNamed: config.userId === null, reauthFresh: reauthFresh(),
        payPeriod: ports.payPeriod, stage, stageLabelKey: STAGE_LABEL[stage],
        ...(run?.submittedBy === undefined ? {} : { submittedBy: run.submittedBy }),
        ...(run?.approvedBy === undefined ? {} : { approvedBy: run.approvedBy }),
        employees: ordered,
        departments: [...byDept.values()].sort((a, b) => a.department.localeCompare(b.department)),
        totals: { count: employees.length, grossMinor, totalDeductionsMinor, netMinor },
        blockingExceptionCount: employees.filter((e) => e.needsAttention).length,
        // Only a LOCKED run has a bank file and a journal to reconcile before release.
        ...(stage === 'locked' ? { lockedArtifacts: lockedArtifactsFor(ordered, run?.netTotalMinor ?? netMinor) } : {}),
        ...(totals === undefined ? {} : { statutory: statutoryFor(totals) }),
        ...(settlementInput === undefined ? {} : { settlement: settlementFor(settlementInput) }),
        ...(previousNet === undefined ? {} : { versionDeltaMinor: netMinor - previousNet }),
        ...(run?.reversedReason === undefined ? {} : { reversedReason: run.reversedReason }),
        screenState: screenStateFor(lang, stage, true),
      };
    },

    can: (action, opts) => {
      const refuse = (refusal: PayrollRefusal, detail: string): ActionOutcome =>
        ({ ok: false, refusal, refusalLabelKey: REFUSAL_LABEL[refusal], detail });

      if (!ports.mayView()) return refuse('not_permitted', 'this user does not hold the payroll permission.');
      if (config.userId === null) return refuse('nobody_named', 'this screen has not been told who is using it.');
      // Offline blocks every state change — the directive's hard line for sensitive administrative data.
      if (!ports.online()) return refuse('offline', 'the screen is offline; a state change is not allowed until it is back online.');

      // Sensitive actions (approve, lock, reverse, bank file, bulk payslips, export) need a FRESH re-auth
      // (MFA) — the owner directive. Checked here, before anything else action-specific.
      if (SENSITIVE.has(action) && !reauthFresh()) {
        return refuse('needs_reauth', 'a fresh identity confirmation (MFA) is required to release this.');
      }

      // Releasing a leaver's settlement — sensitive (re-auth checked above), and only when there IS one.
      if (action === 'releaseSettlement') {
        if (ports.settlement() === undefined) return refuse('no_settlement', 'there is no settlement to release.');
        return { ok: true, detail: 'release the full-and-final settlement' };
      }

      // The locked-run artifacts (bank file, bulk payslips, export) are not lifecycle transitions — they are
      // produced FROM a locked run, so they gate on the run being locked, not on the transition engine.
      if (LOCKED_RUN_ACTIONS.has(action)) {
        if (ports.run()?.state !== 'locked') return refuse('not_locked', 'this can only be produced from a locked pay run.');
        return { ok: true, detail: `${action} from the locked run` };
      }

      // A run cannot be SUBMITTED while any employee cannot be paid. Checked before the engine so the reason
      // is the real one ("resolve the exceptions") rather than a generic state error.
      if (action === 'submit') {
        const blocking = ports.employees().some((e) => e.netPayMinor <= 0 || (e.bankAccount ?? '').trim() === '');
        if (blocking) return refuse('has_blocking_exceptions', 'at least one employee cannot be paid; resolve every exception before submitting.');
      }

      const decision = evaluatePayRunTransition({
        current: ports.run(),
        action: action as PayRunAction,
        actor: config.userId,
        ...(opts?.reason === undefined ? {} : { reason: opts.reason }),
      });
      if (!decision.allowed) {
        const refusal = (decision.refusal ?? 'no_pay_run') as PayrollRefusal;
        return refuse(refusal, decision.reason);
      }
      return { ok: true, detail: decision.reason, ...(decision.resultingState === undefined ? {} : { resultingState: decision.resultingState }) };
    },
  };
}
