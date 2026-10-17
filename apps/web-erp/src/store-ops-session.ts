// Store operations screens — the tested, DOM-free session behind four simple pages (OB-154 "A", owner, 16 Oct 2026, in
// writing: "Add screens before pilot"):
//
//   • Food-safety checks (D-6)      — today's checks: due, MISSED and done, and record one with its reading, each item
//                                      pass/fail and — on any failure — the corrective action taken;
//   • Price mismatches (D-7)        — the ageing exception report in the owner's bands (OB-163: under 1 day, 1–3, 3–7,
//                                      over 7 days);
//   • Store tasks (D-8)             — the manager's board: every task worst first, and assign one to a named person with a
//                                      deadline; and "My tasks" for staff, who complete their own with evidence (OB-158:
//                                      only the assignee completes);
//   • Waste analytics (D-5)         — what was lost, by product, by department and by reason, for a window.
//
// Every rule is head office's (food-safety.ts, price-integrity-ageing.ts, assigned-tasks.ts, waste-analytics.ts): a
// failure with no corrective action, a task completed by someone else, a task with no evidence — each is refused THERE,
// and this session hands the refusal back in head office's own words. The session refuses only the cheap things before a
// POST (a blank field, a reading that is not a number, a failure with no action written) and never writes on open. Each
// act carries its own idempotency key, made once per click. The author of every fact is the signed-in person — head
// office takes it from the session; the page never names anyone as the author. What a person may do only shapes what a
// page OFFERS; head office re-checks every act.

import type { ViewerIdentity } from './browser-entry';

export type Lang = 'en' | 'ta';

/** Head office answered (`ok`), refused in its own words, the page refused before sending, or nobody answered. */
export type Outcome<T> =
  | { readonly result: 'ok'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string }
  | { readonly result: 'invalid'; readonly why: CopyKey }
  | { readonly result: 'lost_link' };

// ── what head office answers (the shapes the pages read) ────────────────────────────────────────────────────

export interface FoodSafetyCheckDef {
  readonly checkId: string; readonly branchId: string; readonly title: string; readonly kind: 'temperature' | 'equipment' | 'cleaning' | 'receiving';
  readonly minTenthsC?: number; readonly maxTenthsC?: number; readonly items: readonly { readonly itemId: string; readonly label: string }[]; readonly active: boolean;
}
export interface FoodSafetySlot {
  readonly checkId: string; readonly title: string; readonly kind: string; readonly branchId: string; readonly slotDueAt: string;
  readonly state: 'done' | 'done_failed' | 'done_late' | 'due' | 'missed' | 'upcoming';
  readonly performedBy?: string; readonly correctiveAction?: string; readonly escalateTo?: string; readonly detail: string;
}
export interface FoodSafetyBoard {
  readonly slots: readonly FoodSafetySlot[]; readonly missedCount: number; readonly failedCount: number; readonly checks: readonly FoodSafetyCheckDef[];
  readonly receiving: readonly { readonly recordId: string; readonly checkId: string; readonly subjectRef?: string; readonly outcome: string; readonly performedBy: string; readonly performedAt: string }[];
}
export interface PriceException {
  readonly productId: string; readonly surface: string; readonly kind: string; readonly recordMinor: number; readonly surfaceMinor?: number;
  readonly differenceMinor: number; readonly openSince: string; readonly ageDays: number; readonly band: string; readonly evidence: string; readonly detail: string;
}
export interface PriceAgeingReport {
  readonly exceptions: readonly PriceException[]; readonly byBand: readonly { readonly band: string; readonly count: number }[];
  readonly oldestOpenSince: string | null; readonly productsChecked: number; readonly detail: string;
}
export interface StoreTask {
  readonly taskId: string; readonly branchId: string; readonly title: string; readonly assignedTo: string; readonly assignedBy: string;
  readonly dueAt: string; readonly accountableDueAt?: string; readonly missedDeadlines?: readonly string[];
  readonly critical: boolean; readonly evidenceRequired: boolean; readonly steps: readonly { readonly stepId: string; readonly label: string }[];
  readonly status: 'pending' | 'overdue' | 'escalated' | 'done' | 'done_late'; readonly overdueByMinutes?: number; readonly detail: string;
  readonly completion?: { readonly doneBy: string; readonly doneAt: string; readonly lateByMinutes: number; readonly evidenceRefs: readonly string[] };
}
export interface WasteLine { readonly key: string; readonly valueMinor: number; readonly qty: number; readonly events: number; readonly shareBps: number }
export interface WasteBreakdown {
  readonly events: number; readonly totalValueMinor: number; readonly bySku: readonly WasteLine[]; readonly byDepartment: readonly WasteLine[]; readonly byReason: readonly WasteLine[];
  readonly unclassified: { readonly events: number; readonly reasonsSeen: readonly string[] };
}
export interface WasteReport { readonly from: string; readonly to: string; readonly writeOffs: WasteBreakdown; readonly wasteRecords: WasteBreakdown }

// ── the words ───────────────────────────────────────────────────────────────────────────────────────────────

export type CopyKey = keyof typeof STORE_OPS_COPY.en;

export const STORE_OPS_COPY = {
  en: {
    lang: 'தமிழ்',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.', reading: 'Reading from head office…',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read this.',
    needAll: 'Fill in every field first. Nothing was sent.', badNumber: 'Write the reading as a number, for example 3.5. Nothing was sent.',
    badDate: 'Pick the dates. Nothing was sent.', needAction: 'Something failed — write down what was done about it. Nothing was sent.',
    needEvidence: 'This task needs its evidence (a photo or document reference). Nothing was sent.', needSteps: 'Tick every step first. Nothing was sent.',
    // food safety
    fsTitle: 'Food-safety checks', fsLead: 'Today\'s checks: what is due now, what was MISSED, and what was done. Record a check in your own name; a failed check needs the corrective action written down.',
    fsMissed: 'Missed', fsDue: 'Due now', fsDone: 'Done', fsFailed: 'Failed (action written)',
    fsColCheck: 'Check', fsColDue: 'Due at', fsColState: 'Where it stands', fsColWho: 'Who',
    stDone: 'Done', stDoneFailed: 'Failed — action taken', stDoneLate: 'Done late', stDue: 'Due now', stMissed: 'MISSED', stUpcoming: 'Later today',
    fsNone: 'No check is scheduled for today.', fsRecord: 'Record this check', fsReading: 'Reading (°C)', fsPass: 'Pass', fsFail: 'Fail',
    fsAction: 'Corrective action taken (needed if anything failed)', fsSave: 'Record the check', fsSaved: 'Recorded in your name.',
    fsReadOnly: 'You can read the checks; recording one needs the facilities record permission.', fsEscalated: 'escalated to',
    fsReceiving: 'Delivery checklists today', fsDelivery: 'Delivery (goods receipt number)', fsNoReceiving: 'No delivery checklist recorded today.',
    // price
    prTitle: 'Price mismatches', prLead: 'Where a shelf label, the app or the till disagrees with the shop\'s own price, and for how long. A shelf or app showing LESS than the price, or a till charging MORE, comes first.',
    prBranch: 'Store', prShow: 'Show the report', prNone: 'No price mismatch is open at this store.', prChecked: '{n} product(s) checked',
    prColProduct: 'Product', prColWhere: 'Where', prColRecord: 'Shop\'s price', prColShown: 'Shown / charged', prColSince: 'Open since', prColBand: 'How long',
    bandUnder1: 'Under 1 day', band1to3: '1–3 days', band3to7: '3–7 days', bandOver7: 'Over 7 days',
    sfShelf: 'Shelf label', sfEsl: 'Electronic label', sfApp: 'App', sfKiosk: 'Kiosk', sfWebsite: 'Website', sfPos: 'Till',
    kShownBelow: 'shows LESS than the price — honour it', kShownAbove: 'shows more than the price', kChargedAbove: 'charged MORE than the price', kChargedBelow: 'charged less than the price', kNever: 'never checked',
    // tasks
    tkTitle: 'Store tasks', tkLead: 'Every task assigned to a named person, worst first: a critical task past its deadline is escalated to whoever assigned it. A re-assigned task keeps the deadline it missed.',
    tkEscalated: 'Escalated', tkOverdue: 'Overdue', tkPending: 'To do', tkDoneLate: 'Done late', tkDone: 'Done on time',
    tkColTask: 'Task', tkColWho: 'Assigned to', tkColDue: 'Deadline', tkColState: 'Where it stands',
    tkNone: 'No task has been assigned.', tkAssign: 'Assign a task', tkTask: 'What to do', tkPerson: 'Who does it (their sign-in id)', tkBranch: 'Store',
    tkDueAt: 'Deadline', tkCritical: 'Critical — escalate if late', tkEvidence: 'Needs evidence (a photo or document)', tkSteps: 'Steps (one per line, optional)',
    tkSave: 'Assign it', tkSaved: 'Assigned in your name.', tkReadOnly: 'You can read the board; assigning a task needs the rota permission.',
    tkMissedWas: 'missed its deadline of', tkLate: '{m} minute(s) late',
    myTitle: 'My tasks', myLead: 'The tasks assigned to you. Only you can complete them, in your own sign-in, with every step ticked and the evidence the task asks for.',
    myNone: 'Nothing is assigned to you.', myEvidence: 'Evidence (photo or document reference)', myNote: 'Note (optional)', myDone: 'Mark done', mySaved: 'Completed in your name.',
    // waste
    waTitle: 'Waste analytics', waLead: 'What the shop lost, by product, by department and by reason. Write-offs and waste records are shown side by side, never added together — one loss is often recorded both ways.',
    waFrom: 'From', waTo: 'To', waShow: 'Show', waWriteOffs: 'Write-offs', waRecords: 'Waste records', waTotal: 'Total lost', waEvents: '{n} event(s)',
    waByReason: 'By reason', waByDept: 'By department', waBySku: 'By product', waColWhat: 'What', waColValue: 'Value', waColQty: 'Quantity', waColShare: 'Share',
    waUnclassified: '{n} event(s) carry a reason that is not on the list — counted, never dropped.', waNone: 'Nothing was lost in this window.',
    rsExpiry: 'Past its date', rsDamage: 'Damaged', rsShrinkage: 'Missing (shrinkage)', rsPreparation: 'Lost in preparation', rsCustomerReturn: 'Customer return, not saleable', rsRecall: 'Recalled',
    rsUnclassified: 'Not on the list', rsNoDept: 'In no department',
  },
  ta: {
    lang: 'English',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கால் இதைப் படிக்க முடியாது.',
    needAll: 'முதலில் எல்லாப் புலங்களையும் நிரப்புங்கள். எதுவும் அனுப்பப்படவில்லை.', badNumber: 'அளவீட்டை எண்ணாக எழுதுங்கள், உதா. 3.5. எதுவும் அனுப்பப்படவில்லை.',
    badDate: 'தேதிகளைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.', needAction: 'ஏதோ தோல்வியடைந்தது — அதற்கு என்ன செய்யப்பட்டது என்று எழுதுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    needEvidence: 'இந்தப் பணிக்குச் சான்று தேவை (புகைப்படம் அல்லது ஆவணக் குறிப்பு). எதுவும் அனுப்பப்படவில்லை.', needSteps: 'முதலில் ஒவ்வொரு படியையும் குறியுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    fsTitle: 'உணவுப் பாதுகாப்புச் சோதனைகள்', fsLead: 'இன்றைய சோதனைகள்: இப்போது செய்ய வேண்டியவை, தவறியவை, செய்யப்பட்டவை. உங்கள் பெயரில் ஒரு சோதனையைப் பதிவு செய்யுங்கள்; தோல்வியடைந்த சோதனைக்கு எடுத்த திருத்த நடவடிக்கையை எழுத வேண்டும்.',
    fsMissed: 'தவறியவை', fsDue: 'இப்போது செய்ய வேண்டியவை', fsDone: 'செய்யப்பட்டவை', fsFailed: 'தோல்வி (நடவடிக்கை எழுதப்பட்டது)',
    fsColCheck: 'சோதனை', fsColDue: 'நேரம்', fsColState: 'நிலை', fsColWho: 'யார்',
    stDone: 'செய்யப்பட்டது', stDoneFailed: 'தோல்வி — நடவடிக்கை எடுக்கப்பட்டது', stDoneLate: 'தாமதமாகச் செய்யப்பட்டது', stDue: 'இப்போது செய்ய வேண்டும்', stMissed: 'தவறியது', stUpcoming: 'இன்று பின்னர்',
    fsNone: 'இன்று எந்தச் சோதனையும் திட்டமிடப்படவில்லை.', fsRecord: 'இந்தச் சோதனையைப் பதிவு செய்', fsReading: 'அளவீடு (°C)', fsPass: 'சரி', fsFail: 'தோல்வி',
    fsAction: 'எடுத்த திருத்த நடவடிக்கை (ஏதாவது தோல்வியடைந்தால் தேவை)', fsSave: 'சோதனையைப் பதிவு செய்', fsSaved: 'உங்கள் பெயரில் பதிவு செய்யப்பட்டது.',
    fsReadOnly: 'நீங்கள் சோதனைகளைப் படிக்கலாம்; பதிவு செய்ய வசதிகள் பதிவு அனுமதி தேவை.', fsEscalated: 'தெரிவிக்கப்பட்டவர்',
    fsReceiving: 'இன்றைய சரக்கு வரவுச் சோதனைகள்', fsDelivery: 'சரக்கு வரவு (GRN எண்)', fsNoReceiving: 'இன்று சரக்கு வரவுச் சோதனை எதுவும் பதிவு செய்யப்படவில்லை.',
    prTitle: 'விலை முரண்பாடுகள்', prLead: 'அடுக்கு லேபிள், செயலி அல்லது கல்லா கடையின் சொந்த விலையுடன் முரண்படும் இடங்களும், எவ்வளவு காலம் என்பதும். விலையை விடக் குறைவாகக் காட்டும் அடுக்கு/செயலி, அல்லது அதிகமாக வசூலிக்கும் கல்லா முதலில்.',
    prBranch: 'கடை', prShow: 'அறிக்கையைக் காட்டு', prNone: 'இந்தக் கடையில் எந்த விலை முரண்பாடும் திறந்திருக்கவில்லை.', prChecked: '{n} பொருள்(கள்) சரிபார்க்கப்பட்டன',
    prColProduct: 'பொருள்', prColWhere: 'எங்கே', prColRecord: 'கடையின் விலை', prColShown: 'காட்டியது / வசூலித்தது', prColSince: 'முதல் திறந்துள்ளது', prColBand: 'எவ்வளவு காலம்',
    bandUnder1: '1 நாளுக்குக் குறைவு', band1to3: '1–3 நாட்கள்', band3to7: '3–7 நாட்கள்', bandOver7: '7 நாட்களுக்கு மேல்',
    sfShelf: 'அடுக்கு லேபிள்', sfEsl: 'மின்னணு லேபிள்', sfApp: 'செயலி', sfKiosk: 'கியாஸ்க்', sfWebsite: 'இணையதளம்', sfPos: 'கல்லா',
    kShownBelow: 'விலையை விடக் குறைவாகக் காட்டுகிறது — அதை மதிக்கவும்', kShownAbove: 'விலையை விட அதிகமாகக் காட்டுகிறது', kChargedAbove: 'விலையை விட அதிகமாக வசூலித்தது', kChargedBelow: 'விலையை விடக் குறைவாக வசூலித்தது', kNever: 'ஒருபோதும் சரிபார்க்கப்படவில்லை',
    tkTitle: 'கடைப் பணிகள்', tkLead: 'பெயரிடப்பட்ட நபருக்கு ஒதுக்கப்பட்ட ஒவ்வொரு பணியும், மோசமானது முதலில்: கெடுவைத் தாண்டிய முக்கியப் பணி ஒதுக்கியவருக்குத் தெரிவிக்கப்படும். மீண்டும் ஒதுக்கப்பட்ட பணி தவறிய கெடுவை வைத்திருக்கும்.',
    tkEscalated: 'தெரிவிக்கப்பட்டது', tkOverdue: 'கெடு தாண்டியது', tkPending: 'செய்ய வேண்டியது', tkDoneLate: 'தாமதமாக முடிந்தது', tkDone: 'நேரத்தில் முடிந்தது',
    tkColTask: 'பணி', tkColWho: 'யாருக்கு', tkColDue: 'கெடு', tkColState: 'நிலை',
    tkNone: 'எந்தப் பணியும் ஒதுக்கப்படவில்லை.', tkAssign: 'ஒரு பணியை ஒதுக்கு', tkTask: 'என்ன செய்ய வேண்டும்', tkPerson: 'யார் செய்வார் (அவரது உள்நுழைவு அடையாளம்)', tkBranch: 'கடை',
    tkDueAt: 'கெடு', tkCritical: 'முக்கியம் — தாமதமானால் தெரிவி', tkEvidence: 'சான்று தேவை (புகைப்படம் அல்லது ஆவணம்)', tkSteps: 'படிகள் (ஒரு வரிக்கு ஒன்று, விருப்பம்)',
    tkSave: 'ஒதுக்கு', tkSaved: 'உங்கள் பெயரில் ஒதுக்கப்பட்டது.', tkReadOnly: 'நீங்கள் பலகையைப் படிக்கலாம்; பணியை ஒதுக்க பணி முறை அனுமதி தேவை.',
    tkMissedWas: 'தவறிய கெடு', tkLate: '{m} நிமிடம் தாமதம்',
    myTitle: 'என் பணிகள்', myLead: 'உங்களுக்கு ஒதுக்கப்பட்ட பணிகள். நீங்கள் மட்டுமே, உங்கள் உள்நுழைவில், ஒவ்வொரு படியையும் குறித்து, கேட்கப்பட்ட சான்றுடன் முடிக்க முடியும்.',
    myNone: 'உங்களுக்கு எதுவும் ஒதுக்கப்படவில்லை.', myEvidence: 'சான்று (புகைப்படம் அல்லது ஆவணக் குறிப்பு)', myNote: 'குறிப்பு (விருப்பம்)', myDone: 'முடிந்தது எனக் குறி', mySaved: 'உங்கள் பெயரில் முடிக்கப்பட்டது.',
    waTitle: 'வீண் பகுப்பாய்வு', waLead: 'கடை இழந்தவை — பொருள், துறை, காரணம் வாரியாக. தள்ளுபடிகளும் வீண் பதிவுகளும் அருகருகே காட்டப்படும், ஒருபோதும் கூட்டப்படாது — ஒரு இழப்பு பெரும்பாலும் இரண்டு வழிகளிலும் பதிவாகும்.',
    waFrom: 'முதல்', waTo: 'வரை', waShow: 'காட்டு', waWriteOffs: 'தள்ளுபடிகள்', waRecords: 'வீண் பதிவுகள்', waTotal: 'மொத்த இழப்பு', waEvents: '{n} நிகழ்வு(கள்)',
    waByReason: 'காரணம் வாரியாக', waByDept: 'துறை வாரியாக', waBySku: 'பொருள் வாரியாக', waColWhat: 'எது', waColValue: 'மதிப்பு', waColQty: 'அளவு', waColShare: 'பங்கு',
    waUnclassified: '{n} நிகழ்வு(கள்) பட்டியலில் இல்லாத காரணத்தைக் கொண்டுள்ளன — எண்ணப்பட்டன, விடப்படவில்லை.', waNone: 'இந்தக் காலத்தில் எதுவும் இழக்கப்படவில்லை.',
    rsExpiry: 'காலாவதியானது', rsDamage: 'சேதமடைந்தது', rsShrinkage: 'காணாமல் போனது', rsPreparation: 'தயாரிப்பில் வீணானது', rsCustomerReturn: 'வாடிக்கையாளர் திருப்பியது, விற்க முடியாது', rsRecall: 'திரும்பப் பெறப்பட்டது',
    rsUnclassified: 'பட்டியலில் இல்லை', rsNoDept: 'எந்தத் துறையிலும் இல்லை',
  },
} as const;

export const COPY_KEYS = Object.keys(STORE_OPS_COPY.en) as CopyKey[];

/** One word in the reader's language, with `{name}` slots filled. */
export function wordsFor(lang: Lang, key: CopyKey, slots: Readonly<Record<string, string | number>> = {}): string {
  let text: string = STORE_OPS_COPY[lang][key] ?? STORE_OPS_COPY.en[key];
  for (const [k, v] of Object.entries(slots)) text = text.replace(`{${k}}`, String(v));
  return text;
}

/** How a refusal, a page-side refusal or a lost link reads to a person (a success reads its own word). */
export function outcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'refused') return `${wordsFor(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return wordsFor(lang, out.why);
  if (out.result === 'lost_link') return wordsFor(lang, 'unreachable');
  return '';
}

const SLOT_WORD: Readonly<Record<FoodSafetySlot['state'], CopyKey>> = { done: 'stDone', done_failed: 'stDoneFailed', done_late: 'stDoneLate', due: 'stDue', missed: 'stMissed', upcoming: 'stUpcoming' };
const TASK_WORD: Readonly<Record<StoreTask['status'], CopyKey>> = { escalated: 'tkEscalated', overdue: 'tkOverdue', pending: 'tkPending', done_late: 'tkDoneLate', done: 'tkDone' };
const BAND_WORD: Readonly<Record<string, CopyKey>> = { 'under 1 day': 'bandUnder1', '1-3 days': 'band1to3', '3-7 days': 'band3to7', 'over 7 days': 'bandOver7' };
const SURFACE_WORD: Readonly<Record<string, CopyKey>> = { shelf_label: 'sfShelf', esl: 'sfEsl', app: 'sfApp', kiosk: 'sfKiosk', website: 'sfWebsite', pos: 'sfPos' };
const KIND_WORD: Readonly<Record<string, CopyKey>> = { shown_below_record: 'kShownBelow', shown_above_record: 'kShownAbove', charged_above_record: 'kChargedAbove', charged_below_record: 'kChargedBelow', never_observed: 'kNever' };
const REASON_WORD: Readonly<Record<string, CopyKey>> = { expiry: 'rsExpiry', damage: 'rsDamage', shrinkage: 'rsShrinkage', preparation: 'rsPreparation', customer_return: 'rsCustomerReturn', recall: 'rsRecall', unclassified: 'rsUnclassified', 'in no department': 'rsNoDept' };

/** The word for a slot's state, and whether it needs a person (a word and a tone — never colour alone). */
export function slotWords(lang: Lang, s: Pick<FoodSafetySlot, 'state'>): { readonly label: string; readonly tone: 'ok' | 'degraded' | 'error' | 'idle'; readonly icon: string } {
  const tone = s.state === 'missed' ? 'error' : s.state === 'due' || s.state === 'done_failed' || s.state === 'done_late' ? 'degraded' : s.state === 'upcoming' ? 'idle' : 'ok';
  return { label: wordsFor(lang, SLOT_WORD[s.state]), tone, icon: tone === 'error' ? '✕' : tone === 'degraded' ? '⚠' : tone === 'idle' ? '…' : '✓' };
}
export function taskWords(lang: Lang, t: Pick<StoreTask, 'status'>): { readonly label: string; readonly tone: 'ok' | 'degraded' | 'error' | 'idle'; readonly icon: string } {
  const tone = t.status === 'escalated' ? 'error' : t.status === 'overdue' || t.status === 'done_late' ? 'degraded' : t.status === 'pending' ? 'idle' : 'ok';
  return { label: wordsFor(lang, TASK_WORD[t.status]), tone, icon: tone === 'error' ? '✕' : tone === 'degraded' ? '⚠' : tone === 'idle' ? '…' : '✓' };
}
/** OB-163: the owner's four bands, in his words. An unknown band is shown as head office named it. */
export const bandWords = (lang: Lang, band: string): string => (BAND_WORD[band] === undefined ? band : wordsFor(lang, BAND_WORD[band]!));
export const surfaceWords = (lang: Lang, surface: string): string => (SURFACE_WORD[surface] === undefined ? surface : wordsFor(lang, SURFACE_WORD[surface]!));
export const kindWords = (lang: Lang, kind: string): string => (KIND_WORD[kind] === undefined ? kind : wordsFor(lang, KIND_WORD[kind]!));
export const reasonWords = (lang: Lang, key: string): string => (REASON_WORD[key] === undefined ? key : wordsFor(lang, REASON_WORD[key]!));
export const OB163_BANDS: readonly string[] = Object.freeze(['under 1 day', '1-3 days', '3-7 days', 'over 7 days']);
export const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;
/** A share in basis points as a percentage a person reads. */
export const percent = (bps: number): string => `${(bps / 100).toFixed(1)}%`;

/** Today's food-safety board split the way the page shows it: missed, due, done (done, failed, late), later. */
export function splitToday(board: FoodSafetyBoard): {
  readonly missed: readonly FoodSafetySlot[]; readonly due: readonly FoodSafetySlot[]; readonly done: readonly FoodSafetySlot[]; readonly later: readonly FoodSafetySlot[];
  readonly failed: number;
} {
  const by = (states: readonly FoodSafetySlot['state'][]) => board.slots.filter((s) => states.includes(s.state));
  return { missed: by(['missed']), due: by(['due']), done: by(['done', 'done_failed', 'done_late']), later: by(['upcoming']), failed: by(['done_failed']).length };
}

/** The start of the reader's own day (local midnight), as an ISO time — "today" on the food-safety board. */
export const startOfToday = (now: Date = new Date()): string => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

export interface CheckRecordForm {
  readonly checkId: string;
  /** The slot being answered; absent on a receiving checklist (which names its delivery). */
  readonly slotDueAt?: string;
  readonly subjectRef?: string;
  /** The reading as typed, in °C (e.g. "3.5"); blank when the check takes none. */
  readonly readingC: string;
  readonly itemResults: Readonly<Record<string, 'pass' | 'fail' | ''>>;
  readonly correctiveAction: string;
}

export interface AssignForm {
  readonly branchId: string; readonly title: string; readonly assignedTo: string; readonly dueAt: string;
  readonly critical: boolean; readonly evidenceRequired: boolean; readonly steps: string;
}

export interface StoreOpsSession {
  /** What this person may do — shapes what the pages OFFER; head office re-checks every act. */
  readonly may: {
    readonly named: boolean; readonly readChecks: boolean; readonly recordChecks: boolean; readonly readPrices: boolean;
    readonly readTasks: boolean; readonly assignTasks: boolean; readonly ownTasks: boolean; readonly readWaste: boolean;
  };
  foodSafetyToday(): Promise<Outcome<FoodSafetyBoard>>;
  recordCheck(check: FoodSafetyCheckDef, form: CheckRecordForm): Promise<Outcome<{ readonly outcome: string; readonly late: boolean }>>;
  priceAgeing(branchId: string): Promise<Outcome<PriceAgeingReport>>;
  taskBoard(): Promise<Outcome<{ readonly tasks: readonly StoreTask[] }>>;
  assignTask(form: AssignForm): Promise<Outcome<{ readonly taskId: string }>>;
  myTasks(): Promise<Outcome<{ readonly tasks: readonly StoreTask[] }>>;
  completeTask(task: StoreTask, form: { readonly evidenceRef: string; readonly stepsDone: readonly string[]; readonly note: string }): Promise<Outcome<{ readonly lateByMinutes: number }>>;
  wasteAnalytics(from: string, to: string): Promise<Outcome<WasteReport>>;
}

const blank = (s: string | undefined): boolean => s === undefined || s.trim() === '';
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

export function createStoreOpsSession(input: {
  readonly viewer: ViewerIdentity | undefined;
  readonly fetch?: typeof globalThis.fetch;
  /** A fresh idempotency key for one click. */
  readonly newKey?: () => string;
  /** A fresh record / task id (the record's own name at head office). */
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
}): StoreOpsSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = {
    named,
    readChecks: named && perms.has('facilities.overdue.read'),
    recordChecks: named && perms.has('facilities.task.record'),
    readPrices: named && perms.has('price.integrity.audit'),
    readTasks: named && perms.has('workforce.task.read'),
    assignTasks: named && perms.has('workforce.roster.manage'),
    ownTasks: named && perms.has('workforce.task.complete.own'),
    readWaste: named && perms.has('waste.view'),
  };
  const rand = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const newKey = input.newKey ?? (() => `ops-${rand()}`);
  const newId = input.newId ?? ((prefix: string) => `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${rand().slice(0, 8)}`);
  const now = input.now ?? (() => new Date());
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Outcome<T>> {
    try {
      const res = await http(path, {
        method, credentials: 'same-origin',
        headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': newKey() } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string };
        return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` };
      }
      return { result: 'ok', value: json as T };
    } catch {
      return { result: 'lost_link' };
    }
  }
  const enc = encodeURIComponent;
  const nobody = { result: 'invalid', why: 'nobody' } as const;
  const cannot = { result: 'invalid', why: 'cannotRead' } as const;

  return {
    may,
    foodSafetyToday: () => (!named ? Promise.resolve(nobody) : !may.readChecks ? Promise.resolve(cannot)
      : call('GET', `/v1/facilities/food-safety/status?from=${enc(startOfToday(now()))}`)),
    recordCheck: async (check, f) => {
      if (!named) return nobody;
      const reading = f.readingC.trim();
      let readingTenthsC: number | undefined;
      if (reading !== '') {
        if (!/^-?\d+(\.\d)?$/.test(reading)) return { result: 'invalid', why: 'badNumber' };
        readingTenthsC = Math.round(Number(reading) * 10);
      }
      if (check.kind === 'temperature' && readingTenthsC === undefined) return { result: 'invalid', why: 'badNumber' };
      const results: Record<string, 'pass' | 'fail'> = {};
      for (const item of check.items) {
        const r = f.itemResults[item.itemId];
        if (r !== 'pass' && r !== 'fail') return { result: 'invalid', why: 'needAll' };
        results[item.itemId] = r;
      }
      // The cheap half of head office's rule, before a POST: a failure needs the action written down.
      const outside = readingTenthsC !== undefined && check.minTenthsC !== undefined && check.maxTenthsC !== undefined
        && (readingTenthsC < check.minTenthsC || readingTenthsC > check.maxTenthsC);
      if ((outside || Object.values(results).includes('fail')) && blank(f.correctiveAction)) return { result: 'invalid', why: 'needAction' };
      if (check.kind === 'receiving' && blank(f.subjectRef)) return { result: 'invalid', why: 'needAll' };
      const out = await call<{ record: { outcome: string; late: boolean } }>('POST', `/v1/facilities/food-safety/checks/${enc(check.checkId)}/records/${enc(newId('fsr'))}`, {
        ...(check.kind === 'receiving' ? { subjectRef: f.subjectRef!.trim() } : { slotDueAt: f.slotDueAt }),
        ...(readingTenthsC === undefined ? {} : { readingTenthsC }),
        ...(check.items.length === 0 ? {} : { itemResults: results }),
        ...(blank(f.correctiveAction) ? {} : { correctiveAction: f.correctiveAction.trim() }),
      });
      return out.result === 'ok' ? { result: 'ok', value: { outcome: out.value.record.outcome, late: out.value.record.late } } : out;
    },
    priceAgeing: async (branchId) => {
      if (!named) return nobody;
      if (!may.readPrices) return cannot;
      if (blank(branchId)) return { result: 'invalid', why: 'needAll' };
      return call('GET', `/v1/pricing/integrity/ageing?branchId=${enc(branchId.trim())}`);
    },
    taskBoard: () => (!named ? Promise.resolve(nobody) : !may.readTasks ? Promise.resolve(cannot) : call('GET', '/v1/hr/workforce/assigned-tasks')),
    assignTask: async (f) => {
      if (!named) return nobody;
      if (blank(f.branchId) || blank(f.title) || blank(f.assignedTo) || blank(f.dueAt) || Number.isNaN(Date.parse(f.dueAt))) return { result: 'invalid', why: 'needAll' };
      const steps = f.steps.split('\n').map((s) => s.trim()).filter((s) => s !== '').map((label, i) => ({ stepId: `s${i + 1}`, label }));
      const taskId = newId('task');
      const out = await call('POST', `/v1/hr/workforce/assigned-tasks/${enc(taskId)}`, {
        branchId: f.branchId.trim(), title: f.title.trim(), assignedTo: f.assignedTo.trim(), dueAt: new Date(f.dueAt).toISOString(),
        critical: f.critical, evidenceRequired: f.evidenceRequired, steps,
      });
      return out.result === 'ok' ? { result: 'ok', value: { taskId } } : out;
    },
    myTasks: () => (!named ? Promise.resolve(nobody) : !may.ownTasks ? Promise.resolve(cannot) : call('GET', '/v1/hr/workforce/my-tasks')),
    completeTask: async (task, f) => {
      if (!named) return nobody;
      if (task.steps.some((s) => !f.stepsDone.includes(s.stepId))) return { result: 'invalid', why: 'needSteps' };
      if (task.evidenceRequired && blank(f.evidenceRef)) return { result: 'invalid', why: 'needEvidence' };
      const out = await call<{ completion: { lateByMinutes: number } }>('POST', `/v1/hr/workforce/assigned-tasks/${enc(task.taskId)}/complete`, {
        stepsDone: [...f.stepsDone], evidenceRefs: blank(f.evidenceRef) ? [] : [f.evidenceRef.trim()], ...(blank(f.note) ? {} : { note: f.note.trim() }),
      });
      return out.result === 'ok' ? { result: 'ok', value: { lateByMinutes: out.value.completion.lateByMinutes } } : out;
    },
    wasteAnalytics: async (from, to) => {
      if (!named) return nobody;
      if (!may.readWaste) return cannot;
      if (!isDay(from) || !isDay(to) || from > to) return { result: 'invalid', why: 'badDate' };
      return call('GET', `/v1/waste/analytics?from=${enc(from)}&to=${enc(to)}`);
    },
  };
}
