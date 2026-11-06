// The Count plans page (WF-08 · D05-FR-05 · M09-FR-04 · OB-59 · OB-66 · §28 · P-08 · hard rules #2 #10) — the session
// model behind the manager's stock-count screen. A THIN client over head office's count-plan routes
// (services/inventory/src/count-plans.ts): every rule — what may be frozen, when a line must be recounted, who may
// approve, what posts — is head office's. This model only:
//   • turns the manager's form into the body the route reads (and refuses the cheap things locally, before any POST:
//     nobody signed in, no place, no products, a threshold that is not money, a count that is not a whole number);
//   • says what the freeze covers in plain words — the owner's default (OB-59: adjustments and write-offs; deliveries and
//     transfers keep flowing) or the planner's own list — and that a till sale is never frozen;
//   • presents each line's state, its recount reasons and its value, the freeze BREACHES (a frozen movement relayed from
//     the floor — kept, visible, recounted) and the damaged write-offs HELD on the plan until it closes (OB-66);
//   • hands head office's refusal back in head office's words.
// The COUNTER's sheet is read from `/sheet`, which never carries an expected figure (blind count); the manager's view
// (`GET /v1/inventory/count-plans/:planId`) carries expected, variance and value. DOM-free and tested.

import type { HeadOfficeHttp, HttpAnswer } from './head-office-http';
import { refusalWords } from './refusal-words';
import { rupees } from './head-office-http';
import { quantityLabel, normaliseUom, typedQuantityMinor } from '../../../packages/contracts/src/quantity';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';

export interface CountPlanViewer { readonly userId?: string; readonly permissions: readonly string[] }

/** The plan as head office keeps it (the fields this screen reads). */
export interface CountPlanRecord {
  readonly planId: string;
  readonly locationId: string;
  readonly productIds: readonly string[];
  readonly frozenKinds: readonly string[];
  readonly frozenByDefault?: boolean;
  readonly recountThresholdMinor: number;
  readonly note: string | null;
  readonly plannedBy: string;
  readonly plannedAt: string;
  readonly state: 'planned' | 'counting' | 'approved' | 'cancelled';
  readonly openedBy?: string; readonly openedAt?: string;
  readonly approvedBy?: string; readonly approvedAt?: string; readonly approvalReason?: string;
  readonly cancelledBy?: string; readonly cancelledAt?: string; readonly cancelReason?: string;
}

export interface PlanCountRecord { readonly countId: string; readonly productId: string; readonly expectedMinor: number; readonly countedMinor: number; readonly varianceMinor: number; readonly valueMinor: number; readonly counterId: string; readonly recountOf?: string; readonly uom?: string }
export interface PlanLineRecord {
  readonly productId: string;
  readonly state: 'not_counted' | 'matched' | 'recount_required' | 'cause_required' | 'ready';
  readonly finalCountId: string | null;
  readonly counts: readonly PlanCountRecord[];
  readonly recountBecause: readonly string[];
  readonly cause: { readonly causeCode: string; readonly note: string; readonly setBy: string } | null;
  readonly varianceMinor: number;
  readonly valueMinor: number;
}
export interface FreezeBreachRecord { readonly movementId: string; readonly productId: string; readonly kind: string; readonly effectMinor: number; readonly occurredAt: string }
export interface HeldWriteOffRecord { readonly heldId: string; readonly productId: string; readonly quantityMinor: number; readonly uom: string; readonly valueMinor: number; readonly state: 'awaiting_close' | 'awaiting_application' | 'applied'; readonly applied: { readonly writeOffId: string; readonly outcome: string } | null }
export interface PlanView {
  readonly plan: CountPlanRecord;
  readonly lines: readonly PlanLineRecord[];
  readonly freezeBreaches: readonly FreezeBreachRecord[];
  readonly heldWriteOffs: readonly HeldWriteOffRecord[];
  readonly totals: { readonly products: number; readonly counted: number; readonly recountRequired: number; readonly causeRequired: number; readonly lossMinor: number; readonly gainMinor: number };
}
export interface SheetView { readonly planId: string; readonly locationId: string; readonly state: string; readonly lines: readonly { readonly productId: string; readonly toDo: 'count' | 'recount' | 'done'; readonly recountOf: string | null }[] }

/** M08-FR-03: a stock correction a handheld asked for, as head office keeps it (`GET /v1/inventory/adjustment-requests`). */
export interface AdjustmentRequestRow {
  readonly requestId: string; readonly productId: string; readonly locationId: string; readonly binId: string | null;
  /** Signed: positive = found more, negative = missing / damaged. */
  readonly deltaMinor: number; readonly uom: string; readonly reasonCode: string; readonly note: string | null;
  readonly valueMinor: number; readonly requestedBy: string; readonly at: string; readonly storeId: string | null; readonly source: string;
  readonly governanceFlags: readonly string[]; readonly status: 'pending' | 'posted' | 'rejected';
  readonly decidedBy: string | null; readonly decidedAt: string | null; readonly decisionReason: string | null; readonly movementId: string | null;
}

export type Refused = { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string };
export type Outcome<T> = ({ readonly result: 'ok' } & T) | Refused | { readonly result: 'lost_link' } | { readonly result: 'invalid'; readonly key: string };

/** The movement kinds a plan may freeze (head office's list — `FREEZABLE_KINDS`); the till's never appear. */
export const FREEZABLE = Object.freeze(['adjusted', 'wasted', 'received', 'transferred_in', 'transferred_out', 'returned_to_supplier', 'produced', 'consumed_in_production', 'counted'] as const);
/** OB-59: what a plan that names nothing freezes. */
export const OWNER_DEFAULT_FREEZE = Object.freeze(['adjusted', 'wasted'] as const);
/** The variance causes head office accepts (`ADJUSTMENT_REASON_CODES`). */
export const CAUSES = Object.freeze(['damaged', 'expired', 'miscount', 'found', 'theft_suspected', 'other'] as const);

const WORDS: Readonly<Record<Lang, Readonly<Record<string, string>>>> = Object.freeze({
  en: {
    title: 'Count plans', lede: 'Plan a stock count for one place, freeze what must not move while it is counted, count blind, recount, give each difference a cause, and have a different person approve it. Head office posts the corrections.',
    newH: 'Plan a count', newLede: 'Choose the place and the products. Left as it is, the count freezes adjustments and write-offs only (the owner\'s default) — deliveries and transfers keep flowing, and the till never stops.',
    place: 'Place', products: 'Products to count', productsBulk: 'Many at once, pasted (one per line or separated by commas)', addProduct: 'Add a product…', remove: 'Remove', noProductsYet: 'No product chosen yet.',
    choose: 'Choose…', pickUnavailable: 'The list could not open — type the id instead.', whichPlace: 'Which place?', whichProduct: 'Which product? (name or barcode)', threshold: 'Recount any difference worth at least ₹', note: 'Note (optional)',
    freezeDefault: 'Owner\'s default: adjustments and write-offs', freezeCustom: 'Choose what to freeze', freezeNone: 'Freeze nothing (said on the plan)', create: 'Plan this count',
    registerH: 'Count plans', registerLede: 'Newest first. Open one to see its lines, its exceptions and what is left to do.', empty: 'No count plans yet.',
    planned: 'Planned — not counting yet', counting: 'Counting — frozen', approved: 'Approved — corrections posted', cancelled: 'Cancelled — nothing posted',
    freezes: 'Frozen while counting:', freezesNothing: 'Freezes nothing.', byDefault: '(the owner\'s default, OB-59)', tillNever: 'Till sales and returns are never frozen.',
    open: 'Open the count (start the freeze)', approve: 'Approve and post', cancel: 'Cancel the count', reason: 'Reason', why: 'Why',
    // U1 · OB-691: the consequence-and-confirm sheet before a count's corrections are posted
    confirmTitle: 'Approve count {plan} at {place}: {counted} of {products} products counted, loss {loss}, gain {gain}',
    confirmDetail: 'Stock is corrected to what was counted, as new movements in the books — nothing is overwritten. A big loss held by the rules waits for its own approval. The freeze on this place ends.',
    confirmAuthority: 'In your name as the approver — never the person who counted. Head office refuses it if your role may not approve, or if you counted a line yourself.',
    confirmLabel: 'Approve and post', confirmUnavailable: 'The confirm step could not open, so nothing was sent. Reload the page and try again.',
    linesH: 'Lines', sheetH: 'Count sheet (blind)', sheetLede: 'What to count or recount — no expected figure is shown here.',
    breachesH: 'Freeze exceptions', breachesLede: 'Frozen movements that reached head office from the floor while counting. Kept, never refused into the void — the product must be counted again.', noBreaches: 'No frozen movement landed here.',
    heldH: 'Damaged write-offs held for this count', heldLede: 'Damaged units that arrived while counting. Held — not on the shelf, not yet written off — and applied once when the count closes (OB-66).', noHeld: 'None held.',
    not_counted: 'Not counted', matched: 'Matched', recount_required: 'Recount needed', cause_required: 'Cause needed', ready: 'Ready to approve',
    over_recount_threshold: 'difference at or over the recount threshold', value_unknown: 'head office cannot value it', moved_during_freeze: 'a frozen movement landed after it was counted', expected_changed: 'a movement dated before the count arrived after it',
    awaiting_close: 'Held until the count closes', awaiting_application: 'Being applied', applied: 'Applied at the close',
    expected: 'Expected', countedLbl: 'Counted', variance: 'Difference', value: 'Value', cause: 'Cause', setCause: 'Set the cause', countIt: 'Record count', recountIt: 'Record recount', qty: 'Counted quantity', uom: 'Unit',
    damaged: 'Damaged', expired: 'Expired', miscount: 'Miscount', found: 'Found', theft_suspected: 'Theft suspected', other: 'Other',
    adjusted: 'Adjustments', wasted: 'Write-offs', received: 'Deliveries', transferred_in: 'Transfers in', transferred_out: 'Transfers out', returned_to_supplier: 'Returns to supplier', produced: 'Production output', consumed_in_production: 'Production use', counted: 'Other counts',
    loss: 'Loss', gain: 'Gain', toDo: 'To do', done: 'Done', count: 'Count', recount: 'Recount',
    plannedBy: 'planned by', approvedBy: 'approved by', cancelledBy: 'cancelled by',
    saved: 'Done — head office recorded it.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing is known to have changed.',
    needPlace: 'Write the place first.', needProducts: 'Name at least one product.', needThreshold: 'Write the recount threshold in rupees (0 or more).', needKinds: 'Tick at least one kind, or choose "Freeze nothing".',
    needQty: 'Write the counted quantity in the item\'s unit (whole items; kg and litres up to 3 decimals).', needReason: 'Write a reason first.', needCause: 'Choose a cause and write a note.',
    colPlan: 'Plan', colPlace: 'Place', colProducts: 'Products', colState: 'Where it stands', colFreeze: 'Frozen while counting', view: 'Look at it', freezeLegend: 'What is frozen while counting', close: 'Close',
    countedOf: 'counted', of: 'of', recountNeeded: 'need a recount', causeNeeded: 'need a cause', recountOfCount: 'recount of',
    cannotRead: 'Your role cannot read count plans.', nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', reading: 'Reading from head office…',
    adjH: 'Stock corrections asked for from the handhelds', adjLede: 'A worker at the racking asked for each of these with a reason. Nothing has moved yet: a different person approves (head office posts one correction) or rejects it. The person who asked can never decide it.',
    adjShow: 'Show the corrections waiting', adjEmpty: 'No correction is waiting.', adjPending: 'waiting', adjAll: 'Show decided ones too',
    adjMore: 'Found more', adjLess: 'Missing or damaged', adjAskedBy: 'asked by', adjAt: 'at', adjBin: 'bin', adjValue: 'Value at cost', adjValueUnknown: 'Not known — head office has no cost for this product',
    adjApprove: 'Approve and post', adjReject: 'Reject', adjReason: 'Reason for your decision', adjYours: 'You asked for this one — a different person decides it.', adjCannotDecide: 'Your role cannot approve stock corrections.',
    adjPosted: 'Approved — correction posted', adjRejected: 'Rejected — nothing moved', adjWaiting: 'Waiting for a decision', adjDecidedBy: 'decided by',
    adjApprovedNow: 'Approved. Head office posted the correction once.', adjRejectedNow: 'Rejected. Nothing moved.', adjAlready: 'Already decided — nothing changed.',
    flag_requester_unknown: 'The person who asked holds no role here', flag_requester_lacks_authority: 'The person who asked may not move stock', flag_value_unknown: 'No cost known — the value is not known',
    cannotReadAdj: 'Your role cannot read the stock corrections.',
  },
  ta: {
    title: 'எண்ணிக்கைத் திட்டங்கள்', lede: 'ஓர் இடத்துக்குச் சரக்கு எண்ணிக்கையைத் திட்டமிடுங்கள், எண்ணும்போது நகரக்கூடாதவற்றை உறைய வையுங்கள், பார்க்காமல் எண்ணுங்கள், மீண்டும் எண்ணுங்கள், ஒவ்வொரு வேறுபாட்டுக்கும் காரணம் கொடுங்கள், வேறொருவர் ஒப்புதல் தரட்டும். திருத்தங்களைத் தலைமை அலுவலகம் பதிவு செய்யும்.',
    newH: 'எண்ணிக்கையைத் திட்டமிடு', newLede: 'இடத்தையும் பொருட்களையும் தேர்ந்தெடுங்கள். அப்படியே விட்டால், சரிசெய்தல்களும் தள்ளுபடிகளும் மட்டுமே உறையும் (உரிமையாளரின் இயல்புநிலை) — வரவுகளும் இடமாற்றங்களும் தொடரும், கல்லா ஒருபோதும் நிற்காது.',
    place: 'இடம்', products: 'எண்ண வேண்டிய பொருட்கள்', productsBulk: 'பல ஒரே நேரத்தில், ஒட்டி (வரிக்கு ஒன்று அல்லது காற்புள்ளியால் பிரித்து)', addProduct: 'ஒரு பொருளைச் சேர்…', remove: 'நீக்கு', noProductsYet: 'இன்னும் பொருள் தேர்ந்தெடுக்கப்படவில்லை.',
    choose: 'தேர்ந்தெடு…', pickUnavailable: 'பட்டியலைத் திறக்க முடியவில்லை — அடையாளத்தைத் தட்டச்சு செய்யவும்.', whichPlace: 'எந்த இடம்?', whichProduct: 'எந்தப் பொருள்? (பெயர் அல்லது பார்கோடு)', threshold: 'இந்த அளவு ₹ அல்லது அதற்கு மேலான வேறுபாட்டை மீண்டும் எண்ணு', note: 'குறிப்பு (விருப்பம்)',
    freezeDefault: 'உரிமையாளரின் இயல்புநிலை: சரிசெய்தல்களும் தள்ளுபடிகளும்', freezeCustom: 'எதை உறைய வைப்பது எனத் தேர்ந்தெடு', freezeNone: 'எதையும் உறைய வைக்காதே (திட்டத்தில் சொல்லப்படும்)', create: 'இந்த எண்ணிக்கையைத் திட்டமிடு',
    registerH: 'எண்ணிக்கைத் திட்டங்கள்', registerLede: 'புதியவை முதலில். ஒன்றைத் திறந்து அதன் வரிகள், விதிவிலக்குகள், மீதமுள்ள வேலையைப் பாருங்கள்.', empty: 'இன்னும் எண்ணிக்கைத் திட்டங்கள் இல்லை.',
    planned: 'திட்டமிடப்பட்டது — இன்னும் எண்ணவில்லை', counting: 'எண்ணுகிறது — உறைந்துள்ளது', approved: 'ஒப்புதல் — திருத்தங்கள் பதிவாயின', cancelled: 'ரத்து — எதுவும் பதிவாகவில்லை',
    freezes: 'எண்ணும்போது உறைந்தவை:', freezesNothing: 'எதையும் உறைய வைக்கவில்லை.', byDefault: '(உரிமையாளரின் இயல்புநிலை, OB-59)', tillNever: 'கல்லா விற்பனையும் திருப்பமும் ஒருபோதும் உறையாது.',
    open: 'எண்ணிக்கையைத் தொடங்கு (உறைவைத் தொடங்கு)', approve: 'ஒப்புதல் தந்து பதிவு செய்', cancel: 'எண்ணிக்கையை ரத்து செய்', reason: 'காரணம்', why: 'ஏன்',
    confirmTitle: '{place}இல் எண்ணிக்கை {plan} ஒப்புதல்: {products}இல் {counted} பொருட்கள் எண்ணப்பட்டன, இழப்பு {loss}, லாபம் {gain}',
    confirmDetail: 'எண்ணியதற்கு ஏற்பச் சரக்கு கணக்கில் புதிய நகர்வுகளாகத் திருத்தப்படும் — எதுவும் மேலெழுதப்படாது. விதிகளால் நிறுத்தப்பட்ட பெரிய இழப்பு அதன் சொந்த ஒப்புதலுக்குக் காத்திருக்கும். இந்த இடத்தின் முடக்கம் முடியும்.',
    confirmAuthority: 'ஒப்புதல் அளிப்பவராக உங்கள் பெயரில் — எண்ணியவர் அல்ல. ஒப்புதல் உரிமை இல்லையெனில் அல்லது நீங்களே ஒரு வரியை எண்ணியிருந்தால் தலைமை அலுவலகம் மறுக்கும்.',
    confirmLabel: 'ஒப்புதல் அளித்துப் பதிவு செய்', confirmUnavailable: 'உறுதிப்படுத்தும் திரையைத் திறக்க முடியவில்லை, எனவே எதுவும் அனுப்பப்படவில்லை. பக்கத்தைப் புதுப்பித்து மீண்டும் முயற்சிக்கவும்.',
    linesH: 'வரிகள்', sheetH: 'எண்ணிக்கைத் தாள் (பார்க்காமல்)', sheetLede: 'எதை எண்ண வேண்டும் அல்லது மீண்டும் எண்ண வேண்டும் — எதிர்பார்க்கும் எண் இங்கே காட்டப்படாது.',
    breachesH: 'உறைவு விதிவிலக்குகள்', breachesLede: 'எண்ணும்போது தளத்திலிருந்து தலைமை அலுவலகத்தை அடைந்த உறைந்த நகர்வுகள். வைக்கப்பட்டவை, மறுக்கப்படவில்லை — பொருளை மீண்டும் எண்ண வேண்டும்.', noBreaches: 'இங்கே உறைந்த நகர்வு எதுவும் வரவில்லை.',
    heldH: 'இந்த எண்ணிக்கைக்காக நிறுத்தப்பட்ட சேத தள்ளுபடிகள்', heldLede: 'எண்ணும்போது வந்த சேதமான அலகுகள். நிறுத்தப்பட்டவை — அடுக்கில் இல்லை, இன்னும் தள்ளுபடி இல்லை — எண்ணிக்கை முடியும்போது ஒருமுறை பதிவாகும் (OB-66).', noHeld: 'எதுவும் நிறுத்தப்படவில்லை.',
    not_counted: 'எண்ணப்படவில்லை', matched: 'பொருந்தியது', recount_required: 'மீண்டும் எண்ண வேண்டும்', cause_required: 'காரணம் தேவை', ready: 'ஒப்புதலுக்குத் தயார்',
    over_recount_threshold: 'வேறுபாடு மீண்டும் எண்ணும் வரம்பை எட்டியது', value_unknown: 'தலைமை அலுவலகத்தால் மதிப்பிட முடியவில்லை', moved_during_freeze: 'எண்ணிய பிறகு உறைந்த நகர்வு வந்தது', expected_changed: 'எண்ணிக்கைக்கு முந்தைய தேதியிட்ட நகர்வு பின்னர் வந்தது',
    awaiting_close: 'எண்ணிக்கை முடியும் வரை நிறுத்தம்', awaiting_application: 'பதிவாகிறது', applied: 'முடிவில் பதிவானது',
    expected: 'எதிர்பார்ப்பு', countedLbl: 'எண்ணியது', variance: 'வேறுபாடு', value: 'மதிப்பு', cause: 'காரணம்', setCause: 'காரணத்தைப் பதிவு செய்', countIt: 'எண்ணிக்கையைப் பதிவு செய்', recountIt: 'மறு எண்ணிக்கையைப் பதிவு செய்', qty: 'எண்ணிய அளவு', uom: 'அலகு',
    damaged: 'சேதம்', expired: 'காலாவதி', miscount: 'தவறான எண்ணிக்கை', found: 'கண்டுபிடிக்கப்பட்டது', theft_suspected: 'திருட்டு சந்தேகம்', other: 'மற்றவை',
    adjusted: 'சரிசெய்தல்கள்', wasted: 'தள்ளுபடிகள்', received: 'வரவுகள்', transferred_in: 'உள்வரும் இடமாற்றங்கள்', transferred_out: 'வெளிச்செல்லும் இடமாற்றங்கள்', returned_to_supplier: 'விநியோகஸ்தருக்குத் திருப்பம்', produced: 'உற்பத்தி வெளியீடு', consumed_in_production: 'உற்பத்திப் பயன்பாடு', counted: 'பிற எண்ணிக்கைகள்',
    loss: 'இழப்பு', gain: 'ஆதாயம்', toDo: 'செய்ய வேண்டியது', done: 'முடிந்தது', count: 'எண்ணு', recount: 'மீண்டும் எண்ணு',
    plannedBy: 'திட்டமிட்டவர்', approvedBy: 'ஒப்புதல் தந்தவர்', cancelledBy: 'ரத்து செய்தவர்',
    saved: 'முடிந்தது — தலைமை அலுவலகம் பதிவு செய்தது.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாறியதாகத் தெரியவில்லை.',
    needPlace: 'முதலில் இடத்தை எழுதுங்கள்.', needProducts: 'குறைந்தது ஒரு பொருளைக் குறிப்பிடுங்கள்.', needThreshold: 'மீண்டும் எண்ணும் வரம்பை ரூபாயில் எழுதுங்கள் (0 அல்லது அதற்கு மேல்).', needKinds: 'குறைந்தது ஒரு வகையைத் தேர்ந்தெடுங்கள், அல்லது "எதையும் உறைய வைக்காதே" என்பதைத் தேர்ந்தெடுங்கள்.',
    needQty: 'எண்ணிய அளவைப் பொருளின் அலகில் எழுதுங்கள் (முழுப் பொருட்கள்; கிலோ, லிட்டருக்கு 3 தசம இடங்கள் வரை).', needReason: 'முதலில் ஒரு காரணத்தை எழுதுங்கள்.', needCause: 'ஒரு காரணத்தைத் தேர்ந்தெடுத்து ஒரு குறிப்பை எழுதுங்கள்.',
    colPlan: 'திட்டம்', colPlace: 'இடம்', colProducts: 'பொருட்கள்', colState: 'நிலை', colFreeze: 'எண்ணும்போது உறைந்தவை', view: 'பார்', freezeLegend: 'எண்ணும்போது எது உறைகிறது', close: 'மூடு',
    countedOf: 'எண்ணப்பட்டவை', of: 'இல்', recountNeeded: 'மீண்டும் எண்ண வேண்டியவை', causeNeeded: 'காரணம் தேவைப்படுபவை', recountOfCount: 'இதன் மறு எண்ணிக்கை',
    cannotRead: 'உங்கள் பங்கால் எண்ணிக்கைத் திட்டங்களைப் படிக்க முடியாது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    adjH: 'கைக்கருவிகளிலிருந்து கேட்கப்பட்ட சரக்குத் திருத்தங்கள்', adjLede: 'அடுக்கில் நின்ற ஒரு பணியாளர் ஒவ்வொன்றையும் காரணத்துடன் கேட்டார். இன்னும் எதுவும் நகரவில்லை: வேறொருவர் ஒப்புதல் தருவார் (தலைமை அலுவலகம் ஒரு திருத்தத்தைப் பதிவு செய்யும்) அல்லது நிராகரிப்பார். கேட்டவர் ஒருபோதும் முடிவு செய்ய முடியாது.',
    adjShow: 'காத்திருக்கும் திருத்தங்களைக் காட்டு', adjEmpty: 'எந்தத் திருத்தமும் காத்திருக்கவில்லை.', adjPending: 'காத்திருப்பவை', adjAll: 'முடிவானவற்றையும் காட்டு',
    adjMore: 'கூடுதலாகக் கண்டது', adjLess: 'காணவில்லை அல்லது சேதம்', adjAskedBy: 'கேட்டவர்', adjAt: 'இடம்', adjBin: 'பெட்டி', adjValue: 'அடக்க விலையில் மதிப்பு', adjValueUnknown: 'தெரியவில்லை — இந்தப் பொருளுக்குத் தலைமை அலுவலகத்திடம் அடக்க விலை இல்லை',
    adjApprove: 'ஒப்புதல் தந்து பதிவு செய்', adjReject: 'நிராகரி', adjReason: 'உங்கள் முடிவுக்கான காரணம்', adjYours: 'இதை நீங்களே கேட்டீர்கள் — வேறொருவர் முடிவு செய்வார்.', adjCannotDecide: 'உங்கள் பங்கால் சரக்குத் திருத்தங்களுக்கு ஒப்புதல் தர முடியாது.',
    adjPosted: 'ஒப்புதல் — திருத்தம் பதிவானது', adjRejected: 'நிராகரிக்கப்பட்டது — எதுவும் நகரவில்லை', adjWaiting: 'முடிவுக்காகக் காத்திருக்கிறது', adjDecidedBy: 'முடிவு செய்தவர்',
    adjApprovedNow: 'ஒப்புதல் தரப்பட்டது. தலைமை அலுவலகம் திருத்தத்தை ஒருமுறை பதிவு செய்தது.', adjRejectedNow: 'நிராகரிக்கப்பட்டது. எதுவும் நகரவில்லை.', adjAlready: 'ஏற்கனவே முடிவானது — எதுவும் மாறவில்லை.',
    flag_requester_unknown: 'கேட்டவருக்கு இங்கே எந்தப் பங்கும் இல்லை', flag_requester_lacks_authority: 'கேட்டவர் சரக்கை நகர்த்த அனுமதி இல்லாதவர்', flag_value_unknown: 'அடக்க விலை தெரியவில்லை — மதிப்பு தெரியவில்லை',
    cannotReadAdj: 'உங்கள் பங்கால் சரக்குத் திருத்தங்களைப் படிக்க முடியாது.',
  },
});

/** Every word key the page draws — the Tamil-completeness test binds to it. */
export const COUNT_PLAN_WORD_KEYS: readonly string[] = Object.freeze(Object.keys(WORDS.en));

export const text = (lang: Lang, key: string): string => WORDS[lang][key] ?? WORDS.en[key] ?? key;

/** Rupees as typed (₹12.50, 12,000) → paise; undefined when it is not a non-negative amount. */
export function paiseOf(typed: string): number | undefined {
  const s = typed.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  return Math.round(Number(s) * 100);
}

/** What the freeze covers, in words. */
export function freezeWords(lang: Lang, plan: Pick<CountPlanRecord, 'frozenKinds' | 'frozenByDefault'>): string {
  if (plan.frozenKinds.length === 0) return `${text(lang, 'freezesNothing')} ${text(lang, 'tillNever')}`;
  return `${text(lang, 'freezes')} ${plan.frozenKinds.map((k) => text(lang, k)).join(', ')}${plan.frozenByDefault === true ? ` ${text(lang, 'byDefault')}` : ''}. ${text(lang, 'tillNever')}`;
}

/** One line as the manager reads it: the standing count's figures, the state, why a recount is needed, the cause. */
export function lineView(lang: Lang, line: PlanLineRecord) {
  const final = line.counts.find((c) => c.countId === line.finalCountId) ?? null;
  return {
    productId: line.productId, state: line.state, stateWord: text(lang, line.state),
    tone: line.state === 'matched' || line.state === 'ready' ? 'ok' : line.state === 'not_counted' ? 'idle' : 'degraded',
    expected: final === null ? null : final.expectedMinor, counted: final === null ? null : final.countedMinor,
    variance: line.varianceMinor, value: rupees(line.varianceMinor < 0 ? -line.valueMinor : line.valueMinor),
    recountBecause: line.recountBecause.map((r) => text(lang, r)),
    cause: line.cause === null ? null : `${text(lang, line.cause.causeCode)} — ${line.cause.note}`,
    finalCountId: line.finalCountId,
    needsCause: line.state === 'cause_required' || (line.state === 'ready' && line.varianceMinor !== 0),
  };
}

export const breachView = (lang: Lang, b: FreezeBreachRecord) => ({ ...b, kindWord: text(lang, b.kind) });
export const heldView = (lang: Lang, h: HeldWriteOffRecord) => ({ ...h, value: rupees(h.valueMinor), stateWord: text(lang, h.state) });

/**
 * M08-FR-03: one handheld correction as the approver reads it — the quantity in its own unit (2.500 kg, never 2500), which
 * way it moves, the value at head office's cost or "not known", the warnings head office put on it, and whether THIS viewer
 * may decide it (never the person who asked — §28; head office refuses that too).
 */
export function adjustmentView(lang: Lang, r: AdjustmentRequestRow, viewerId: string | null, mayDecide: boolean) {
  const valueUnknown = r.governanceFlags.includes('value_unknown');
  const yours = viewerId !== null && r.requestedBy === viewerId;
  return {
    requestId: r.requestId, status: r.status,
    tone: r.status === 'pending' ? 'degraded' : r.status === 'posted' ? 'ok' : 'idle',
    heading: `${r.productId} — ${r.deltaMinor > 0 ? text(lang, 'adjMore') : text(lang, 'adjLess')} ${quantityLabel(Math.abs(r.deltaMinor), r.uom)} · ${text(lang, r.reasonCode)}`,
    where: `${text(lang, 'adjAt')} ${r.locationId}${r.binId === null || r.binId === '' ? '' : ` · ${text(lang, 'adjBin')} ${r.binId}`} · ${text(lang, 'adjAskedBy')} ${r.requestedBy} · ${r.at}`,
    value: `${text(lang, 'adjValue')}: ${valueUnknown ? text(lang, 'adjValueUnknown') : rupees(r.valueMinor)}`,
    note: r.note,
    flags: r.governanceFlags.filter((f) => f !== 'value_unknown').map((f) => text(lang, `flag_${f}`)),
    stateWord: r.status === 'pending' ? text(lang, 'adjWaiting') : `${text(lang, r.status === 'posted' ? 'adjPosted' : 'adjRejected')} · ${text(lang, 'adjDecidedBy')} ${r.decidedBy ?? ''}${r.decisionReason === null ? '' : ` — ${r.decisionReason}`}`,
    yours,
    canDecide: r.status === 'pending' && mayDecide && !yours,
  };
}

const enc = encodeURIComponent;
const isPlanView = (b: unknown): b is PlanView => b !== null && typeof b === 'object' && Array.isArray((b as PlanView).lines) && typeof (b as PlanView).plan === 'object';
const refusedOrLost = (a: HttpAnswer): Refused | { readonly result: 'lost_link' } => (a.result === 'lost_link' ? a : { result: 'refused', status: a.status, code: a.result === 'refused' ? a.code : 'unreadable_answer', whatHappened: a.result === 'refused' ? a.whatHappened : '' });

export interface NewPlanForm {
  readonly locationId: string;
  readonly productsText: string;
  readonly thresholdRupees: string;
  /** 'default' → the owner's default (frozenKinds left out); 'custom' → `kinds`; 'none' → an empty list. */
  readonly freeze: 'default' | 'custom' | 'none';
  readonly kinds: readonly string[];
  readonly note: string;
}

/** The plan body the route reads, or the word key of what is missing. */
export function planBody(form: NewPlanForm): { readonly body: Record<string, unknown> } | { readonly key: string } {
  const locationId = form.locationId.trim();
  if (locationId === '') return { key: 'needPlace' };
  const productIds = [...new Set(form.productsText.split(/[\n,]/).map((p) => p.trim()).filter((p) => p !== ''))];
  if (productIds.length === 0) return { key: 'needProducts' };
  const threshold = paiseOf(form.thresholdRupees);
  if (threshold === undefined) return { key: 'needThreshold' };
  if (form.freeze === 'custom' && form.kinds.length === 0) return { key: 'needKinds' };
  return {
    body: {
      locationId, productIds, recountThresholdMinor: threshold,
      ...(form.freeze === 'default' ? {} : { frozenKinds: form.freeze === 'none' ? [] : [...form.kinds] }),
      ...(form.note.trim() === '' ? {} : { note: form.note.trim() }),
    },
  };
}

const stamp = (): string => shopDateIn(new Date().toISOString(), servedShopZone()).replace(/-/g, ''); // OB-606: the SHOP's date, never this device's
const rand = (): string => Math.random().toString(36).slice(2, 7);

export function createCountPlansSession(viewer: CountPlanViewer | undefined, http: HeadOfficeHttp, ids: { plan(): string; count(planId: string, productId: string): string } = {
  plan: () => `cp-${stamp()}-${rand()}`,
  count: (planId, productId) => `${planId}-${productId}-${rand()}`,
}) {
  const perms = new Set(viewer?.permissions ?? []);
  const nobody = viewer === undefined;
  const may = {
    read: perms.has('inventory.count.plan'),
    plan: perms.has('inventory.count.plan'),
    count: perms.has('inventory.movement.append'),
    approve: perms.has('inventory.adjustment.approve'),
    /** M08-FR-03: read the handheld corrections (head office's `inventory.availability.read`) and decide them. */
    readAdjustments: perms.has('inventory.availability.read'),
    decideAdjustments: perms.has('inventory.adjustment.approve'),
  };
  const post = async (path: string, body: unknown): Promise<Outcome<{ readonly body: unknown }>> => {
    if (nobody) return { result: 'invalid', key: 'nobody' };
    const a = await http.post(path, body);
    return a.result === 'ok' ? { result: 'ok', body: a.body } : refusedOrLost(a);
  };
  return {
    nobody, userId: viewer?.userId ?? null, may,
    text, freezeWords, lineView, breachView, heldView, rupees,
    adjustmentView: (lang: Lang, r: AdjustmentRequestRow) => adjustmentView(lang, r, viewer?.userId ?? null, may.decideAdjustments),
    /** M08-FR-03: the corrections the handhelds asked for — waiting ones only, or every one (waiting first, newest first). */
    async adjustments(all = false): Promise<Outcome<{ readonly requests: readonly AdjustmentRequestRow[]; readonly pending: number }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      if (!may.readAdjustments) return { result: 'invalid', key: 'cannotReadAdj' };
      const a = await http.get(`/v1/inventory/adjustment-requests${all ? '' : '?status=pending'}`);
      if (a.result !== 'ok') return refusedOrLost(a);
      const b = a.body as { requests?: unknown; pending?: unknown };
      return { result: 'ok', requests: Array.isArray(b.requests) ? (b.requests as AdjustmentRequestRow[]) : [], pending: typeof b.pending === 'number' ? b.pending : 0 };
    },
    /** M08-FR-03: approve (head office posts the one compensating movement) or reject, with the reason a person reads later. */
    async decideAdjustment(requestId: string, decision: 'approved' | 'rejected', reason: string): Promise<Outcome<{ readonly body: unknown }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      if (!may.decideAdjustments) return { result: 'invalid', key: 'adjCannotDecide' };
      if (reason.trim() === '') return { result: 'invalid', key: 'needReason' };
      return post(`/v1/inventory/adjustment-requests/${enc(requestId)}/decide`, { decision, reason: reason.trim() });
    },
    async list(): Promise<Outcome<{ readonly plans: readonly CountPlanRecord[] }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      const a = await http.get('/v1/inventory/count-plans');
      if (a.result !== 'ok') return refusedOrLost(a);
      const plans = (a.body as { plans?: unknown }).plans;
      return { result: 'ok', plans: Array.isArray(plans) ? (plans as CountPlanRecord[]) : [] };
    },
    async read(planId: string): Promise<Outcome<{ readonly view: PlanView }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      const a = await http.get(`/v1/inventory/count-plans/${enc(planId)}`);
      if (a.result !== 'ok') return refusedOrLost(a);
      if (!isPlanView(a.body)) return { result: 'refused', status: a.status, code: 'unreadable_answer', whatHappened: '' };
      const v = a.body;
      return { result: 'ok', view: { ...v, freezeBreaches: Array.isArray(v.freezeBreaches) ? v.freezeBreaches : [], heldWriteOffs: Array.isArray(v.heldWriteOffs) ? v.heldWriteOffs : [] } };
    },
    async sheet(planId: string): Promise<Outcome<{ readonly sheet: SheetView }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      const a = await http.get(`/v1/inventory/count-plans/${enc(planId)}/sheet`);
      if (a.result !== 'ok') return refusedOrLost(a);
      return { result: 'ok', sheet: a.body as SheetView };
    },
    async create(form: NewPlanForm): Promise<Outcome<{ readonly planId: string; readonly body: unknown }>> {
      const made = planBody(form);
      if ('key' in made) return { result: 'invalid', key: made.key };
      const planId = ids.plan();
      const out = await post(`/v1/inventory/count-plans/${enc(planId)}`, made.body);
      return out.result === 'ok' ? { ...out, planId } : out;
    },
    open: (planId: string) => post(`/v1/inventory/count-plans/${enc(planId)}/open`, {}),
    async count(planId: string, input: { readonly productId: string; readonly locationId: string; readonly uom: string; readonly countedText: string; readonly recountOf: string | null }): Promise<Outcome<{ readonly body: unknown }>> {
      const s = input.countedText.trim();
      const uom = input.uom.trim() === '' ? 'EA' : input.uom.trim();
      // OB-31 (Round 4b): counted in the item's own unit — "2.5" kg is 2500 g — through the one shared reading; a unit this
      // system does not know (a pack level) keeps the whole-number count head office converts.
      const counted = normaliseUom(uom) === undefined ? (/^\d+$/.test(s) ? Number(s) : undefined) : typedQuantityMinor(s, uom, { allowZero: true });
      if (counted === undefined) return { result: 'invalid', key: 'needQty' };
      const countId = ids.count(planId, input.productId);
      return post(`/v1/inventory/count-plans/${enc(planId)}/counts/${enc(countId)}`, {
        productId: input.productId, locationId: input.locationId, uom, countedMinor: counted,
        ...(input.recountOf === null ? {} : { recountOf: input.recountOf }),
      });
    },
    async cause(planId: string, countId: string, causeCode: string, note: string): Promise<Outcome<{ readonly body: unknown }>> {
      if (!(CAUSES as readonly string[]).includes(causeCode) || note.trim() === '') return { result: 'invalid', key: 'needCause' };
      return post(`/v1/inventory/count-plans/${enc(planId)}/counts/${enc(countId)}/cause`, { causeCode, note: note.trim() });
    },
    async approve(planId: string, reason: string): Promise<Outcome<{ readonly body: unknown }>> {
      if (reason.trim() === '') return { result: 'invalid', key: 'needReason' };
      return post(`/v1/inventory/count-plans/${enc(planId)}/approve`, { reason: reason.trim() });
    },
    async cancel(planId: string, reason: string): Promise<Outcome<{ readonly body: unknown }>> {
      if (reason.trim() === '') return { result: 'invalid', key: 'needReason' };
      return post(`/v1/inventory/count-plans/${enc(planId)}/cancel`, { reason: reason.trim() });
    },
    /** The status line for an outcome, in the reader's language — head office's own words when it refused. */
    say(lang: Lang, out: Outcome<unknown>, good = 'saved'): { readonly tone: 'good' | 'err'; readonly words: string } {
      if (out.result === 'ok') return { tone: 'good', words: text(lang, good) };
      if (out.result === 'lost_link') return { tone: 'err', words: text(lang, 'unreachable') };
      if (out.result === 'invalid') return { tone: 'err', words: text(lang, out.key) };
      return { tone: 'err', words: refusalWords(lang, out) }; // U0 · G10: what happened · nothing was changed · the next safe action
    },
  };
}

export type CountPlansSession = ReturnType<typeof createCountPlansSession>;
