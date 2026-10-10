// The Approvals page — head office's maker-checker inbox (ADR-0024 · audit PA-03 · M02-FR-03 · §28 · P-04 · P-05).
//
// Head office's approval engine replaced every box where the person doing the work TYPED the approver's name. Now:
//   1. the MAKER asks for approval in their own session (`POST /v1/approvals/requests`) — the import, Products & prices,
//      Finance (month close and reopen) and Record a loss (a material write-off) screens do this;
//   2. a CHECKER — anyone else who holds that kind's approval permission, never the maker — sees the request here,
//      under "Waiting for you", and approves or rejects it WITH A WRITTEN REASON, in their own session
//      (`POST /v1/approvals/requests/:requestId/decide`);
//   3. the maker then does the action naming the approved request; it is spent once.
//
// This page is the checker's inbox and the maker's list of what they asked for (`GET /v1/approvals/requests`). Every
// signed-in person may open it (`identity.self.read`, the same word the routes check): the server decides what waits
// for whom — never the maker's own request — and is the single gate on every decision. The screen refuses only the
// cheap things locally before any POST (nobody named, no reason written, a request that is not waiting for this
// person), and it shows the server's own words when the server refuses.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui + a11y
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only renders what
// this hands over. No AI approves anything (hard rule #5): a decision is a person's click with a person's reason.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

// ── the shapes the routes hand over (shared with the import screen, which asks for approvals) ────────────────────

export type ApprovalStatus = 'waiting' | 'approved' | 'rejected' | 'expired' | 'used';

/** One request as `GET /v1/approvals/requests` hands it over (the request, where it stands, and its decision). */
export interface ApprovalRequestView {
  readonly requestId: string;
  readonly kind: string;
  /** What the action is, in the owner's words (from the server's kind catalogue). */
  readonly label: string;
  readonly subjectRef: string;
  /** The amount it is for, in paise; null when the action moves no money. */
  readonly valueMinor: number | null;
  /** The exact details the maker asked for — what will actually happen. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly status: ApprovalStatus;
  readonly decidedBy?: string;
  readonly decisionReason?: string;
  readonly decidedAt?: string;
  readonly expiresAt?: string | null;
  readonly usedBy?: string;
}

/** The inbox: what waits for the caller to decide (never their own), and what they asked for. */
export interface ApprovalInboxView {
  readonly waitingForMe: readonly ApprovalRequestView[];
  readonly mine: readonly ApprovalRequestView[];
  readonly asAt: string | null;
}

/** The server refused, in its own words (`{ error: { code, whatHappened } }`). */
export interface Refused { readonly result: 'refused'; readonly code: string; readonly whatHappened: string; }
/** The request never got an answer — nothing is known to have happened. */
export interface LostLink { readonly result: 'lost_link'; }

/** A read of the inbox (GET — writes nothing). */
export type InboxRead = { readonly result: 'read'; readonly inbox: ApprovalInboxView } | Refused | LostLink;

/** What a maker asks for (POST /v1/approvals/requests). */
export interface ApprovalAsk {
  readonly kind: string;
  readonly subjectRef: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly valueMinor: number | null;
  readonly summary: string;
  readonly reason: string;
}
export type AskResult = { readonly result: 'asked'; readonly request: ApprovalRequestView } | Refused | LostLink;

export type DecisionWord = 'approved' | 'rejected';
/** A checker's decision as the server recorded it. */
export type DecideResult = { readonly result: 'decided'; readonly decision: DecisionWord; readonly decidedBy: string } | Refused | LostLink;

export interface ApprovalsPorts {
  /** The inbox the shell last read (live from head office, or the injected stand-in). */
  inbox(): ApprovalInboxView;
  /** Whether this person may use approvals at all (`identity.self.read` — every signed-in member of the shop). */
  mayUse(): boolean;
  /** Record a decision (POST /v1/approvals/requests/:requestId/decide) in the caller's own session. Only on a click. */
  decide(input: { readonly requestId: string; readonly decision: DecisionWord; readonly reason: string }): Promise<DecideResult>;
}

export interface ApprovalsConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen — then nothing is decided. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'waitingHeading' | 'waitingCount' | 'nothingWaiting' | 'mineHeading' | 'nothingAsked'
  | 'askedByLabel' | 'whyLabel' | 'whenLabel' | 'amountLabel' | 'detailsLabel' | 'aboutLabel'
  | 'reasonLabel' | 'reasonPlaceholder' | 'approveBtn' | 'rejectBtn'
  | 'kindDataImport' | 'kindDataImportRollback' | 'kindCategoryDefine' | 'kindSupplierBank'
  | 'kindPriceChange' | 'kindPriceListEntry' | 'kindPromotionLaunch' | 'kindQuotationBelowFloor'
  | 'kindPeriodClose' | 'kindPeriodReopen' | 'kindConcessionContract' | 'kindConcessionDepositForfeit'
  | 'kindStockWriteOff' | 'kindStockAdjustmentUp' | 'kindOrderRefund' | 'kindServiceCompensation'
  | 'kindSupplierInvoiceCheck' | 'kindSupplierPayment'
  | 'kindDisplayContract' | 'kindRebateScheme' | 'kindPurchaseContract'
  | 'kindEmergencyAccess' | 'kindAccessChange' | 'kindSubstitutionAboveCap'
  | 'detailJobId' | 'detailContentFingerprint'
  | 'detailProductId' | 'detailPriceMinor' | 'detailMrpMinor' | 'detailCostMinor' | 'detailCurrency' | 'detailMarginFloorBps'
  | 'detailPromotionId' | 'detailDescription' | 'detailNormalPrice' | 'detailPromoPrice' | 'detailUnitCost'
  | 'detailVendorFundingPerUnit' | 'detailBaselineUnits' | 'detailExpectedUnits'
  | 'detailPeriod' | 'detailReason'
  | 'detailLocationId' | 'detailQty' | 'detailUom' | 'detailLossType' | 'detailReasonCode' | 'detailValueMinor' | 'detailEvidenceRef'
  | 'detailWriteOffId'
  | 'detailAmountMinor' | 'detailRefundId' | 'detailOrderId' | 'detailBasis' | 'detailCaseId' | 'detailKind'
  | 'detailInvoiceId' | 'detailSupplierId' | 'detailPaymentId' | 'detailPaidOn' | 'detailMethod' | 'detailReference'
  | 'detailMovementId' | 'detailQuantityMinor'
  | 'detailStoreId' | 'detailFundingAmount' | 'detailStartsOn' | 'detailEndsOn' | 'detailLocationIds' | 'detailAreaId'
  | 'detailContractId' | 'detailSchemeId' | 'detailRateBp' | 'detailThresholdMinor' | 'detailAgreedLeadTimeDays'
  | 'detailUserId' | 'detailRoleId' | 'detailBranchScope' | 'detailMinutes' | 'detailMaxMinutes' | 'detailGrantId'
  | 'detailEvent' | 'detailGrants' | 'detailOwnedOpenItems' | 'detailRequestId' | 'allBranches'
  | 'statusWaitingForYou' | 'statusWaiting' | 'statusApproved' | 'statusApprovedUntil' | 'statusRejected'
  | 'statusExpired' | 'statusUsed'
  | 'decidedApproved' | 'decidedRejected' | 'decideNeedsReason' | 'decideNobody' | 'decideNotPermitted'
  | 'decideNotWaiting' | 'decideOwnRequest' | 'decideAlreadyDecided' | 'decideRefused' | 'decideRefusedNoWords' | 'decideLostLink'
  | 'yesWord' | 'noWord'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const APPROVALS_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Approvals', langName: 'தமிழ்',
    lead: 'Some actions need a second person. Here you approve or reject what other people have asked for — always with a reason they can read — and see where your own requests stand. You can never approve your own.',
    waitingHeading: 'Waiting for you', waitingCount: 'waiting for you', nothingWaiting: 'Nothing is waiting for you to approve.',
    mineHeading: 'What you asked for', nothingAsked: 'You have not asked for any approvals.',
    askedByLabel: 'Asked by', whyLabel: 'Why', whenLabel: 'When', amountLabel: 'Amount', detailsLabel: 'Exactly what will happen', aboutLabel: 'About',
    reasonLabel: 'Your reason (the person who asked will read it)', reasonPlaceholder: 'For example: checked the prices against the supplier\'s letter.',
    approveBtn: 'Approve', rejectBtn: 'Reject',
    kindDataImport: 'Apply a bulk import', kindDataImportRollback: 'Undo a bulk import', kindCategoryDefine: 'Add or change a product category', kindSupplierBank: 'Change where a supplier is paid',
    kindPriceChange: 'Set a price below cost or below the margin floor', kindPriceListEntry: 'Add a price-list entry below cost or below the margin floor',
    kindPromotionLaunch: 'Launch a promotion that loses margin', kindQuotationBelowFloor: 'Quote a customer below the margin floor',
    kindPeriodClose: 'Close and sign an accounting month', kindPeriodReopen: 'Reopen a signed accounting month',
    kindConcessionContract: 'Approve a concession contract', kindConcessionDepositForfeit: 'Forfeit a concessionaire\'s deposit',
    kindStockWriteOff: 'Write off stock (a material loss)', kindStockAdjustmentUp: 'Correct stock upward',
    kindOrderRefund: 'Refund an online order', kindServiceCompensation: 'Give a customer compensation above the desk\'s own limit',
    kindSupplierInvoiceCheck: 'Check a supplier bill', kindSupplierPayment: 'Pay a supplier',
    kindDisplayContract: 'Approve a supplier\'s display-space funding', kindRebateScheme: 'Approve a supplier rebate scheme',
    kindPurchaseContract: 'Approve a supplier contract',
    kindEmergencyAccess: 'Give someone emergency access for a short time', kindAccessChange: 'Change a person\'s access (joining, moving or leaving)',
    kindSubstitutionAboveCap: 'Charge a dearer substitute above the original price',
    detailJobId: 'Load name', detailContentFingerprint: 'File check code',
    detailProductId: 'Item', detailPriceMinor: 'New price', detailMrpMinor: 'MRP', detailCostMinor: 'What it costs us', detailCurrency: 'Currency',
    detailMarginFloorBps: 'Minimum margin', detailPromotionId: 'Offer', detailDescription: 'Offer description', detailNormalPrice: 'Normal price',
    detailPromoPrice: 'Offer price', detailUnitCost: 'What one unit costs us', detailVendorFundingPerUnit: 'Supplier pays per unit',
    detailBaselineUnits: 'Units we sell now', detailExpectedUnits: 'Units expected with the offer',
    detailPeriod: 'Month', detailReason: 'Why',
    detailLocationId: 'Where', detailQty: 'Quantity', detailUom: 'Unit', detailLossType: 'Kind of loss', detailReasonCode: 'Reason code',
    detailValueMinor: 'What it is worth', detailEvidenceRef: 'Evidence', detailWriteOffId: 'Write-off',
    detailAmountMinor: 'Amount', detailRefundId: 'Refund', detailOrderId: 'Order', detailBasis: 'Reason for the refund',
    detailCaseId: 'Customer case', detailKind: 'What kind', detailInvoiceId: 'Supplier bill', detailSupplierId: 'Supplier',
    detailPaymentId: 'Payment', detailPaidOn: 'Paid on', detailMethod: 'How it is paid', detailReference: 'Reference',
    detailMovementId: 'Stock movement', detailQuantityMinor: 'Quantity',
    detailStoreId: 'Store', detailFundingAmount: 'Funding the supplier pays', detailStartsOn: 'Starts on', detailEndsOn: 'Ends on',
    detailLocationIds: 'Display places', detailAreaId: 'Floor area', detailContractId: 'Contract', detailSchemeId: 'Rebate scheme',
    detailRateBp: 'Rebate rate', detailThresholdMinor: 'Buying needed before it pays', detailAgreedLeadTimeDays: 'Agreed delivery time (days)',
    detailUserId: 'Person', detailRoleId: 'Role', detailBranchScope: 'Branches', detailMinutes: 'For how many minutes',
    detailMaxMinutes: 'Longest allowed (minutes)', detailGrantId: 'Emergency grant', detailEvent: 'Joining, moving or leaving',
    detailGrants: 'Access after the change', detailOwnedOpenItems: 'Open work they still own', detailRequestId: 'Access change',
    allBranches: 'all branches',
    statusWaitingForYou: 'Waiting for your decision', statusWaiting: 'Waiting for a second person',
    statusApproved: 'Approved by {who}', statusApprovedUntil: 'Approved by {who} — use it before {until}',
    statusRejected: 'Rejected by {who}: {reason}', statusExpired: 'Expired — it was not used in time. Ask again.',
    statusUsed: 'Used — the action it allowed has been done.',
    decidedApproved: 'Approved. The person who asked can now go ahead — once.',
    decidedRejected: 'Rejected. The person who asked will see your reason.',
    decideNeedsReason: 'Write a reason first — the person who asked reads it, and it is kept on the record.',
    decideNobody: 'This store computer has not been told who is using this screen, so nothing can be decided here.',
    decideNotPermitted: 'You do not have permission to use approvals.',
    decideNotWaiting: 'That request is no longer waiting for you — someone may already have decided it. The list has been read again.',
    decideOwnRequest: 'You asked for this, so a different person must decide it (§28).',
    decideAlreadyDecided: 'Someone already decided this:', decideRefused: 'Not recorded:',
    decideRefusedNoWords: 'Not recorded — head office refused the decision.',
    decideLostLink: 'No connection — nothing was decided. Try again.',
    yesWord: 'yes', noWord: 'no',
    scrReady: 'Showing your approvals', scrEmpty: 'Nothing is waiting for you to approve.',
    stateNotPermitted: 'You do not have permission to use approvals.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'அனுமதிகள்', langName: 'English',
    lead: 'சில செயல்களுக்கு இரண்டாம் நபரின் அனுமதி தேவை. மற்றவர்கள் கேட்டதை இங்கே நீங்கள் அனுமதிக்கலாம் அல்லது மறுக்கலாம் — எப்போதும் அவர்கள் படிக்கக்கூடிய காரணத்துடன் — உங்கள் சொந்தக் கோரிக்கைகள் எந்த நிலையில் உள்ளன என்பதையும் பார்க்கலாம். உங்கள் சொந்தக் கோரிக்கையை நீங்களே ஒருபோதும் அனுமதிக்க முடியாது.',
    waitingHeading: 'உங்களுக்காகக் காத்திருப்பவை', waitingCount: 'உங்களுக்காகக் காத்திருக்கின்றன', nothingWaiting: 'நீங்கள் அனுமதிக்க எதுவும் காத்திருக்கவில்லை.',
    mineHeading: 'நீங்கள் கேட்டவை', nothingAsked: 'நீங்கள் எந்த அனுமதியும் கேட்கவில்லை.',
    askedByLabel: 'கேட்டவர்', whyLabel: 'ஏன்', whenLabel: 'எப்போது', amountLabel: 'தொகை', detailsLabel: 'சரியாக என்ன நடக்கும்', aboutLabel: 'எதைப் பற்றி',
    reasonLabel: 'உங்கள் காரணம் (கேட்டவர் இதைப் படிப்பார்)', reasonPlaceholder: 'உதாரணம்: விநியோகஸ்தரின் கடிதத்துடன் விலைகளைச் சரிபார்த்தேன்.',
    approveBtn: 'அனுமதி', rejectBtn: 'மறு',
    kindDataImport: 'மொத்த இறக்குமதியைப் பயன்படுத்துதல்', kindDataImportRollback: 'மொத்த இறக்குமதியைத் திரும்பப் பெறுதல்', kindCategoryDefine: 'பொருள் வகையைச் சேர்த்தல் அல்லது மாற்றுதல்', kindSupplierBank: 'விநியோகஸ்தருக்குப் பணம் செல்லும் கணக்கை மாற்றுதல்',
    kindPriceChange: 'அடக்க விலைக்கு அல்லது குறைந்தபட்ச லாப வரம்புக்குக் கீழே விலை வைத்தல்', kindPriceListEntry: 'அடக்க விலைக்கு அல்லது குறைந்தபட்ச லாப வரம்புக்குக் கீழே விலைப்பட்டியல் பதிவு',
    kindPromotionLaunch: 'லாபத்தை இழக்கும் சலுகையைத் தொடங்குதல்', kindQuotationBelowFloor: 'குறைந்தபட்ச லாப வரம்புக்குக் கீழே வாடிக்கையாளருக்கு விலை மேற்கோள்',
    kindPeriodClose: 'கணக்கு மாதத்தை மூடி கையெழுத்திடுதல்', kindPeriodReopen: 'கையெழுத்திட்ட கணக்கு மாதத்தை மீண்டும் திறத்தல்',
    kindConcessionContract: 'கூட்டாளர் கவுண்டர் ஒப்பந்தத்தை அனுமதித்தல்', kindConcessionDepositForfeit: 'கூட்டாளரின் வைப்புத் தொகையைப் பறிமுதல் செய்தல்',
    kindStockWriteOff: 'சரக்கை இழப்பாகக் கழித்தல் (பெரிய இழப்பு)', kindStockAdjustmentUp: 'சரக்கு எண்ணிக்கையை மேல்நோக்கித் திருத்துதல்',
    kindOrderRefund: 'ஆன்லைன் ஆர்டருக்குப் பணத்தைத் திருப்பித் தருதல்', kindServiceCompensation: 'சேவை மேசையின் சொந்த வரம்புக்கு மேல் வாடிக்கையாளருக்கு இழப்பீடு வழங்குதல்',
    kindSupplierInvoiceCheck: 'விநியோகஸ்தர் பில்லைச் சரிபார்த்தல்', kindSupplierPayment: 'விநியோகஸ்தருக்குப் பணம் செலுத்துதல்',
    kindDisplayContract: 'விநியோகஸ்தரின் காட்சி இட நிதியை அனுமதித்தல்', kindRebateScheme: 'விநியோகஸ்தர் தள்ளுபடித் திட்டத்தை அனுமதித்தல்',
    kindPurchaseContract: 'விநியோகஸ்தர் ஒப்பந்தத்தை அனுமதித்தல்',
    kindEmergencyAccess: 'ஒருவருக்குக் குறுகிய நேர அவசர அணுகல் வழங்குதல்', kindAccessChange: 'ஒருவரின் அணுகலை மாற்றுதல் (சேர்தல், இடமாற்றம் அல்லது விலகல்)',
    kindSubstitutionAboveCap: 'விலை கூடிய மாற்றுப் பொருளுக்கு அசல் விலைக்கு மேல் கட்டணம் வசூலித்தல்',
    detailJobId: 'ஏற்றத்தின் பெயர்', detailContentFingerprint: 'கோப்புச் சரிபார்ப்புக் குறியீடு',
    detailProductId: 'பொருள்', detailPriceMinor: 'புதிய விலை', detailMrpMinor: 'அதிகபட்ச சில்லறை விலை (MRP)', detailCostMinor: 'நமக்கு ஆகும் அடக்க விலை', detailCurrency: 'நாணயம்',
    detailMarginFloorBps: 'குறைந்தபட்ச லாப வரம்பு', detailPromotionId: 'சலுகை', detailDescription: 'சலுகை விவரம்', detailNormalPrice: 'வழக்கமான விலை',
    detailPromoPrice: 'சலுகை விலை', detailUnitCost: 'ஒரு அலகுக்கு நமக்கு ஆகும் அடக்கம்', detailVendorFundingPerUnit: 'ஒரு அலகுக்கு விநியோகஸ்தர் தருவது',
    detailBaselineUnits: 'இப்போது விற்கும் அலகுகள்', detailExpectedUnits: 'சலுகையுடன் எதிர்பார்க்கும் அலகுகள்',
    detailPeriod: 'மாதம்', detailReason: 'ஏன்',
    detailLocationId: 'எங்கே', detailQty: 'எண்ணிக்கை', detailUom: 'அலகு', detailLossType: 'இழப்பின் வகை', detailReasonCode: 'காரணக் குறியீடு',
    detailValueMinor: 'மதிப்பு', detailEvidenceRef: 'ஆதாரம்', detailWriteOffId: 'இழப்புப் பதிவு',
    detailAmountMinor: 'தொகை', detailRefundId: 'பணத்திருப்பம்', detailOrderId: 'ஆர்டர்', detailBasis: 'பணத்திருப்பத்தின் காரணம்',
    detailCaseId: 'வாடிக்கையாளர் புகார்', detailKind: 'வகை', detailInvoiceId: 'விநியோகஸ்தர் பில்', detailSupplierId: 'விநியோகஸ்தர்',
    detailPaymentId: 'பணம் செலுத்துதல்', detailPaidOn: 'செலுத்திய தேதி', detailMethod: 'செலுத்தும் முறை', detailReference: 'குறிப்பு எண்',
    detailMovementId: 'சரக்கு நகர்வு', detailQuantityMinor: 'அளவு',
    detailStoreId: 'கடை', detailFundingAmount: 'விநியோகஸ்தர் செலுத்தும் நிதி', detailStartsOn: 'தொடங்கும் நாள்', detailEndsOn: 'முடியும் நாள்',
    detailLocationIds: 'காட்சி இடங்கள்', detailAreaId: 'தளப் பகுதி', detailContractId: 'ஒப்பந்தம்', detailSchemeId: 'தள்ளுபடித் திட்டம்',
    detailRateBp: 'தள்ளுபடி விகிதம்', detailThresholdMinor: 'பலன் கிடைக்க வாங்க வேண்டிய அளவு', detailAgreedLeadTimeDays: 'ஒப்புக்கொண்ட விநியோக நேரம் (நாட்கள்)',
    detailUserId: 'நபர்', detailRoleId: 'பொறுப்பு', detailBranchScope: 'கிளைகள்', detailMinutes: 'எத்தனை நிமிடங்களுக்கு',
    detailMaxMinutes: 'அதிகபட்ச அனுமதி (நிமிடங்கள்)', detailGrantId: 'அவசர அணுகல்', detailEvent: 'சேர்தல், இடமாற்றம் அல்லது விலகல்',
    detailGrants: 'மாற்றத்திற்குப் பின் அணுகல்', detailOwnedOpenItems: 'அவர் இன்னும் பொறுப்பேற்றுள்ள பணிகள்', detailRequestId: 'அணுகல் மாற்றம்',
    allBranches: 'அனைத்துக் கிளைகளும்',
    statusWaitingForYou: 'உங்கள் முடிவுக்காகக் காத்திருக்கிறது', statusWaiting: 'இரண்டாம் நபருக்காகக் காத்திருக்கிறது',
    statusApproved: '{who} அனுமதித்தார்', statusApprovedUntil: '{who} அனுமதித்தார் — {until}-க்குள் பயன்படுத்தவும்',
    statusRejected: '{who} மறுத்தார்: {reason}', statusExpired: 'காலாவதியானது — நேரத்தில் பயன்படுத்தப்படவில்லை. மீண்டும் கேளுங்கள்.',
    statusUsed: 'பயன்படுத்தப்பட்டது — அது அனுமதித்த செயல் முடிந்தது.',
    decidedApproved: 'அனுமதிக்கப்பட்டது. கேட்டவர் இப்போது ஒருமுறை தொடரலாம்.',
    decidedRejected: 'மறுக்கப்பட்டது. கேட்டவர் உங்கள் காரணத்தைப் பார்ப்பார்.',
    decideNeedsReason: 'முதலில் ஒரு காரணத்தை எழுதுங்கள் — கேட்டவர் அதைப் படிப்பார், அது பதிவில் வைக்கப்படும்.',
    decideNobody: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை, எனவே இங்கே எதையும் முடிவு செய்ய முடியாது.',
    decideNotPermitted: 'அனுமதிகளைப் பயன்படுத்த உங்களுக்கு அனுமதி இல்லை.',
    decideNotWaiting: 'அந்தக் கோரிக்கை இனி உங்களுக்காகக் காத்திருக்கவில்லை — வேறொருவர் ஏற்கனவே முடிவு செய்திருக்கலாம். பட்டியல் மீண்டும் படிக்கப்பட்டது.',
    decideOwnRequest: 'இதைக் கேட்டது நீங்கள், எனவே வேறொருவர்தான் முடிவு செய்ய வேண்டும் (§28).',
    decideAlreadyDecided: 'இதை ஏற்கனவே ஒருவர் முடிவு செய்துவிட்டார்:', decideRefused: 'பதிவு செய்யப்படவில்லை:',
    decideRefusedNoWords: 'பதிவு செய்யப்படவில்லை — தலைமை அலுவலகம் முடிவை ஏற்கவில்லை.',
    decideLostLink: 'இணைப்பு இல்லை — எதுவும் முடிவு செய்யப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    yesWord: 'ஆம்', noWord: 'இல்லை',
    scrReady: 'உங்கள் அனுமதிகளைக் காட்டுகிறது', scrEmpty: 'நீங்கள் அனுமதிக்க எதுவும் காத்திருக்கவில்லை.',
    stateNotPermitted: 'அனுமதிகளைப் பயன்படுத்த உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(APPROVALS_COPY.en) as CopyKey[]);

/** The kinds this screen can name in both languages; any other kind shows the server's own label. */
const KIND_COPY: Readonly<Record<string, CopyKey>> = {
  data_import_commit: 'kindDataImport',
  data_import_rollback: 'kindDataImportRollback',
  category_define: 'kindCategoryDefine',
  supplier_bank_change: 'kindSupplierBank',
  price_change: 'kindPriceChange',
  price_list_entry: 'kindPriceListEntry',
  promotion_launch: 'kindPromotionLaunch',
  quotation_below_floor: 'kindQuotationBelowFloor',
  period_close: 'kindPeriodClose',
  period_reopen: 'kindPeriodReopen',
  concession_contract: 'kindConcessionContract',
  concession_deposit_forfeit: 'kindConcessionDepositForfeit',
  stock_write_off: 'kindStockWriteOff',
  stock_adjustment_up: 'kindStockAdjustmentUp',
  order_refund: 'kindOrderRefund',
  service_compensation: 'kindServiceCompensation',
  supplier_invoice_check: 'kindSupplierInvoiceCheck',
  supplier_payment: 'kindSupplierPayment',
  display_contract: 'kindDisplayContract',
  rebate_scheme: 'kindRebateScheme',
  purchase_contract: 'kindPurchaseContract',
  emergency_access: 'kindEmergencyAccess',
  access_change: 'kindAccessChange',
  substitution_above_cap: 'kindSubstitutionAboveCap',
};
/** Detail keys this screen can name in both languages; any other key is spelt out from its own name. */
const DETAIL_COPY: Readonly<Record<string, CopyKey>> = {
  jobId: 'detailJobId',
  contentFingerprint: 'detailContentFingerprint',
  productId: 'detailProductId', priceMinor: 'detailPriceMinor', mrpMinor: 'detailMrpMinor', costMinor: 'detailCostMinor',
  currency: 'detailCurrency', marginFloorBps: 'detailMarginFloorBps', promotionId: 'detailPromotionId', description: 'detailDescription',
  normalPrice: 'detailNormalPrice', promoPrice: 'detailPromoPrice', unitCost: 'detailUnitCost',
  vendorFundingPerUnit: 'detailVendorFundingPerUnit', baselineUnits: 'detailBaselineUnits', expectedUnits: 'detailExpectedUnits',
  period: 'detailPeriod', reason: 'detailReason',
  locationId: 'detailLocationId', qty: 'detailQty', uom: 'detailUom', lossType: 'detailLossType', reasonCode: 'detailReasonCode',
  valueMinor: 'detailValueMinor', evidenceRef: 'detailEvidenceRef', writeOffId: 'detailWriteOffId',
  amountMinor: 'detailAmountMinor', refundId: 'detailRefundId', orderId: 'detailOrderId', basis: 'detailBasis', caseId: 'detailCaseId',
  kind: 'detailKind', invoiceId: 'detailInvoiceId', supplierId: 'detailSupplierId', paymentId: 'detailPaymentId', paidOn: 'detailPaidOn',
  method: 'detailMethod', reference: 'detailReference', movementId: 'detailMovementId', quantityMinor: 'detailQuantityMinor',
  storeId: 'detailStoreId', fundingAmount: 'detailFundingAmount', startsOn: 'detailStartsOn', endsOn: 'detailEndsOn',
  locationIds: 'detailLocationIds', areaId: 'detailAreaId', contractId: 'detailContractId', schemeId: 'detailSchemeId',
  rateBp: 'detailRateBp', thresholdMinor: 'detailThresholdMinor', agreedLeadTimeDays: 'detailAgreedLeadTimeDays',
  userId: 'detailUserId', roleId: 'detailRoleId', branchScope: 'detailBranchScope', minutes: 'detailMinutes',
  maxMinutes: 'detailMaxMinutes', grantId: 'detailGrantId', event: 'detailEvent', grants: 'detailGrants',
  ownedOpenItems: 'detailOwnedOpenItems', requestId: 'detailRequestId',
};

// ── small, deterministic formatters ───────────────────────────────────────────────────────────────────────────

export const rupees = (minor: number): string =>
  `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A time as the shop reads it: India time, DD-MM-YYYY HH:MM — the same words on every screen and in every test. */
export function shopTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.trim() === '') return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms + 330 * 60_000); // IST is UTC+05:30, with no daylight saving
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getUTCDate())}-${two(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** "contentFingerprint" → "Content fingerprint": a key nobody translated still reads as words, never as code. */
function spellOut(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words === '' ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

const LONG_CODE = /^[0-9a-f]{24,}$/i;

/** A `…Minor` figure is money in paise — except a quantity in its smallest unit (`quantityMinor`), which is a count. */
const isMoneyKey = (key: string): boolean => /Minor$/.test(key) && !/(?:quantity|qty)Minor$/i.test(key);

/** One detail value as plain words: money in rupees, long check codes shortened, yes/no, anything else as text. */
function detailValue(t: (k: CopyKey) => string, key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? t('yesWord') : t('noWord');
  if (typeof value === 'number') {
    if (isMoneyKey(key) && Number.isSafeInteger(value)) return rupees(value);
    // Basis points as the shop says it: 2000 → "20.00%" (a margin floor's `…Bps`, a rebate's `rateBp`).
    if (/Bps?$/.test(key) && Number.isSafeInteger(value)) return `${(value / 100).toFixed(2)}%`;
    return String(value);
  }
  if (key === 'branchScope' && value === 'all') return t('allBranches');
  if (typeof value === 'string') return LONG_CODE.test(value) ? `${value.slice(0, 12)}…` : value;
  // A list of names (a display contract's places) reads as a list, never as code.
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.length === 0 ? '—' : value.join(', ');
  // Access after a change ([{ roleId, branchScope }]) reads as "cashier (b1); store_manager (all branches)".
  if (Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['roleId'] === 'string')) {
    if (value.length === 0) return '—';
    return value.map((v) => {
      const g = v as Record<string, unknown>;
      const scope = g['branchScope'] === 'all' ? t('allBranches') : Array.isArray(g['branchScope']) ? (g['branchScope'] as unknown[]).join(', ') : '';
      return scope === '' ? String(g['roleId']) : `${String(g['roleId'])} (${scope})`;
    }).join('; ');
  }
  // Money as { minor, currency } (an offer's prices) reads as rupees, never as code.
  if (typeof value === 'object' && !Array.isArray(value)) {
    const m = value as Record<string, unknown>;
    if (Number.isSafeInteger(m['minor']) && m['currency'] === 'INR' && Object.keys(m).length === 2) return rupees(m['minor'] as number);
  }
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────────

export interface PresentedDetail { readonly key: string; readonly label: string; readonly value: string; }

export interface PresentedRequest {
  readonly requestId: string;
  readonly kind: string;
  /** The plain-words label of the action, in the reader's language where the screen knows the kind. */
  readonly label: string;
  readonly summary: string;
  readonly subjectRef: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly requestedAt: string;
  /** The same moment in shop time, for reading. */
  readonly when: string;
  /** The amount in rupees, or null when the action moves no money. */
  readonly amount: string | null;
  readonly details: readonly PresentedDetail[];
  /** Where it stands — tone + icon + WORDS, never colour alone. */
  readonly status: StatusPresentation;
  readonly approvalStatus: ApprovalStatus;
}

export interface ApprovalsView {
  readonly screenState: StatusPresentation;
  readonly mayUse: boolean;
  readonly nobodyNamed: boolean;
  /** Requests other people asked for, that this person may decide. Biggest amount first, then oldest. */
  readonly waiting: readonly PresentedRequest[];
  /** What this person asked for. Newest first. */
  readonly mine: readonly PresentedRequest[];
  readonly waitingCount: number;
  readonly asAt: string | null;
}

/** The outcome of pressing Approve or Reject. */
export type DecideOutcome =
  | { readonly kind: 'decided'; readonly decision: DecisionWord }
  | { readonly kind: 'needs_reason' }
  | { readonly kind: 'nobody_named' }
  | { readonly kind: 'not_permitted' }
  | { readonly kind: 'not_waiting' }
  | { readonly kind: 'own_request' }
  | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };

export interface ApprovalsSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): ApprovalsView;
  /** Approve or reject one request with a written reason. Refused locally (no POST) without a reason, without a
   *  named person, or for a request not waiting for this person; otherwise the server decides and is the gate. */
  decide(requestId: string, decision: DecisionWord, reason: string): Promise<DecideOutcome>;
  presentDecideOutcome(lang: Lang, outcome: DecideOutcome): StatusPresentation;
}

/** Where a request stands, in words — the shared chip both this page and the import screen show. */
export function presentRequestStatus(lang: Lang, r: ApprovalRequestView, waitingForReader = false): StatusPresentation {
  const t = translator(APPROVALS_COPY, lang);
  const who = r.decidedBy ?? '—';
  switch (r.status) {
    case 'waiting':
      return waitingForReader
        ? presentStatus({ tone: 'degraded', icon: '…', label: t('statusWaitingForYou'), needsAttention: true })
        : presentScreenState({ state: 'pending', label: t('statusWaiting') });
    case 'approved': {
      const until = shopTime(r.expiresAt ?? null);
      const label = until === '' ? fill(t('statusApproved'), { who }) : fill(t('statusApprovedUntil'), { who, until });
      return presentStatus({ tone: 'ok', icon: '✓', label, needsAttention: false });
    }
    case 'rejected':
      return presentStatus({ tone: 'error', icon: '✕', label: fill(t('statusRejected'), { who, reason: r.decisionReason ?? '—' }), needsAttention: true });
    case 'expired':
      return presentStatus({ tone: 'idle', icon: '⌛', label: t('statusExpired'), needsAttention: false });
    case 'used':
      return presentStatus({ tone: 'idle', icon: '✔', label: t('statusUsed'), needsAttention: false });
  }
}

/** One request presented for reading — label, amount, details as key: value lines, and its status chip. */
export function presentRequest(lang: Lang, r: ApprovalRequestView, waitingForReader = false): PresentedRequest {
  const t = translator(APPROVALS_COPY, lang);
  const kindKey = KIND_COPY[r.kind];
  const details: PresentedDetail[] = Object.keys(r.details).map((key) => {
    const known = DETAIL_COPY[key];
    return { key, label: known === undefined ? spellOut(key) : t(known), value: detailValue(t, key, r.details[key]) };
  });
  return {
    requestId: r.requestId,
    kind: r.kind,
    label: kindKey === undefined ? (r.label.trim() === '' ? spellOut(r.kind) : r.label) : t(kindKey),
    summary: r.summary,
    subjectRef: r.subjectRef,
    requestedBy: r.requestedBy,
    reason: r.reason,
    requestedAt: r.requestedAt,
    when: shopTime(r.requestedAt),
    amount: r.valueMinor === null ? null : rupees(r.valueMinor),
    details,
    status: presentRequestStatus(lang, r, waitingForReader),
    approvalStatus: r.status,
  };
}

export function createApprovalsSession(config: ApprovalsConfig, ports: ApprovalsPorts): ApprovalsSession {
  const text = (lang: Lang, key: CopyKey): string => translator(APPROVALS_COPY, lang)(key);

  return {
    text,

    view: (lang) => {
      const t = translator(APPROVALS_COPY, lang);
      const nobodyNamed = config.userId === null;
      if (!ports.mayUse()) {
        return {
          screenState: presentScreenState({ state: 'locked', label: t('stateNotPermitted') }),
          mayUse: false, nobodyNamed, waiting: [], mine: [], waitingCount: 0, asAt: null,
        };
      }
      const inbox = ports.inbox();
      // Defensive: the server never puts a person's own request in their inbox (§28); if one ever arrived it is not
      // offered as something to decide — it still shows under "What you asked for".
      const waitingRows = inbox.waitingForMe
        .filter((r) => r.status === 'waiting' && (config.userId === null || r.requestedBy !== config.userId))
        .slice()
        .sort((a, b) => (b.valueMinor ?? 0) - (a.valueMinor ?? 0) || a.requestedAt.localeCompare(b.requestedAt));
      const mineRows = inbox.mine.slice().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
      const waiting = waitingRows.map((r) => presentRequest(lang, r, true));
      const mine = mineRows.map((r) => presentRequest(lang, r, false));
      const state = waiting.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        mayUse: true, nobodyNamed, waiting, mine, waitingCount: waiting.length, asAt: inbox.asAt,
      };
    },

    decide: async (requestId, decision, reason) => {
      if (!ports.mayUse()) return { kind: 'not_permitted' };
      if (config.userId === null) return { kind: 'nobody_named' };
      if (reason.trim() === '') return { kind: 'needs_reason' };
      const row = ports.inbox().waitingForMe.find((r) => r.requestId === requestId);
      if (row === undefined || row.status !== 'waiting') return { kind: 'not_waiting' };
      if (row.requestedBy === config.userId) return { kind: 'own_request' }; // §28 — never sent
      const r = await ports.decide({ requestId, decision, reason: reason.trim() });
      if (r.result === 'decided') return { kind: 'decided', decision: r.decision };
      if (r.result === 'lost_link') return { kind: 'lost_link' };
      if (r.code === 'self_approval') return { kind: 'own_request' };
      return { kind: 'refused', code: r.code, whatHappened: r.whatHappened };
    },

    presentDecideOutcome: (lang, o) => {
      const t = translator(APPROVALS_COPY, lang);
      const err = (label: string): StatusPresentation => presentStatus({ tone: 'error', icon: '✕', label, needsAttention: true });
      const warn = (label: string): StatusPresentation => presentStatus({ tone: 'degraded', icon: '⚠', label, needsAttention: true });
      switch (o.kind) {
        case 'decided':
          return presentStatus({ tone: 'ok', icon: '✓', label: t(o.decision === 'approved' ? 'decidedApproved' : 'decidedRejected'), needsAttention: false });
        case 'needs_reason': return err(t('decideNeedsReason'));
        case 'nobody_named': return err(t('decideNobody'));
        case 'not_permitted': return err(t('decideNotPermitted'));
        case 'not_waiting': return warn(t('decideNotWaiting'));
        case 'own_request': return err(t('decideOwnRequest'));
        case 'lost_link': return warn(t('decideLostLink'));
        case 'refused': {
          const words = o.whatHappened.trim();
          if (o.code === 'already_decided') return warn(words === '' ? t('decideNotWaiting') : `${t('decideAlreadyDecided')} ${words}`);
          return err(words === '' ? t('decideRefusedNoWords') : `${t('decideRefused')} ${words}`);
        }
      }
    },
  };
}
