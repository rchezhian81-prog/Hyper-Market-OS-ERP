// The SUPPLIERS screen — the supplier workbench's face (M06-FR-01 · M23-FR-01 · M15-FR-03 · §28 · API-03 · P-02 one
// commerce truth · P-03 control by exception · P-04 · P-07 · P-08 no silent failure). SP-7c gave every supplier ONE
// record and ONE balance on the cloud; this screen shows them to the people who buy, approve and pay, and lets the
// two governed acts of the supplier master happen from the screen where — and only where — the reader holds the right:
//
//   • **Every supplier the records name**, needing-a-person FIRST (P-03): under a hold, awaiting approval, a
//     look-alike, a shared or unverified bank account, unmatched or withheld bills, a return the supplier still owes
//     us, a second bill for the same goods — each said in words, never a colour alone. Then the clean ones.
//   • **One balance** (P-02): what is owed is the SP-7b account's figure, read from the cloud — never typed here,
//     never recomputed here.
//   • **PROPOSE** (`purchase.supplier.manage`): a purchase user adds or updates a supplier — code, name, GSTIN,
//     contact, payment terms. A same-name / same-GSTIN supplier is SAID back as a possible duplicate.
//   • **APPROVE** (`purchase.supplier.approve`): a DIFFERENT person makes a proposed supplier active, with a written
//     reason. The proposer is refused on this screen BEFORE anything is sent (§28) — and the server refuses them again.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui primitives;
// the shell renders only what this hands over. The writes are HUMAN acts on an explicit click, posted under the
// reader's own session; the server re-verifies the authority and the separation and is the single gate (hard rule #5
// does not arise — no AI here; nothing here commits a price, a payment or a stock change).

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

// ── what the screen was last told (the supplier list, one snapshot) ──────────────────────────────────────────

export type SupplierMasterStatus = 'proposed' | 'active' | 'no_master_record';

/** Why a supplier needs a person — the cloud's own words (`attentionReasons` on the purchase service), shown as-is. */
export type SupplierAttentionReason =
  | 'no_master_record' | 'awaiting_approval' | 'blocked' | 'possible_duplicate' | 'duplicate_bank_account' | 'no_verified_bank_account'
  | 'unmatched_invoices' | 'blocked_invoices' | 'withheld' | 'pending_returns' | 'over_invoiced';

/** One supplier as the cloud lists it — master state, hold, verified bank, the account's figures, the reasons. */
export interface SupplierRowView {
  readonly supplierId: string;
  /** The master record's name, or `null` when the registers name a supplier nobody has recorded yet. */
  readonly name: string | null;
  readonly status: SupplierMasterStatus;
  readonly blocked: boolean;
  /** Who proposed the record — so the screen can refuse a self-approval before any POST (§28). `null` when no record. */
  readonly proposedBy: string | null;
  /** The independently VERIFIED bank account's masked reference, or `null` when there is none (a bank payment cannot go). */
  readonly bankAccountRef: string | null;
  readonly owedMinor: number;
  readonly withheldMinor: number;
  readonly paidMinor: number;
  readonly unmatchedInvoices: number;
  readonly blockedInvoices: number;
  readonly pendingReturns: number;
  readonly currency: string;
  readonly needsAttention: boolean;
  readonly attention: readonly SupplierAttentionReason[];
}

/**
 * Everything the box last told this screen about suppliers. `suppliers` absent means the screen has not been given
 * the list yet (a different thing from an empty list, which means no supplier is known — only one is a data gap).
 */
export interface SuppliersData {
  readonly suppliers?: readonly SupplierRowView[];
  /** When the list was read (ISO) — the overall "as of". */
  readonly asAt?: string;
  /** What every supplier together is owed — the cloud's sum, never re-added here. */
  readonly owedMinor?: number;
}

// ── the two governed writes, as ports (the model never opens a socket itself) ───────────────────────────────

export type ApprovePostResult =
  | { readonly result: 'approved' | 'already_approved' | 'lost_link' }
  | { readonly result: 'refused'; readonly reason: string };

/** The authenticated POST of an approval (`POST /v1/purchase/suppliers/:id/approval`, body `{ reason }`). The server
 *  records the approver as the authenticated caller and refuses the proposer (§28). */
export interface SupplierApprovePort {
  post(input: { readonly supplierId: string; readonly reason: string }): Promise<ApprovePostResult>;
}

export interface SupplierProposeInput {
  readonly supplierId: string;
  readonly name: string;
  readonly gstin: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly paymentTermsDays: number | null;
}

export type ProposePostResult =
  | { readonly result: 'proposed' | 'updated'; readonly possibleDuplicates: readonly string[] }
  | { readonly result: 'lost_link' }
  | { readonly result: 'refused'; readonly reason: string };

/** The authenticated POST that proposes or updates a supplier (`POST /v1/purchase/suppliers/:id`). */
export interface SupplierProposePort {
  post(input: SupplierProposeInput): Promise<ProposePostResult>;
}

export interface SuppliersPorts {
  /** The supplier list the shell last read (live from the cloud, or the injected stand-in). */
  snapshot(): SuppliersData;
  /** Whether this user may read suppliers (`supplier.view`). */
  mayRead(): boolean;
  /** Whether this user may propose / update a supplier (`purchase.supplier.manage`). */
  mayPropose(): boolean;
  /** Whether this user may approve a proposed supplier (`purchase.supplier.approve`). */
  mayApprove(): boolean;
  /** The approval write, or `null` when this page has no way to reach head office (an offline box, a test with none). */
  approvePort(): SupplierApprovePort | null;
  /** The propose write, or `null` likewise. */
  proposePort(): SupplierProposePort | null;
}

export interface SuppliersConfig {
  /** Who is looking. `null` means the box was not told who is at the screen — an approval carries the approver's
   *  name, so the screen surfaces when nobody is named and offers no write. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ────────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'listHeading' | 'asOfLabel' | 'refresh'
  | 'summarySuppliers' | 'summaryNeedAttention' | 'summaryOwed'
  | 'sigBlocked' | 'sigAttention' | 'sigClear'
  | 'masterProposed' | 'masterActive' | 'masterNone'
  | 'bankVerified' | 'bankNone'
  | 'owedLabel' | 'withheldLabel' | 'paidLabel' | 'unmatchedLabel' | 'blockedInvoicesLabel' | 'pendingReturnsLabel' | 'proposedByLabel'
  | 'rsnNoMaster' | 'rsnAwaitingApproval' | 'rsnBlocked' | 'rsnPossibleDuplicate' | 'rsnDuplicateBank' | 'rsnNoVerifiedBank'
  | 'rsnUnmatched' | 'rsnBlockedInvoices' | 'rsnWithheld' | 'rsnPendingReturns' | 'rsnOverInvoiced'
  | 'approveHeading' | 'approveChoiceLabel' | 'approveReasonLabel' | 'approveReasonPlaceholder' | 'approveBtn'
  | 'approveNoneWaiting' | 'approveOwnProposal'
  | 'approveRecorded' | 'approveAlready' | 'approveRefused' | 'approveLostLink' | 'approveSelf' | 'approveNotPermitted' | 'approveNeedsReason' | 'approveNotProposed' | 'approveNoLink'
  | 'proposeHeading' | 'proposeCodeLabel' | 'proposeCodePlaceholder' | 'proposeNameLabel' | 'proposeGstinLabel' | 'proposePhoneLabel' | 'proposeEmailLabel' | 'proposeTermsLabel' | 'proposeBtn'
  | 'proposeRecorded' | 'proposeUpdated' | 'proposeRefused' | 'proposeLostLink' | 'proposeIncomplete' | 'proposeNotPermitted' | 'proposeNoLink' | 'proposeDuplicates'
  | 'noPropose' | 'noApprove'
  | 'scrReady' | 'scrEmpty' | 'scrNoSuppliers' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const SUPPLIERS_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Suppliers', langName: 'தமிழ்',
    lead: 'Every supplier the shop buys from — one record, one balance, read from head office. The ones needing a person are at the top, each with the reason in words. A new supplier is proposed here and made active by a different person; the balance owed is what the matched bills say, never a typed figure.',
    listHeading: 'Suppliers', asOfLabel: 'As of', refresh: 'Refresh',
    summarySuppliers: 'suppliers', summaryNeedAttention: 'need a person', summaryOwed: 'owed in total',
    sigBlocked: 'On hold — nothing is paid or ordered', sigAttention: 'Needs a person', sigClear: 'In order',
    masterProposed: 'Awaiting approval', masterActive: 'Approved supplier', masterNone: 'No supplier record yet',
    bankVerified: 'Verified bank account', bankNone: 'No verified bank account',
    owedLabel: 'Owed', withheldLabel: 'Withheld', paidLabel: 'Paid', unmatchedLabel: 'bills not yet matched', blockedInvoicesLabel: 'bills blocked',
    pendingReturnsLabel: 'returns owed to us', proposedByLabel: 'Proposed by',
    rsnNoMaster: 'Bills or orders name this supplier but nobody has recorded it', rsnAwaitingApproval: 'Proposed — a different person must approve it',
    rsnBlocked: 'Under a hold', rsnPossibleDuplicate: 'Looks like another supplier (same name or GSTIN)',
    rsnDuplicateBank: 'Shares a bank account with another supplier', rsnNoVerifiedBank: 'Owed money but no verified bank account to pay',
    rsnUnmatched: 'Has bills not yet matched to a delivery', rsnBlockedInvoices: 'Has bills blocked for a second person', rsnWithheld: 'Money withheld on a bill',
    rsnPendingReturns: 'Refused goods still to go back', rsnOverInvoiced: 'Billed more than was ordered',
    approveHeading: 'Approve a proposed supplier', approveChoiceLabel: 'Which supplier', approveReasonLabel: 'Why you are approving it (this is the record)',
    approveReasonPlaceholder: 'What did you check?', approveBtn: 'Approve the supplier',
    approveNoneWaiting: 'No supplier is waiting for your approval.', approveOwnProposal: 'proposed by you — someone else must approve it',
    approveRecorded: 'Supplier approved — it is now active.', approveAlready: 'This supplier was already approved.',
    approveRefused: 'Head office refused the approval:', approveLostLink: 'No connection — not approved. Try again.',
    approveSelf: 'You proposed this supplier, so you cannot approve it. A different person must (nothing was sent).',
    approveNotPermitted: 'You do not have permission to approve a supplier.', approveNeedsReason: 'Write why you are approving it — the reason is the record.',
    approveNotProposed: 'This supplier is not waiting for approval.', approveNoLink: 'This page cannot reach head office, so nothing can be approved from it.',
    proposeHeading: 'Add or update a supplier', proposeCodeLabel: 'Supplier code (the one on orders and bills)', proposeCodePlaceholder: 'e.g. SUP-042',
    proposeNameLabel: 'Name', proposeGstinLabel: 'GSTIN (optional)', proposePhoneLabel: 'Phone (optional)', proposeEmailLabel: 'Email (optional)',
    proposeTermsLabel: 'Payment terms, days (optional)', proposeBtn: 'Save the supplier for approval',
    proposeRecorded: 'Supplier proposed — a different person must approve it before it counts.', proposeUpdated: 'Supplier record updated.',
    proposeRefused: 'Head office refused it:', proposeLostLink: 'No connection — not saved. Try again.',
    proposeIncomplete: 'A supplier needs a code and a name (payment terms, if given, are whole days). Nothing was sent.',
    proposeNotPermitted: 'You do not have permission to add a supplier.', proposeNoLink: 'This page cannot reach head office, so nothing can be saved from it.',
    proposeDuplicates: 'Looks like another supplier:',
    noPropose: 'You can see the suppliers, but adding one needs the purchasing permission.',
    noApprove: 'You can see the suppliers, but approving one needs the approval permission.',
    scrReady: 'Showing your suppliers', scrEmpty: 'This screen has not been given the supplier list yet.',
    scrNoSuppliers: 'No supplier is recorded yet.',
    stateNotPermitted: 'You do not have permission to see suppliers.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'விநியோகஸ்தர்கள்', langName: 'English',
    lead: 'கடை வாங்கும் ஒவ்வொரு விநியோகஸ்தரும் — ஒரு பதிவு, ஒரு நிலுவை, தலைமை அலுவலகத்திலிருந்து வாசிக்கப்படுகிறது. ஒருவரின் கவனம் தேவைப்படுபவர்கள் மேலே, ஒவ்வொன்றும் காரணத்துடன். புதிய விநியோகஸ்தர் இங்கே முன்மொழியப்பட்டு வேறு ஒருவரால் செயல்படுத்தப்படுகிறார்; தர வேண்டிய நிலுவை பொருந்திய பில்கள் சொல்வதே, தட்டச்சு செய்த எண் அல்ல.',
    listHeading: 'விநியோகஸ்தர்கள்', asOfLabel: 'நிலவரம்', refresh: 'புதுப்பி',
    summarySuppliers: 'விநியோகஸ்தர்கள்', summaryNeedAttention: 'ஒருவரின் கவனம் தேவை', summaryOwed: 'மொத்தம் தர வேண்டியது',
    sigBlocked: 'நிறுத்தி வைக்கப்பட்டது — பணமும் ஆர்டரும் இல்லை', sigAttention: 'ஒருவரின் கவனம் தேவை', sigClear: 'சரியாக உள்ளது',
    masterProposed: 'ஒப்புதலுக்குக் காத்திருக்கிறது', masterActive: 'ஒப்புதல் பெற்ற விநியோகஸ்தர்', masterNone: 'விநியோகஸ்தர் பதிவு இன்னும் இல்லை',
    bankVerified: 'சரிபார்க்கப்பட்ட வங்கிக் கணக்கு', bankNone: 'சரிபார்க்கப்பட்ட வங்கிக் கணக்கு இல்லை',
    owedLabel: 'தர வேண்டியது', withheldLabel: 'நிறுத்தி வைத்தது', paidLabel: 'செலுத்தியது', unmatchedLabel: 'இன்னும் பொருத்தப்படாத பில்கள்', blockedInvoicesLabel: 'தடுக்கப்பட்ட பில்கள்',
    pendingReturnsLabel: 'நமக்குத் திருப்பித் தர வேண்டியவை', proposedByLabel: 'முன்மொழிந்தவர்',
    rsnNoMaster: 'பில்கள் அல்லது ஆர்டர்கள் இந்த விநியோகஸ்தரைக் குறிப்பிடுகின்றன, ஆனால் யாரும் பதிவு செய்யவில்லை', rsnAwaitingApproval: 'முன்மொழியப்பட்டது — வேறு ஒருவர் ஒப்புதல் அளிக்க வேண்டும்',
    rsnBlocked: 'நிறுத்தி வைக்கப்பட்டுள்ளது', rsnPossibleDuplicate: 'வேறொரு விநியோகஸ்தரைப் போலவே உள்ளது (அதே பெயர் அல்லது GSTIN)',
    rsnDuplicateBank: 'வேறொரு விநியோகஸ்தருடன் ஒரே வங்கிக் கணக்கு', rsnNoVerifiedBank: 'பணம் தர வேண்டும், ஆனால் சரிபார்க்கப்பட்ட வங்கிக் கணக்கு இல்லை',
    rsnUnmatched: 'டெலிவரியுடன் இன்னும் பொருத்தப்படாத பில்கள் உள்ளன', rsnBlockedInvoices: 'இரண்டாம் நபருக்காகத் தடுக்கப்பட்ட பில்கள் உள்ளன', rsnWithheld: 'ஒரு பில்லில் பணம் நிறுத்தி வைக்கப்பட்டது',
    rsnPendingReturns: 'மறுக்கப்பட்ட பொருட்கள் இன்னும் திருப்பி அனுப்பப்படவில்லை', rsnOverInvoiced: 'ஆர்டரை விட அதிகமாக பில் போடப்பட்டது',
    approveHeading: 'முன்மொழிந்த விநியோகஸ்தருக்கு ஒப்புதல்', approveChoiceLabel: 'எந்த விநியோகஸ்தர்', approveReasonLabel: 'நீங்கள் ஏன் ஒப்புதல் அளிக்கிறீர்கள் (இதுவே பதிவு)',
    approveReasonPlaceholder: 'என்ன சரிபார்த்தீர்கள்?', approveBtn: 'விநியோகஸ்தருக்கு ஒப்புதல் அளி',
    approveNoneWaiting: 'உங்கள் ஒப்புதலுக்கு எந்த விநியோகஸ்தரும் காத்திருக்கவில்லை.', approveOwnProposal: 'நீங்கள் முன்மொழிந்தது — வேறு ஒருவர் ஒப்புதல் அளிக்க வேண்டும்',
    approveRecorded: 'விநியோகஸ்தர் ஒப்புதல் பெற்றார் — இப்போது செயலில் உள்ளார்.', approveAlready: 'இந்த விநியோகஸ்தர் ஏற்கனவே ஒப்புதல் பெற்றவர்.',
    approveRefused: 'தலைமை அலுவலகம் ஒப்புதலை மறுத்தது:', approveLostLink: 'இணைப்பு இல்லை — ஒப்புதல் அளிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    approveSelf: 'இந்த விநியோகஸ்தரை நீங்களே முன்மொழிந்தீர்கள், அதனால் நீங்கள் ஒப்புதல் அளிக்க முடியாது. வேறு ஒருவர் அளிக்க வேண்டும் (எதுவும் அனுப்பப்படவில்லை).',
    approveNotPermitted: 'விநியோகஸ்தருக்கு ஒப்புதல் அளிக்க உங்களுக்கு அனுமதி இல்லை.', approveNeedsReason: 'ஏன் ஒப்புதல் அளிக்கிறீர்கள் என்று எழுதுங்கள் — காரணமே பதிவு.',
    approveNotProposed: 'இந்த விநியோகஸ்தர் ஒப்புதலுக்குக் காத்திருக்கவில்லை.', approveNoLink: 'இந்தப் பக்கம் தலைமை அலுவலகத்தை அடைய முடியாது, அதனால் இங்கிருந்து ஒப்புதல் அளிக்க முடியாது.',
    proposeHeading: 'விநியோகஸ்தரைச் சேர் அல்லது புதுப்பி', proposeCodeLabel: 'விநியோகஸ்தர் குறியீடு (ஆர்டர்களிலும் பில்களிலும் உள்ளது)', proposeCodePlaceholder: 'எ.கா. SUP-042',
    proposeNameLabel: 'பெயர்', proposeGstinLabel: 'GSTIN (விருப்பம்)', proposePhoneLabel: 'தொலைபேசி (விருப்பம்)', proposeEmailLabel: 'மின்னஞ்சல் (விருப்பம்)',
    proposeTermsLabel: 'பணம் செலுத்தும் கால அவகாசம், நாட்கள் (விருப்பம்)', proposeBtn: 'ஒப்புதலுக்காக விநியோகஸ்தரைச் சேமி',
    proposeRecorded: 'விநியோகஸ்தர் முன்மொழியப்பட்டார் — கணக்கில் வர வேறு ஒருவர் ஒப்புதல் அளிக்க வேண்டும்.', proposeUpdated: 'விநியோகஸ்தர் பதிவு புதுப்பிக்கப்பட்டது.',
    proposeRefused: 'தலைமை அலுவலகம் மறுத்தது:', proposeLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    proposeIncomplete: 'விநியோகஸ்தருக்கு ஒரு குறியீடும் பெயரும் தேவை (கால அவகாசம் கொடுத்தால் முழு நாட்கள்). எதுவும் அனுப்பப்படவில்லை.',
    proposeNotPermitted: 'விநியோகஸ்தரைச் சேர்க்க உங்களுக்கு அனுமதி இல்லை.', proposeNoLink: 'இந்தப் பக்கம் தலைமை அலுவலகத்தை அடைய முடியாது, அதனால் இங்கிருந்து சேமிக்க முடியாது.',
    proposeDuplicates: 'வேறொரு விநியோகஸ்தரைப் போலவே உள்ளது:',
    noPropose: 'விநியோகஸ்தர்களைப் பார்க்கலாம், ஆனால் சேர்க்க கொள்முதல் அனுமதி தேவை.',
    noApprove: 'விநியோகஸ்தர்களைப் பார்க்கலாம், ஆனால் ஒப்புதல் அளிக்க ஒப்புதல் அனுமதி தேவை.',
    scrReady: 'உங்கள் விநியோகஸ்தர்களைக் காட்டுகிறது', scrEmpty: 'இந்தத் திரைக்கு இன்னும் விநியோகஸ்தர் பட்டியல் தரப்படவில்லை.',
    scrNoSuppliers: 'இன்னும் விநியோகஸ்தர் எவரும் பதிவு செய்யப்படவில்லை.',
    stateNotPermitted: 'விநியோகஸ்தர்களைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(SUPPLIERS_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

const REASON_COPY: Readonly<Record<SupplierAttentionReason, CopyKey>> = Object.freeze({
  no_master_record: 'rsnNoMaster', awaiting_approval: 'rsnAwaitingApproval', blocked: 'rsnBlocked', possible_duplicate: 'rsnPossibleDuplicate',
  duplicate_bank_account: 'rsnDuplicateBank', no_verified_bank_account: 'rsnNoVerifiedBank', unmatched_invoices: 'rsnUnmatched',
  blocked_invoices: 'rsnBlockedInvoices', withheld: 'rsnWithheld', pending_returns: 'rsnPendingReturns', over_invoiced: 'rsnOverInvoiced',
});

const MASTER_COPY: Readonly<Record<SupplierMasterStatus, CopyKey>> = Object.freeze({
  proposed: 'masterProposed', active: 'masterActive', no_master_record: 'masterNone',
});

export interface PresentedSupplier {
  readonly status: StatusPresentation;
  readonly supplierId: string;
  /** The name, or the code when nobody has recorded a name. */
  readonly headline: string;
  readonly masterStatus: SupplierMasterStatus;
  readonly masterLabel: string;
  readonly blocked: boolean;
  readonly proposedBy: string | null;
  readonly bankAccountRef: string | null;
  readonly bankLabel: string;
  readonly owedMinor: number;
  readonly withheldMinor: number;
  readonly paidMinor: number;
  readonly unmatchedInvoices: number;
  readonly blockedInvoices: number;
  readonly pendingReturns: number;
  readonly currency: string;
  readonly needsAttention: boolean;
  /** Every reason, in the reader's language, in the cloud's order. */
  readonly reasons: readonly { readonly reason: SupplierAttentionReason; readonly label: string }[];
  /** True when THIS reader may approve THIS supplier from here: they hold the right, it is proposed, and they did not propose it. */
  readonly canApproveHere: boolean;
  /** True when it is proposed and this reader proposed it — offered as a word, never as a button (§28). */
  readonly ownProposal: boolean;
}

export interface SuppliersView {
  readonly screenState: StatusPresentation;
  readonly asOf: string | null;
  /** Needing-a-person first — this is the primary list the shell renders. */
  readonly suppliers: readonly PresentedSupplier[];
  readonly count: number;
  readonly needingAttentionCount: number;
  readonly owedMinor: number;
  /** Whether to offer the propose form — this user holds `purchase.supplier.manage` and the page can reach head office. */
  readonly canPropose: boolean;
  /** Whether to offer the approve action at all — this user holds `purchase.supplier.approve` and the page can reach head office. */
  readonly canApprove: boolean;
  /** The proposed suppliers this reader may approve (never their own) — what the approve control can target. */
  readonly approvable: readonly PresentedSupplier[];
  readonly nobodyNamed: boolean;
}

export type ApproveOutcome =
  | { readonly outcome: 'approved' | 'already_approved' | 'lost_link' | 'self_approval' | 'not_permitted' | 'needs_reason' | 'not_proposed' | 'no_link' }
  | { readonly outcome: 'refused'; readonly reason: string };

export type ProposeOutcome =
  | { readonly outcome: 'proposed' | 'updated'; readonly possibleDuplicates: readonly string[] }
  | { readonly outcome: 'lost_link' | 'incomplete' | 'not_permitted' | 'no_link' }
  | { readonly outcome: 'refused'; readonly reason: string };

/** What the propose form hands over — raw strings from the fields; the model reads them. */
export interface ProposeFormInput {
  readonly supplierId: string;
  readonly name: string;
  readonly gstin: string;
  readonly phone: string;
  readonly email: string;
  readonly paymentTermsDays: string;
}

export interface SuppliersSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): SuppliersView;
  /** Approve a proposed supplier — a HUMAN write on an explicit click. Refused here, with nothing sent, when the
   *  reader lacks the right, proposed it themselves (§28), gives no reason, or the supplier is not waiting. */
  approve(supplierId: string, reason: string): Promise<ApproveOutcome>;
  /** Propose or update a supplier — a HUMAN write on an explicit click. Refused here, with nothing sent, when the
   *  reader lacks the right or the form has no code or name. */
  propose(input: ProposeFormInput): Promise<ProposeOutcome>;
  presentApproveOutcome(lang: Lang, outcome: ApproveOutcome): StatusPresentation;
  presentProposeOutcome(lang: Lang, outcome: ProposeOutcome): StatusPresentation;
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, asOf: string | null, canPropose: boolean, canApprove: boolean): SuppliersView => ({
  screenState, asOf, suppliers: [], count: 0, needingAttentionCount: 0, owedMinor: 0, canPropose, canApprove, approvable: [], nobodyNamed,
});

/** Whole, non-negative days or nothing; anything else is not a payment term. */
function readTermsDays(raw: string): number | null | undefined {
  const s = raw.trim();
  if (s === '') return null;
  if (!/^\d+$/.test(s)) return undefined;
  return Number(s);
}

export function createSuppliersSession(config: SuppliersConfig, ports: SuppliersPorts): SuppliersSession {
  const text = (lang: Lang, key: CopyKey): string => translator(SUPPLIERS_COPY, lang)(key);
  const nobodyNamed = config.userId === null;
  // A write needs a named person (the server attributes it to the session; the screen refuses to guess) and a port.
  const canPropose = (): boolean => !nobodyNamed && ports.mayPropose() && ports.proposePort() !== null;
  const canApprove = (): boolean => !nobodyNamed && ports.mayApprove() && ports.approvePort() !== null;

  const present = (lang: Lang, s: SupplierRowView): PresentedSupplier => {
    const t = translator(SUPPLIERS_COPY, lang);
    const headline = s.name ?? s.supplierId;
    const status = s.blocked
      ? presentStatus({ tone: 'error', icon: '⛔', label: t('sigBlocked'), announcement: `${t('sigBlocked')}: ${headline}`, needsAttention: true })
      : s.needsAttention
        ? presentStatus({ tone: 'degraded', icon: '❗', label: t('sigAttention'), announcement: `${t('sigAttention')}: ${headline}`, needsAttention: true })
        : presentStatus({ tone: 'ok', icon: '✓', label: t('sigClear'), announcement: `${t('sigClear')}: ${headline}`, needsAttention: false });
    const ownProposal = s.status === 'proposed' && s.proposedBy !== null && s.proposedBy === config.userId;
    return {
      status, supplierId: s.supplierId, headline, masterStatus: s.status, masterLabel: t(MASTER_COPY[s.status]),
      blocked: s.blocked, proposedBy: s.proposedBy, bankAccountRef: s.bankAccountRef,
      bankLabel: s.bankAccountRef === null ? t('bankNone') : `${t('bankVerified')} ${s.bankAccountRef}`,
      owedMinor: s.owedMinor, withheldMinor: s.withheldMinor, paidMinor: s.paidMinor,
      unmatchedInvoices: s.unmatchedInvoices, blockedInvoices: s.blockedInvoices, pendingReturns: s.pendingReturns, currency: s.currency,
      needsAttention: s.needsAttention,
      reasons: s.attention.map((reason) => ({ reason, label: t(REASON_COPY[reason]) })),
      canApproveHere: canApprove() && s.status === 'proposed' && !ownProposal,
      ownProposal,
    };
  };

  return {
    text,

    view: (lang) => {
      const t = translator(SUPPLIERS_COPY, lang);

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, null, false, false);
      }
      const data = ports.snapshot();
      if (data.suppliers === undefined) {
        return EMPTY_VIEW(presentScreenState({ state: 'empty', label: t('scrEmpty') }), nobodyNamed, null, canPropose(), canApprove());
      }
      if (data.suppliers.length === 0) {
        return EMPTY_VIEW(presentScreenState({ state: 'empty', label: t('scrNoSuppliers') }), nobodyNamed, data.asAt ?? null, canPropose(), canApprove());
      }

      // Needing-a-person first (P-03), a hold before the rest, then the most money owed, then by name — a
      // deterministic order this screen owns, never trusting the wire's order.
      const ordered = data.suppliers.slice().sort((a, b) =>
        (a.needsAttention === b.needsAttention ? 0 : a.needsAttention ? -1 : 1)
        || (a.blocked === b.blocked ? 0 : a.blocked ? -1 : 1)
        || (b.owedMinor - a.owedMinor)
        || (a.name ?? a.supplierId).localeCompare(b.name ?? b.supplierId)
        || a.supplierId.localeCompare(b.supplierId));
      const suppliers = ordered.map((s) => present(lang, s));

      return {
        screenState: presentScreenState({ state: 'ready', label: t('scrReady') }),
        asOf: data.asAt ?? null,
        suppliers,
        count: suppliers.length,
        needingAttentionCount: suppliers.filter((s) => s.needsAttention).length,
        // The cloud's own sum when it gave one; otherwise the rows' — never a silent zero over a list with money in it.
        owedMinor: data.owedMinor ?? suppliers.reduce((sum, s) => sum + s.owedMinor, 0),
        canPropose: canPropose(),
        canApprove: canApprove(),
        approvable: suppliers.filter((s) => s.canApproveHere),
        nobodyNamed,
      };
    },

    approve: async (supplierId, reason) => {
      if (!ports.mayRead() || !ports.mayApprove() || nobodyNamed) return { outcome: 'not_permitted' };
      const port = ports.approvePort();
      if (port === null) return { outcome: 'no_link' };
      const id = supplierId.trim();
      const row = (ports.snapshot().suppliers ?? []).find((s) => s.supplierId === id);
      if (row === undefined || row.status !== 'proposed') return { outcome: 'not_proposed' };
      // §28 on the screen: the proposer never approves — refused before anything is sent. The server refuses again.
      if (row.proposedBy !== null && row.proposedBy === config.userId) return { outcome: 'self_approval' };
      if (reason.trim() === '') return { outcome: 'needs_reason' };
      const posted = await port.post({ supplierId: id, reason: reason.trim() });
      if (posted.result === 'refused') return { outcome: 'refused', reason: posted.reason };
      return { outcome: posted.result };
    },

    propose: async (input) => {
      if (!ports.mayRead() || !ports.mayPropose() || nobodyNamed) return { outcome: 'not_permitted' };
      const port = ports.proposePort();
      if (port === null) return { outcome: 'no_link' };
      const supplierId = input.supplierId.trim();
      const name = input.name.trim();
      const terms = readTermsDays(input.paymentTermsDays);
      if (supplierId === '' || name === '' || terms === undefined) return { outcome: 'incomplete' };
      const opt = (v: string): string | null => (v.trim() === '' ? null : v.trim());
      const posted = await port.post({ supplierId, name, gstin: opt(input.gstin), phone: opt(input.phone), email: opt(input.email), paymentTermsDays: terms });
      if (posted.result === 'refused') return { outcome: 'refused', reason: posted.reason };
      if (posted.result === 'lost_link') return { outcome: 'lost_link' };
      return { outcome: posted.result, possibleDuplicates: posted.possibleDuplicates };
    },

    presentApproveOutcome: (lang, o) => {
      const t = translator(SUPPLIERS_COPY, lang);
      switch (o.outcome) {
        case 'approved': return presentStatus({ tone: 'ok', icon: '✓', label: t('approveRecorded'), needsAttention: false });
        case 'already_approved': return presentStatus({ tone: 'ok', icon: '✓', label: t('approveAlready'), needsAttention: false });
        case 'lost_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('approveLostLink'), needsAttention: true });
        case 'refused': return presentStatus({ tone: 'error', icon: '✕', label: `${t('approveRefused')} ${o.reason}`, needsAttention: true });
        case 'self_approval': return presentStatus({ tone: 'error', icon: '✕', label: t('approveSelf'), needsAttention: true });
        case 'not_permitted': return presentStatus({ tone: 'error', icon: '✕', label: t('approveNotPermitted'), needsAttention: true });
        case 'needs_reason': return presentStatus({ tone: 'error', icon: '✕', label: t('approveNeedsReason'), needsAttention: true });
        case 'not_proposed': return presentStatus({ tone: 'error', icon: '✕', label: t('approveNotProposed'), needsAttention: true });
        case 'no_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('approveNoLink'), needsAttention: true });
      }
    },

    presentProposeOutcome: (lang, o) => {
      const t = translator(SUPPLIERS_COPY, lang);
      switch (o.outcome) {
        case 'proposed':
        case 'updated': {
          const base = t(o.outcome === 'proposed' ? 'proposeRecorded' : 'proposeUpdated');
          // A look-alike is SAID on the same line as the success — never hidden, never a refusal (M06-FR-01).
          return o.possibleDuplicates.length > 0
            ? presentStatus({ tone: 'degraded', icon: '❗', label: `${base} ${t('proposeDuplicates')} ${o.possibleDuplicates.join(', ')}`, needsAttention: true })
            : presentStatus({ tone: 'ok', icon: '✓', label: base, needsAttention: false });
        }
        case 'lost_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('proposeLostLink'), needsAttention: true });
        case 'refused': return presentStatus({ tone: 'error', icon: '✕', label: `${t('proposeRefused')} ${o.reason}`, needsAttention: true });
        case 'incomplete': return presentStatus({ tone: 'error', icon: '✕', label: t('proposeIncomplete'), needsAttention: true });
        case 'not_permitted': return presentStatus({ tone: 'error', icon: '✕', label: t('proposeNotPermitted'), needsAttention: true });
        case 'no_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('proposeNoLink'), needsAttention: true });
      }
    },
  };
}
