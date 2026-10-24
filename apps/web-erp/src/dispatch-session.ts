// The Dispatch office page — waves from confirmed orders, the day's routes, the proofs at each door and the cash
// (M19-FR-01/03/04 · WF-14 · WF-15 · D09-FR-05/06 · OB-294 · OB-300 · OB-313 · P-07 · P-08). A tested, DOM-free session.
//
// Everything is asked of head office on a click; nothing is read on open and nothing is a zero that was not counted. A
// number the owner has not entered is "not set", in words. Each write is a person's explicit act: build a wave and give it
// to a picker; plan the day; hand a route to its driver; take a driver's routes back (with the reason); approve an order
// held below the owner's contribution threshold (with the reason); propose, approve and pay a fleet settlement; enter the
// owner's numbers. Head office re-checks every one of them — this only shapes what the page offers.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export interface WaveCandidate {
  readonly orderId: string; readonly fulfilment: 'delivery' | 'pickup'; readonly lineCount: number; readonly placedAt: string;
  readonly slot: { readonly startsAt: string; readonly endsAt: string } | null; readonly standing: string; readonly waveId?: string;
}
export interface Candidates { readonly storeId: string; readonly ready: readonly WaveCandidate[]; readonly held: readonly WaveCandidate[]; readonly onWave: readonly WaveCandidate[] }
export interface Refusal { readonly orderId: string; readonly reason: string; readonly detail: string }
export interface WaveBuilt { readonly waveId: string; readonly pickerId: string; readonly orderIds: readonly string[]; readonly lineCount: number; readonly refused: readonly Refusal[]; readonly alreadyAssigned?: boolean }
export interface WaveRow {
  readonly waveId: string; readonly pickerId: string; readonly orderIds: readonly string[]; readonly lineCount: number;
  readonly picked: number; readonly short: number; readonly substituted: number; readonly qualityFailed: number; readonly notYet: number;
  readonly packed: boolean; readonly stage: 'not_started' | 'picking' | 'packed';
}
export interface DriverEntry { readonly driverId: string; readonly maxStops: number; readonly availableFrom: string; readonly availableUntil: string }
export interface PlannedStop { readonly stopId: string; readonly orderId: string; readonly sequence: number; readonly estimatedArrivalAt: string; readonly missesTheWindow: boolean; readonly codMinor: number; readonly area: string }
export interface PlannedRoute { readonly routeId: string; readonly driverId: string; readonly slotId: string; readonly startsAt: string; readonly stops: readonly PlannedStop[]; readonly totalMetres: number; readonly totalCodMinor: number }
export interface Plan { readonly routes: readonly PlannedRoute[]; readonly unplanned: readonly { readonly orderId: string; readonly reason: string; readonly detail: string }[]; readonly distancesAre: string }
export interface PlanResult { readonly runDate: string; readonly plan: Plan; readonly held: readonly { readonly orderId: string; readonly standing: string }[]; readonly withdrawn?: readonly string[] }
export interface BoardStop {
  readonly stopId: string; readonly orderRef: string; readonly sequence: number; readonly plannedArrivalAt: string | null; readonly state: string;
  readonly flags: readonly string[]; readonly proofKind: string | null; readonly imagesKept: number; readonly codMinor: number; readonly codCollectedMinor: number;
  readonly proofCheck: { readonly code: string; readonly fence: { readonly result: string; readonly distanceMetres?: number; readonly radiusMetres?: number } } | null;
  readonly failureReason: string | null;
}
export interface BoardRoute {
  readonly routeId: string; readonly driverId: string | null; readonly status: 'not_assigned' | 'assigned' | 'withdrawn' | 'settled';
  readonly stops: readonly BoardStop[]; readonly flags: readonly string[];
  readonly cash: { readonly fromStops: { readonly expectedMinor: number; readonly collectedMinor: number; readonly cashHeldMinor: number }; readonly settlement: unknown; readonly handover: { readonly countedMinor: number; readonly varianceMinor: number; readonly material: boolean } | null };
}
export interface Board { readonly runDate: string; readonly routes: readonly BoardRoute[]; readonly held: readonly { readonly orderId: string; readonly standing: string }[]; readonly plan: { readonly unplanned: Plan['unplanned'] } | null }
export interface ControlNumber { readonly key: string; readonly value: unknown; readonly state: 'set' | 'default' | 'not_set'; readonly words: { readonly en: string; readonly ta: string }; readonly setBy?: string; readonly decidedBy?: string }
export interface Controls { readonly numbers: readonly ControlNumber[]; readonly notSet: readonly string[] }
export interface ContributionRow { readonly orderId: string; readonly standing: string; readonly gate: { readonly detail: string; readonly assessment: { readonly contributionMinor: number } | null; readonly missing: readonly string[] } }
export interface ContributionRead { readonly thresholdMinor: number | null; readonly thresholdState: 'set' | 'not_set'; readonly orders: readonly ContributionRow[] }
export interface Settlement { readonly routeId: string; readonly stage: string; readonly proposed: { readonly amountMinor: number; readonly drops: number; readonly by: string } | null; readonly approved: { readonly by: string } | null; readonly paidMinor: number; readonly differenceMinor: number | null; readonly books: string }

export const DISPATCH_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Dispatch',
    lead: 'Build pickers’ waves from confirmed orders, plan the day’s routes, hand each route to its driver, and see every door and the cash. Distances are straight lines, not a map.',
    storeL: 'Store', dateL: 'Run date (YYYY-MM-DD)', badDate: 'Write the date as YYYY-MM-DD.', needStore: 'Say which store.',
    wavesH: 'Waves from confirmed orders', showOrders: 'Show orders waiting', waveIdL: 'Wave id', pickerL: 'Picker', build: 'Build the wave and give it to the picker',
    deliveryK: 'Delivery', pickupK: 'Collection',
    readyK: 'Ready to pick', heldK: 'Held for a manager', onWaveK: 'Already on a wave', noneReady: 'No confirmed order is waiting to be picked.',
    chooseOrders: 'Tick at least one order.', needPicker: 'Name the picker and the wave.', built: 'Wave given to the picker —', lines: 'lines', refusedK: 'Kept out',
    boardWaves: 'Show the waves', stage_not_started: 'Not started', stage_picking: 'Picking', stage_packed: 'Packed',
    pickedK: 'picked', shortK: 'short', subK: 'swapped', qcK: 'quality failed', notYetK: 'not yet',
    routesH: 'Routes', driversL: 'Drivers on shift (one per line: driver, most stops, from HH:MM, until HH:MM)', speedL: 'Average speed (km/h)', minutesL: 'Minutes at each door',
    plan: 'Plan the day', needDrivers: 'Enter at least one driver: driver, most stops, from, until.', needSpeed: 'Enter the day’s speed and minutes at each door.',
    planned: 'Planned —', routesK: 'routes', unplannedK: 'Not on a route', assign: 'Give this route to its driver', assigned: 'Given to', offRoad: 'Driver off the road — take their routes back',
    reasonL: 'Why?', needReason: 'Say why, in a few words.', withdrawnK: 'Taken back:',
    boardH: 'The day’s routes', showBoard: 'Show the routes', s_not_assigned: 'Not given out', s_assigned: 'With the driver', s_withdrawn: 'Taken back', s_settled: 'Settled',
    expectedK: 'Cash expected', collectedK: 'collected', countedK: 'counted', varianceK: 'difference', cashOffice: 'cash office must look',
    codeK: 'Code', fenceK: 'Where', photoK: 'Pictures kept', noProofYet: 'no door yet',
    code_matched: 'matched', code_wrong: 'WRONG', code_not_issued: 'no code issued', code_not_given: 'not a code proof',
    fence_inside: 'at the address', fence_outside: 'AWAY from the address', fence_radius_not_set: 'radius not set', fence_no_device_location: 'no phone location', fence_no_address_location: 'no address on record',
    // OB-343 · OB-344: every flag on a stop in words — a wrong code or a hand-over away from the address is never a code word.
    defaultK: 'the shop’s default', needsLook: 'Needs a person to look:',
    flag_delivery_code_wrong: 'the code the driver typed is NOT the customer’s', flag_delivery_code_not_issued: 'a code was typed but none was issued for this order',
    flag_delivery_code_missing: 'no code was given', flag_outside_geofence: 'handed over away from the address (farther than the radius)',
    flag_proof_image_missing: 'the photo or signature did not arrive', flag_geofence_mismatch: 'the phone said it was away from the address',
    flag_delivered_without_proof_kind: 'delivered with no proof', flag_contribution_flagged: 'the order loses money (contribution rule)',
    flag_driver_unknown: 'the driver named is not known', flag_driver_lacks_authority: 'the driver named may not deliver',
    heldH: 'Orders held under the contribution rule', showHeld: 'Show the contribution rule', thresholdK: 'Owner’s threshold', notSet: 'Not set — the rule only flags',
    approve: 'Approve', decline: 'Decline', decisionL: 'Reason', decided: 'Recorded:',
    st_held: 'Held — needs a manager', st_declined: 'Declined', st_approved: 'Approved', st_clear: 'Clear', st_flag_only: 'Flag only', st_not_assessed: 'Not assessed',
    controlsH: 'The owner’s numbers', showControls: 'Show the numbers', save: 'Save', saved: 'Saved.', needNumber: 'Enter a whole number.',
    settleH: 'Own-fleet settlement', routeIdL: 'Route', propose: 'Propose the settlement', approveSettle: 'Approve the settlement', paid: 'Record the payment',
    amountL: 'Amount paid (₹)', voucherL: 'Voucher', stage: 'Stage', drops: 'drops', settleBooks: 'Books',
    nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot read deliveries.', cannotWave: 'Your role cannot build waves.',
    cannotDispatch: 'Your role cannot plan or hand out routes.', cannotDecide: 'Your role cannot decide on held orders.', cannotSet: 'Only the owner enters these numbers.',
    cannotApprove: 'Your role cannot approve settlements.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.',
  },
  ta: {
    lang: 'English', title: 'அனுப்புதல்',
    lead: 'உறுதிசெய்த ஆர்டர்களிலிருந்து எடுப்பவர்களின் அலைகளை உருவாக்குங்கள், நாளின் வழிகளைத் திட்டமிடுங்கள், ஒவ்வொரு வழியையும் டிரைவரிடம் கொடுங்கள், ஒவ்வொரு வாசலையும் பணத்தையும் பாருங்கள். தூரங்கள் நேர்கோடு, வரைபடம் அல்ல.',
    storeL: 'கடை', dateL: 'ஓட்ட நாள் (YYYY-MM-DD)', badDate: 'தேதியை YYYY-MM-DD என எழுதுங்கள்.', needStore: 'எந்தக் கடை என்று சொல்லுங்கள்.',
    wavesH: 'உறுதிசெய்த ஆர்டர்களிலிருந்து அலைகள்', showOrders: 'காத்திருக்கும் ஆர்டர்களைக் காட்டு', waveIdL: 'அலை எண்', pickerL: 'எடுப்பவர்', build: 'அலையை உருவாக்கி எடுப்பவரிடம் கொடு',
    deliveryK: 'டெலிவரி', pickupK: 'கடையில் பெறுதல்',
    readyK: 'எடுக்கத் தயார்', heldK: 'மேலாளருக்காக நிறுத்தப்பட்டது', onWaveK: 'ஏற்கனவே அலையில்', noneReady: 'எடுக்கக் காத்திருக்கும் உறுதிசெய்த ஆர்டர் இல்லை.',
    chooseOrders: 'குறைந்தது ஒரு ஆர்டரைத் தேர்ந்தெடுங்கள்.', needPicker: 'எடுப்பவரையும் அலையையும் குறிப்பிடுங்கள்.', built: 'அலை எடுப்பவரிடம் கொடுக்கப்பட்டது —', lines: 'வரிகள்', refusedK: 'வெளியே வைக்கப்பட்டது',
    boardWaves: 'அலைகளைக் காட்டு', stage_not_started: 'தொடங்கவில்லை', stage_picking: 'எடுக்கப்படுகிறது', stage_packed: 'பொதி செய்யப்பட்டது',
    pickedK: 'எடுக்கப்பட்டது', shortK: 'குறைவு', subK: 'மாற்றப்பட்டது', qcK: 'தரம் தோல்வி', notYetK: 'இன்னும் இல்லை',
    routesH: 'வழிகள்', driversL: 'பணியில் உள்ள டிரைவர்கள் (ஒரு வரிக்கு ஒருவர்: டிரைவர், அதிகபட்ச நிறுத்தங்கள், HH:MM முதல், HH:MM வரை)', speedL: 'சராசரி வேகம் (கி.மீ/மணி)', minutesL: 'ஒவ்வொரு வாசலிலும் நிமிடங்கள்',
    plan: 'நாளைத் திட்டமிடு', needDrivers: 'குறைந்தது ஒரு டிரைவரை உள்ளிடுங்கள்: டிரைவர், அதிகபட்ச நிறுத்தங்கள், முதல், வரை.', needSpeed: 'நாளின் வேகத்தையும் வாசல் நிமிடங்களையும் உள்ளிடுங்கள்.',
    planned: 'திட்டமிடப்பட்டது —', routesK: 'வழிகள்', unplannedK: 'வழியில் இல்லை', assign: 'இந்த வழியை டிரைவரிடம் கொடு', assigned: 'கொடுக்கப்பட்டது:', offRoad: 'டிரைவர் சாலையில் இல்லை — அவரது வழிகளைத் திரும்பப் பெறு',
    reasonL: 'ஏன்?', needReason: 'சில வார்த்தைகளில் ஏன் என்று சொல்லுங்கள்.', withdrawnK: 'திரும்பப் பெறப்பட்டது:',
    boardH: 'நாளின் வழிகள்', showBoard: 'வழிகளைக் காட்டு', s_not_assigned: 'கொடுக்கப்படவில்லை', s_assigned: 'டிரைவரிடம் உள்ளது', s_withdrawn: 'திரும்பப் பெறப்பட்டது', s_settled: 'கணக்கு முடிந்தது',
    expectedK: 'எதிர்பார்த்த பணம்', collectedK: 'வசூலானது', countedK: 'எண்ணியது', varianceK: 'வித்தியாசம்', cashOffice: 'பணப் பிரிவு பார்க்க வேண்டும்',
    codeK: 'குறியீடு', fenceK: 'இடம்', photoK: 'வைத்த படங்கள்', noProofYet: 'இன்னும் வாசல் இல்லை',
    code_matched: 'பொருந்தியது', code_wrong: 'தவறு', code_not_issued: 'குறியீடு வழங்கப்படவில்லை', code_not_given: 'குறியீட்டு நிரூபணம் அல்ல',
    fence_inside: 'முகவரியில்', fence_outside: 'முகவரியிலிருந்து தொலைவில்', fence_radius_not_set: 'ஆரம் அமைக்கப்படவில்லை', fence_no_device_location: 'ஃபோன் இடம் இல்லை', fence_no_address_location: 'பதிவில் முகவரி இல்லை',
    defaultK: 'கடையின் இயல்பு மதிப்பு', needsLook: 'ஒருவர் பார்க்க வேண்டும்:',
    flag_delivery_code_wrong: 'டிரைவர் உள்ளிட்ட குறியீடு வாடிக்கையாளருடையது அல்ல', flag_delivery_code_not_issued: 'குறியீடு உள்ளிடப்பட்டது, ஆனால் இந்த ஆர்டருக்கு வழங்கப்படவில்லை',
    flag_delivery_code_missing: 'குறியீடு கொடுக்கப்படவில்லை', flag_outside_geofence: 'முகவரியிலிருந்து தொலைவில் ஒப்படைக்கப்பட்டது (ஆரத்திற்கு அப்பால்)',
    flag_proof_image_missing: 'படம் அல்லது கையொப்பம் வரவில்லை', flag_geofence_mismatch: 'ஃபோன் முகவரியிலிருந்து தொலைவில் இருப்பதாகச் சொன்னது',
    flag_delivered_without_proof_kind: 'நிரூபணம் இல்லாமல் டெலிவரி', flag_contribution_flagged: 'ஆர்டர் நஷ்டம் தருகிறது (பங்களிப்பு விதி)',
    flag_driver_unknown: 'குறிப்பிட்ட டிரைவர் தெரியவில்லை', flag_driver_lacks_authority: 'குறிப்பிட்ட டிரைவர் டெலிவரி செய்ய அனுமதி இல்லை',
    heldH: 'பங்களிப்பு விதியின் கீழ் நிறுத்திய ஆர்டர்கள்', showHeld: 'பங்களிப்பு விதியைக் காட்டு', thresholdK: 'உரிமையாளரின் வரம்பு', notSet: 'அமைக்கப்படவில்லை — விதி கொடி மட்டும் காட்டும்',
    approve: 'அனுமதி', decline: 'மறு', decisionL: 'காரணம்', decided: 'பதிவானது:',
    st_held: 'நிறுத்தப்பட்டது — மேலாளர் தேவை', st_declined: 'மறுக்கப்பட்டது', st_approved: 'அனுமதிக்கப்பட்டது', st_clear: 'சரி', st_flag_only: 'கொடி மட்டும்', st_not_assessed: 'மதிப்பிடப்படவில்லை',
    controlsH: 'உரிமையாளரின் எண்கள்', showControls: 'எண்களைக் காட்டு', save: 'சேமி', saved: 'சேமிக்கப்பட்டது.', needNumber: 'முழு எண்ணை உள்ளிடுங்கள்.',
    settleH: 'சொந்த வாகனக் கணக்குத் தீர்வு', routeIdL: 'வழி', propose: 'தீர்வை முன்மொழி', approveSettle: 'தீர்வை அனுமதி', paid: 'செலுத்தியதைப் பதிவு செய்',
    amountL: 'செலுத்திய தொகை (₹)', voucherL: 'வவுச்சர்', stage: 'நிலை', drops: 'டெலிவரிகள்', settleBooks: 'கணக்கேடுகள்',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு டெலிவரிகளைப் படிக்க முடியாது.', cannotWave: 'உங்கள் பங்கு அலைகளை உருவாக்க முடியாது.',
    cannotDispatch: 'உங்கள் பங்கு வழிகளைத் திட்டமிடவோ கொடுக்கவோ முடியாது.', cannotDecide: 'உங்கள் பங்கு நிறுத்திய ஆர்டர்களில் முடிவெடுக்க முடியாது.', cannotSet: 'இந்த எண்களை உரிமையாளர் மட்டுமே உள்ளிடுவார்.',
    cannotApprove: 'உங்கள் பங்கு தீர்வுகளை அனுமதிக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.',
  },
} as const;
export const dispatchWords = (lang: Lang, key: string): string => (DISPATCH_COPY[lang] as Record<string, string>)[key] ?? (DISPATCH_COPY.en as Record<string, string>)[key] ?? key;
/** A stop's flags in the reader's words (OB-343 · OB-344) — a flag with no words is shown as itself, never hidden. */
export const flagWords = (lang: Lang, flags: readonly string[]): readonly string[] => flags.map((f) => {
  const w = dispatchWords(lang, `flag_${f}`);
  return w === `flag_${f}` ? f.replace(/_/g, ' ') : w;
});
export const dispatchOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => dispatchWords(lang, k), out);

/** Rupees with paise, Indian grouping — from whole paise. */
export function rupees(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}₹${Math.floor(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Read the drivers box: one driver per line, "driver, most stops, from HH:MM, until HH:MM", on the run date. The times are
 * the shop's wall clock; `offsetMinutes` turns them into instants (India is +330). Undefined: a line that cannot be read.
 */
export function readDrivers(text: string, runDate: string, offsetMinutes: number): readonly DriverEntry[] | undefined {
  const out: DriverEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const [driverId, stops, from, until] = line.split(',').map((x) => x.trim());
    if (driverId === undefined || driverId === '' || stops === undefined || !/^\d+$/.test(stops) || Number(stops) < 1 || from === undefined || !HHMM.test(from) || until === undefined || !HHMM.test(until)) return undefined;
    const at = (hhmm: string): string => new Date(Date.parse(`${runDate}T${hhmm}:00.000Z`) - offsetMinutes * 60_000).toISOString();
    out.push({ driverId, maxStops: Number(stops), availableFrom: at(from), availableUntil: at(until) });
  }
  return out.length === 0 ? undefined : out;
}

export interface DispatchSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly waves: boolean; readonly dispatch: boolean; readonly decide: boolean; readonly setNumbers: boolean; readonly approveSettlement: boolean };
  candidates(storeId: string): Promise<Outcome<Candidates>>;
  buildWave(input: { readonly waveId: string; readonly storeId: string; readonly pickerId: string; readonly orderIds: readonly string[] }): Promise<Outcome<WaveBuilt>>;
  waves(storeId: string): Promise<Outcome<{ readonly waves: readonly WaveRow[] }>>;
  plan(input: { readonly runDate: string; readonly storeId: string; readonly driversText: string; readonly speed: string; readonly minutes: string; readonly offsetMinutes?: number }): Promise<Outcome<PlanResult>>;
  assign(runDate: string, routeId: string, storeId: string): Promise<Outcome<{ readonly routeId: string; readonly driverId: string; readonly stopCount: number }>>;
  offRoad(input: { readonly runDate: string; readonly storeId: string; readonly driverId: string; readonly reason: string; readonly driversText: string; readonly speed: string; readonly minutes: string; readonly offsetMinutes?: number }): Promise<Outcome<PlanResult>>;
  board(runDate: string, storeId: string): Promise<Outcome<Board>>;
  contribution(storeId: string): Promise<Outcome<ContributionRead>>;
  decide(orderId: string, decision: 'approve' | 'decline', reason: string): Promise<Outcome<{ readonly standing: string }>>;
  controls(): Promise<Outcome<Controls>>;
  setNumber(key: string, value: string): Promise<Outcome<Controls>>;
  settlement(routeId: string): Promise<Outcome<Settlement>>;
  propose(routeId: string): Promise<Outcome<Settlement>>;
  approveSettlement(routeId: string): Promise<Outcome<Settlement>>;
  recordPaid(routeId: string, rupeesText: string, voucherRef: string): Promise<Outcome<Settlement>>;
}

export function createDispatchSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): DispatchSession {
  const named = input.viewer?.userId !== undefined;
  const held = input.viewer?.permissions ?? [];
  const has = (p: string): boolean => named && held.includes(p);
  const may = {
    named, read: has('delivery.run.read'), waves: has('fulfilment.wave.assign'), dispatch: has('delivery.dispatch.manage'),
    decide: has('delivery.contribution.approve'), setNumbers: has('delivery.controls.set'), approveSettlement: has('delivery.settlement.approve'),
  };
  const call = makeCaller({ ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }), keyPrefix: 'dispatch' });
  const gate = (allowed: boolean, why: string): Outcome<never> | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !allowed ? { result: 'invalid', why } : undefined);
  const enc = encodeURIComponent;
  const storeOk = (s: string): Outcome<never> | undefined => (s.trim() === '' ? { result: 'invalid', why: 'needStore' } : undefined);
  const dayOk = (d: string): Outcome<never> | undefined => (DAY.test(d.trim()) ? undefined : { result: 'invalid', why: 'badDate' });
  const dayInputs = (i: { readonly runDate: string; readonly storeId: string; readonly driversText: string; readonly speed: string; readonly minutes: string; readonly offsetMinutes?: number }) => {
    const bad = dayOk(i.runDate) ?? storeOk(i.storeId);
    if (bad !== undefined) return bad;
    const drivers = readDrivers(i.driversText, i.runDate.trim(), i.offsetMinutes ?? 330);
    if (drivers === undefined) return { result: 'invalid' as const, why: 'needDrivers' };
    const speed = Number(i.speed); const minutes = Number(i.minutes);
    if (i.speed.trim() === '' || i.minutes.trim() === '' || !Number.isFinite(speed) || speed <= 0 || !Number.isFinite(minutes) || minutes < 0) return { result: 'invalid' as const, why: 'needSpeed' };
    return { storeId: i.storeId.trim(), drivers, averageSpeedKmh: speed, serviceMinutesPerStop: minutes };
  };
  return {
    may,
    candidates: async (storeId) => gate(may.waves, 'cannotWave') ?? storeOk(storeId) ?? call<Candidates>('GET', `/v1/fulfilment/wave-candidates?storeId=${enc(storeId.trim())}`),
    buildWave: async (i) => {
      const g = gate(may.waves, 'cannotWave') ?? storeOk(i.storeId); if (g !== undefined) return g;
      if (i.waveId.trim() === '' || i.pickerId.trim() === '') return { result: 'invalid', why: 'needPicker' };
      if (i.orderIds.length === 0) return { result: 'invalid', why: 'chooseOrders' };
      return call<WaveBuilt>('POST', `/v1/fulfilment/waves/${enc(i.waveId.trim())}/build`, { storeId: i.storeId.trim(), pickerId: i.pickerId.trim(), orderIds: i.orderIds });
    },
    waves: async (storeId) => gate(may.waves, 'cannotWave') ?? storeOk(storeId) ?? call('GET', `/v1/fulfilment/wave-board?storeId=${enc(storeId.trim())}`),
    plan: async (i) => {
      const g = gate(may.dispatch, 'cannotDispatch'); if (g !== undefined) return g;
      const body = dayInputs(i); if ('result' in body) return body;
      return call<PlanResult>('POST', `/v1/delivery/dispatch/${i.runDate.trim()}/plan-from-orders`, body);
    },
    assign: async (runDate, routeId, storeId) => gate(may.dispatch, 'cannotDispatch') ?? dayOk(runDate) ?? storeOk(storeId)
      ?? call('POST', `/v1/delivery/dispatch/${runDate.trim()}/routes/${enc(routeId)}/assign`, { storeId: storeId.trim() }),
    offRoad: async (i) => {
      const g = gate(may.dispatch, 'cannotDispatch'); if (g !== undefined) return g;
      if (i.reason.trim().length < 5) return { result: 'invalid', why: 'needReason' };
      const body = dayInputs(i); if ('result' in body) return body;
      return call<PlanResult>('POST', `/v1/delivery/dispatch/${i.runDate.trim()}/reassign-driver`, { ...body, withoutDriverId: i.driverId.trim(), reason: i.reason.trim() });
    },
    board: async (runDate, storeId) => gate(may.read, 'cannotRead') ?? dayOk(runDate) ?? storeOk(storeId) ?? call<Board>('GET', `/v1/delivery/dispatch/${runDate.trim()}/board?storeId=${enc(storeId.trim())}`),
    contribution: async (storeId) => gate(may.read, 'cannotRead') ?? storeOk(storeId) ?? call<ContributionRead>('GET', `/v1/delivery/contribution?storeId=${enc(storeId.trim())}`),
    decide: async (orderId, decision, reason) => {
      const g = gate(may.decide, 'cannotDecide'); if (g !== undefined) return g;
      if (reason.trim().length < 5) return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/delivery/contribution/${enc(orderId)}/decision`, { decision, reason: reason.trim() });
    },
    controls: async () => gate(may.read, 'cannotRead') ?? call<Controls>('GET', '/v1/delivery/controls'),
    setNumber: async (key, value) => {
      const g = gate(may.setNumbers, 'cannotSet'); if (g !== undefined) return g;
      const v = value.trim();
      if (key === 'fleetRate') {
        // "per_drop 4000" or "per_run 50000" (paise).
        const [basis, rate] = v.split(/\s+/);
        if ((basis !== 'per_drop' && basis !== 'per_run') || rate === undefined || !/^\d+$/.test(rate)) return { result: 'invalid', why: 'needNumber' };
        return call<Controls>('POST', '/v1/delivery/controls', { fleetRate: { basis, rateMinor: Number(rate) } });
      }
      if (!/^\d+$/.test(v)) return { result: 'invalid', why: 'needNumber' };
      return call<Controls>('POST', '/v1/delivery/controls', { [key]: Number(v) });
    },
    settlement: async (routeId) => gate(may.read, 'cannotRead') ?? call<Settlement>('GET', `/v1/delivery/fleet-settlements/${enc(routeId)}`),
    propose: async (routeId) => gate(may.dispatch, 'cannotDispatch') ?? call<Settlement>('POST', `/v1/delivery/fleet-settlements/${enc(routeId)}`, {}),
    approveSettlement: async (routeId) => gate(may.approveSettlement, 'cannotApprove') ?? call<Settlement>('POST', `/v1/delivery/fleet-settlements/${enc(routeId)}/approve`, {}),
    recordPaid: async (routeId, rupeesText, voucherRef) => {
      const g = gate(may.approveSettlement, 'cannotApprove'); if (g !== undefined) return g;
      const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(rupeesText.trim());
      if (m === null || voucherRef.trim() === '') return { result: 'invalid', why: 'needNumber' };
      const minor = Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
      return call<Settlement>('POST', `/v1/delivery/fleet-settlements/${enc(routeId)}/paid`, { amountMinor: minor, voucherRef: voucherRef.trim() });
    },
  };
}
