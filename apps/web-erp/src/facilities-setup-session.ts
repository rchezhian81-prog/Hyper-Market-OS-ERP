// Facilities set-up (Round 4d · M26-FR-01/02/03 · D-6 · Screen D "facilities and food-safety schedules, assets, monitored
// rooms") — a tested, DOM-free session over head office's facilities engines, which no screen could feed: without it the
// Facilities and Food-safety checks pages had nothing to show, because nobody could register an asset, set a room's range,
// set a cleaning or fire-safety schedule, or define a temperature check without a programmer.
//   • ASSETS — `GET /v1/facilities/office?branchId` (the register), `POST /v1/facilities/assets/:assetId` (add or change),
//     `POST …/assets/:assetId/services/:serviceId` (log a service, drawing the spares it used — M26-FR-01).
//   • SPARE PARTS — `GET /v1/facilities/spares?branchId`, `POST /v1/facilities/spares/:id` (define), `POST …/movements/:id`
//     (stock received, or a counted correction with a reason). On hand is the sum of the movements, never typed.
//   • MONITORED ROOMS — the office read's equipment, `POST /v1/facilities/equipment/:assetId/range` (the range in °C, the
//     grace, how often a reading is expected, on backup power).
//   • SCHEDULES — `GET /v1/facilities/schedules?branchId`, `POST /v1/facilities/schedules/:id` (define), `POST …/tasks/:id`
//     (raise the task due on a day).
//   • FOOD-SAFETY CHECKS — `GET /v1/facilities/food-safety/status?branchId` (the checks in force), `POST
//     /v1/facilities/food-safety/checks/:id` (define; a change is a new version from now — a slot already missed stays missed).
// Reading needs `facilities.asset.read` (assets, spares, rooms) and `facilities.overdue.read` (schedules, checks); writing
// `facilities.asset.manage` or `facilities.schedule.manage`; raising a task `facilities.task.record`. Head office re-checks
// each, audits each, and keeps every version. Every word here has a Tamil twin; head office's own sentences stay English.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const ASSET_KINDS = ['refrigeration', 'cold_room', 'freezer', 'power_ups', 'power_dg', 'pos_hardware', 'weighing', 'fire_safety', 'handling', 'other'] as const;
export const CRITICALITIES = ['critical', 'important', 'routine'] as const;
export const SERVICE_KINDS = ['preventive', 'breakdown', 'inspection'] as const;
export const SCHEDULE_CATEGORIES = ['cleaning', 'pest_control', 'fire_safety', 'electrical_safety', 'maintenance', 'statutory'] as const;
export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'annual'] as const;
export const CHECK_KINDS = ['temperature', 'equipment', 'cleaning', 'receiving'] as const;

export interface AssetRow { readonly assetId: string; readonly name: string; readonly kind: string; readonly criticality: string; readonly installedOn: string; readonly active: boolean; readonly warrantyUntil: string | null; readonly amcUntil: string | null; readonly amcVendor: string | null; readonly serviceEveryDays: number | null; readonly lastServicedOn: string | null; readonly protectsValueMinor: number | null }
export interface SpareRow { readonly sparePartId: string; readonly name: string; readonly unit: string; readonly minimumLevel: number; readonly compatibleAssetIds: readonly string[]; readonly active: boolean; readonly onHand: number; readonly low: boolean; readonly movements: readonly { readonly kind: string; readonly qty: number; readonly on: string; readonly by: string; readonly reason?: string; readonly serviceId?: string; readonly assetId?: string }[] }
export interface RoomRow { readonly assetId: string; readonly name: string; readonly onBackup: boolean; readonly minTenthsC: number; readonly maxTenthsC: number; readonly graceMinutes: number; readonly expectEveryMinutes: number | null; readonly state: string }
export interface ScheduleRow { readonly scheduleId: string; readonly title: string; readonly category: string; readonly frequency: string; readonly assignedRole: string; readonly escalatesTo: string; readonly evidenceRequired: boolean; readonly verificationRequired: boolean; readonly escalateAfterDays: number | null; readonly assetId: string | null; readonly active: boolean; readonly tasksRaised: number; readonly lastDueOn: string | null; readonly open: number }
export interface CheckRow { readonly checkId: string; readonly title: string; readonly kind: string; readonly everyMinutes: number | null; readonly startsAt: string | null; readonly graceMinutes: number; readonly minTenthsC: number | null; readonly maxTenthsC: number | null; readonly items: readonly { readonly itemId: string; readonly label: string }[]; readonly equipmentId: string | null; readonly assignedRole: string; readonly escalatesTo: string; readonly active: boolean; readonly effectiveFrom: string | null }

type Why = 'nobody' | 'noStore' | 'cannotRead' | 'cannotManage' | 'needName' | 'needDate' | 'badNumber' | 'badTemperature' | 'rangeInverted' | 'needItems' | 'needRole' | 'needEscalation' | 'needSchedule' | 'needReason' | 'needQty';
export type SetupOutcome<T> = Outcome<T, Why>;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A temperature typed in °C ("3.5", "-18") as whole tenths, or undefined when it is not one. */
export function tenthsOf(typed: string): number | undefined {
  const t = typed.trim().replace(',', '.');
  if (!/^-?\d+(\.\d)?$/.test(t)) return undefined;
  return Math.round(Number(t) * 10);
}
export const celsius = (tenths: number | null): string => (tenths === null ? '' : (tenths / 10).toFixed(1));
/** A whole number typed (no sign unless `signed`), or undefined. */
export function wholeOf(typed: string, opts: { signed?: boolean; min?: number } = {}): number | undefined {
  const t = typed.trim();
  if (!(opts.signed ? /^-?\d+$/ : /^\d+$/).test(t)) return undefined;
  const n = Number(t);
  return opts.min !== undefined && n < opts.min ? undefined : n;
}
/** Rupees typed ("1,250.50") as paise, or undefined. */
export function paiseOf(typed: string): number | undefined {
  const t = typed.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  return Math.round(Number(t) * 100);
}
/** A checklist typed one item per line, each with an id made from its own words (stable for the same words). */
export function itemsOf(typed: string): { itemId: string; label: string }[] {
  const seen = new Set<string>();
  return typed.split('\n').map((l) => l.trim()).filter((l) => l !== '').flatMap((label, i) => {
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `item-${i + 1}`;
    let id = base; let n = 2;
    while (seen.has(id)) { id = `${base}-${n}`; n += 1; }
    seen.add(id);
    return [{ itemId: id, label }];
  });
}

export const FACILITIES_SETUP_COPY = {
  en: {
    title: 'Facilities set-up',
    lead: 'The machines, spare parts, cold rooms, maintenance schedules and food-safety checks of this store. The Facilities and Food-safety checks pages work from what is set here. Every change is kept with who made it; a changed check counts only from now — a check already missed stays missed.',
    tabAssets: 'Assets', tabSpares: 'Spare parts', tabRooms: 'Monitored rooms', tabSchedules: 'Schedules', tabChecks: 'Food-safety checks',
    cardAssets: 'Assets registered', cardCritical: 'Critical assets', cardLow: 'Spare parts running low', cardRooms: 'Rooms watched', cardSchedules: 'Schedules set', cardChecks: 'Food-safety checks in force',
    noteLow: 'below the level you want', noteNotKept: 'not kept for this shop',
    // assets
    assetsH: 'Assets', assetRegister: 'Asset register', colName: 'Name', colKind: 'Kind', colCriticality: 'How critical', colAmc: 'AMC until', colLastService: 'Last serviced',
    assetFormH: 'Add or change an asset', assetName: 'Name', assetKind: 'Kind', criticality: 'How critical', installedOn: 'Installed on', warrantyUntil: 'Warranty until', amcUntil: 'AMC until', amcVendor: 'AMC company', serviceEveryDays: 'Service every (days)', protectsValue: 'Stock that depends on it (₹)', active: 'In use',
    saveAsset: 'Save the asset', assetSaved: 'Asset saved.', editThis: 'Change this', emptyAssets: 'No asset registered for this store yet', emptyAssetsDetail: 'Add the chillers, freezers, generator and UPS first. An empty register is not a sign that nothing needs servicing.',
    serviceH: 'Log a service', performedOn: 'Done on', performedBy: 'Done by (person or company)', serviceKind: 'Kind of service', notes: 'What was done', cost: 'Cost (₹)', sparesUsedH: 'Spare parts used (how many of each)', noFittingSpares: 'No spare part in the register fits this asset.', logService: 'Log the service', serviceLogged: 'Service logged; the spares used were taken off the register.',
    k_refrigeration: 'Chiller or fridge', k_cold_room: 'Cold room', k_freezer: 'Freezer', k_power_ups: 'UPS', k_power_dg: 'Generator', k_pos_hardware: 'Till hardware', k_weighing: 'Weighing scale', k_fire_safety: 'Fire safety', k_handling: 'Trolley or lift', k_other: 'Other',
    c_critical: 'critical', c_important: 'important', c_routine: 'routine',
    s_preventive: 'Preventive service', s_breakdown: 'Breakdown repair', s_inspection: 'Inspection',
    // spares
    sparesH: 'Spare parts', spareRegister: 'Spare parts register', colOnHand: 'On hand', colMinimum: 'Keep at least', colFits: 'Fits', colState: 'State',
    low: 'running low', enough: 'enough', inactive: 'not in use',
    spareFormH: 'Add or change a spare part', spareName: 'Part name', unit: 'Counted in', minimumLevel: 'Keep at least', fits: 'Fits these assets',
    saveSpare: 'Save the spare part', spareSaved: 'Spare part saved.',
    receivedH: 'Stock received', qty: 'How many', on: 'On', recordReceived: 'Record the stock received', received: 'Stock received recorded.',
    correctionH: 'Correct the count', correctionQty: 'Change (+ or −)', reason: 'Why', recordCorrection: 'Record the correction', corrected: 'Correction recorded; the earlier movements stay on the record.',
    movementsH: 'Every movement', m_received: 'received', m_used: 'used', m_correction: 'correction', forService: 'for service', emptySpares: 'No spare part registered yet', emptySparesDetail: 'Spares used on a service are taken off this register. An empty register is not a sign that nothing is needed.',
    // rooms
    roomsH: 'Monitored rooms and cabinets', roomRegister: 'Rooms and cabinets watched', colRange: 'Range (°C)', colGrace: 'Grace (minutes)', colBackup: 'On backup power',
    roomFormH: 'Watch a room or cabinet', roomAsset: 'Which asset', roomName: 'Name shown', minC: 'Lowest allowed (°C)', maxC: 'Highest allowed (°C)', graceMinutes: 'Minutes outside before it counts', expectEvery: 'A reading expected every (minutes)', onBackup: 'On backup power',
    saveRoom: 'Save the range', roomSaved: 'Range saved.', yes: 'yes', no: 'no', emptyRooms: 'No room or cabinet is watched yet', emptyRoomsDetail: 'Set a range for each chiller, freezer and cold room. A room with no range is never checked — not a pass.',
    // schedules
    schedulesH: 'Maintenance and compliance schedules', scheduleRegister: 'Schedules', colTitle: 'What', colCategory: 'Kind', colFrequency: 'How often', colLastDue: 'Last raised for', colOpen: 'Open',
    scheduleFormH: 'Add or change a schedule', scheduleTitle: 'What is done', category: 'Kind', frequency: 'How often', assignedRole: 'Done by (role)', escalatesTo: 'A miss is told to', evidenceRequired: 'A photo or document is needed', verificationRequired: 'A second person must check it', escalateAfterDays: 'Escalate after (days late)', scheduleAsset: 'About this asset (optional)', none: 'none',
    saveSchedule: 'Save the schedule', scheduleSaved: 'Schedule saved.', raiseH: 'Raise the next task', dueOn: 'Due on', raise: 'Raise the task', raised: 'Task raised; it shows on the Facilities page until it is done.',
    cat_cleaning: 'Cleaning', cat_pest_control: 'Pest control', cat_fire_safety: 'Fire safety', cat_electrical_safety: 'Electrical safety', cat_maintenance: 'Maintenance', cat_statutory: 'Statutory check',
    f_daily: 'daily', f_weekly: 'weekly', f_monthly: 'monthly', f_quarterly: 'every three months', f_half_yearly: 'every six months', f_annual: 'every year',
    emptySchedules: 'No schedule set yet', emptySchedulesDetail: 'Set the pest control, fire extinguisher, cleaning and electrical checks. No schedule is not the same as nothing overdue.',
    // checks
    checksH: 'Food-safety checks', checkRegister: 'Checks in force', colEvery: 'Every', colLimits: 'Limits (°C)', colItems: 'Items',
    checkFormH: 'Add or change a food-safety check', checkTitle: 'What is checked', checkKind: 'Kind of check', everyMinutes: 'Every (minutes)', startsAt: 'First one at', checkGrace: 'Minutes after it is due before it is missed', items: 'Items to tick (one per line)', equipment: 'Which room or cabinet (optional)',
    saveCheck: 'Save the check', checkSaved: 'Check saved. A change counts from now; a slot already missed stays missed.', checkUnchanged: 'Nothing changed — the check in force is the same.',
    ck_temperature: 'Temperature', ck_equipment: 'Equipment', ck_cleaning: 'Cleaning', ck_receiving: 'Receiving (per delivery)', perDelivery: 'each delivery', minutesShort: 'min',
    emptyChecks: 'No food-safety check defined yet', emptyChecksDetail: 'Define the chiller temperature checks and the cleaning lists. No check is not the same as all checks passed.',
    // shared
    saving: 'Saving…', reading: 'Reading from head office…', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
    nobody: 'Nobody is signed in on this screen.', noStore: 'This store computer does not say which store it is, so nothing can be read.', cannotRead: 'Your role cannot see this part of the facilities set-up.', cannotManage: 'You can see this; changing it needs the store manager\'s permission.',
    needName: 'Fill in the name.', needDate: 'Type the date as YYYY-MM-DD.', badNumber: 'Type a whole number.', badTemperature: 'Type the temperature in °C, e.g. 3.5 or -18.', rangeInverted: 'The highest allowed is below the lowest.', needItems: 'Type at least one item to tick.', needRole: 'Say which role does it.', needEscalation: 'Say who a miss is told to.', needSchedule: 'Say how often, and when the first one is.', needReason: 'Say why.', needQty: 'Type how many (a whole number, not 0).',
  },
  ta: {
    title: 'வசதிகள் அமைப்பு',
    lead: 'இந்தக் கடையின் இயந்திரங்கள், உதிரி பாகங்கள், குளிர் அறைகள், பராமரிப்பு அட்டவணைகள் மற்றும் உணவுப் பாதுகாப்புச் சோதனைகள். வசதிகள் மற்றும் உணவுப் பாதுகாப்புச் சோதனைகள் பக்கங்கள் இங்கே அமைப்பதிலிருந்தே வேலை செய்கின்றன. ஒவ்வொரு மாற்றமும் செய்தவருடன் வைக்கப்படும்; மாற்றிய சோதனை இனிமேல் மட்டுமே கணக்கிடப்படும் — ஏற்கனவே தவறியது தவறியதாகவே இருக்கும்.',
    tabAssets: 'சொத்துகள்', tabSpares: 'உதிரி பாகங்கள்', tabRooms: 'கண்காணிக்கும் அறைகள்', tabSchedules: 'அட்டவணைகள்', tabChecks: 'உணவுப் பாதுகாப்புச் சோதனைகள்',
    cardAssets: 'பதிவான சொத்துகள்', cardCritical: 'முக்கியச் சொத்துகள்', cardLow: 'குறைந்து வரும் உதிரி பாகங்கள்', cardRooms: 'கண்காணிக்கும் அறைகள்', cardSchedules: 'அமைத்த அட்டவணைகள்', cardChecks: 'நடைமுறையில் உள்ள சோதனைகள்',
    noteLow: 'நீங்கள் விரும்பும் அளவிற்குக் கீழே', noteNotKept: 'இந்தக் கடைக்கு வைக்கப்படவில்லை',
    assetsH: 'சொத்துகள்', assetRegister: 'சொத்துப் பதிவேடு', colName: 'பெயர்', colKind: 'வகை', colCriticality: 'எவ்வளவு முக்கியம்', colAmc: 'AMC வரை', colLastService: 'கடைசி சேவை',
    assetFormH: 'சொத்தைச் சேர் அல்லது மாற்று', assetName: 'பெயர்', assetKind: 'வகை', criticality: 'எவ்வளவு முக்கியம்', installedOn: 'நிறுவிய நாள்', warrantyUntil: 'உத்தரவாதம் வரை', amcUntil: 'AMC வரை', amcVendor: 'AMC நிறுவனம்', serviceEveryDays: 'சேவை இடைவெளி (நாட்கள்)', protectsValue: 'இதைச் சார்ந்த சரக்கு (₹)', active: 'பயன்பாட்டில்',
    saveAsset: 'சொத்தைச் சேமி', assetSaved: 'சொத்து சேமிக்கப்பட்டது.', editThis: 'இதை மாற்று', emptyAssets: 'இந்தக் கடைக்கு இன்னும் சொத்து பதியப்படவில்லை', emptyAssetsDetail: 'முதலில் குளிர்சாதனங்கள், உறைவிப்பான்கள், ஜெனரேட்டர், UPS ஆகியவற்றைச் சேருங்கள். காலியான பதிவேடு எதற்கும் சேவை தேவையில்லை என்பதற்கான அடையாளம் அல்ல.',
    serviceH: 'சேவையைப் பதி', performedOn: 'செய்த நாள்', performedBy: 'செய்தவர் (நபர் அல்லது நிறுவனம்)', serviceKind: 'சேவை வகை', notes: 'செய்தது என்ன', cost: 'செலவு (₹)', sparesUsedH: 'பயன்படுத்திய உதிரி பாகங்கள் (ஒவ்வொன்றும் எத்தனை)', noFittingSpares: 'பதிவேட்டில் இந்தச் சொத்திற்குப் பொருந்தும் உதிரி பாகம் இல்லை.', logService: 'சேவையைப் பதி', serviceLogged: 'சேவை பதியப்பட்டது; பயன்படுத்திய உதிரி பாகங்கள் பதிவேட்டிலிருந்து கழிக்கப்பட்டன.',
    k_refrigeration: 'குளிர்சாதனம்', k_cold_room: 'குளிர் அறை', k_freezer: 'உறைவிப்பான்', k_power_ups: 'UPS', k_power_dg: 'ஜெனரேட்டர்', k_pos_hardware: 'கல்லா வன்பொருள்', k_weighing: 'எடைத் தராசு', k_fire_safety: 'தீ பாதுகாப்பு', k_handling: 'தள்ளுவண்டி அல்லது லிஃப்ட்', k_other: 'மற்றவை',
    c_critical: 'மிக முக்கியம்', c_important: 'முக்கியம்', c_routine: 'வழக்கமானது',
    s_preventive: 'தடுப்புச் சேவை', s_breakdown: 'பழுது சரிசெய்தல்', s_inspection: 'ஆய்வு',
    sparesH: 'உதிரி பாகங்கள்', spareRegister: 'உதிரி பாகப் பதிவேடு', colOnHand: 'கையிருப்பு', colMinimum: 'குறைந்தது வைக்க', colFits: 'பொருந்துவது', colState: 'நிலை',
    low: 'குறைந்து வருகிறது', enough: 'போதுமானது', inactive: 'பயன்பாட்டில் இல்லை',
    spareFormH: 'உதிரி பாகத்தைச் சேர் அல்லது மாற்று', spareName: 'பாகத்தின் பெயர்', unit: 'எண்ணும் அலகு', minimumLevel: 'குறைந்தது வைக்க', fits: 'இந்தச் சொத்துகளுக்குப் பொருந்தும்',
    saveSpare: 'உதிரி பாகத்தைச் சேமி', spareSaved: 'உதிரி பாகம் சேமிக்கப்பட்டது.',
    receivedH: 'வந்த சரக்கு', qty: 'எத்தனை', on: 'நாள்', recordReceived: 'வந்த சரக்கைப் பதி', received: 'வந்த சரக்கு பதியப்பட்டது.',
    correctionH: 'எண்ணிக்கையைத் திருத்து', correctionQty: 'மாற்றம் (+ அல்லது −)', reason: 'ஏன்', recordCorrection: 'திருத்தத்தைப் பதி', corrected: 'திருத்தம் பதியப்பட்டது; முந்தைய நகர்வுகள் பதிவில் இருக்கும்.',
    movementsH: 'ஒவ்வொரு நகர்வும்', m_received: 'வந்தது', m_used: 'பயன்பட்டது', m_correction: 'திருத்தம்', forService: 'சேவைக்கு', emptySpares: 'இன்னும் உதிரி பாகம் பதியப்படவில்லை', emptySparesDetail: 'சேவையில் பயன்படுத்திய உதிரி பாகங்கள் இந்தப் பதிவேட்டிலிருந்து கழிக்கப்படும். காலியான பதிவேடு எதுவும் தேவையில்லை என்பதற்கான அடையாளம் அல்ல.',
    roomsH: 'கண்காணிக்கும் அறைகளும் அலமாரிகளும்', roomRegister: 'கண்காணிக்கும் அறைகள்', colRange: 'வரம்பு (°C)', colGrace: 'சலுகை (நிமிடங்கள்)', colBackup: 'மாற்று மின்சாரத்தில்',
    roomFormH: 'ஒரு அறையை அல்லது அலமாரியைக் கண்காணி', roomAsset: 'எந்தச் சொத்து', roomName: 'காட்டும் பெயர்', minC: 'குறைந்தபட்சம் (°C)', maxC: 'அதிகபட்சம் (°C)', graceMinutes: 'கணக்கிடும் முன் வெளியே இருக்கும் நிமிடங்கள்', expectEvery: 'அளவீடு எதிர்பார்க்கும் இடைவெளி (நிமிடங்கள்)', onBackup: 'மாற்று மின்சாரத்தில்',
    saveRoom: 'வரம்பைச் சேமி', roomSaved: 'வரம்பு சேமிக்கப்பட்டது.', yes: 'ஆம்', no: 'இல்லை', emptyRooms: 'இன்னும் எந்த அறையும் கண்காணிக்கப்படவில்லை', emptyRoomsDetail: 'ஒவ்வொரு குளிர்சாதனம், உறைவிப்பான், குளிர் அறைக்கும் வரம்பு அமையுங்கள். வரம்பு இல்லாத அறை சோதிக்கப்படுவதே இல்லை — அது தேர்ச்சி அல்ல.',
    schedulesH: 'பராமரிப்பு மற்றும் இணக்க அட்டவணைகள்', scheduleRegister: 'அட்டவணைகள்', colTitle: 'என்ன', colCategory: 'வகை', colFrequency: 'எவ்வளவு அடிக்கடி', colLastDue: 'கடைசியாக எழுப்பியது', colOpen: 'திறந்தவை',
    scheduleFormH: 'அட்டவணையைச் சேர் அல்லது மாற்று', scheduleTitle: 'செய்வது என்ன', category: 'வகை', frequency: 'எவ்வளவு அடிக்கடி', assignedRole: 'செய்பவர் (பங்கு)', escalatesTo: 'தவறினால் யாரிடம் சொல்வது', evidenceRequired: 'புகைப்படம் அல்லது ஆவணம் தேவை', verificationRequired: 'இரண்டாவது நபர் சரிபார்க்க வேண்டும்', escalateAfterDays: 'எத்தனை நாள் தாமதத்தில் உயர்த்துவது', scheduleAsset: 'இந்தச் சொத்து பற்றி (விருப்பம்)', none: 'எதுவும் இல்லை',
    saveSchedule: 'அட்டவணையைச் சேமி', scheduleSaved: 'அட்டவணை சேமிக்கப்பட்டது.', raiseH: 'அடுத்த பணியை எழுப்பு', dueOn: 'செய்ய வேண்டிய நாள்', raise: 'பணியை எழுப்பு', raised: 'பணி எழுப்பப்பட்டது; முடியும் வரை வசதிகள் பக்கத்தில் தெரியும்.',
    cat_cleaning: 'சுத்தம்', cat_pest_control: 'பூச்சி கட்டுப்பாடு', cat_fire_safety: 'தீ பாதுகாப்பு', cat_electrical_safety: 'மின் பாதுகாப்பு', cat_maintenance: 'பராமரிப்பு', cat_statutory: 'சட்டப்படியான சோதனை',
    f_daily: 'தினமும்', f_weekly: 'வாரந்தோறும்', f_monthly: 'மாதந்தோறும்', f_quarterly: 'மூன்று மாதத்திற்கு ஒருமுறை', f_half_yearly: 'ஆறு மாதத்திற்கு ஒருமுறை', f_annual: 'ஆண்டுதோறும்',
    emptySchedules: 'இன்னும் அட்டவணை அமைக்கப்படவில்லை', emptySchedulesDetail: 'பூச்சி கட்டுப்பாடு, தீயணைப்பான், சுத்தம், மின் சோதனைகளை அமையுங்கள். அட்டவணை இல்லை என்பது தாமதம் இல்லை என்பதல்ல.',
    checksH: 'உணவுப் பாதுகாப்புச் சோதனைகள்', checkRegister: 'நடைமுறையில் உள்ள சோதனைகள்', colEvery: 'இடைவெளி', colLimits: 'வரம்புகள் (°C)', colItems: 'பொருட்கள்',
    checkFormH: 'உணவுப் பாதுகாப்புச் சோதனையைச் சேர் அல்லது மாற்று', checkTitle: 'என்ன சோதிக்கப்படுகிறது', checkKind: 'சோதனை வகை', everyMinutes: 'இடைவெளி (நிமிடங்கள்)', startsAt: 'முதல் சோதனை நேரம்', checkGrace: 'தவறியதாகக் கணக்கிடும் முன் நிமிடங்கள்', items: 'டிக் செய்ய வேண்டியவை (வரிக்கு ஒன்று)', equipment: 'எந்த அறை அல்லது அலமாரி (விருப்பம்)',
    saveCheck: 'சோதனையைச் சேமி', checkSaved: 'சோதனை சேமிக்கப்பட்டது. மாற்றம் இனிமேல் கணக்கிடப்படும்; ஏற்கனவே தவறியது தவறியதாகவே இருக்கும்.', checkUnchanged: 'எதுவும் மாறவில்லை — நடைமுறைச் சோதனை அதுவே.',
    ck_temperature: 'வெப்பநிலை', ck_equipment: 'உபகரணம்', ck_cleaning: 'சுத்தம்', ck_receiving: 'சரக்கு வரவு (ஒவ்வொரு டெலிவரிக்கும்)', perDelivery: 'ஒவ்வொரு டெலிவரியும்', minutesShort: 'நிமி',
    emptyChecks: 'இன்னும் உணவுப் பாதுகாப்புச் சோதனை வரையறுக்கப்படவில்லை', emptyChecksDetail: 'குளிர்சாதன வெப்பநிலைச் சோதனைகளையும் சுத்தப் பட்டியல்களையும் வரையறுங்கள். சோதனை இல்லை என்பது எல்லாம் தேர்ச்சி என்பதல்ல.',
    saving: 'சேமிக்கிறது…', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', noStore: 'இந்தக் கடைக் கணினி எந்தக் கடை என்று சொல்லவில்லை, எனவே எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு வசதிகள் அமைப்பின் இந்தப் பகுதியைப் பார்க்க முடியாது.', cannotManage: 'இதைப் பார்க்கலாம்; மாற்ற கடை மேலாளர் அனுமதி தேவை.',
    needName: 'பெயரை நிரப்புங்கள்.', needDate: 'நாளை YYYY-MM-DD என்று தட்டச்சு செய்யுங்கள்.', badNumber: 'முழு எண்ணைத் தட்டச்சு செய்யுங்கள்.', badTemperature: 'வெப்பநிலையை °C இல் தட்டச்சு செய்யுங்கள், எ.கா. 3.5 அல்லது -18.', rangeInverted: 'அதிகபட்சம் குறைந்தபட்சத்தை விடக் குறைவாக உள்ளது.', needItems: 'டிக் செய்ய குறைந்தது ஒன்றைத் தட்டச்சு செய்யுங்கள்.', needRole: 'எந்தப் பங்கு செய்கிறது என்று சொல்லுங்கள்.', needEscalation: 'தவறினால் யாரிடம் சொல்வது என்று சொல்லுங்கள்.', needSchedule: 'எவ்வளவு அடிக்கடி, முதல் சோதனை எப்போது என்று சொல்லுங்கள்.', needReason: 'ஏன் என்று சொல்லுங்கள்.', needQty: 'எத்தனை என்று தட்டச்சு செய்யுங்கள் (முழு எண், 0 அல்ல).',
  },
} as const;

export const facilitiesSetupWords = (lang: Lang, key: string): string =>
  (FACILITIES_SETUP_COPY[lang] as Record<string, string>)[key] ?? (FACILITIES_SETUP_COPY.en as Record<string, string>)[key] ?? key;
export const facilitiesSetupOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => facilitiesSetupWords(lang, k), out);

export interface FacilitiesSetupRead {
  readonly assets: SetupOutcome<readonly AssetRow[]>;
  readonly rooms: SetupOutcome<readonly RoomRow[]>;
  readonly spares: SetupOutcome<{ readonly kept: boolean; readonly rows: readonly SpareRow[] }>;
  readonly schedules: SetupOutcome<readonly ScheduleRow[]>;
  readonly checks: SetupOutcome<readonly CheckRow[]>;
}

export interface AssetInput { readonly assetId?: string; readonly name: string; readonly kind: string; readonly criticality: string; readonly installedOn: string; readonly warrantyUntil: string; readonly amcUntil: string; readonly amcVendor: string; readonly serviceEveryDays: string; readonly protectsValue: string; readonly active: boolean }
export interface ServiceInput { readonly performedOn: string; readonly performedBy: string; readonly kind: string; readonly notes: string; readonly cost: string; readonly spares: Readonly<Record<string, string>> }
export interface SpareInput { readonly sparePartId?: string; readonly name: string; readonly unit: string; readonly minimumLevel: string; readonly compatibleAssetIds: readonly string[]; readonly active: boolean }
export interface RoomInput { readonly assetId: string; readonly name: string; readonly minC: string; readonly maxC: string; readonly graceMinutes: string; readonly expectEvery: string; readonly onBackup: boolean }
export interface ScheduleInput { readonly scheduleId?: string; readonly title: string; readonly category: string; readonly frequency: string; readonly assignedRole: string; readonly escalatesTo: string; readonly evidenceRequired: boolean; readonly verificationRequired: boolean; readonly escalateAfterDays: string; readonly assetId: string; readonly active: boolean }
export interface CheckInput { readonly checkId?: string; readonly title: string; readonly kind: string; readonly everyMinutes: string; readonly startsAt: string; readonly graceMinutes: string; readonly minC: string; readonly maxC: string; readonly items: string; readonly equipmentId: string; readonly assignedRole: string; readonly escalatesTo: string; readonly active: boolean }

export interface FacilitiesSetupSession {
  readonly may: { readonly named: boolean; readonly store: boolean; readonly readAssets: boolean; readonly manageAssets: boolean; readonly readSchedules: boolean; readonly manageSchedules: boolean; readonly raiseTasks: boolean };
  read(): Promise<FacilitiesSetupRead>;
  saveAsset(a: AssetInput): Promise<SetupOutcome<{ readonly assetId: string }>>;
  logService(assetId: string, s: ServiceInput): Promise<SetupOutcome<{ readonly serviceId: string }>>;
  saveSpare(s: SpareInput): Promise<SetupOutcome<{ readonly sparePartId: string }>>;
  receiveSpare(sparePartId: string, qty: string, on: string): Promise<SetupOutcome<{ readonly onHand: number }>>;
  correctSpare(sparePartId: string, qty: string, on: string, reason: string): Promise<SetupOutcome<{ readonly onHand: number }>>;
  saveRoom(r: RoomInput): Promise<SetupOutcome<{ readonly assetId: string }>>;
  saveSchedule(s: ScheduleInput): Promise<SetupOutcome<{ readonly scheduleId: string }>>;
  raiseTask(scheduleId: string, dueOn: string): Promise<SetupOutcome<{ readonly taskId: string }>>;
  saveCheck(c: CheckInput): Promise<SetupOutcome<{ readonly checkId: string; readonly unchanged: boolean }>>;
}

export function createFacilitiesSetupSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly storeId?: string; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): FacilitiesSetupSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const store = (input.storeId ?? '').trim();
  const may = {
    named, store: store !== '',
    readAssets: named && held.has('facilities.asset.read'), manageAssets: named && held.has('facilities.asset.manage'),
    readSchedules: named && held.has('facilities.overdue.read'), manageSchedules: named && held.has('facilities.schedule.manage'),
    raiseTasks: named && held.has('facilities.task.record'),
  };
  const call = makeCaller({ keyPrefix: 'facilities-setup', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const no = (why: Why): SetupOutcome<never> => ({ result: 'invalid', why });
  const gate = (need: keyof typeof may): SetupOutcome<never> | undefined => (!named ? no('nobody') : !may.store ? no('noStore') : !may[need] ? no(need.startsWith('read') ? 'cannotRead' : 'cannotManage') : undefined);
  const q = `branchId=${encodeURIComponent(store)}`;
  const enc = encodeURIComponent;
  const optDay = (s: string): string | undefined | false => (s.trim() === '' ? undefined : DAY.test(s.trim()) ? s.trim() : false);

  return {
    may,
    read: async () => {
      const officeGate = gate('readAssets');
      const schedGate = gate('readSchedules');
      const [office, spares, schedules, checks] = await Promise.all([
        officeGate ?? call<Record<string, unknown>>('GET', `/v1/facilities/office?${q}`),
        officeGate ?? call<Record<string, unknown>>('GET', `/v1/facilities/spares?${q}`),
        schedGate ?? call<Record<string, unknown>>('GET', `/v1/facilities/schedules?${q}`),
        schedGate ?? call<Record<string, unknown>>('GET', `/v1/facilities/food-safety/status?${q}`),
      ]);
      const assets: SetupOutcome<readonly AssetRow[]> = office.result !== 'ok' ? office : { result: 'ok', value: list(office.value['assets']).map((a) => ({
        assetId: str(a['assetId']), name: str(a['name']), kind: str(a['kind']), criticality: str(a['criticality']), installedOn: str(a['installedOn']), active: a['active'] !== false,
        warrantyUntil: strOrNull(a['warrantyUntil']), amcUntil: strOrNull(a['amcUntil']), amcVendor: strOrNull(a['amcVendor']), serviceEveryDays: numOrNull(a['serviceEveryDays']),
        lastServicedOn: strOrNull(a['lastServicedOn']), protectsValueMinor: numOrNull(a['protectsValueMinor']),
      })) };
      const rooms: SetupOutcome<readonly RoomRow[]> = office.result !== 'ok' ? office : { result: 'ok', value: list(office.value['equipment']).map((e) => {
        const r = isObj(e['range']) ? e['range'] : {};
        const state = isObj(e['assessment']) ? str(e['assessment']['state']) : '';
        return { assetId: str(e['assetId']), name: str(e['name']), onBackup: e['onBackup'] === true, minTenthsC: Number(r['minTenthsC'] ?? 0), maxTenthsC: Number(r['maxTenthsC'] ?? 0), graceMinutes: Number(r['graceMinutes'] ?? 0), expectEveryMinutes: numOrNull(r['expectEveryMinutes']), state };
      }) };
      const sparesOut: FacilitiesSetupRead['spares'] = spares.result !== 'ok' ? spares : { result: 'ok', value: { kept: spares.value['kept'] !== false, rows: list(spares.value['spares']).map((p) => ({
        sparePartId: str(p['sparePartId']), name: str(p['name']), unit: str(p['unit']), minimumLevel: Number(p['minimumLevel'] ?? 0),
        compatibleAssetIds: Array.isArray(p['compatibleAssetIds']) ? (p['compatibleAssetIds'] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
        active: p['active'] !== false, onHand: Number(p['onHand'] ?? 0), low: p['low'] === true,
        movements: list(p['movements']).map((m) => ({ kind: str(m['kind']), qty: Number(m['qty'] ?? 0), on: str(m['on']), by: str(m['by']), ...(typeof m['reason'] === 'string' ? { reason: m['reason'] } : {}), ...(typeof m['serviceId'] === 'string' ? { serviceId: m['serviceId'] } : {}), ...(typeof m['assetId'] === 'string' ? { assetId: m['assetId'] } : {}) })),
      })) } };
      const schedulesOut: FacilitiesSetupRead['schedules'] = schedules.result !== 'ok' ? schedules : { result: 'ok', value: list(schedules.value['schedules']).map((s) => ({
        scheduleId: str(s['scheduleId']), title: str(s['title']), category: str(s['category']), frequency: str(s['frequency']), assignedRole: str(s['assignedRole']), escalatesTo: str(s['escalatesTo']),
        evidenceRequired: s['evidenceRequired'] === true, verificationRequired: s['verificationRequired'] === true, escalateAfterDays: numOrNull(s['escalateAfterDays']), assetId: strOrNull(s['assetId']),
        active: s['active'] !== false, tasksRaised: Number(s['tasksRaised'] ?? 0), lastDueOn: strOrNull(s['lastDueOn']), open: Number(s['open'] ?? 0),
      })) };
      const checksOut: FacilitiesSetupRead['checks'] = checks.result !== 'ok' ? checks : { result: 'ok', value: list(checks.value['checks']).map((c) => ({
        checkId: str(c['checkId']), title: str(c['title']), kind: str(c['kind']), everyMinutes: numOrNull(c['everyMinutes']), startsAt: strOrNull(c['startsAt']), graceMinutes: Number(c['graceMinutes'] ?? 0),
        minTenthsC: numOrNull(c['minTenthsC']), maxTenthsC: numOrNull(c['maxTenthsC']), items: list(c['items']).map((i) => ({ itemId: str(i['itemId']), label: str(i['label']) })),
        equipmentId: strOrNull(c['equipmentId']), assignedRole: str(c['assignedRole']), escalatesTo: str(c['escalatesTo']), active: c['active'] !== false, effectiveFrom: strOrNull(c['effectiveFrom']),
      })) };
      return { assets, rooms, spares: sparesOut, schedules: schedulesOut, checks: checksOut };
    },

    saveAsset: async (a) => {
      const g = gate('manageAssets'); if (g) return g;
      if (a.name.trim() === '') return no('needName');
      if (!DAY.test(a.installedOn.trim())) return no('needDate');
      const warranty = optDay(a.warrantyUntil); const amc = optDay(a.amcUntil);
      if (warranty === false || amc === false) return no('needDate');
      const every = a.serviceEveryDays.trim() === '' ? undefined : wholeOf(a.serviceEveryDays, { min: 1 });
      const protects = a.protectsValue.trim() === '' ? undefined : paiseOf(a.protectsValue);
      if (every === undefined && a.serviceEveryDays.trim() !== '') return no('badNumber');
      if (protects === undefined && a.protectsValue.trim() !== '') return no('badNumber');
      const assetId = a.assetId ?? newId('asset');
      const out = await call('POST', `/v1/facilities/assets/${enc(assetId)}`, {
        branchId: store, name: a.name.trim(), kind: a.kind, criticality: a.criticality, installedOn: a.installedOn.trim(), active: a.active,
        ...(warranty === undefined ? {} : { warrantyUntil: warranty }), ...(amc === undefined ? {} : { amcUntil: amc }),
        ...(a.amcVendor.trim() === '' ? {} : { amcVendor: a.amcVendor.trim() }), ...(every === undefined ? {} : { serviceEveryDays: every }), ...(protects === undefined ? {} : { protectsValueMinor: protects }),
      });
      return out.result === 'ok' ? { result: 'ok', value: { assetId } } : out;
    },

    logService: async (assetId, s) => {
      const g = gate('manageAssets'); if (g) return g;
      if (!DAY.test(s.performedOn.trim())) return no('needDate');
      if (s.performedBy.trim() === '') return no('needName');
      const cost = s.cost.trim() === '' ? undefined : paiseOf(s.cost);
      if (cost === undefined && s.cost.trim() !== '') return no('badNumber');
      const spares: { sparePartId: string; qty: number }[] = [];
      for (const [sparePartId, typed] of Object.entries(s.spares)) {
        if (typed.trim() === '' || typed.trim() === '0') continue;
        const qty = wholeOf(typed, { min: 1 });
        if (qty === undefined) return no('needQty');
        spares.push({ sparePartId, qty });
      }
      const serviceId = newId('svc');
      const out = await call('POST', `/v1/facilities/assets/${enc(assetId)}/services/${enc(serviceId)}`, {
        performedOn: s.performedOn.trim(), performedBy: s.performedBy.trim(), kind: s.kind,
        ...(s.notes.trim() === '' ? {} : { notes: s.notes.trim() }), ...(cost === undefined ? {} : { costMinor: cost }), ...(spares.length === 0 ? {} : { sparesUsed: spares }),
      });
      return out.result === 'ok' ? { result: 'ok', value: { serviceId } } : out;
    },

    saveSpare: async (s) => {
      const g = gate('manageAssets'); if (g) return g;
      if (s.name.trim() === '') return no('needName');
      const minimum = wholeOf(s.minimumLevel, { min: 0 });
      if (minimum === undefined) return no('badNumber');
      const sparePartId = s.sparePartId ?? newId('spare');
      const out = await call('POST', `/v1/facilities/spares/${enc(sparePartId)}`, {
        branchId: store, name: s.name.trim(), minimumLevel: minimum, compatibleAssetIds: [...s.compatibleAssetIds], active: s.active, ...(s.unit.trim() === '' ? {} : { unit: s.unit.trim() }),
      });
      return out.result === 'ok' ? { result: 'ok', value: { sparePartId } } : out;
    },

    receiveSpare: async (sparePartId, qty, on) => {
      const g = gate('manageAssets'); if (g) return g;
      const n = wholeOf(qty, { min: 1 });
      if (n === undefined) return no('needQty');
      if (!DAY.test(on.trim())) return no('needDate');
      const out = await call<{ onHand?: unknown }>('POST', `/v1/facilities/spares/${enc(sparePartId)}/movements/${enc(newId('rcv'))}`, { kind: 'received', qty: n, on: on.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { onHand: Number(out.value.onHand ?? 0) } } : out;
    },

    correctSpare: async (sparePartId, qty, on, reason) => {
      const g = gate('manageAssets'); if (g) return g;
      const n = wholeOf(qty.replace('−', '-').replace(/^\+/, ''), { signed: true });
      if (n === undefined || n === 0) return no('needQty');
      if (!DAY.test(on.trim())) return no('needDate');
      if (reason.trim() === '') return no('needReason');
      const out = await call<{ onHand?: unknown }>('POST', `/v1/facilities/spares/${enc(sparePartId)}/movements/${enc(newId('cnt'))}`, { kind: 'correction', qty: n, on: on.trim(), reason: reason.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { onHand: Number(out.value.onHand ?? 0) } } : out;
    },

    saveRoom: async (r) => {
      const g = gate('manageAssets'); if (g) return g;
      if (r.assetId.trim() === '' || r.name.trim() === '') return no('needName');
      const min = tenthsOf(r.minC); const max = tenthsOf(r.maxC);
      if (min === undefined || max === undefined) return no('badTemperature');
      if (max < min) return no('rangeInverted');
      const grace = wholeOf(r.graceMinutes, { min: 0 });
      const every = r.expectEvery.trim() === '' ? undefined : wholeOf(r.expectEvery, { min: 1 });
      if (grace === undefined || (every === undefined && r.expectEvery.trim() !== '')) return no('badNumber');
      const out = await call('POST', `/v1/facilities/equipment/${enc(r.assetId)}/range`, {
        branchId: store, name: r.name.trim(), minTenthsC: min, maxTenthsC: max, graceMinutes: grace, onBackup: r.onBackup, ...(every === undefined ? {} : { expectEveryMinutes: every }),
      });
      return out.result === 'ok' ? { result: 'ok', value: { assetId: r.assetId } } : out;
    },

    saveSchedule: async (s) => {
      const g = gate('manageSchedules'); if (g) return g;
      if (s.title.trim() === '') return no('needName');
      if (s.assignedRole.trim() === '') return no('needRole');
      if (s.escalatesTo.trim() === '') return no('needEscalation');
      const after = s.escalateAfterDays.trim() === '' ? undefined : wholeOf(s.escalateAfterDays, { min: 0 });
      if (after === undefined && s.escalateAfterDays.trim() !== '') return no('badNumber');
      const scheduleId = s.scheduleId ?? newId('sched');
      const out = await call('POST', `/v1/facilities/schedules/${enc(scheduleId)}`, {
        branchId: store, title: s.title.trim(), category: s.category, frequency: s.frequency, assignedRole: s.assignedRole.trim(), escalatesTo: s.escalatesTo.trim(),
        evidenceRequired: s.evidenceRequired, verificationRequired: s.verificationRequired, active: s.active,
        ...(after === undefined ? {} : { escalateAfterDays: after }), ...(s.assetId.trim() === '' ? {} : { assetId: s.assetId.trim() }),
      });
      return out.result === 'ok' ? { result: 'ok', value: { scheduleId } } : out;
    },

    raiseTask: async (scheduleId, dueOn) => {
      const g = gate('raiseTasks'); if (g) return g;
      if (!DAY.test(dueOn.trim())) return no('needDate');
      // one task per schedule and due day: the same day raised twice is one task
      const taskId = `${scheduleId}-${dueOn.trim()}`;
      const out = await call('POST', `/v1/facilities/schedules/${enc(scheduleId)}/tasks/${enc(taskId)}`, { dueOn: dueOn.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { taskId } } : out;
    },

    saveCheck: async (c) => {
      const g = gate('manageSchedules'); if (g) return g;
      if (c.title.trim() === '') return no('needName');
      if (c.assignedRole.trim() === '') return no('needRole');
      if (c.escalatesTo.trim() === '') return no('needEscalation');
      const grace = wholeOf(c.graceMinutes, { min: 0 });
      if (grace === undefined) return no('badNumber');
      const scheduled = c.kind !== 'receiving';
      let every: number | undefined; let startsAt: string | undefined;
      if (scheduled) {
        every = wholeOf(c.everyMinutes, { min: 1 });
        const t = Date.parse(c.startsAt.trim());
        if (every === undefined || c.startsAt.trim() === '' || Number.isNaN(t)) return no('needSchedule');
        startsAt = new Date(t).toISOString();
      }
      let min: number | undefined; let max: number | undefined;
      if (c.kind === 'temperature') {
        min = tenthsOf(c.minC); max = tenthsOf(c.maxC);
        if (min === undefined || max === undefined) return no('badTemperature');
        if (max < min) return no('rangeInverted');
      }
      const items = itemsOf(c.items);
      if (c.kind !== 'temperature' && items.length === 0) return no('needItems');
      const checkId = c.checkId ?? newId('fsc');
      const out = await call<{ unchanged?: unknown }>('POST', `/v1/facilities/food-safety/checks/${enc(checkId)}`, {
        branchId: store, title: c.title.trim(), kind: c.kind, graceMinutes: grace, items, assignedRole: c.assignedRole.trim(), escalatesTo: c.escalatesTo.trim(), active: c.active,
        ...(every === undefined ? {} : { everyMinutes: every }), ...(startsAt === undefined ? {} : { startsAt }),
        ...(min === undefined ? {} : { minTenthsC: min }), ...(max === undefined ? {} : { maxTenthsC: max }), ...(c.equipmentId.trim() === '' ? {} : { equipmentId: c.equipmentId.trim() }),
      });
      return out.result === 'ok' ? { result: 'ok', value: { checkId, unchanged: out.value.unchanged === true } } : out;
    },
  };
}
