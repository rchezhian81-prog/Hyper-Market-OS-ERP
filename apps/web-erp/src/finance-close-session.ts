// MONTH-END — the finance close screens over head office's own routes (M23-FR-01/03/04 · WF-18 · D10-FR-03/05 · OB-55 ·
// OB-56 · OB-57 · OB-67 · OB-69 · P-03 · P-08 · hard rules #2, #3, #5, #10).
//
// Four things finance does at the end of a month, each a THIN client over a route that already holds the rule:
//
//   1. CARD AND UPI PAYMENTS WITH NO ANSWER (`/v1/finance/payment-exceptions*`): every attempt a store raised the moment the
//      machine gave no answer (OB-69) or a day close carried forward (OB-55) — one item per attempt — with the open totals
//      by kind, who closed and approved, any doubt head office found (flags), and any CONFLICT: a second, different answer
//      for an item already resolved is kept and shown, never applied (hard rule #10). Finance resolves an open item ONLY
//      with the provider's own record (the tested engine rules on it); an incomplete record keeps it open.
//   2. THE MONTH'S PROFIT AND LOSS (`/v1/finance/periods/:p/profit-and-loss`): read from the journals; says when cost of goods
//      sold is not in the books yet and which accounts have no class — never a guess.
//   3. THE MONTH-END STOCK ADJUSTMENT (`/v1/finance/periods/:p/stock-valuation`, `/stock-adjustment`): the valuation first —
//      closing stock at average buying cost, purchases, the books' stock, cost of goods sold — with everything that BLOCKS it
//      named: products on hand with no cost (by name), receipts that cannot be valued, count differences / write-offs /
//      shortfalls not in the books yet, and damaged write-offs HELD on an open count. Then one post, head office's figures.
//   4. BUDGET AND FIXED ASSETS (`/v1/finance/budgets/:p`, `/v1/finance/fixed-assets*`): a month's budget (each save a new
//      version), the register (add, move, dispose — each a dated fact, never an edit) and the monthly depreciation run.
//
// Nothing here decides: every figure and every refusal is head office's, shown in its own words. A button is offered only
// to a person whose grants include the route's permission (head office still checks — a refusal is shown as said). No
// value is invented: a read that fails is "not known", never an empty list or a zero.

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';

// ── The wire ────────────────────────────────────────────────────────────────────────────────────────────────────

/** One answer from head office. `status: 0` — it could not be reached. */
export interface HttpAnswer { readonly status: number; readonly body: unknown }

/** The person's own session to head office (cookies on the same origin). Writes carry their own idempotency key. */
export interface FinanceCloseHttp {
  get(path: string): Promise<HttpAnswer>;
  send(method: 'POST' | 'PUT', path: string, body: unknown): Promise<HttpAnswer>;
}

/** What the store computer tells the screen: who is looking and what they hold (head office's `GET /v1/identity/me`). */
export interface FinanceCloseViewer {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  /** This month in the shop's calendar (YYYY-MM). The screen never reads a clock of its own. */
  readonly period?: string;
}

/** The route permissions — the same codes head office checks. */
export const FINANCE_CLOSE_PERMISSIONS = Object.freeze({
  read: 'finance.period.read',
  resolve: 'settlement.investigation.manage',
  post: 'finance.journal.post',
  budget: 'finance.posting.configure',
  products: 'catalogue.pack.read',
});

export type Outcome<T> =
  | { readonly kind: 'done'; readonly status: number; readonly body: T }
  | { readonly kind: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string; readonly nextSafeAction: string }
  | { readonly kind: 'not_allowed'; readonly needs: string }
  | { readonly kind: 'invalid'; readonly detail: string }
  | { readonly kind: 'unreachable' };

// ── Head office's answers, as the routes give them ─────────────────────────────────────────────────────────────

export interface PaymentExceptionRow {
  readonly attemptId: string;
  readonly storeId: string;
  readonly laneId: string;
  readonly billRef: string;
  readonly kind: 'card' | 'upi';
  readonly amountMinor: number;
  readonly tradingDay: string;
  readonly askedAt: string;
  readonly stage?: 'raised' | 'carried';
  readonly raisedAt?: string | null;
  readonly dayCloseId: string | null;
  readonly closedBy: string | null;
  readonly approvedBy: string | null;
  readonly reason: string | null;
  readonly governanceFlags: readonly string[];
  readonly state: 'open' | 'resolved_paid' | 'resolved_not_paid';
  readonly resolution: { readonly paid: boolean; readonly owedToCustomerMinor: number; readonly via: string; readonly by: string; readonly resolvedAt: string; readonly detail: string } | null;
  readonly conflicts: readonly { readonly standing: { readonly paid: boolean; readonly owedToCustomerMinor: number }; readonly offered: { readonly paid: boolean; readonly owedToCustomerMinor: number; readonly via: string; readonly by: string; readonly detail: string }; readonly at: string }[];
  readonly lateAnswer: { readonly outcome: string; readonly answeredBy: string; readonly approvedBy: string; readonly flags: readonly string[] } | null;
}
export interface PaymentExceptionList {
  readonly exceptions: readonly PaymentExceptionRow[];
  readonly open: number;
  readonly openMinor: { readonly card: number; readonly upi: number };
  readonly owedToCustomersMinor: number;
  readonly flagged: readonly string[];
  readonly asAt: string;
}

export interface ProfitAndLossView {
  readonly period: string;
  readonly income: readonly { readonly account: string; readonly amountMinor: number }[];
  readonly expenses: readonly { readonly account: string; readonly amountMinor: number }[];
  readonly totalIncomeMinor: number;
  readonly totalExpensesMinor: number;
  readonly netMinor: number;
  readonly unclassified: readonly { readonly account: string; readonly netDebitMinor: number }[];
  readonly complete: boolean;
  readonly journals: number;
  readonly notInTheBooks: readonly string[];
  readonly grossMargin: { readonly revenueMinor: number; readonly costOfSalesMinor: number; readonly grossMarginMinor: number; readonly marginBps: number | null } | null;
  readonly periodState: string;
}

export interface ClosingLine { readonly productId: string; readonly storeId: string; readonly onHandMinor: number; readonly uom: string; readonly unitCostMinor: number | null; readonly valueMinor: number | null; readonly name?: string }
export interface StockValuationView {
  readonly period: string;
  readonly valuation: {
    readonly closing: readonly ClosingLine[];
    readonly closingValueMinor: number;
    readonly unvalued: readonly ClosingLine[];
    readonly negative: readonly ClosingLine[];
    readonly purchases: { readonly receivedMinor: number; readonly returnedToSupplierMinor: number; readonly purchasesMinor: number; readonly unvalued: readonly string[] };
    readonly openingLoadsMinor: number;
  };
  readonly outstandingStockPostings: readonly string[];
  readonly figures: { readonly booksInventoryBeforeMinor: number; readonly purchasesMinor: number; readonly closingValueMinor: number; readonly costOfSalesMinor: number; readonly inventoryChangeMinor: number; readonly inventoryAccount: string } | null;
  readonly mapped: boolean;
  readonly posted: { readonly entryId: string; readonly postedBy: string; readonly narrative: string } | null;
}

/** What blocks the month-end adjustment, named — the page lists each; head office still decides on the post. */
export interface StockBlockers {
  readonly unvaluedProducts: readonly { readonly productId: string; readonly name: string; readonly storeId: string; readonly onHandMinor: number; readonly uom: string }[];
  readonly unvaluedReceipts: readonly string[];
  readonly heldWriteOffs: readonly string[];
  readonly outstandingPostings: readonly string[];
  readonly notMapped: boolean;
  readonly any: boolean;
}

export interface BudgetView {
  readonly period: string;
  readonly budget: { readonly version: number; readonly setBy: string; readonly at: string; readonly reason: string; readonly lines: readonly { readonly account: string; readonly amountMinor: number }[] } | null;
  readonly versions: readonly { readonly version: number; readonly setBy: string; readonly at: string; readonly reason: string; readonly totalMinor: number }[];
  readonly rows: readonly { readonly account: string; readonly accountClass: string | null; readonly budgetMinor: number; readonly actualMinor: number; readonly varianceMinor: number }[];
  readonly unbudgeted: readonly { readonly account: string; readonly accountClass: string | null; readonly actualMinor: number }[];
  readonly unclassified: readonly string[];
  readonly classesDefined: boolean;
}

export interface AssetRow {
  readonly assetId: string; readonly name: string; readonly category: string; readonly storeId: string;
  readonly costMinor: number; readonly salvageMinor: number; readonly usefulLifeMonths: number; readonly inServiceDate: string;
  readonly state: 'in_use' | 'disposed'; readonly depreciationPostedMinor: number; readonly bookValueMinor: number; readonly monthlyMinor: number;
  readonly acquisitionPosted: boolean; readonly disposalPosted: boolean;
  readonly transfers: readonly { readonly fromStoreId: string; readonly toStoreId: string; readonly on: string; readonly reason: string }[];
  readonly disposal: { readonly on: string; readonly proceedsMinor: number; readonly reason: string } | null;
}
export interface DepreciationRun {
  readonly posted: readonly { readonly entryId: string; readonly period: string; readonly fixedAsset: { readonly assetId: string; readonly kind: string; readonly month?: string; readonly amountMinor: number } }[];
  readonly exceptions: readonly { readonly entryId: string; readonly reason: string; readonly detail: string }[];
}

/** The provider's record for one payment, as finance reads it off the acquirer / UPI switch report. */
export interface ProviderRecordInput {
  /** What the provider's report shows for this reference: taken, declined, voided — or nothing found at all. */
  readonly found: 'captured' | 'declined' | 'voided' | 'nothing';
  readonly amountMinor: number;
  /** When the provider recorded it (ISO). */
  readonly at: string;
  /** The provider's report for that day is complete (a final statement, not an intraday extract). */
  readonly statementComplete: boolean;
}

export interface AssetInput {
  readonly assetId: string; readonly name: string; readonly category: string; readonly storeId: string;
  readonly costMinor: number; readonly salvageMinor: number; readonly usefulLifeMonths: number; readonly inServiceDate: string;
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type CloseCopyKey =
  | 'title' | 'purpose' | 'month' | 'tabPayments' | 'tabPl' | 'tabStock' | 'tabPlan'
  | 'payH' | 'payLede' | 'open' | 'openCard' | 'openUpi' | 'owed' | 'flagged' | 'noPayments' | 'stageRaised' | 'stageCarried'
  | 'stateOpen' | 'statePaid' | 'stateNotPaid' | 'closedBy' | 'approvedBy' | 'why' | 'conflict' | 'conflictLine' | 'flagsLine' | 'lateAnswer'
  | 'resolveH' | 'found' | 'foundCaptured' | 'foundDeclined' | 'foundVoided' | 'foundNothing' | 'amount' | 'when' | 'complete' | 'resolve' | 'resolved' | 'alreadyResolved'
  | 'plH' | 'plLede' | 'income' | 'expenses' | 'totalIncome' | 'totalExpenses' | 'net' | 'grossMargin' | 'revenue' | 'costOfSales' | 'unclassified' | 'periodState' | 'noJournals' | 'show'
  | 'stockH' | 'stockLede' | 'closingValue' | 'purchases' | 'booksBefore' | 'cogs' | 'change' | 'blockersH' | 'noBlockers' | 'unvaluedProduct' | 'unvaluedReceipt' | 'held' | 'outstanding' | 'notMapped'
  | 'postAdjustment' | 'adjustmentPosted' | 'alreadyPosted' | 'postedBy'
  | 'budgetH' | 'budgetLede' | 'account' | 'budgetCol' | 'actual' | 'variance' | 'unbudgeted' | 'noBudget' | 'version' | 'addLine' | 'reason' | 'saveBudget' | 'budgetSaved'
  | 'assetsH' | 'assetsLede' | 'assetId' | 'assetName' | 'category' | 'store' | 'cost' | 'salvage' | 'life' | 'inService' | 'addAsset' | 'assetAdded'
  | 'monthly' | 'bookValue' | 'depreciated' | 'inUse' | 'disposed' | 'moveTo' | 'moveOn' | 'move' | 'moved' | 'disposeOn' | 'proceeds' | 'dispose' | 'disposedDone' | 'noAssets'
  | 'runH' | 'runLede' | 'run' | 'ranPosted' | 'ranNothing' | 'ranExceptions'
  | 'kindCard' | 'kindUpi'
  | 'refused' | 'unreachable' | 'notAllowed' | 'cannotRead' | 'nobody' | 'reading' | 'notKnown' | 'readOnly' | 'needFields';

export const FINANCE_CLOSE_COPY: BilingualCopy<CloseCopyKey> = {
  en: {
    title: 'Month-end', purpose: 'Close the month from head office\'s own books: payments with no answer, the profit and loss, the stock adjustment, the budget and the shop\'s equipment.',
    month: 'Month', tabPayments: 'Card and UPI with no answer', tabPl: 'Profit and loss', tabStock: 'Stock adjustment', tabPlan: 'Budget and assets',
    payH: 'Card and UPI payments with no answer', payLede: 'Each payment the machine never answered — raised by the store the moment it happened, or carried by a day close. Only the provider\'s own record settles one.',
    open: 'still open', openCard: 'card still open', openUpi: 'UPI still open', owed: 'owed back to customers', flagged: 'need a look',
    noPayments: 'No card or UPI payment is waiting for an answer.', stageRaised: 'Raised by the store when the machine gave no answer', stageCarried: 'Carried by the day close',
    stateOpen: 'Open — no answer yet', statePaid: 'Settled — the provider took the money', stateNotPaid: 'Settled — the provider did not take the money',
    closedBy: 'day closed by', approvedBy: 'carried on the approval of', why: 'why', conflict: 'Two different answers — the first stands',
    conflictLine: 'Standing: {standing}. Another answer ({via}, {by}) said: {offered}.', flagsLine: 'Head office found: {flags}', lateAnswer: 'Answer typed at the till later',
    resolveH: 'Settle with the provider\'s record', found: 'What the provider\'s report shows for this payment', foundCaptured: 'Money taken', foundDeclined: 'Declined', foundVoided: 'Voided',
    foundNothing: 'Nothing found', amount: 'Amount (₹)', when: 'When the provider recorded it', complete: 'The provider\'s report for that day is complete', resolve: 'Settle this payment',
    resolved: 'Settled — head office kept the provider\'s answer.', alreadyResolved: 'Already settled with the same answer — nothing changed.',
    plH: 'Profit and loss', plLede: 'The month as the books hold it — every figure from the journals posted to it.',
    income: 'Income', expenses: 'Expenses', totalIncome: 'Total income', totalExpenses: 'Total expenses', net: 'Profit (loss) for the month', grossMargin: 'Gross margin',
    revenue: 'Sales', costOfSales: 'Cost of goods sold', unclassified: 'Accounts with no class (not counted above)', periodState: 'The month is', noJournals: 'Nothing is posted to this month yet.', show: 'Show',
    stockH: 'Month-end stock adjustment', stockLede: 'Closing stock at average buying cost against the stock the books hold. Read the figures and what blocks it first; then post once.',
    closingValue: 'Closing stock (on hand at average cost)', purchases: 'Purchases in the month', booksBefore: 'Stock in the books before', cogs: 'Cost of goods sold', change: 'Change to the stock account',
    blockersH: 'What stops it posting', noBlockers: 'Nothing blocks the adjustment.', unvaluedProduct: '{name} at {store}: {qty} {uom} on hand with no buying cost — never valued at zero',
    unvaluedReceipt: 'Cannot be valued: {what}', held: 'Damaged write-off held on an open count: {what}', outstanding: 'Not in the books yet: {what}',
    notMapped: 'The accountant\'s posting map has no rule for the month-end adjustment.', postAdjustment: 'Post the month-end adjustment', adjustmentPosted: 'Posted — one journal for the month.',
    alreadyPosted: 'Already posted for this month — nothing posted twice.', postedBy: 'posted by',
    budgetH: 'Budget against the books', budgetLede: 'Each save is a new version — the old one is kept. Actual is what the books hold for the month.',
    account: 'Account', budgetCol: 'Budget', actual: 'Actual', variance: 'Difference', unbudgeted: 'Actual with no budget', noBudget: 'No budget set for this month.', version: 'version',
    addLine: 'Add a line', reason: 'Why (kept with the version)', saveBudget: 'Save as a new version', budgetSaved: 'Saved — head office kept the new version.',
    assetsH: 'Fixed assets', assetsLede: 'The shop\'s own equipment. Added once at its cost; moved and disposed as dated facts — never edited.',
    assetId: 'Asset code', assetName: 'Name', category: 'Kind of asset', store: 'Store', cost: 'Cost (₹)', salvage: 'Left at the end (₹)', life: 'Useful life (months)', inService: 'In service from',
    addAsset: 'Add to the register', assetAdded: 'Added — head office kept it.', monthly: 'a month', bookValue: 'worth in the books', depreciated: 'depreciated so far',
    inUse: 'In use', disposed: 'Disposed', moveTo: 'Move to store', moveOn: 'On', move: 'Move', moved: 'Moved — head office kept the date.', disposeOn: 'Disposed on', proceeds: 'It fetched (₹)',
    dispose: 'Dispose', disposedDone: 'Disposed — head office kept it.', noAssets: 'Nothing on the register yet.',
    runH: 'Monthly depreciation', runLede: 'Posts each asset\'s depreciation once per month, a full month from the month it went into service. Running it again posts nothing twice.',
    run: 'Run depreciation for this month', ranPosted: '{n} journal(s) posted.', ranNothing: 'Nothing new to post — every month is already in the books.', ranExceptions: 'Not posted: {what}',
    kindCard: 'Card', kindUpi: 'UPI',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.', notAllowed: 'Your role cannot do this.',
    cannotRead: 'Your role cannot read the month-end books.', nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.',
    reading: 'Reading from head office…', notKnown: 'Not known — head office could not be read.', readOnly: 'You can read this; changing it needs another role.', needFields: 'Fill in every box first.',
  },
  ta: {
    title: 'மாத இறுதி', purpose: 'தலைமை அலுவலகத்தின் சொந்தக் கணக்குகளிலிருந்து மாதத்தை மூடுங்கள்: பதில் இல்லாத கட்டணங்கள், லாப நட்டம், சரக்கு சரிசெய்தல், வரவுசெலவுத் திட்டம், கடையின் உபகரணங்கள்.',
    month: 'மாதம்', tabPayments: 'பதில் இல்லாத கார்டு, யுபிஐ', tabPl: 'லாப நட்டம்', tabStock: 'சரக்கு சரிசெய்தல்', tabPlan: 'திட்டமும் சொத்துகளும்',
    payH: 'பதில் இல்லாத கார்டு, யுபிஐ கட்டணங்கள்', payLede: 'இயந்திரம் பதில் தராத ஒவ்வொரு கட்டணமும் — நடந்த உடனே கடை எழுப்பியது, அல்லது நாள் மூடல் கொண்டு வந்தது. வழங்குநரின் சொந்தப் பதிவே ஒன்றைத் தீர்க்கும்.',
    open: 'இன்னும் திறந்துள்ளது', openCard: 'கார்டு இன்னும் திறந்துள்ளது', openUpi: 'யுபிஐ இன்னும் திறந்துள்ளது', owed: 'வாடிக்கையாளர்களுக்குத் திருப்பித் தர வேண்டியது', flagged: 'பார்க்க வேண்டியவை',
    noPayments: 'பதிலுக்காகக் காத்திருக்கும் கார்டு அல்லது யுபிஐ கட்டணம் இல்லை.', stageRaised: 'இயந்திரம் பதில் தராதபோது கடை எழுப்பியது', stageCarried: 'நாள் மூடல் கொண்டு வந்தது',
    stateOpen: 'திறந்துள்ளது — இன்னும் பதில் இல்லை', statePaid: 'தீர்ந்தது — வழங்குநர் பணம் எடுத்தார்', stateNotPaid: 'தீர்ந்தது — வழங்குநர் பணம் எடுக்கவில்லை',
    closedBy: 'நாளை மூடியவர்', approvedBy: 'ஒப்புதல் அளித்தவர்', why: 'ஏன்', conflict: 'இரண்டு வேறுபட்ட பதில்கள் — முதலாவது நிற்கும்',
    conflictLine: 'நிற்பது: {standing}. மற்றொரு பதில் ({via}, {by}) சொன்னது: {offered}.', flagsLine: 'தலைமை அலுவலகம் கண்டது: {flags}', lateAnswer: 'பின்னர் கவுண்டரில் தட்டச்சு செய்த பதில்',
    resolveH: 'வழங்குநரின் பதிவுடன் தீர்', found: 'இந்தக் கட்டணத்துக்கு வழங்குநரின் அறிக்கை காட்டுவது', foundCaptured: 'பணம் எடுக்கப்பட்டது', foundDeclined: 'நிராகரிக்கப்பட்டது', foundVoided: 'ரத்து செய்யப்பட்டது',
    foundNothing: 'எதுவும் கிடைக்கவில்லை', amount: 'தொகை (₹)', when: 'வழங்குநர் பதிவு செய்த நேரம்', complete: 'அந்த நாளுக்கான வழங்குநரின் அறிக்கை முழுமையானது', resolve: 'இந்தக் கட்டணத்தைத் தீர்',
    resolved: 'தீர்ந்தது — தலைமை அலுவலகம் வழங்குநரின் பதிலை வைத்துக்கொண்டது.', alreadyResolved: 'ஏற்கனவே அதே பதிலுடன் தீர்ந்தது — எதுவும் மாறவில்லை.',
    plH: 'லாப நட்டம்', plLede: 'கணக்குகள் வைத்திருக்கும் மாதம் — ஒவ்வொரு எண்ணும் அதில் பதிவான பதிவேடுகளிலிருந்து.',
    income: 'வருமானம்', expenses: 'செலவுகள்', totalIncome: 'மொத்த வருமானம்', totalExpenses: 'மொத்தச் செலவுகள்', net: 'மாதத்தின் லாபம் (நட்டம்)', grossMargin: 'மொத்த லாப வரம்பு',
    revenue: 'விற்பனை', costOfSales: 'விற்ற பொருட்களின் அடக்கவிலை', unclassified: 'வகை இல்லாத கணக்குகள் (மேலே சேர்க்கப்படவில்லை)', periodState: 'மாதம்', noJournals: 'இந்த மாதத்துக்கு இன்னும் எதுவும் பதிவாகவில்லை.', show: 'காட்டு',
    stockH: 'மாத இறுதிச் சரக்கு சரிசெய்தல்', stockLede: 'சராசரி வாங்கு விலையில் இறுதிச் சரக்கு, கணக்கில் உள்ள சரக்குடன். முதலில் எண்களையும் தடுப்பவற்றையும் படியுங்கள்; பிறகு ஒருமுறை பதிவிடுங்கள்.',
    closingValue: 'இறுதிச் சரக்கு (சராசரி விலையில் கையிருப்பு)', purchases: 'மாதத்தின் கொள்முதல்', booksBefore: 'முன்பு கணக்கில் இருந்த சரக்கு', cogs: 'விற்ற பொருட்களின் அடக்கவிலை', change: 'சரக்குக் கணக்கில் மாற்றம்',
    blockersH: 'பதிவிடுவதைத் தடுப்பவை', noBlockers: 'சரிசெய்தலை எதுவும் தடுக்கவில்லை.', unvaluedProduct: '{store} இல் {name}: {qty} {uom} கையிருப்பு, வாங்கு விலை இல்லை — பூஜ்ஜியத்தில் ஒருபோதும் மதிப்பிடப்படாது',
    unvaluedReceipt: 'மதிப்பிட முடியாது: {what}', held: 'திறந்த எண்ணிக்கையில் நிறுத்திவைக்கப்பட்ட சேதக் கழிவு: {what}', outstanding: 'இன்னும் கணக்கில் இல்லை: {what}',
    notMapped: 'கணக்காளரின் பதிவு வரைபடத்தில் மாத இறுதிச் சரிசெய்தலுக்கு விதி இல்லை.', postAdjustment: 'மாத இறுதிச் சரிசெய்தலைப் பதிவிடு', adjustmentPosted: 'பதிவிடப்பட்டது — மாதத்துக்கு ஒரு பதிவேடு.',
    alreadyPosted: 'இந்த மாதத்துக்கு ஏற்கனவே பதிவிடப்பட்டது — இரண்டு முறை பதிவிடப்படவில்லை.', postedBy: 'பதிவிட்டவர்',
    budgetH: 'கணக்குடன் வரவுசெலவுத் திட்டம்', budgetLede: 'ஒவ்வொரு சேமிப்பும் புதிய பதிப்பு — பழையது வைக்கப்படும். உண்மை என்பது மாதத்துக்குக் கணக்கில் உள்ளது.',
    account: 'கணக்கு', budgetCol: 'திட்டம்', actual: 'உண்மை', variance: 'வேறுபாடு', unbudgeted: 'திட்டம் இல்லாத உண்மைச் செலவு', noBudget: 'இந்த மாதத்துக்குத் திட்டம் இல்லை.', version: 'பதிப்பு',
    addLine: 'ஒரு வரியைச் சேர்', reason: 'ஏன் (பதிப்புடன் வைக்கப்படும்)', saveBudget: 'புதிய பதிப்பாகச் சேமி', budgetSaved: 'சேமிக்கப்பட்டது — தலைமை அலுவலகம் புதிய பதிப்பை வைத்துக்கொண்டது.',
    assetsH: 'நிலைச் சொத்துகள்', assetsLede: 'கடையின் சொந்த உபகரணங்கள். அதன் விலையில் ஒருமுறை சேர்க்கப்படும்; இடமாற்றமும் அகற்றலும் தேதியிட்ட உண்மைகள் — ஒருபோதும் திருத்தப்படாது.',
    assetId: 'சொத்துக் குறியீடு', assetName: 'பெயர்', category: 'சொத்தின் வகை', store: 'கடை', cost: 'விலை (₹)', salvage: 'இறுதியில் மீதம் (₹)', life: 'பயன்படும் காலம் (மாதங்கள்)', inService: 'பயன்பாட்டில் இருந்து',
    addAsset: 'பதிவேட்டில் சேர்', assetAdded: 'சேர்க்கப்பட்டது — தலைமை அலுவலகம் வைத்துக்கொண்டது.', monthly: 'மாதத்துக்கு', bookValue: 'கணக்கில் மதிப்பு', depreciated: 'இதுவரை தேய்மானம்',
    inUse: 'பயன்பாட்டில்', disposed: 'அகற்றப்பட்டது', moveTo: 'இந்தக் கடைக்கு மாற்று', moveOn: 'தேதி', move: 'மாற்று', moved: 'மாற்றப்பட்டது — தலைமை அலுவலகம் தேதியை வைத்துக்கொண்டது.', disposeOn: 'அகற்றிய தேதி', proceeds: 'கிடைத்தது (₹)',
    dispose: 'அகற்று', disposedDone: 'அகற்றப்பட்டது — தலைமை அலுவலகம் வைத்துக்கொண்டது.', noAssets: 'பதிவேட்டில் இன்னும் எதுவும் இல்லை.',
    runH: 'மாதாந்திரத் தேய்மானம்', runLede: 'ஒவ்வொரு சொத்தின் தேய்மானத்தையும் மாதத்துக்கு ஒருமுறை பதிவிடும், பயன்பாட்டுக்கு வந்த மாதத்திலிருந்து முழு மாதம். மீண்டும் இயக்கினால் இரண்டு முறை பதிவிடாது.',
    run: 'இந்த மாதத்துக்குத் தேய்மானம் இயக்கு', ranPosted: '{n} பதிவேடு(கள்) பதிவிடப்பட்டன.', ranNothing: 'புதிதாகப் பதிவிட எதுவும் இல்லை — ஒவ்வொரு மாதமும் ஏற்கனவே கணக்கில் உள்ளது.', ranExceptions: 'பதிவிடப்படவில்லை: {what}',
    kindCard: 'கார்டு', kindUpi: 'யுபிஐ',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.', notAllowed: 'உங்கள் பங்கால் இதைச் செய்ய முடியாது.',
    cannotRead: 'உங்கள் பங்கால் மாத இறுதிக் கணக்குகளைப் படிக்க முடியாது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.',
    reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', notKnown: 'தெரியவில்லை — தலைமை அலுவலகத்தைப் படிக்க முடியவில்லை.', readOnly: 'நீங்கள் இதைப் படிக்கலாம்; மாற்ற வேறு பங்கு தேவை.', needFields: 'முதலில் ஒவ்வொரு பெட்டியையும் நிரப்புங்கள்.',
  },
};

export const FINANCE_CLOSE_COPY_KEYS: readonly CloseCopyKey[] = Object.freeze(Object.keys(FINANCE_CLOSE_COPY.en) as CloseCopyKey[]);

/** The words in a language, with `{name}` filled. */
export function closeWords(lang: Lang): (key: CloseCopyKey, fill?: Readonly<Record<string, string | number>>) => string {
  const t = translator(FINANCE_CLOSE_COPY, lang);
  return (key, fill) => Object.entries(fill ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key));
}

/** Rupees from paise, the Indian way, never a float in the arithmetic. */
export function rupees(minor: number): string {
  const sign = minor < 0 ? '−' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const paise = String(abs % 100).padStart(2, '0');
  return `${sign}₹${whole.toLocaleString('en-IN')}.${paise}`;
}

/** Rupees a person typed into exact paise; `null` when it is not a number of rupees. */
export function paiseOf(text: string): number | null {
  const s = String(text).trim().replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

/** A head-office refusal in its own words, prefixed in the reader's language. */
export function sayOutcome(lang: Lang, o: Outcome<unknown>, good: string): { readonly ok: boolean; readonly text: string } {
  const w = closeWords(lang);
  switch (o.kind) {
    case 'done': return { ok: true, text: good };
    case 'refused': return { ok: false, text: `${w('refused')} ${o.whatHappened}${o.nextSafeAction === '' ? '' : ` ${o.nextSafeAction}`}` };
    case 'not_allowed': return { ok: false, text: w('notAllowed') };
    case 'invalid': return { ok: false, text: o.detail === '' ? w('needFields') : o.detail };
    case 'unreachable': return { ok: false, text: w('unreachable') };
  }
}

/** Head office's flag codes, said in words a person reads. */
const FLAG_WORDS: Record<string, { en: string; ta: string }> = {
  approved_by_the_closer: { en: 'the person who closed the day also approved carrying it', ta: 'நாளை மூடியவரே ஒப்புதலும் அளித்தார்' },
  approver_lacks_authority: { en: 'the approver does not hold the authority', ta: 'ஒப்புதல் அளித்தவருக்கு அதிகாரம் இல்லை' },
  approver_not_verified_at_store: { en: 'the approver\'s PIN was not verified at the store computer', ta: 'ஒப்புதல் அளித்தவரின் பின் கடைக் கணினியில் சரிபார்க்கப்படவில்லை' },
  approver_unknown: { en: 'head office does not know the approver', ta: 'ஒப்புதல் அளித்தவரைத் தலைமை அலுவலகம் அறியாது' },
  approved_by_the_person_who_answered: { en: 'the person who typed the answer also approved it', ta: 'பதிலைத் தட்டச்சு செய்தவரே ஒப்புதலும் அளித்தார்' },
};
export function flagWords(lang: Lang, code: string): string { return FLAG_WORDS[code]?.[lang] ?? code; }

// ── Pure readings ─────────────────────────────────────────────────────────────────────────────────────────────

/** What blocks the adjustment, each named — products by their name where head office gave one. Pure. */
export function stockBlockers(v: StockValuationView, names: ReadonlyMap<string, string>): StockBlockers {
  const held = v.outstandingStockPostings.filter((s) => s.startsWith('held_write_off:'));
  const outstanding = v.outstandingStockPostings.filter((s) => !s.startsWith('held_write_off:'));
  const unvaluedProducts = v.valuation.unvalued.map((l) => ({ productId: l.productId, name: l.name ?? names.get(l.productId) ?? l.productId, storeId: l.storeId, onHandMinor: l.onHandMinor, uom: l.uom }));
  const notMapped = !v.mapped && v.posted === null;
  return {
    unvaluedProducts, unvaluedReceipts: v.valuation.purchases.unvalued, heldWriteOffs: held, outstandingPostings: outstanding, notMapped,
    any: unvaluedProducts.length > 0 || v.valuation.purchases.unvalued.length > 0 || held.length > 0 || outstanding.length > 0 || notMapped,
  };
}

/** One payment item's state in words. Pure. */
export function paymentStateWords(lang: Lang, row: PaymentExceptionRow): string {
  const w = closeWords(lang);
  return row.state === 'open' ? w('stateOpen') : row.state === 'resolved_paid' ? w('statePaid') : w('stateNotPaid');
}

/** One conflict on an item, in words. Pure. */
export function conflictWords(lang: Lang, c: PaymentExceptionRow['conflicts'][number]): string {
  const w = closeWords(lang);
  const say = (paid: boolean, owed: number) => `${paid ? w('statePaid') : w('stateNotPaid')}${owed > 0 ? ` (${w('owed')} ${rupees(owed)})` : ''}`;
  return w('conflictLine', { standing: say(c.standing.paid, c.standing.owedToCustomerMinor), via: c.offered.via, by: c.offered.by, offered: say(c.offered.paid, c.offered.owedToCustomerMinor) });
}

// ── The session ───────────────────────────────────────────────────────────────────────────────────────────────

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const enc = encodeURIComponent;

export interface FinanceCloseSession {
  readonly viewer: { readonly userId: string | null; readonly signedIn: boolean };
  readonly may: { readonly read: boolean; readonly resolve: boolean; readonly post: boolean; readonly budget: boolean };
  readonly period: string;
  paymentExceptions(): Promise<Outcome<PaymentExceptionList>>;
  resolvePayment(attemptId: string, record: ProviderRecordInput): Promise<Outcome<{ readonly alreadyResolved?: boolean }>>;
  profitAndLoss(period: string): Promise<Outcome<ProfitAndLossView>>;
  stockValuation(period: string): Promise<Outcome<StockValuationView & { readonly blockers: StockBlockers }>>;
  postStockAdjustment(period: string): Promise<Outcome<{ readonly alreadyPosted?: boolean }>>;
  budget(period: string): Promise<Outcome<BudgetView>>;
  setBudget(period: string, lines: readonly { readonly account: string; readonly amountMinor: number }[], reason: string): Promise<Outcome<unknown>>;
  assets(): Promise<Outcome<{ readonly assets: readonly AssetRow[] }>>;
  addAsset(a: AssetInput): Promise<Outcome<{ readonly alreadyAdded?: boolean }>>;
  moveAsset(assetId: string, toStoreId: string, on: string, reason: string): Promise<Outcome<unknown>>;
  disposeAsset(assetId: string, on: string, proceedsMinor: number, reason: string): Promise<Outcome<unknown>>;
  runDepreciation(period: string): Promise<Outcome<DepreciationRun>>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A route's answer as an outcome: 2xx done; head office's refusal in its own words; nothing back — unreachable. */
export function outcomeOf<T>(a: HttpAnswer): Outcome<T> {
  if (a.status === 0) return { kind: 'unreachable' };
  if (a.status >= 200 && a.status < 300) return { kind: 'done', status: a.status, body: a.body as T };
  const e = isObj(a.body) && isObj(a.body['error']) ? a.body['error'] : {};
  return {
    kind: 'refused', status: a.status,
    code: typeof e['code'] === 'string' ? e['code'] : String(a.status),
    whatHappened: typeof e['whatHappened'] === 'string' ? e['whatHappened'] : `Head office answered ${a.status}.`,
    nextSafeAction: typeof e['nextSafeAction'] === 'string' ? e['nextSafeAction'] : '',
  };
}

export function createFinanceCloseSession(viewer: FinanceCloseViewer | undefined, http: FinanceCloseHttp): FinanceCloseSession {
  const held = new Set(viewer?.permissions ?? []);
  const P = FINANCE_CLOSE_PERMISSIONS;
  const may = Object.freeze({ read: held.has(P.read), resolve: held.has(P.resolve), post: held.has(P.post), budget: held.has(P.budget) });
  const notAllowed = (needs: string): Outcome<never> => ({ kind: 'not_allowed', needs });
  const invalid = (detail = ''): Outcome<never> => ({ kind: 'invalid', detail });
  const okPeriod = (p: string): boolean => PERIOD.test(p);
  const get = async <T>(path: string): Promise<Outcome<T>> => outcomeOf<T>(await http.get(path));
  const send = async <T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<Outcome<T>> => outcomeOf<T>(await http.send(method, path, body));

  /** The products' names, read from head office when the viewer may read the catalogue — else none (the id is shown). */
  const productNames = async (): Promise<ReadonlyMap<string, string>> => {
    if (!held.has(P.products)) return new Map();
    const r = await get<{ products?: readonly { productId?: string; name?: string; product?: { name?: string } }[] }>('/v1/catalogue/products');
    if (r.kind !== 'done') return new Map();
    return new Map((r.body.products ?? []).flatMap((p) => (typeof p.productId === 'string' ? [[p.productId, p.name ?? p.product?.name ?? p.productId] as const] : [])));
  };

  return {
    viewer: { userId: viewer?.userId ?? null, signedIn: viewer?.userId !== undefined },
    may,
    period: viewer?.period !== undefined && okPeriod(viewer.period) ? viewer.period : '',

    paymentExceptions: async () => (may.read ? get<PaymentExceptionList>('/v1/finance/payment-exceptions') : notAllowed(P.read)),

    resolvePayment: async (attemptId, rec) => {
      if (!may.resolve) return notAllowed(P.resolve);
      if (attemptId.trim() === '' || typeof rec.statementComplete !== 'boolean') return invalid();
      if (rec.found !== 'nothing' && (!Number.isSafeInteger(rec.amountMinor) || rec.amountMinor <= 0 || Number.isNaN(Date.parse(rec.at)))) return invalid();
      // The provider's reference for the payment IS the attempt id the till asked under (the engine matches on it).
      const authorisations = rec.found === 'nothing' ? [] : [{ ref: attemptId, amountMinor: rec.amountMinor, status: rec.found, at: new Date(rec.at).toISOString() }];
      return send('POST', `/v1/finance/payment-exceptions/${enc(attemptId)}/resolve`, { authorisations, statementComplete: rec.statementComplete });
    },

    profitAndLoss: async (period) => (!may.read ? notAllowed(P.read) : !okPeriod(period) ? invalid() : get<ProfitAndLossView>(`/v1/finance/periods/${enc(period)}/profit-and-loss`)),

    stockValuation: async (period) => {
      if (!may.read) return notAllowed(P.read);
      if (!okPeriod(period)) return invalid();
      const [r, names] = await Promise.all([get<StockValuationView>(`/v1/finance/periods/${enc(period)}/stock-valuation`), productNames()]);
      if (r.kind !== 'done') return r;
      return { ...r, body: { ...r.body, blockers: stockBlockers(r.body, names) } };
    },

    postStockAdjustment: async (period) => (!may.post ? notAllowed(P.post) : !okPeriod(period) ? invalid() : send('POST', `/v1/finance/periods/${enc(period)}/stock-adjustment`, {})),

    budget: async (period) => (!may.read ? notAllowed(P.read) : !okPeriod(period) ? invalid() : get<BudgetView>(`/v1/finance/budgets/${enc(period)}`)),

    setBudget: async (period, lines, reason) => {
      if (!may.budget) return notAllowed(P.budget);
      const clean = lines.filter((l) => l.account.trim() !== '');
      if (!okPeriod(period) || clean.length === 0 || clean.some((l) => !Number.isSafeInteger(l.amountMinor) || l.amountMinor < 0)) return invalid();
      return send('PUT', `/v1/finance/budgets/${enc(period)}`, { lines: clean.map((l) => ({ account: l.account.trim(), amountMinor: l.amountMinor })), ...(reason.trim() === '' ? {} : { reason: reason.trim() }) });
    },

    assets: async () => (may.read ? get<{ assets: readonly AssetRow[] }>('/v1/finance/fixed-assets') : notAllowed(P.read)),

    addAsset: async (a) => {
      if (!may.post) return notAllowed(P.post);
      if ([a.assetId, a.name, a.category, a.storeId].some((s) => s.trim() === '') || !DATE.test(a.inServiceDate)
        || ![a.costMinor, a.salvageMinor, a.usefulLifeMonths].every(Number.isSafeInteger)) return invalid();
      const { assetId, ...body } = a;
      return send('POST', `/v1/finance/fixed-assets/${enc(assetId.trim())}`, body);
    },

    moveAsset: async (assetId, toStoreId, on, reason) => {
      if (!may.post) return notAllowed(P.post);
      if (toStoreId.trim() === '' || !DATE.test(on) || reason.trim() === '') return invalid();
      return send('POST', `/v1/finance/fixed-assets/${enc(assetId)}/transfer`, { toStoreId: toStoreId.trim(), on, reason: reason.trim() });
    },

    disposeAsset: async (assetId, on, proceedsMinor, reason) => {
      if (!may.post) return notAllowed(P.post);
      if (!DATE.test(on) || !Number.isSafeInteger(proceedsMinor) || proceedsMinor < 0 || reason.trim() === '') return invalid();
      return send('POST', `/v1/finance/fixed-assets/${enc(assetId)}/dispose`, { on, proceedsMinor, reason: reason.trim() });
    },

    runDepreciation: async (period) => (!may.post ? notAllowed(P.post) : !okPeriod(period) ? invalid() : send('POST', `/v1/finance/fixed-assets/depreciation/${enc(period)}`, {})),
  };
}

/** The browser's own session to head office: same-origin cookies; each write its own idempotency key. */
export function browserFinanceCloseHttp(): FinanceCloseHttp {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  const key = (): string => globalThis.crypto?.randomUUID?.() ?? `finance-close-${Date.now()}-${Math.random()}`;
  const answer = async (res: Response): Promise<HttpAnswer> => ({ status: res.status, body: await res.json().catch(() => null) });
  return {
    get: async (path) => {
      if (fetchFn === undefined) return { status: 0, body: null };
      try { return await answer(await fetchFn(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' })); } catch { return { status: 0, body: null }; }
    },
    send: async (method, path, body) => {
      if (fetchFn === undefined) return { status: 0, body: null };
      try {
        return await answer(await fetchFn(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': key() }, body: JSON.stringify(body ?? {}) }));
      } catch { return { status: 0, body: null }; }
    },
  };
}
