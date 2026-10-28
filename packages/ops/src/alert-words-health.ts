// OB-435: the health engine's words (`checkHealth`, the escalation sweep) and the frame every alert is shown and sent in
// (its component, its status, the text message), in English and Tamil. The English is word for word what it was before.

import { s, n, b, type AlertTemplate, type Shown } from './alert-text';

/** A length of time from seconds, as the health engine always said it ("45s", "12 min", "3h 5m", "2 days"). */
export function durationEn(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)} days`;
}
/** The same in Tamil. */
export function durationTa(seconds: number): string {
  if (seconds < 60) return `${seconds} வினாடி`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} நிமிடம்`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} மணி ${Math.floor((seconds % 3_600) / 60)} நிமிடம்`;
  return `${Math.floor(seconds / 86_400)} நாள்`;
}

/** The four health statuses, as a person reads them. */
const STATUS_TA: Readonly<Record<string, string>> = { ok: 'சரி', degraded: 'குறைபாடு உள்ளது', down: 'செயலிழந்தது', unknown: 'தெரியவில்லை' };

/** A component's name in Tamil (English keeps the name the alert was raised under, as it always did). */
const COMPONENT_TA: Readonly<Record<string, string>> = {
  sync: 'ஒத்திசைவு',
  queue: 'அனுப்பும் வரிசை',
  dead_letter: 'அனுப்ப முடியாமல் நின்றவை',
  catalogue: 'விலைப் பட்டியல்',
  database: 'மேகத் தரவுத்தளம்',
  local_store: 'கவுண்டரின் பதிவு',
  backup: 'காப்புப் பிரதி',
  access_separation_of_duties: 'பணிப் பிரிப்பு (அணுகல்)',
  bill_number_high_water: 'பில் எண் கணக்கீடு',
  box_history: 'கடை கணினிகளின் சேமித்த வரலாறு',
  box_history_saving: 'சேமித்த வரலாற்றைச் சேமித்தல்',
  box_history_seal: 'சேமித்த வரலாற்றின் முத்திரை',
  box_history_build: 'சேமித்த வரலாற்றை உருவாக்குதல்',
  store_computer_checks_stuck: 'கடை கணினிச் சோதனைகள்',
  box_clock_held: 'கடை கணினிக் கடிகாரம் — விலை மாற்றம் நிறுத்தம்',
};
const PER_STORE_TA: Readonly<Record<string, (store: string) => string>> = {
  box_disk: (x) => `கடை ${x} கணினியின் வட்டு`,
  box_queue: (x) => `கடை ${x} கணினியின் அனுப்பும் வரிசை`,
  till_devices: (x) => `கடை ${x} கவுண்டர் கருவிகள்`,
  box_clock: (x) => `கடை ${x} கணினியின் கடிகாரம்`,
  box_time_zone: (x) => `கடை ${x} கணினியின் நேர மண்டலம்`,
  box_bill_numbers: (x) => `கடை ${x} பில் எண்கள்`,
  box_unused_numbers: (x) => `கடை ${x} பயன்படுத்தாத பில் எண்கள்`,
  box_prefixes_refused: (x) => `கடை ${x} மறுக்கப்பட்ட பில் எண் முன்னொட்டுகள்`,
  integration: (x) => `இணைப்பு ${x}`,
};
/** A health component's name in Tamil; a name it does not know is kept as it is (never blank). */
export function componentTa(component: string): string {
  const whole = COMPONENT_TA[component];
  if (whole !== undefined) return whole;
  const i = component.indexOf(':');
  const per = i < 0 ? undefined : PER_STORE_TA[component.slice(0, i)];
  return per === undefined ? component : per(component.slice(i + 1));
}

const dur = (lang: 'en' | 'ta', v: Shown | undefined): string => (lang === 'en' ? durationEn(n(v)) : durationTa(n(v)));

export const HEALTH_WORDS = {
  // ── the frame: a component, a status, a text message ──────────────────────────────────────────────────────────────
  'alert.component': {
    en: (p) => s(p['component']),
    ta: (p) => componentTa(s(p['component'])),
    sample: { component: 'box_disk:store-1' },
  },
  'alert.status': {
    en: (p) => s(p['status']),
    ta: (p) => STATUS_TA[s(p['status'])] ?? s(p['status']),
    sample: { status: 'down' },
  },
  'alert.sms.raised': {
    en: (p) => `${b(p['updated']) ? 'UPDATED: ' : ''}${s(p['component'])} is ${s(p['status'])} — ${s(p['detail'])}. Please acknowledge by ${s(p['ackDueBy'])}.`,
    ta: (p) => `${b(p['updated']) ? 'புதுப்பிப்பு: ' : ''}${s(p['component'])} — ${s(p['status'])}: ${s(p['detail'])}. ${s(p['ackDueBy'])} க்குள் பார்த்ததாக ஒப்புக்கொள்ளுங்கள்.`,
    sample: { updated: true, component: 'backup', status: 'down', detail: 'no backup has ever been reported', ackDueBy: '2026-10-28T10:15:00Z' },
  },
  'alert.sms.escalated': {
    en: (p) => `ESCALATED to you: ${s(p['component'])} is ${s(p['status'])} — ${s(p['detail'])}. ${s(p['ownerName'])} has not acknowledged it.`,
    ta: (p) => `உங்களுக்கு மேலே அனுப்பப்பட்டது: ${s(p['component'])} — ${s(p['status'])}: ${s(p['detail'])}. ${s(p['ownerName'])} இதை இன்னும் ஒப்புக்கொள்ளவில்லை.`,
    sample: { component: 'backup', status: 'down', detail: 'no backup has ever been reported', ownerName: 'Store Manager One' },
  },

  // ── checkHealth (packages/ops/src/health.ts) ─────────────────────────────────────────────────────────────────────
  'health.sync.never': {
    en: () => 'nothing has ever reported a successful sync — that is not the same as being up to date',
    ta: () => 'இதுவரை எதுவும் வெற்றிகரமான ஒத்திசைவைத் தெரிவிக்கவில்லை — அது "எல்லாம் புதுப்பித்த நிலையில் உள்ளது" என்பதற்குச் சமம் அல்ல',
    sample: {},
  },
  'health.sync.ok': {
    en: (p) => `last synced ${dur('en', p['lagSeconds'])} ago`,
    ta: (p) => `கடைசியாக ${dur('ta', p['lagSeconds'])} முன்பு ஒத்திசைந்தது`,
    sample: { lagSeconds: 125 },
  },
  'health.sync.behind': {
    en: (p) => `nothing has reached the cloud for ${dur('en', p['lagSeconds'])} — the store is still trading, but head-office figures are that old`,
    ta: (p) => `கடந்த ${dur('ta', p['lagSeconds'])} இல் எதுவும் தலைமை அலுவலகத்தை (cloud) அடையவில்லை — கடை விற்பனை தொடர்கிறது, ஆனால் தலைமை அலுவலக எண்ணிக்கைகள் அவ்வளவு பழையவை`,
    sample: { lagSeconds: 4_000 },
  },
  'health.queue.unknown': {
    en: () => 'the outbox has not reported its depth',
    ta: () => 'அனுப்பும் வரிசை தன்னில் எத்தனை உள்ளன என்று இன்னும் தெரிவிக்கவில்லை',
    sample: {},
  },
  'health.queue.empty': {
    en: () => 'everything has been sent',
    ta: () => 'எல்லாம் அனுப்பப்பட்டுவிட்டது',
    sample: {},
  },
  'health.queue.waiting': {
    en: (p) => `${n(p['depth'])} item(s) waiting to send${b(p['notDraining']) ? ' — the queue is not draining' : ''}`,
    ta: (p) => `${n(p['depth'])} பதிவு(கள்) அனுப்பக் காத்திருக்கின்றன${b(p['notDraining']) ? ' — வரிசை குறையவில்லை' : ''}`,
    sample: { depth: 140, notDraining: true },
  },
  'health.deadLetter.unknown': {
    en: () => 'dead letters have not been reported',
    ta: () => 'அனுப்ப முடியாமல் நின்றவை இன்னும் தெரிவிக்கப்படவில்லை',
    sample: {},
  },
  'health.deadLetter.none': {
    en: () => 'nothing is stuck',
    ta: () => 'எதுவும் சிக்கி நிற்கவில்லை',
    sample: {},
  },
  'health.deadLetter.some': {
    en: (p) => `${n(p['count'])} item(s) could not be sent and are waiting for a person — each one is a real sale, receipt or order`,
    ta: (p) => `${n(p['count'])} பதிவு(கள்) அனுப்ப முடியாமல் ஒருவருக்காகக் காத்திருக்கின்றன — ஒவ்வொன்றும் உண்மையான விற்பனை, ரசீது அல்லது ஆர்டர்`,
    sample: { count: 2 },
  },
  'health.catalogue.stale': {
    en: (p) => `prices on the lane are ${dur('en', p['ageSeconds'])} old — a price changed today may not be here`,
    ta: (p) => `கவுண்டரில் உள்ள விலைகள் ${dur('ta', p['ageSeconds'])} பழையவை — இன்று மாற்றிய விலை இங்கு இல்லாமல் இருக்கலாம்`,
    sample: { ageSeconds: 20_000 },
  },
  'health.catalogue.fresh': {
    en: (p) => `prices are ${dur('en', p['ageSeconds'])} old`,
    ta: (p) => `விலைகள் ${dur('ta', p['ageSeconds'])} பழையவை`,
    sample: { ageSeconds: 600 },
  },
  'health.database.ok': {
    en: () => 'cloud database reachable',
    ta: () => 'மேகத் தரவுத்தளத்தை அணுக முடிகிறது',
    sample: {},
  },
  'health.database.unreachable': {
    en: () => 'cloud database not reachable — the store keeps trading locally and work is queued',
    ta: () => 'மேகத் தரவுத்தளத்தை அணுக முடியவில்லை — கடை உள்ளூரிலேயே விற்பனையைத் தொடர்கிறது; வேலைகள் வரிசையில் காத்திருக்கின்றன',
    sample: {},
  },
  'health.localStore.ok': {
    en: () => 'the lane can record sales',
    ta: () => 'இந்தக் கவுண்டர் விற்பனையைப் பதிவு செய்ய முடியும்',
    sample: {},
  },
  'health.localStore.cannot': {
    en: () => 'the lane CANNOT record a sale — stop selling on this lane; an unrecorded sale is worse than a refused one',
    ta: () => 'இந்தக் கவுண்டரால் விற்பனையைப் பதிவு செய்ய முடியாது — இந்தக் கவுண்டரில் விற்பனையை நிறுத்துங்கள்; பதிவாகாத விற்பனை, மறுக்கப்பட்ட விற்பனையை விட மோசமானது',
    sample: {},
  },
  'health.backup.never': {
    en: () => 'no backup has ever been reported — this is the one to fix before anything else',
    ta: () => 'இதுவரை எந்தக் காப்புப் பிரதியும் தெரிவிக்கப்படவில்லை — மற்ற எதற்கும் முன் இதைச் சரிசெய்யுங்கள்',
    sample: {},
  },
  'health.backup.overdue': {
    en: (p) => `the last backup was ${dur('en', p['ageSeconds'])} ago — a stale backup is a silent disaster`,
    ta: (p) => `கடைசி காப்புப் பிரதி ${dur('ta', p['ageSeconds'])} முன்பு எடுக்கப்பட்டது — பழைய காப்புப் பிரதி சத்தமில்லாத பேரழிவு`,
    sample: { ageSeconds: 200_000 },
  },
  'health.backup.recent': {
    en: (p) => `last backup ${dur('en', p['ageSeconds'])} ago`,
    ta: (p) => `கடைசி காப்புப் பிரதி ${dur('ta', p['ageSeconds'])} முன்பு`,
    sample: { ageSeconds: 3_700 },
  },
  'health.integration.ok': {
    en: () => 'responding',
    ta: () => 'பதில் அளிக்கிறது',
    sample: {},
  },
  'health.integration.down': {
    en: (p) => `${s(p['name'])} is not responding — work is queued, not lost`,
    ta: (p) => `${s(p['name'])} பதில் அளிக்கவில்லை — வேலைகள் வரிசையில் உள்ளன, இழக்கப்படவில்லை`,
    sample: { name: 'sms-gateway' },
  },

  // ── the escalation sweep (escalateUnacknowledged) ────────────────────────────────────────────────────────────────
  'alert.escalate.nowhere': {
    en: (p) => `nobody is configured above ${s(p['ownerName'])} — this alert has nowhere to escalate to`,
    ta: (p) => `${s(p['ownerName'])} க்கு மேல் யாரும் அமைக்கப்படவில்லை — இந்த எச்சரிக்கையை மேலே அனுப்ப இடமில்லை`,
    sample: { ownerName: 'Store Manager One' },
  },
  'alert.escalate.to': {
    en: (p) => `${s(p['ownerName'])} has not acknowledged in time; escalated to ${s(p['to'])}`,
    ta: (p) => `${s(p['ownerName'])} உரிய நேரத்தில் ஒப்புக்கொள்ளவில்லை; ${s(p['to'])} க்கு மேலே அனுப்பப்பட்டது`,
    sample: { ownerName: 'Store Manager One', to: 'u-owner-1' },
  },
} as const satisfies Readonly<Record<string, AlertTemplate>>;
