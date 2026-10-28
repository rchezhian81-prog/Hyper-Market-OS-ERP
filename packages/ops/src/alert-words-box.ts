// OB-435: the words of the store computers' health at head office (services/platform/src/box-health.ts) — their disks,
// queues, tills, clocks, time zones, bill numbers and saved history — in English and Tamil. The English is word for word
// what it was before; a till's own device message, an error a machine reported and a machine's own reason are kept as
// they were said (verbatim in both languages).

import { s, n, b, l, opt, type AlertTemplate, type Shown, type AlertLang } from './alert-text';

type L = AlertLang;
const pad6 = (x: number): string => String(x).padStart(6, '0');
/** Ranges travel as a flat list of numbers [from1, to1, from2, to2, …]. */
const pairs = (v: Shown | undefined): [number, number][] => {
  const xs = l(v).map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i]!, xs[i + 1]!]);
  return out;
};
/** Bill numbers as the till prints them: "R-1-000012 to R-1-000015, R-1-000020" (Tamil: "… முதல் … வரை"). */
export function rangeWordsIn(lang: L, prefix: string, ranges: readonly (readonly [number, number])[]): string {
  return ranges.map(([a, z]) => (a === z ? `${prefix}${pad6(a)}` : lang === 'en' ? `${prefix}${pad6(a)} to ${prefix}${pad6(z)}` : `${prefix}${pad6(a)} முதல் ${prefix}${pad6(z)} வரை`)).join(', ');
}
const rw = (lang: L, p: Readonly<Record<string, Shown>>, key = 'ranges'): string => rangeWordsIn(lang, s(p['prefix']), pairs(p[key]));
/** Flatten ranges for a parameter. */
export const flatRanges = (ranges: readonly (readonly [number, number])[]): number[] => ranges.flatMap(([a, z]) => [a, z]);
const mb = (bytes: Shown | undefined): string => `${Math.floor(n(bytes) / 1_048_576)} MB`;
/** How long ago, as the store computer page always said it ("12 min", "3h 5m"). */
const ago = (lang: L, sec: Shown | undefined): string => {
  const x = n(sec);
  if (lang === 'en') return x < 3_600 ? `${Math.floor(x / 60)} min` : `${Math.floor(x / 3_600)}h ${Math.floor((x % 3_600) / 60)}m`;
  return x < 3_600 ? `${Math.floor(x / 60)} நிமிடம்` : `${Math.floor(x / 3_600)} மணி ${Math.floor((x % 3_600) / 60)} நிமிடம்`;
};
/** A length of time in the owner's words ("9 hours 20 minutes", "45 minutes"), from milliseconds. */
export function durationWordsIn(lang: L, ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (lang === 'ta') return h === 0 ? `${m} நிமிடம்` : `${h} மணி${m === 0 ? '' : ` ${m} நிமிடம்`}`;
  if (h === 0) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${h} hour${h === 1 ? '' : 's'}${m === 0 ? '' : ` ${m} minute${m === 1 ? '' : 's'}`}`;
}
const DEVICE_TA: Readonly<Record<string, string>> = { scanner: 'ஸ்கேனர்', printer: 'அச்சுப்பொறி', scale: 'எடைத் தராசு', cash_drawer: 'பணப் பெட்டி', card_terminal: 'அட்டை இயந்திரம்' };
/** Offers and prices held on a store computer: "offer P1, price X9" / "சலுகை P1, விலை X9". */
const heldList = (lang: L, p: Readonly<Record<string, Shown>>): string[] => [
  ...l(p['offers']).map((id) => (lang === 'en' ? `offer ${id}` : `சலுகை ${id}`)),
  ...l(p['prices']).map((id) => (lang === 'en' ? `price ${id}` : `விலை ${id}`)),
];
const SAMPLE_RANGES = [12, 15, 20, 20];

const STAYS_NOT_CHECKED_EN = 'This stays until the owner or head office staff (all-stores authority — a store\'s own manager cannot, and neither can the IT/platform administrator) acknowledge it with a reason, after support has compared the restore record. The acknowledgement holds while the store computer keeps reporting this same set of not-checked numbers; a different set needs a new acknowledgement';
const STAYS_NOT_CHECKED_TA = 'உதவிக் குழு மீட்டெடுப்புப் பதிவை ஒப்பிட்ட பின், உரிமையாளர் அல்லது தலைமை அலுவலகப் பணியாளர் (எல்லாக் கடைகளுக்குமான அதிகாரம் — கடையின் சொந்த மேலாளரோ IT/தள நிர்வாகியோ முடியாது) காரணத்துடன் ஒப்புக்கொள்ளும் வரை இது இருக்கும். கடை கணினி இதே சரிபார்க்காத எண்களைத் தொடர்ந்து தெரிவிக்கும் வரை அந்த ஒப்புதல் செல்லும்; வேறு எண்களுக்குப் புதிய ஒப்புதல் தேவை';
const STAYS_UNUSED_EN = 'This stays until the owner or head office staff (all-stores authority — a store\'s own manager cannot, and neither can the IT/platform administrator) acknowledge it with a reason, after support has checked the store computer. The acknowledgement holds while head office finds this same set of numbers; a new number needs a new acknowledgement';
const STAYS_UNUSED_TA = 'உதவிக் குழு கடை கணினியைச் சரிபார்த்த பின், உரிமையாளர் அல்லது தலைமை அலுவலகப் பணியாளர் (எல்லாக் கடைகளுக்குமான அதிகாரம் — கடையின் சொந்த மேலாளரோ IT/தள நிர்வாகியோ முடியாது) காரணத்துடன் ஒப்புக்கொள்ளும் வரை இது இருக்கும். தலைமை அலுவலகம் இதே எண்களைக் காணும் வரை அந்த ஒப்புதல் செல்லும்; புதிய எண்ணுக்குப் புதிய ஒப்புதல் தேவை';
const STAYS_REFUSAL_EN = 'This stays until head office has banked that many, or the owner or head office staff (all-stores authority — a store\'s own manager cannot, and neither can the IT/platform administrator) acknowledge this count with a reason. The acknowledgement holds while the store computer keeps reporting this same count; a different count needs a new acknowledgement';
const STAYS_REFUSAL_TA = 'தலைமை அலுவலகம் அத்தனை பில்களைப் பெறும் வரை, அல்லது உரிமையாளர் அல்லது தலைமை அலுவலகப் பணியாளர் (எல்லாக் கடைகளுக்குமான அதிகாரம் — கடையின் சொந்த மேலாளரோ IT/தள நிர்வாகியோ முடியாது) இந்த எண்ணிக்கையைக் காரணத்துடன் ஒப்புக்கொள்ளும் வரை இது இருக்கும். கடை கணினி இதே எண்ணிக்கையைத் தொடர்ந்து தெரிவிக்கும் வரை அந்த ஒப்புதல் செல்லும்; வேறு எண்ணிக்கைக்குப் புதிய ஒப்புதல் தேவை';
const NO_PAPER_LISTS_EN = 'Do NOT re-enter any of them from paper until a person has checked the store computer\'s "waiting to send" and "gave up sending" lists';
const NO_PAPER_LISTS_TA = 'கடை கணினியின் "அனுப்பக் காத்திருப்பவை", "அனுப்புவதைக் கைவிட்டவை" பட்டியல்களை ஒருவர் சரிபார்க்கும் வரை, இவற்றில் எதையும் காகிதப் பில்களிலிருந்து மீண்டும் பதிவு செய்ய வேண்டாம்';

export const BOX_WORDS = {
  // ── the long-standing sentences other words point to ────────────────────────────────────────────────────────────
  'box.stays.notChecked': { en: () => STAYS_NOT_CHECKED_EN, ta: () => STAYS_NOT_CHECKED_TA, sample: {} },
  'box.stays.unused': { en: () => STAYS_UNUSED_EN, ta: () => STAYS_UNUSED_TA, sample: {} },
  'box.stays.refusal': { en: () => STAYS_REFUSAL_EN, ta: () => STAYS_REFUSAL_TA, sample: {} },

  // ── stale reports ───────────────────────────────────────────────────────────────────────────────────────────────
  'box.staleNote': {
    en: (p) => `STALE — store ${s(p['storeId'])}'s computer last reported ${ago('en', p['agoSeconds'])} ago (${s(p['at'])}); it has not been heard from since, so this is old news, not the state now`,
    ta: (p) => `பழைய தகவல் — கடை ${s(p['storeId'])} இன் கணினி கடைசியாக ${ago('ta', p['agoSeconds'])} முன்பு (${s(p['at'])}) தெரிவித்தது; அதன் பிறகு எதுவும் வரவில்லை, எனவே இது பழைய செய்தி, இப்போதைய நிலை அல்ல`,
    sample: { storeId: 'store-1', agoSeconds: 4_000, at: '2026-10-28T08:00:00Z' },
  },
  'box.stale.then': {
    en: (p) => `${s(p['stale'])}. Then: ${s(p['then'])}`,
    ta: (p) => `${s(p['stale'])}. அப்போது: ${s(p['then'])}`,
    sample: { stale: { kind: 'box.staleNote', params: { storeId: 'store-1', agoSeconds: 4_000, at: '2026-10-28T08:00:00Z' } }, then: { kind: 'box.zone.same', params: { storeId: 'store-1', shop: 'Asia/Kolkata' } } },
  },

  // ── bills waiting on a store computer past the owner's line ─────────────────────────────────────────────────────
  'box.waiting.unsaid': {
    en: (p) => `bills may be waiting on the store computer for ${n(p['hours'])} hours: store ${s(p['storeId'])}'s computer has said since ${s(p['since'])} that its queue holds item(s) still to send (${n(p['unsent'])} now), and it does not say which bills under ${s(p['prefix'])} they are (an older or altered store computer) — longer than the ${n(p['warnHours'])}-hour line. Head office no longer takes that as a reason to hold back: any bill under ${s(p['prefix'])} it has not received is checked as never received. Check that store computer's connection and its "waiting to send" count, and call support. Do NOT re-enter bills from paper until support has checked the store computer`,
    ta: (p) => `பில்கள் ${n(p['hours'])} மணி நேரமாகக் கடை கணினியில் காத்திருக்கலாம்: கடை ${s(p['storeId'])} இன் கணினி ${s(p['since'])} முதல் தன் வரிசையில் அனுப்ப வேண்டியவை உள்ளன என்கிறது (இப்போது ${n(p['unsent'])}), ஆனால் ${s(p['prefix'])} இன் கீழ் எந்தப் பில்கள் என்று சொல்லவில்லை (பழைய அல்லது மாற்றப்பட்ட கடை கணினி) — ${n(p['warnHours'])} மணி நேர வரம்பை விட அதிகம். இனி தலைமை அலுவலகம் அதற்காகக் காத்திருக்காது: ${s(p['prefix'])} இன் கீழ் பெறாத எந்தப் பில்லும் "ஒருபோதும் பெறப்படவில்லை" என்று சரிபார்க்கப்படும். அந்தக் கடை கணினியின் இணைப்பையும் "அனுப்பக் காத்திருப்பவை" எண்ணிக்கையையும் சரிபார்த்து, உதவிக் குழுவை அழையுங்கள். உதவிக் குழு கடை கணினியைச் சரிபார்க்கும் வரை காகிதப் பில்களிலிருந்து மீண்டும் பதிவு செய்ய வேண்டாம்`,
    sample: { hours: 3, storeId: 'store-1', since: '2026-10-28T06:00:00Z', unsent: 4, prefix: 'R-1-', warnHours: 2 },
  },
  'box.waiting.list': {
    en: (p) => `bills waiting on the store computer for ${n(p['hours'])} hours: store ${s(p['storeId'])}'s computer has held ${n(p['count'])} bill(s) under ${s(p['prefix'])} (between ${rw('en', p)}) unsent since ${s(p['since'])}; ${s(p['first'])}, and they are still said to be waiting — longer than the ${n(p['warnHours'])}-hour line. Head office has not received them. Check that store computer's connection and its "waiting to send" count; if the count is not going down, call support. Do NOT re-enter these bills from paper until support has checked the store computer`,
    ta: (p) => `பில்கள் ${n(p['hours'])} மணி நேரமாகக் கடை கணினியில் காத்திருக்கின்றன: கடை ${s(p['storeId'])} இன் கணினி ${s(p['prefix'])} இன் கீழ் ${n(p['count'])} பில்(களை) (${rw('ta', p)} இடையே) ${s(p['since'])} முதல் அனுப்பாமல் வைத்திருக்கிறது; ${s(p['first'])}; அவை இன்னும் காத்திருப்பதாகவே சொல்லப்படுகிறது — ${n(p['warnHours'])} மணி நேர வரம்பை விட அதிகம். தலைமை அலுவலகம் அவற்றைப் பெறவில்லை. அந்தக் கடை கணினியின் இணைப்பையும் "அனுப்பக் காத்திருப்பவை" எண்ணிக்கையையும் சரிபார்க்கவும்; எண்ணிக்கை குறையவில்லை என்றால் உதவிக் குழுவை அழையுங்கள். உதவிக் குழு கடை கணினியைச் சரிபார்க்கும் வரை இந்தப் பில்களைக் காகிதத்திலிருந்து மீண்டும் பதிவு செய்ய வேண்டாம்`,
    sample: { hours: 3, storeId: 'store-1', count: 4, prefix: 'R-1-', ranges: [12, 15], since: '2026-10-28T06:00:00Z', first: { kind: 'box.waiting.firstSeen', params: { prefix: 'R-1-', ranges: [12, 15], observedSince: '2026-10-28T06:00:00Z' } }, warnHours: 2 },
  },
  'box.waiting.firstJoined': {
    en: (p) => `head office's clock for them runs from ${s(p['observedSince'])}, the first time a waiting list reached these numbers or the ones it keeps together with them (keeping them together keeps the earliest time, so this can only be a little early, never late)`,
    ta: (p) => `இவற்றுக்கான தலைமை அலுவலகக் கணக்கு ${s(p['observedSince'])} முதல் ஓடுகிறது — காத்திருப்புப் பட்டியல் இந்த எண்களையோ இவற்றுடன் சேர்த்து வைத்த எண்களையோ முதலில் தொட்ட நேரம் (சேர்த்து வைப்பது முதல் நேரத்தையே வைக்கும்; எனவே இது சற்று முன்னதாக இருக்கலாம், ஒருபோதும் தாமதமாக அல்ல)`,
    sample: { observedSince: '2026-10-28T06:00:00Z' },
  },
  'box.waiting.firstSeen': {
    en: (p) => `head office first saw ${rw('en', p)} said to be waiting at ${s(p['observedSince'])}`,
    ta: (p) => `${rw('ta', p)} காத்திருப்பதாகத் தலைமை அலுவலகம் முதலில் கண்டது ${s(p['observedSince'])} அன்று`,
    sample: { prefix: 'R-1-', ranges: [12, 15], observedSince: '2026-10-28T06:00:00Z' },
  },

  // ── the store computers' saved history ──────────────────────────────────────────────────────────────────────────
  'box.history.preparing': {
    en: (p) => `being prepared — store computer checks not yet available: head office is building the store computers' saved history (since ${s(p['since'])}, because ${s(p['why'])}). Until it is ready, the store computers' disks, queues, tills and bill numbers are NOT judged here — not known, never "all fine". It is built in the background; the tills keep selling and nothing is lost. If this lasts more than an hour, call support`,
    ta: (p) => `தயாராகிக்கொண்டிருக்கிறது — கடை கணினிச் சோதனைகள் இன்னும் கிடைக்கவில்லை: தலைமை அலுவலகம் கடை கணினிகளின் சேமித்த வரலாற்றை உருவாக்குகிறது (${s(p['since'])} முதல்; காரணம்: ${s(p['why'])}). அது தயாராகும் வரை கடை கணினிகளின் வட்டுகள், வரிசைகள், கவுண்டர்கள், பில் எண்கள் இங்கே மதிப்பிடப்படுவதில்லை — தெரியாது, "எல்லாம் சரி" அல்ல. இது பின்னணியில் உருவாகிறது; கவுண்டர்கள் விற்பனையைத் தொடர்கின்றன, எதுவும் இழக்கப்படவில்லை. ஒரு மணி நேரத்துக்கு மேல் நீடித்தால் உதவிக் குழுவை அழையுங்கள்`,
    sample: { since: '2026-10-28T06:00:00Z', why: 'first read after an upgrade' },
  },
  'box.history.size.over': {
    en: (p) => `the store computers' saved history is ${n(p['kb'])} KB — above the ${n(p['warnMb'])} MB line (an honest busy store stays well under 2 MB). Something is making it grow — a store computer sending many refused counts or long lists, say. Head office still answers correctly, but each health check gets slower: call support to find which store computer`,
    ta: (p) => `கடை கணினிகளின் சேமித்த வரலாறு ${n(p['kb'])} KB — ${n(p['warnMb'])} MB வரம்புக்கு மேல் (நேர்மையான பரபரப்பான கடை 2 MB க்கு வெகு கீழேயே இருக்கும்). ஏதோ இதைப் பெரிதாக்குகிறது — உதாரணமாக, ஒரு கடை கணினி பல மறுக்கப்பட்ட எண்ணிக்கைகளையோ நீண்ட பட்டியல்களையோ அனுப்புவது. தலைமை அலுவலகம் இன்னும் சரியாகவே பதில் தருகிறது, ஆனால் ஒவ்வொரு சோதனையும் மெதுவாகிறது: எந்தக் கடை கணினி என்று கண்டுபிடிக்க உதவிக் குழுவை அழையுங்கள்`,
    sample: { kb: 5_000, warnMb: 4 },
  },
  'box.history.size.ok': {
    en: (p) => `the store computers' saved history is ${n(p['kb'])} KB (the alarm is above ${n(p['warnMb'])} MB)`,
    ta: (p) => `கடை கணினிகளின் சேமித்த வரலாறு ${n(p['kb'])} KB (${n(p['warnMb'])} MB க்கு மேல் போனால் எச்சரிக்கை)`,
    sample: { kb: 120, warnMb: 4 },
  },
  'box.history.saving': {
    en: (p) => `the store computers' saved history has not been saved since ${s(p['since'])} (${n(p['minutes'])} min): an open database transaction holds it back, so head office keeps it in memory, and each health check reads again every store-computer report above the last saved position — if nothing could be saved since the history was built, that is EVERY report (the ones already counted are skipped, never counted twice) — still correct, but slower. Ask the database administrator to find it — a session "idle in transaction" or a prepared transaction anywhere on the database server (pg_stat_activity, pg_prepared_xacts) — and end it`,
    ta: (p) => `கடை கணினிகளின் சேமித்த வரலாறு ${s(p['since'])} முதல் (${n(p['minutes'])} நிமிடம்) சேமிக்கப்படவில்லை: திறந்திருக்கும் ஒரு தரவுத்தளப் பரிவர்த்தனை அதைத் தடுக்கிறது; எனவே தலைமை அலுவலகம் அதை நினைவகத்தில் வைத்து, ஒவ்வொரு சோதனையிலும் கடைசியாகச் சேமித்த இடத்துக்குப் பிறகான எல்லாக் கடை கணினி அறிக்கைகளையும் மீண்டும் படிக்கிறது — வரலாறு உருவான பின் எதுவும் சேமிக்க முடியவில்லை என்றால், அது எல்லா அறிக்கைகளும் (ஏற்கனவே எண்ணியவை தவிர்க்கப்படும், இருமுறை எண்ணப்படாது) — இன்னும் சரி, ஆனால் மெதுவாக. தரவுத்தள நிர்வாகியிடம் அதைக் கண்டுபிடித்து முடிக்கச் சொல்லுங்கள் — தரவுத்தள சேவையகத்தில் எங்காவது "idle in transaction" அமர்வு அல்லது prepared transaction (pg_stat_activity, pg_prepared_xacts)`,
    sample: { since: '2026-10-28T06:00:00Z', minutes: 9 },
  },
  'box.history.seal': {
    en: () => 'head office was started without the key that seals the store computers\' saved history, so it trusts no saved history and saves none: every health check re-reads every store-computer report (correct, but slow, and a big store stays "being prepared"). This should never happen in a real deployment (the key comes from BOX_HISTORY_SEAL_KEY, head office\'s own secret, which the API needs to start) — call support',
    ta: () => 'கடை கணினிகளின் சேமித்த வரலாற்றை முத்திரையிடும் சாவி இல்லாமல் தலைமை அலுவலகம் தொடங்கப்பட்டது; எனவே அது எந்தச் சேமித்த வரலாற்றையும் நம்பாது, எதையும் சேமிக்காது: ஒவ்வொரு சோதனையும் எல்லாக் கடை கணினி அறிக்கைகளையும் மீண்டும் படிக்கிறது (சரி, ஆனால் மெதுவாக; பெரிய கடை "தயாராகிக்கொண்டிருக்கிறது" என்றே இருக்கும்). உண்மையான நிறுவலில் இது ஒருபோதும் நடக்கக்கூடாது (சாவி BOX_HISTORY_SEAL_KEY இலிருந்து வருகிறது — தலைமை அலுவலகத்தின் சொந்த ரகசியம்) — உதவிக் குழுவை அழையுங்கள்',
    sample: {},
  },
  'box.history.build': {
    en: (p) => `building the store computers' saved history failed at ${s(p['at'])} (${s(p['error'])}); the next health check tries again. If this stays, call support`,
    ta: (p) => `கடை கணினிகளின் சேமித்த வரலாற்றை உருவாக்குவது ${s(p['at'])} அன்று தோல்வியடைந்தது (${s(p['error'])}); அடுத்த சோதனை மீண்டும் முயலும். இது நீடித்தால் உதவிக் குழுவை அழையுங்கள்`,
    sample: { at: '2026-10-28T06:00:00Z', error: 'connection reset' },
  },

  // ── round 31-36 · OB-114 / OB-129: the store computer checks not ready ──────────────────────────────────────────
  'box.checks.stuck': {
    en: (p) => `the store computer checks have not been ready for ${n(p['minutes'])} minutes of head office running (since ${s(p['since'])}; now ${s(p['what'])}${l(p['extras']).join('')}) — more than the ${n(p['limit'])}-minute line. Head office cannot check the store computers' disks, queues, tills and bill numbers meanwhile (the tills keep selling and nothing is lost). Call support today`,
    ta: (p) => `தலைமை அலுவலகம் இயங்கிய ${n(p['minutes'])} நிமிடங்களாகக் கடை கணினிச் சோதனைகள் தயாராகவில்லை (${s(p['since'])} முதல்; இப்போது ${s(p['what'])}${l(p['extras']).join('')}) — ${n(p['limit'])} நிமிட வரம்பை விட அதிகம். இதற்கிடையில் கடை கணினிகளின் வட்டுகள், வரிசைகள், கவுண்டர்கள், பில் எண்களைத் தலைமை அலுவலகம் சரிபார்க்க முடியாது (கவுண்டர்கள் விற்பனையைத் தொடர்கின்றன, எதுவும் இழக்கப்படவில்லை). இன்றே உதவிக் குழுவை அழையுங்கள்`,
    sample: { minutes: 75, since: '2026-10-28T06:00:00Z', what: { kind: 'box.checks.what.preparing' }, extras: [{ kind: 'box.checks.off', params: { ms: 3_600_000 } }], limit: 60 },
  },
  'box.checks.notReady': {
    en: (p) => `the store computer checks are not ready yet (${s(p['what'])}, for ${n(p['minutes'])} minutes of head office running so far${l(p['extras']).join('')}); the owner is told if this lasts more than ${n(p['limit'])} minutes of head office running`,
    ta: (p) => `கடை கணினிச் சோதனைகள் இன்னும் தயாராகவில்லை (${s(p['what'])}; தலைமை அலுவலகம் இயங்கிய ${n(p['minutes'])} நிமிடங்களாக${l(p['extras']).join('')}); தலைமை அலுவலகம் இயங்கும் நேரத்தில் இது ${n(p['limit'])} நிமிடங்களுக்கு மேல் நீடித்தால் உரிமையாளருக்குச் சொல்லப்படும்`,
    sample: { what: { kind: 'box.checks.what.noSeal' }, minutes: 10, extras: [], limit: 60 },
  },
  'box.checks.what.preparing': { en: () => 'being prepared', ta: () => 'தயாராகிக்கொண்டிருக்கிறது', sample: {} },
  'box.checks.what.noSeal': {
    en: () => 'running without the seal key, so the saved history cannot be sealed',
    ta: () => 'முத்திரைச் சாவி இல்லாமல் இயங்குகிறது, எனவே சேமித்த வரலாற்றை முத்திரையிட முடியாது',
    sample: {},
  },
  'box.checks.off': {
    en: (p) => `; head office was off for ${durationWordsIn('en', n(p['ms']))} in that time — not counted`,
    ta: (p) => `; அந்த நேரத்தில் தலைமை அலுவலகம் ${durationWordsIn('ta', n(p['ms']))} அணைந்திருந்தது — அது எண்ணப்படவில்லை`,
    sample: { ms: 5_400_000 },
  },
  'box.checks.reasonWas': {
    en: (p) => `; until ${s(p['at'])} the reason was ${s(p['from']) === 'no_seal_key' ? 'that head office had no seal key' : 'that they were being prepared'} — the time is counted from the start, whatever the reason`,
    ta: (p) => `; ${s(p['at'])} வரை காரணம் ${s(p['from']) === 'no_seal_key' ? 'தலைமை அலுவலகத்திடம் முத்திரைச் சாவி இல்லாதது' : 'அவை தயாராகிக்கொண்டிருந்தது'} — காரணம் எதுவானாலும் நேரம் தொடக்கத்திலிருந்தே எண்ணப்படுகிறது`,
    sample: { at: '2026-10-28T06:30:00Z', from: 'no_seal_key' },
  },
  'box.checks.ahead': {
    en: (p) => `; a running note stamped ${s(p['stamped'])} (ahead of head office's clock) was set aside at ${s(p['noticedAt'])} — a head-office clock is wrong, call support`,
    ta: (p) => `; ${s(p['stamped'])} என்று முத்திரையிட்ட ஓட்டக் குறிப்பு (தலைமை அலுவலகக் கடிகாரத்தை விட முன்னால்) ${s(p['noticedAt'])} அன்று ஒதுக்கி வைக்கப்பட்டது — தலைமை அலுவலகக் கடிகாரம் தவறு, உதவிக் குழுவை அழையுங்கள்`,
    sample: { stamped: '2026-10-28T09:00:00Z', noticedAt: '2026-10-28T08:00:00Z' },
  },
  'box.checks.before': {
    en: (p) => `; ${durationWordsIn('en', n(p['ms']))} of it is from before head office noted its running time (an earlier version) — counted as running`,
    ta: (p) => `; அதில் ${durationWordsIn('ta', n(p['ms']))} தலைமை அலுவலகம் தன் இயங்கும் நேரத்தைக் குறிக்கத் தொடங்கும் முன்பானது (முந்தைய பதிப்பு) — இயங்கியதாகவே எண்ணப்படுகிறது`,
    sample: { ms: 7_200_000 },
  },

  // ── bills issued but never received, and the other bill-number findings ─────────────────────────────────────────
  'box.unreceived': {
    en: (p) => {
      const them = b(p['many']) ? 'them' : 'it';
      return `bills issued but never received: store ${s(p['storeId'])}'s computer gave ${rw('en', p)} (on a bill, or after the backup it was restored from) and head office has not received ${them} ${n(p['grace'])} minutes or more after ${b(p['notTaken']) ? `it stopped taking the store computer's word that it still held ${them}` : `the store computer said it no longer held ${them} to send`} (${s(p['since'])})${b(p['capped']) ? `; only the newest ${n(p['cap'])} were checked` : ''}. ${s(p['tail'])}`;
    },
    ta: (p) => `வழங்கியும் பெறப்படாத பில்கள்: கடை ${s(p['storeId'])} இன் கணினி ${rw('ta', p)} ஐ வழங்கியது (பில்லில், அல்லது அது மீட்டெடுக்கப்பட்ட காப்புப் பிரதிக்குப் பிறகு); ஆனால் ${b(p['notTaken']) ? 'அவை இன்னும் தன்னிடம் இருப்பதாகக் கடை கணினி சொன்னதைத் தலைமை அலுவலகம் ஏற்பதை நிறுத்தி' : 'அவை இனி அனுப்பத் தன்னிடம் இல்லை என்று கடை கணினி சொல்லி'} ${n(p['grace'])} நிமிடங்களுக்கு மேல் ஆகியும் (${s(p['since'])}) தலைமை அலுவலகம் அவற்றைப் பெறவில்லை${b(p['capped']) ? `; புதிய ${n(p['cap'])} மட்டுமே சரிபார்க்கப்பட்டன` : ''}. ${s(p['tail'])}`,
    sample: { storeId: 'store-1', prefix: 'R-1-', ranges: SAMPLE_RANGES, many: true, grace: 30, notTaken: false, since: '2026-10-28T06:00:00Z', capped: false, cap: 500, tail: { kind: 'box.unreceived.tail.restore' } },
  },
  'box.unreceived.tail.reclaimed': {
    en: (p) => `The store computer said at ${s(p['saidGoneAt'])} that it no longer held ${rw('en', p)}, and its latest report says ${b(p['byList']) ? 'they are in its list of bills still to send, given up on, or given and never used' : 'its queue holds item(s) still to send, without saying which'} again. A store computer keeps a bill until head office takes it and never takes back one it has let go, so head office no longer waits on that word. ${NO_PAPER_LISTS_EN}`,
    ta: (p) => `${rw('ta', p)} இனி தன்னிடம் இல்லை என்று கடை கணினி ${s(p['saidGoneAt'])} அன்று சொன்னது; ஆனால் அதன் சமீபத்திய அறிக்கை மீண்டும் ${b(p['byList']) ? 'அவை அனுப்ப வேண்டியவை, கைவிட்டவை, அல்லது வழங்கியும் பயன்படுத்தாதவை பட்டியலில் உள்ளன' : 'எவை என்று சொல்லாமல், அனுப்ப வேண்டியவை வரிசையில் உள்ளன'} என்கிறது. தலைமை அலுவலகம் பெறும் வரை கடை கணினி பில்லை வைத்திருக்கும்; விட்டுவிட்டதை ஒருபோதும் திரும்ப எடுக்காது; எனவே தலைமை அலுவலகம் இனி அந்தச் சொல்லுக்காகக் காத்திருக்காது. ${NO_PAPER_LISTS_TA}`,
    sample: { saidGoneAt: '2026-10-28T05:00:00Z', prefix: 'R-1-', ranges: [12, 12], byList: true },
  },
  'box.unreceived.tail.sparse': {
    en: (p) => `The store computer says it still holds ${n(p['count'])} bill(s) somewhere between ${rw('en', p, 'spans')} (to send, or given up on) — fewer than the ${n(p['missing'])} head office has not received there, so at least ${n(p['missing']) - n(p['count'])} of them are not on it, and which ones cannot be told. ${NO_PAPER_LISTS_EN}`,
    ta: (p) => `${rw('ta', p, 'spans')} இடையே எங்கோ ${n(p['count'])} பில்(கள்) இன்னும் தன்னிடம் உள்ளன என்று கடை கணினி சொல்கிறது (அனுப்ப, அல்லது கைவிட்டவை) — அங்கே தலைமை அலுவலகம் பெறாத ${n(p['missing'])} ஐ விடக் குறைவு; எனவே குறைந்தது ${n(p['missing']) - n(p['count'])} அதனிடம் இல்லை, எவை என்று சொல்ல முடியாது. ${NO_PAPER_LISTS_TA}`,
    sample: { count: 2, prefix: 'R-1-', spans: [10, 30], missing: 5 },
  },
  'box.unreceived.tail.wholeQueue': {
    en: (p) => `The store computer still says its queue holds ${n(p['items'])} item(s) to send, as it has since ${s(p['since'])}, but not which bills — past the owner's line head office no longer waits on that. These may be among them: do NOT re-enter them from paper until a person has checked the store computer's "waiting to send" count`,
    ta: (p) => `${s(p['since'])} முதல் சொல்வது போல், தன் வரிசையில் அனுப்ப ${n(p['items'])} பதிவு(கள்) உள்ளன என்று கடை கணினி இன்னும் சொல்கிறது, ஆனால் எந்தப் பில்கள் என்று சொல்லவில்லை — உரிமையாளரின் வரம்பைத் தாண்டிய பின் தலைமை அலுவலகம் அதற்காகக் காத்திருக்காது. இவை அவற்றில் இருக்கலாம்: கடை கணினியின் "அனுப்பக் காத்திருப்பவை" எண்ணிக்கையை ஒருவர் சரிபார்க்கும் வரை இவற்றைக் காகிதத்திலிருந்து மீண்டும் பதிவு செய்ய வேண்டாம்`,
    sample: { items: 6, since: '2026-10-28T03:00:00Z' },
  },
  'box.unreceived.tail.maybeGivenUp': {
    en: (p) => `The store computer also says it holds ${n(p['dead'])} item(s) it gave up sending, and does not say which bills they are — these may be among them: do NOT re-enter them from paper until a person has checked the store computer's "gave up sending" list`,
    ta: (p) => `அனுப்புவதைக் கைவிட்ட ${n(p['dead'])} பதிவு(கள்) தன்னிடம் உள்ளன என்றும், அவை எந்தப் பில்கள் என்று சொல்லாமலும் கடை கணினி சொல்கிறது — இவை அவற்றில் இருக்கலாம்: கடை கணினியின் "அனுப்புவதைக் கைவிட்டவை" பட்டியலை ஒருவர் சரிபார்க்கும் வரை இவற்றைக் காகிதத்திலிருந்து மீண்டும் பதிவு செய்ய வேண்டாம்`,
    sample: { dead: 3 },
  },
  'box.unreceived.tail.restore': {
    en: () => 'If the store computer was restored from a backup, these sales are lost from head office\'s books: find the paper bills and enter them, or write them off with the reason',
    ta: () => 'கடை கணினி காப்புப் பிரதியிலிருந்து மீட்டெடுக்கப்பட்டிருந்தால், இந்த விற்பனைகள் தலைமை அலுவலகக் கணக்குகளிலிருந்து இழக்கப்பட்டுள்ளன: காகிதப் பில்களைக் கண்டுபிடித்துப் பதிவு செய்யுங்கள், அல்லது காரணத்துடன் தள்ளுபடி செய்யுங்கள்',
    sample: {},
  },
  'box.contradictsEarlier': {
    en: (p) => {
      const one = b(p['one']);
      return `store ${s(p['storeId'])}'s computer contradicts its own earlier report: at ${s(p['saidGoneAt'])} it said it no longer held ${rw('en', p)} (head office has not received ${one ? 'it' : 'them'}), and its latest report${opt(p['latestAt']) === undefined ? '' : ` (${s(p['latestAt'])})`} lists ${one ? 'it' : 'them'} as still on it (to send, given up on, or given and never used). A store computer keeps a bill until head office takes it and never takes back one it has let go, so head office does not believe the later list for ${one ? 'it' : 'them'}: ${one ? 'it is' : 'they are'} named as never received. The store computer or head office lost track of these bills — call support (owner decision OB-92: no blame is placed; rarely head office lost a sale it accepted). ${NO_PAPER_LISTS_EN}`;
    },
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி தன் முந்தைய அறிக்கைக்கு முரண்படுகிறது: ${s(p['saidGoneAt'])} அன்று ${rw('ta', p)} இனி தன்னிடம் இல்லை என்றது (தலைமை அலுவலகம் அவற்றைப் பெறவில்லை); ஆனால் அதன் சமீபத்திய அறிக்கை${opt(p['latestAt']) === undefined ? '' : ` (${s(p['latestAt'])})`} அவை இன்னும் தன்னிடம் உள்ளன என்று பட்டியலிடுகிறது (அனுப்ப, கைவிட்டவை, அல்லது வழங்கியும் பயன்படுத்தாதவை). தலைமை அலுவலகம் பெறும் வரை கடை கணினி பில்லை வைத்திருக்கும்; விட்டுவிட்டதை ஒருபோதும் திரும்ப எடுக்காது; எனவே பிந்தைய பட்டியலைத் தலைமை அலுவலகம் நம்பவில்லை: அவை "ஒருபோதும் பெறப்படவில்லை" எனப் பெயரிடப்படுகின்றன. கடை கணினியோ தலைமை அலுவலகமோ இந்தப் பில்களின் கணக்கை இழந்தது — உதவிக் குழுவை அழையுங்கள் (உரிமையாளர் முடிவு OB-92: யார் மீதும் பழி இல்லை; அரிதாக, ஏற்ற விற்பனையைத் தலைமை அலுவலகமே இழந்திருக்கலாம்). ${NO_PAPER_LISTS_TA}`,
    sample: { storeId: 'store-1', saidGoneAt: '2026-10-28T05:00:00Z', prefix: 'R-1-', ranges: [12, 12], one: true, latestAt: '2026-10-28T07:00:00Z' },
  },
  'box.deadLettered': {
    en: (p) => `needs a person (the store computer gave up sending; do NOT re-enter from paper): store ${s(p['storeId'])}'s computer holds ${n(p['count'])} bill(s) under ${s(p['prefix'])} (between ${rw('en', p)}) that it stopped trying to send to head office. They are on the store computer, not lost. Support checks why head office did not take them and releases them from the store computer's "gave up sending" list; entering them from paper as well would book them twice`,
    ta: (p) => `ஒருவர் தேவை (கடை கணினி அனுப்புவதைக் கைவிட்டது; காகிதத்திலிருந்து மீண்டும் பதிவு செய்ய வேண்டாம்): கடை ${s(p['storeId'])} இன் கணினியில் ${s(p['prefix'])} இன் கீழ் ${n(p['count'])} பில்(கள்) (${rw('ta', p)} இடையே) உள்ளன; அவற்றைத் தலைமை அலுவலகத்துக்கு அனுப்ப முயல்வதை அது நிறுத்திவிட்டது. அவை கடை கணினியில் உள்ளன, இழக்கப்படவில்லை. தலைமை அலுவலகம் ஏன் அவற்றை ஏற்கவில்லை என்று உதவிக் குழு சரிபார்த்து, கடை கணினியின் "அனுப்புவதைக் கைவிட்டவை" பட்டியலிலிருந்து விடுவிக்கும்; காகிதத்திலிருந்தும் பதிவு செய்தால் இருமுறை பதிவாகும்`,
    sample: { storeId: 'store-1', count: 3, prefix: 'R-1-', ranges: [40, 42] },
  },
  'box.atRisk': {
    en: (p) => `not checked: store ${s(p['storeId'])}'s computer says it cannot vouch for ${n(p['total'])} bill number(s) under ${s(p['prefix'])} (given after the backup it was restored from); head office checks the newest ${n(p['cap'])} of them one by one on each report, so ${n(p['unchecked'])} older one(s), below ${s(p['prefix'])}${pad6(n(p['below']))}, were NOT checked. Ask support to compare that store computer's restore record with head office's bills; any of them head office does not hold may be a sale lost by the restore. Do NOT re-enter bills from paper until support has checked. ${STAYS_NOT_CHECKED_EN}`,
    ta: (p) => `சரிபார்க்கப்படவில்லை: ${s(p['prefix'])} இன் கீழ் ${n(p['total'])} பில் எண்(களுக்கு) தன்னால் உறுதியளிக்க முடியாது என்று கடை ${s(p['storeId'])} இன் கணினி சொல்கிறது (அது மீட்டெடுக்கப்பட்ட காப்புப் பிரதிக்குப் பிறகு வழங்கியவை); ஒவ்வொரு அறிக்கையிலும் புதிய ${n(p['cap'])} ஐ மட்டும் தலைமை அலுவலகம் ஒவ்வொன்றாகச் சரிபார்க்கிறது; எனவே ${s(p['prefix'])}${pad6(n(p['below']))} க்குக் கீழே உள்ள பழைய ${n(p['unchecked'])} சரிபார்க்கப்படவில்லை. அந்தக் கடை கணினியின் மீட்டெடுப்புப் பதிவைத் தலைமை அலுவலகப் பில்களுடன் ஒப்பிடச் சொல்லி உதவிக் குழுவிடம் கேளுங்கள்; தலைமை அலுவலகத்திடம் இல்லாதவை மீட்டெடுப்பால் இழந்த விற்பனையாக இருக்கலாம். உதவிக் குழு சரிபார்க்கும் வரை காகிதப் பில்களிலிருந்து மீண்டும் பதிவு செய்ய வேண்டாம். ${STAYS_NOT_CHECKED_TA}`,
    sample: { storeId: 'store-1', total: 700, prefix: 'R-1-', cap: 500, unchecked: 200, below: 1_201 },
  },
  'box.queueContradiction': {
    en: (p) => [
      ...(b(p['unsentOver']) ? [`its bills still to send under each prefix add up to ${n(p['unsent'])}, more than the ${n(p['queueUnsent'])} item(s) its whole queue holds`] : []),
      ...(b(p['deadOver']) ? [`its bills given up on under each prefix add up to ${n(p['dead'])}, more than the ${n(p['queueDead'])} item(s) it says it gave up on`] : []),
    ].join('; '),
    ta: (p) => [
      ...(b(p['unsentOver']) ? [`ஒவ்வொரு முன்னொட்டின் கீழும் அனுப்ப வேண்டிய அதன் பில்களின் கூட்டு ${n(p['unsent'])} — அதன் முழு வரிசையில் உள்ள ${n(p['queueUnsent'])} பதிவுகளை விட அதிகம்`] : []),
      ...(b(p['deadOver']) ? [`ஒவ்வொரு முன்னொட்டின் கீழும் கைவிட்ட அதன் பில்களின் கூட்டு ${n(p['dead'])} — அது கைவிட்டதாகச் சொல்லும் ${n(p['queueDead'])} பதிவுகளை விட அதிகம்`] : []),
    ].join('; '),
    sample: { unsentOver: true, unsent: 9, queueUnsent: 4, deadOver: true, dead: 3, queueDead: 1 },
  },
  'box.contradictsQueue': {
    en: (p) => `store ${s(p['storeId'])}'s computer's report contradicts itself — ${s(p['contradiction'])}. Head office does not believe its list of bills still to send: any bill it has not received is named as never received after ${n(p['grace'])} minutes. Check that store computer (its software may be faulty or altered)`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினியின் அறிக்கை தனக்குத் தானே முரண்படுகிறது — ${s(p['contradiction'])}. அனுப்ப வேண்டிய பில்களின் அதன் பட்டியலைத் தலைமை அலுவலகம் நம்பவில்லை: பெறாத எந்தப் பில்லும் ${n(p['grace'])} நிமிடங்களுக்குப் பின் "ஒருபோதும் பெறப்படவில்லை" எனப் பெயரிடப்படும். அந்தக் கடை கணினியைச் சரிபார்க்கவும் (அதன் மென்பொருள் பழுதாகவோ மாற்றப்பட்டோ இருக்கலாம்)`,
    sample: { storeId: 'store-1', contradiction: { kind: 'box.queueContradiction', params: { unsentOver: true, unsent: 9, queueUnsent: 4, deadOver: false, dead: 0, queueDead: 0 } }, grace: 30 },
  },
  'box.clock.storeComputer': {
    en: () => ' (both times by the store computer\'s own clock: when it said so, and when it took the bill from the till)',
    ta: () => ' (இரண்டு நேரமும் கடை கணினியின் சொந்தக் கடிகாரப்படி: அது சொன்ன நேரம், கவுண்டரிடமிருந்து பில்லை எடுத்த நேரம்)',
    sample: {},
  },
  'box.clock.till': {
    en: (p) => ` (${opt(p['some']) === undefined ? '' : `for ${n(p['some'])} of them, `}the bill's time is the TILL's own clock — this store computer did not stamp when it took the bill, so a till clock that is slow can make an honest number look like this: check the till's clock first)`,
    ta: (p) => ` (${opt(p['some']) === undefined ? '' : `அவற்றில் ${n(p['some'])} க்கு, `}பில்லின் நேரம் கவுண்டரின் சொந்தக் கடிகாரப்படி — இந்தக் கடை கணினி பில்லை எடுத்த நேரத்தைக் குறிக்கவில்லை; எனவே மெதுவான கவுண்டர் கடிகாரம் நேர்மையான எண்ணையும் இப்படிக் காட்டலாம்: முதலில் கவுண்டரின் கடிகாரத்தைச் சரிபார்க்கவும்)`,
    sample: { some: 2 },
  },
  'box.capped': {
    en: (p) => ` Not every number was looked at: ${[
      n(p['notChecked']) > 0 ? `${n(p['notChecked'])} older number(s) said unused, beyond the newest ${n(p['cap'])}, were not checked against head office's bills` : '',
      n(p['notTimed']) > 0 ? `${n(p['notTimed'])} more number(s) head office holds a bill for, beyond the newest ${n(p['timedMax'])}, did not have their bill's time read` : '',
    ].filter((x) => x !== '').join('; ')} — so there may be more than this line names${b(p['noDot']) ? '' : '.'}`,
    ta: (p) => ` எல்லா எண்களும் பார்க்கப்படவில்லை: ${[
      n(p['notChecked']) > 0 ? `பயன்படுத்தவில்லை எனச் சொன்ன பழைய ${n(p['notChecked'])} எண்(கள்), புதிய ${n(p['cap'])} க்கு அப்பால், தலைமை அலுவலகப் பில்களுடன் சரிபார்க்கப்படவில்லை` : '',
      n(p['notTimed']) > 0 ? `தலைமை அலுவலகத்திடம் பில் உள்ள மேலும் ${n(p['notTimed'])} எண்(கள்), புதிய ${n(p['timedMax'])} க்கு அப்பால், அவற்றின் பில் நேரம் படிக்கப்படவில்லை` : '',
    ].filter((x) => x !== '').join('; ')} — எனவே இந்த வரி சொல்வதை விட அதிகம் இருக்கலாம்${b(p['noDot']) ? '' : '.'}`,
    sample: { notChecked: 3, cap: 500, notTimed: 1, timedMax: 50, noDot: false },
  },
  'box.unusedReceived': {
    en: (p) => {
      const one = b(p['one']);
      const held = s(p['heldAs']);
      const what = held === 'sales' ? (one ? 'a sale' : 'sales') : held === 'returns' ? (one ? 'a return' : 'returns') : 'sales and returns';
      return `does not fit: store ${s(p['storeId'])}'s computer said (last at ${s(p['said'])}) that it gave ${rw('en', p)} and never put ${one ? 'it' : 'them'} on a bill, but head office holds ${what} under ${one ? 'that number' : 'those numbers'}, made before that (the first at ${s(p['firstAt'])}, ${s(p['prefix'])}${pad6(n(p['firstNumber']))})${s(p['clock'])}. A number put on a bill is never "unused" afterwards. Nothing is missing — head office has ${one ? 'the bill' : 'the bills'}, so do NOT look for paper bills — but the store computer's list of unused numbers under ${s(p['prefix'])} cannot be relied on: call support to check that store computer (the store computer or head office lost track; no blame is placed, as owner decision OB-92).${s(p['capped'])} ${STAYS_UNUSED_EN}`;
    },
    ta: (p) => {
      const held = s(p['heldAs']);
      const what = held === 'sales' ? 'விற்பனை(கள்)' : held === 'returns' ? 'திருப்பல்(கள்)' : 'விற்பனைகளும் திருப்பல்களும்';
      return `பொருந்தவில்லை: ${rw('ta', p)} ஐ வழங்கி எந்தப் பில்லிலும் போடவில்லை என்று கடை ${s(p['storeId'])} இன் கணினி சொன்னது (கடைசியாக ${s(p['said'])}), ஆனால் அதற்கு முன்பே அந்த எண்(களின்) கீழ் தலைமை அலுவலகத்திடம் ${what} உள்ளன (முதலாவது ${s(p['firstAt'])}, ${s(p['prefix'])}${pad6(n(p['firstNumber']))})${s(p['clock'])}. பில்லில் போட்ட எண் பிறகு ஒருபோதும் "பயன்படுத்தாதது" ஆகாது. எதுவும் காணாமல் போகவில்லை — பில் தலைமை அலுவலகத்திடம் உள்ளது, எனவே காகிதப் பில்களைத் தேட வேண்டாம் — ஆனால் ${s(p['prefix'])} இன் கீழ் கடை கணினியின் பயன்படுத்தாத எண்கள் பட்டியலை நம்ப முடியாது: அந்தக் கடை கணினியைச் சரிபார்க்க உதவிக் குழுவை அழையுங்கள் (கடை கணினியோ தலைமை அலுவலகமோ கணக்கை இழந்தது; உரிமையாளர் முடிவு OB-92 படி யார் மீதும் பழி இல்லை).${s(p['capped'])} ${STAYS_UNUSED_TA}`;
    },
    sample: { storeId: 'store-1', said: '2026-10-28T07:00:00Z', prefix: 'R-1-', ranges: [12, 12], one: true, heldAs: 'sales', firstAt: '2026-10-28T06:00:00Z', firstNumber: 12, clock: { kind: 'box.clock.storeComputer' }, capped: '' },
  },
  'box.refusedNotKept.own': {
    en: (p) => `${n(p['count'])} more refused bill count(s) under ${s(p['prefix'])} not kept: store ${s(p['storeId'])}'s computer ${s(p['computer'])} reported more NEW bill counts under ${s(p['prefix'])} that head office refused (a count too far ahead of what head office has received, or a till that belongs to another store computer) than head office keeps — at most ${n(p['max'])} new ones a day per store computer per till — between ${s(p['first'])} and ${s(p['last'])}; the highest of them was ${s(p['prefix'])}${pad6(n(p['highest']))}. The ones above that are counted here, never kept, so they are not listed one by one (the refused counts that were kept are listed above). A store computer that keeps reporting impossible counts for its own till is faulty or has been altered: call support the same day, and ask them to block that store computer's sign-in if it goes on. This line stays for ${n(p['days'])} days after the last one`,
    ta: (p) => `${s(p['prefix'])} இன் கீழ் மறுக்கப்பட்ட மேலும் ${n(p['count'])} பில் எண்ணிக்கை(கள்) வைக்கப்படவில்லை: கடை ${s(p['storeId'])} இன் கணினி ${s(p['computer'])}, ${s(p['first'])} முதல் ${s(p['last'])} வரை, ${s(p['prefix'])} இன் கீழ் தலைமை அலுவலகம் மறுத்த புதிய பில் எண்ணிக்கைகளை (பெற்றதை விட மிக முன்னால் உள்ள எண்ணிக்கை, அல்லது வேறு கடை கணினியின் கவுண்டர்) தலைமை அலுவலகம் வைத்திருப்பதை விட அதிகமாகத் தெரிவித்தது — ஒரு கடை கணினிக்கு ஒரு கவுண்டருக்கு நாளுக்கு அதிகபட்சம் ${n(p['max'])} புதியவை; அவற்றில் உயர்ந்தது ${s(p['prefix'])}${pad6(n(p['highest']))}. அதற்கு மேலானவை இங்கே எண்ணப்படுகின்றன, வைக்கப்படுவதில்லை; எனவே ஒவ்வொன்றாகப் பட்டியலிடப்படவில்லை (வைக்கப்பட்ட மறுக்கப்பட்ட எண்ணிக்கைகள் மேலே உள்ளன). தன் சொந்தக் கவுண்டருக்கு இயலாத எண்ணிக்கைகளைத் தொடர்ந்து தெரிவிக்கும் கடை கணினி பழுதானது அல்லது மாற்றப்பட்டது: அன்றே உதவிக் குழுவை அழையுங்கள்; இது தொடர்ந்தால் அந்தக் கடை கணினியின் உள்நுழைவைத் தடுக்கச் சொல்லுங்கள். கடைசியானதற்குப் பின் ${n(p['days'])} நாட்கள் இந்த வரி இருக்கும்`,
    sample: { count: 4, prefix: 'R-1-', storeId: 'store-1', computer: 'box-1', max: 20, first: '2026-10-28T01:00:00Z', last: '2026-10-28T05:00:00Z', highest: 99_999, days: 7 },
  },
  'box.refusedNotKept.other': {
    en: (p) => `${n(p['count'])} more refused bill-number prefix(es) not kept: store ${s(p['storeId'])}'s computer ${s(p['computer'])} named more new bill-number prefixes that are not this store's (or new counts under them) than head office keeps — at most ${n(p['max'])} new ones a day per store computer — between ${s(p['first'])} and ${s(p['last'])}. The ones above that are counted here, never kept, so they are not listed one by one. A store computer that names many prefixes that are not its store's is faulty or has been altered: call support the same day, and ask them to block that store computer's sign-in if it goes on. This line stays for ${n(p['days'])} days after the last one`,
    ta: (p) => `மறுக்கப்பட்ட மேலும் ${n(p['count'])} பில் எண் முன்னொட்டு(கள்) வைக்கப்படவில்லை: கடை ${s(p['storeId'])} இன் கணினி ${s(p['computer'])}, ${s(p['first'])} முதல் ${s(p['last'])} வரை, இந்தக் கடைக்குச் சொந்தமில்லாத புதிய பில் எண் முன்னொட்டுகளை (அல்லது அவற்றின் கீழ் புதிய எண்ணிக்கைகளை) தலைமை அலுவலகம் வைத்திருப்பதை விட அதிகமாகக் குறிப்பிட்டது — ஒரு கடை கணினிக்கு நாளுக்கு அதிகபட்சம் ${n(p['max'])} புதியவை. அதற்கு மேலானவை இங்கே எண்ணப்படுகின்றன, வைக்கப்படுவதில்லை; எனவே ஒவ்வொன்றாகப் பட்டியலிடப்படவில்லை. தன் கடைக்குச் சொந்தமில்லாத பல முன்னொட்டுகளைக் குறிப்பிடும் கடை கணினி பழுதானது அல்லது மாற்றப்பட்டது: அன்றே உதவிக் குழுவை அழையுங்கள்; இது தொடர்ந்தால் அந்தக் கடை கணினியின் உள்நுழைவைத் தடுக்கச் சொல்லுங்கள். கடைசியானதற்குப் பின் ${n(p['days'])} நாட்கள் இந்த வரி இருக்கும்`,
    sample: { count: 4, storeId: 'store-1', computer: 'box-1', max: 20, first: '2026-10-28T01:00:00Z', last: '2026-10-28T05:00:00Z', days: 7 },
  },
  'box.refused': {
    en: (p) => {
      const others = l(p['others']);
      return `${s(p['head'])}${others.length === 0 ? '' : `. It also reported ${others.length === 1 ? 'another count' : 'other counts'} head office refused under ${s(p['prefix'])}, still to be looked at: ${others.slice(0, 5).join(', ')}${others.length > 5 ? ` and ${others.length - 5} more` : ''}`}. ${STAYS_REFUSAL_EN}`;
    },
    ta: (p) => {
      const others = l(p['others']);
      return `${s(p['head'])}${others.length === 0 ? '' : `. ${s(p['prefix'])} இன் கீழ் தலைமை அலுவலகம் மறுத்த வேறு எண்ணிக்கைகளையும் அது தெரிவித்தது, இன்னும் பார்க்க வேண்டியவை: ${others.slice(0, 5).join(', ')}${others.length > 5 ? ` மற்றும் மேலும் ${others.length - 5}` : ''}`}. ${STAYS_REFUSAL_TA}`;
    },
    sample: { head: { kind: 'box.refused.anotherStore', params: { storeId: 'store-1', by: 'box-1', prefix: 'R-9-', through: 40 } }, prefix: 'R-9-', others: [30, 20] },
  },
  'box.refused.anotherStore': {
    en: (p) => `store ${s(p['storeId'])}'s computer (${s(p['by'])}) reported giving bill numbers under ${s(p['prefix'])} through ${n(p['through'])}, but head office issued ${s(p['prefix'])} to a till of ANOTHER store — not counted, so no till is affected; check that store computer`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி (${s(p['by'])}) ${s(p['prefix'])} இன் கீழ் ${n(p['through'])} வரை பில் எண்களை வழங்கியதாகத் தெரிவித்தது; ஆனால் தலைமை அலுவலகம் ${s(p['prefix'])} ஐ வேறு கடையின் கவுண்டருக்கு வழங்கியுள்ளது — எண்ணப்படவில்லை, எனவே எந்தக் கவுண்டரும் பாதிக்கப்படவில்லை; அந்தக் கடை கணினியைச் சரிபார்க்கவும்`,
    sample: { storeId: 'store-1', by: 'box-1', prefix: 'R-9-', through: 40 },
  },
  'box.refused.farAhead': {
    en: (p) => `store ${s(p['storeId'])}'s computer (${s(p['by'])}) reported giving bill numbers under ${s(p['prefix'])} through ${n(p['through'])}, far beyond the ${n(p['banked'])} head office holds banked (at most ${n(p['plausible'])} is believed, ${n(p['ahead'])} ahead) — not counted, so the till keeps selling; check that store computer's bill numbers`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி (${s(p['by'])}) ${s(p['prefix'])} இன் கீழ் ${n(p['through'])} வரை பில் எண்களை வழங்கியதாகத் தெரிவித்தது — தலைமை அலுவலகம் பெற்றுள்ள ${n(p['banked'])} ஐ விட மிக அதிகம் (அதிகபட்சம் ${n(p['plausible'])} வரை நம்பப்படும், ${n(p['ahead'])} முன்னால்) — எண்ணப்படவில்லை, எனவே கவுண்டர் விற்பனையைத் தொடர்கிறது; அந்தக் கடை கணினியின் பில் எண்களைச் சரிபார்க்கவும்`,
    sample: { storeId: 'store-1', by: 'box-1', prefix: 'R-1-', through: 90_000, banked: 120, plausible: 10_120, ahead: 10_000 },
  },
  'box.refused.twoComputers': {
    en: (p) => {
      const prefix = s(p['prefix']); const used = s(p['used']); const other = s(p['other']);
      const why = s(p['via']) === 'replacement'
        ? `the owner approved moving ${prefix} to it${opt(p['since']) === undefined ? '' : ` at ${s(p['since'])}`}${opt(p['replacementId']) === undefined ? '' : ` (act ${s(p['replacementId'])})`}`
        : `it was the first to report ${prefix}${opt(p['since']) === undefined ? '' : `, at ${s(p['since'])}`}`;
      return `two store computers report bill numbers under ${prefix} for store ${s(p['storeId'])}: ${used} and ${other}. Head office uses ${used}'s reports for ${prefix} because ${why}; it keeps ${other}'s report (through ${n(p['through'])}) as evidence and does not use it. One store computer per bill-number prefix (owner decision OB-94), so until a person has checked both machines, head office checks ${prefix}'s bills for loss only on ${used}'s word — bills sold on ${other}, if that is the till's real store computer, are not checked. Check both machines: if ${other} is the till's store computer now, record a replaced store computer on the Store computers page (the owner approves it); if it is a stand-by or a copy, switch it off or give its till a new prefix`;
    },
    ta: (p) => {
      const prefix = s(p['prefix']); const used = s(p['used']); const other = s(p['other']);
      const why = s(p['via']) === 'replacement'
        ? `${prefix} ஐ அதற்கு நகர்த்த உரிமையாளர் அனுமதித்தார்${opt(p['since']) === undefined ? '' : ` (${s(p['since'])})`}${opt(p['replacementId']) === undefined ? '' : ` (செயல் ${s(p['replacementId'])})`}`
        : `${prefix} ஐ முதலில் தெரிவித்தது அதுதான்${opt(p['since']) === undefined ? '' : ` (${s(p['since'])})`}`;
      return `கடை ${s(p['storeId'])} க்கு ${prefix} இன் கீழ் இரண்டு கடை கணினிகள் பில் எண்களைத் தெரிவிக்கின்றன: ${used}, ${other}. ${prefix} க்கு ${used} இன் அறிக்கைகளையே தலைமை அலுவலகம் பயன்படுத்துகிறது, ஏனெனில் ${why}; ${other} இன் அறிக்கையை (${n(p['through'])} வரை) சான்றாக வைத்திருக்கிறது, பயன்படுத்துவதில்லை. ஒரு பில் எண் முன்னொட்டுக்கு ஒரே கடை கணினி (உரிமையாளர் முடிவு OB-94); எனவே ஒருவர் இரண்டு கணினிகளையும் சரிபார்க்கும் வரை, ${prefix} பில்களின் இழப்பைத் தலைமை அலுவலகம் ${used} இன் சொல்லின்படி மட்டுமே சரிபார்க்கிறது — ${other} தான் உண்மையான கடை கணினி என்றால், அதில் விற்ற பில்கள் சரிபார்க்கப்படுவதில்லை. இரண்டு கணினிகளையும் சரிபார்க்கவும்: இப்போது ${other} தான் அந்தக் கவுண்டரின் கடை கணினி என்றால், கடை கணினிகள் பக்கத்தில் மாற்றப்பட்ட கடை கணினியைப் பதிவு செய்யுங்கள் (உரிமையாளர் அனுமதிப்பார்); அது மாற்று அல்லது நகல் என்றால், அதை அணையுங்கள் அல்லது அதன் கவுண்டருக்குப் புதிய முன்னொட்டு கொடுங்கள்`;
    },
    sample: { prefix: 'R-1-', storeId: 'store-1', used: 'box-1', other: 'box-2', through: 50, via: 'first', since: '2026-10-01T00:00:00Z', replacementId: null },
  },

  // ── judgeBoxes: one store computer's disk, queue, tills, clock, time zone, bill numbers ─────────────────────────
  'box.othersSay': {
    en: (p) => {
      const c = l(p['computers']);
      const one = c.length === 1;
      return ` (${one ? 'another store computer' : 'other store computers'}, ${c.join(', ')}, also ${one ? 'reports' : 'report'} for this store but ${one ? 'holds' : 'hold'} none of its tills' bill numbers, so head office takes the store's health only from ${opt(p['reportedBy']) ?? 'the store computer that does'}; ${l(p['lines']).join('; ')})`;
    },
    ta: (p) => ` (${l(p['computers']).join(', ')} ${l(p['computers']).length === 1 ? 'என்ற இன்னொரு கடை கணினியும்' : 'என்ற மற்ற கடை கணினிகளும்'} இந்தக் கடைக்காகத் தெரிவிக்கின்றன, ஆனால் அதன் கவுண்டர்களின் பில் எண்கள் எதுவும் அவற்றிடம் இல்லை; எனவே கடையின் நிலையைத் தலைமை அலுவலகம் ${opt(p['reportedBy']) ?? 'பில் எண்களை வைத்திருக்கும் கடை கணினி'} இடமிருந்து மட்டுமே எடுக்கிறது; ${l(p['lines']).join('; ')})`,
    sample: { computers: ['box-2'], reportedBy: 'box-1', lines: [{ kind: 'box.othersSay.line', params: { computer: 'box-2', at: '2026-10-28T07:00:00Z', full: true } }] },
  },
  'box.othersSay.line': {
    en: (p) => `${s(p['computer'])} last reported ${s(p['at'])}${b(p['full']) ? ', its own disk full' : ''}`,
    ta: (p) => `${s(p['computer'])} கடைசியாகத் தெரிவித்தது ${s(p['at'])}${b(p['full']) ? ', அதன் சொந்த வட்டு நிரம்பியுள்ளது' : ''}`,
    sample: { computer: 'box-2', at: '2026-10-28T07:00:00Z', full: true },
  },
  'box.disk.notReported': {
    en: (p) => `the store computer that holds store ${s(p['storeId'])}'s tills' bill numbers (${l(p['computers']).join(', ')}) has not reported its disk, queue or tills${s(p['others'])}. Not known — never read from another machine`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கவுண்டர்களின் பில் எண்களை வைத்திருக்கும் கடை கணினி (${l(p['computers']).join(', ')}) தன் வட்டு, வரிசை, கவுண்டர்களைத் தெரிவிக்கவில்லை${s(p['others'])}. தெரியாது — வேறு கணினியிலிருந்து ஒருபோதும் எடுக்கப்படாது`,
    sample: { storeId: 'store-1', computers: ['box-1'], others: '' },
  },
  'box.unusedNumbers': {
    en: (p) => `taken but never used (information — nothing to look for): store ${s(p['storeId'])}'s computer says these bill numbers were given and never put on a bill — ${l(p['days']).join('; ')}. A bill abandoned at the till or a card declined after the number was taken keeps its number; if one day shows many, ask the store why${l(p['capped']).join('')}`,
    ta: (p) => `எடுத்தும் பயன்படுத்தாதவை (தகவல் மட்டும் — தேட எதுவும் இல்லை): இந்தப் பில் எண்கள் வழங்கப்பட்டும் எந்தப் பில்லிலும் போடப்படவில்லை என்று கடை ${s(p['storeId'])} இன் கணினி சொல்கிறது — ${l(p['days']).join('; ')}. கவுண்டரில் கைவிட்ட பில்லும், எண் எடுத்த பின் மறுக்கப்பட்ட அட்டையும் தன் எண்ணை வைத்திருக்கும்; ஒரு நாளில் அதிகம் இருந்தால், கடையிடம் காரணம் கேளுங்கள்${l(p['capped']).join('')}`,
    sample: { storeId: 'store-1', days: [{ kind: 'box.unusedNumbers.day', params: { prefix: 'R-1-', day: '2026-10-27', count: 2, ranges: [12, 13], more: 0 } }], capped: [] },
  },
  'box.unusedNumbers.day': {
    en: (p) => `till ${s(p['prefix'])} on ${s(p['day'])}: ${n(p['count'])} number(s), ${rw('en', p)}${n(p['more']) > 0 ? ` and ${n(p['more'])} more range(s)` : ''}`,
    ta: (p) => `கவுண்டர் ${s(p['prefix'])}, ${s(p['day'])}: ${n(p['count'])} எண்(கள்), ${rw('ta', p)}${n(p['more']) > 0 ? ` மற்றும் மேலும் ${n(p['more'])} வரிசை(கள்)` : ''}`,
    sample: { prefix: 'R-1-', day: '2026-10-27', count: 2, ranges: [12, 13], more: 1 },
  },
  'box.unusedNumbers.capped': {
    en: (p) => `. Under ${s(p['prefix'])}:${s(p['capped'])}`,
    ta: (p) => `. ${s(p['prefix'])} இன் கீழ்:${s(p['capped'])}`,
    sample: { prefix: 'R-1-', capped: { kind: 'box.capped', params: { notChecked: 3, cap: 500, notTimed: 0, timedMax: 50, noDot: true } } },
  },
  'box.zone.differs': {
    en: (p) => `store ${s(p['storeId'])}'s computer (${s(p['computer'])}) keeps the time zone ${s(p['machine'])}, not the shop's (${s(p['shop'])}${b(p['shopDefault']) ? ', the shop default — its store pack names none' : ''}). Bills, shifts and the day close are still dated by the shop's zone; ask IT to set that computer to ${s(p['shop'])}`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி (${s(p['computer'])}) ${s(p['machine'])} நேர மண்டலத்தில் உள்ளது, கடையின் மண்டலத்தில் அல்ல (${s(p['shop'])}${b(p['shopDefault']) ? ', கடையின் இயல்பு மண்டலம் — கடைத் தொகுப்பில் எதுவும் இல்லை' : ''}). பில்கள், ஷிப்ட்கள், நாள் முடிவு இன்னும் கடையின் மண்டலப்படியே தேதியிடப்படுகின்றன; அந்தக் கணினியை ${s(p['shop'])} க்கு அமைக்க IT-யிடம் சொல்லுங்கள்`,
    sample: { storeId: 'store-1', computer: 'box-1', machine: 'UTC', shop: 'Asia/Kolkata', shopDefault: true },
  },
  'box.zone.same': {
    en: (p) => `store ${s(p['storeId'])}'s computer keeps the shop's time zone (${s(p['shop'])})`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி கடையின் நேர மண்டலத்தைப் பின்பற்றுகிறது (${s(p['shop'])})`,
    sample: { storeId: 'store-1', shop: 'Asia/Kolkata' },
  },
  'box.clock.out': {
    en: (p) => (opt(p['offsetSeconds']) === undefined ? '' : `${Math.max(1, Math.round(Math.abs(n(p['offsetSeconds'])) / 60))} min ${n(p['offsetSeconds']) < 0 ? 'AHEAD of' : 'BEHIND'} head office`),
    ta: (p) => (opt(p['offsetSeconds']) === undefined ? '' : `தலைமை அலுவலகத்தை விட ${Math.max(1, Math.round(Math.abs(n(p['offsetSeconds'])) / 60))} நிமிடம் ${n(p['offsetSeconds']) < 0 ? 'முன்னால்' : 'பின்னால்'}`),
    sample: { offsetSeconds: -420 },
  },
  'box.clock.held': {
    en: (p) => {
      const held = heldList('en', p);
      return `store ${s(p['storeId'])}'s computer (${s(p['computer'])}): price change held — its clock is ${s(p['out']) || 'out'} (${n(p['flagMinutes'])} min or more, since ${s(p['since'])}). Prices and offers already running stay; no new price, offer or bill-number year starts on it until its clock is back in step, and every bill taken meanwhile is marked for checking. Selling goes on. ${held.length === 0 ? 'Nothing new has been due yet' : `Held now: ${held.join(', ')}`}. Ask IT to correct that computer's clock`;
    },
    ta: (p) => {
      const held = heldList('ta', p);
      return `கடை ${s(p['storeId'])} இன் கணினி (${s(p['computer'])}): விலை மாற்றம் நிறுத்தப்பட்டுள்ளது — அதன் கடிகாரம் ${s(p['out']) || 'தவறாக உள்ளது'} (${n(p['flagMinutes'])} நிமிடமோ அதற்கு மேலோ, ${s(p['since'])} முதல்). ஏற்கனவே நடைமுறையில் உள்ள விலைகளும் சலுகைகளும் தொடரும்; கடிகாரம் சரியாகும் வரை புதிய விலை, சலுகை, பில் எண் ஆண்டு எதுவும் அதில் தொடங்காது; இதற்கிடையில் எடுக்கும் ஒவ்வொரு பில்லும் சரிபார்க்கக் குறிக்கப்படும். விற்பனை தொடர்கிறது. ${held.length === 0 ? 'இதுவரை புதிதாக எதுவும் வரவில்லை' : `இப்போது நிறுத்தப்பட்டவை: ${held.join(', ')}`}. அந்தக் கணினியின் கடிகாரத்தைச் சரிசெய்ய IT-யிடம் சொல்லுங்கள்`;
    },
    sample: { storeId: 'store-1', computer: 'box-1', out: { kind: 'box.clock.out', params: { offsetSeconds: -420 } }, flagMinutes: 5, since: '2026-10-28T07:00:00Z', offers: ['P1'], prices: ['X9'] },
  },
  'box.clock.warning': {
    en: (p) => `store ${s(p['storeId'])}'s computer (${s(p['computer'])}): its clock is ${s(p['out'])} (${n(p['warnMinutes'])} min or more). Correct it before ${n(p['flagMinutes'])} min, when bills are marked and new prices and offers are held (OB-403)`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி (${s(p['computer'])}): அதன் கடிகாரம் ${s(p['out'])} (${n(p['warnMinutes'])} நிமிடமோ அதற்கு மேலோ). ${n(p['flagMinutes'])} நிமிடம் ஆகும் முன் சரிசெய்யுங்கள் — அப்போது பில்கள் குறிக்கப்படும், புதிய விலைகளும் சலுகைகளும் நிறுத்தப்படும் (OB-403)`,
    sample: { storeId: 'store-1', computer: 'box-1', out: { kind: 'box.clock.out', params: { offsetSeconds: 150 } }, warnMinutes: 2, flagMinutes: 5 },
  },
  'box.clock.notChecked': {
    en: (p) => `store ${s(p['storeId'])}'s computer has not compared its clock with head office since it started`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி தொடங்கியதிலிருந்து தன் கடிகாரத்தைத் தலைமை அலுவலகத்துடன் ஒப்பிடவில்லை`,
    sample: { storeId: 'store-1' },
  },
  'box.clock.ok': {
    en: (p) => `store ${s(p['storeId'])}'s computer's clock agrees with head office`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினிக் கடிகாரம் தலைமை அலுவலகத்துடன் ஒத்துப்போகிறது`,
    sample: { storeId: 'store-1' },
  },
  'box.clockHeld.store': {
    en: (p) => {
      const held = heldList('en', p);
      const m = opt(p['minutes']) === undefined ? undefined : n(p['minutes']);
      const outBy = m === undefined ? 'out (by how much was not measured)'
        : `${m} minute${m === 1 ? '' : 's'}${m >= 60 ? ` (${durationWordsIn('en', m * 60_000)})` : ''} ${b(p['ahead']) ? 'AHEAD of' : 'BEHIND'} head office`;
      return `store ${s(p['storeId'])} (computer ${s(p['computer'])}): its clock is ${outBy}, since ${s(p['since'])}; new prices and offers are HELD there — ${held.length === 0 ? 'nothing new has been due yet' : `held now: ${held.join(', ')}`}${b(p['stale']) ? ` (STALE — it last reported ${ago('en', p['agoSeconds'])} ago, ${s(p['at'])}; not heard from since, so this is its last word, not known to be the state now)` : ''}`;
    },
    ta: (p) => {
      const held = heldList('ta', p);
      const m = opt(p['minutes']) === undefined ? undefined : n(p['minutes']);
      const outBy = m === undefined ? 'தவறாக உள்ளது (எவ்வளவு என்று அளக்கப்படவில்லை)'
        : `தலைமை அலுவலகத்தை விட ${m >= 60 ? durationWordsIn('ta', m * 60_000) : `${m} நிமிடம்`} ${b(p['ahead']) ? 'முன்னால்' : 'பின்னால்'}`;
      return `கடை ${s(p['storeId'])} (கணினி ${s(p['computer'])}): அதன் கடிகாரம் ${outBy}, ${s(p['since'])} முதல்; அங்கே புதிய விலைகளும் சலுகைகளும் நிறுத்தப்பட்டுள்ளன — ${held.length === 0 ? 'இதுவரை புதிதாக எதுவும் வரவில்லை' : `இப்போது நிறுத்தப்பட்டவை: ${held.join(', ')}`}${b(p['stale']) ? ` (பழைய தகவல் — கடைசியாக ${ago('ta', p['agoSeconds'])} முன்பு, ${s(p['at'])} அன்று தெரிவித்தது; அதன் பிறகு எதுவும் வரவில்லை, எனவே இது அதன் கடைசிச் சொல், இப்போதைய நிலை தெரியாது)` : ''}`;
    },
    sample: { storeId: 'store-1', computer: 'box-1', minutes: 7, ahead: true, since: '2026-10-28T07:00:00Z', offers: ['P1'], prices: [], stale: true, agoSeconds: 4_000, at: '2026-10-28T07:00:00Z' },
  },
  'box.clockHeld': {
    en: (p) => {
      const stores = l(p['stores']);
      const one = stores.length === 1;
      return `price change held — ${one ? "a store computer's clock is" : `${stores.length} store computers' clocks are`} 5 minutes or more out: ${stores.join('; ')}. Prices and offers already running stay, selling goes on, and every bill taken meanwhile is marked for checking. Ask IT to correct ${one ? "that computer's clock" : "those computers' clocks"}; this clears by itself when ${one ? 'it reports its clock' : 'each reports its clock'} back in step, and the held changes then start (owner decisions OB-403, OB-409)`;
    },
    ta: (p) => {
      const stores = l(p['stores']);
      return `விலை மாற்றம் நிறுத்தப்பட்டுள்ளது — ${stores.length === 1 ? 'ஒரு கடை கணினியின் கடிகாரம்' : `${stores.length} கடை கணினிகளின் கடிகாரங்கள்`} 5 நிமிடமோ அதற்கு மேலோ தவறாக உள்ளன: ${stores.join('; ')}. ஏற்கனவே நடைமுறையில் உள்ள விலைகளும் சலுகைகளும் தொடரும், விற்பனை தொடர்கிறது; இதற்கிடையில் எடுக்கும் ஒவ்வொரு பில்லும் சரிபார்க்கக் குறிக்கப்படும். கடிகாரத்தைச் சரிசெய்ய IT-யிடம் சொல்லுங்கள்; கடிகாரம் சரியானதாகத் தெரிவித்ததும் இது தானாகவே நீங்கும், நிறுத்தப்பட்ட மாற்றங்கள் அப்போது தொடங்கும் (உரிமையாளர் முடிவுகள் OB-403, OB-409)`;
    },
    sample: { stores: [{ kind: 'box.clockHeld.store', params: { storeId: 'store-1', computer: 'box-1', minutes: 7, ahead: false, since: '2026-10-28T07:00:00Z', offers: [], prices: ['X9'], stale: false, agoSeconds: 0, at: '2026-10-28T07:00:00Z' } }] },
  },
  'box.bn.witnessUnavailable': {
    en: (p) => `store ${s(p['storeId'])}'s computer CANNOT keep its bill-number witness (${opt(p['fault']) ?? 'the witness folder could not be opened'}), so it treats every restart as a possible restore and numbers under a brand-new prefix until head office answers — no bill number is ever repeated, but fix its witness folder (EDGE_WITNESS_DIR)`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினியால் தன் பில் எண் சாட்சியை (witness) வைத்திருக்க முடியவில்லை (${opt(p['fault']) ?? 'சாட்சிக் கோப்புறையைத் திறக்க முடியவில்லை'}); எனவே ஒவ்வொரு மறுதொடக்கத்தையும் மீட்டெடுப்பாக இருக்கலாம் என்று கருதி, தலைமை அலுவலகம் பதில் தரும் வரை புத்தம் புதிய முன்னொட்டின் கீழ் எண்ணிடுகிறது — எந்தப் பில் எண்ணும் மீண்டும் வராது, ஆனால் அதன் சாட்சிக் கோப்புறையைச் சரிசெய்யுங்கள் (EDGE_WITNESS_DIR)`,
    sample: { storeId: 'store-1', fault: null },
  },
  'box.bn.sharedWitness': {
    en: (p) => `store ${s(p['storeId'])}'s computer shares its witness folder with ${l(p['others']).length} other store computer(s) (${l(p['others']).join('; ')}) — give each its own`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி தன் சாட்சிக் கோப்புறையை வேறு ${l(p['others']).length} கடை கணினி(களுடன்) பகிர்கிறது (${l(p['others']).join('; ')}) — ஒவ்வொன்றுக்கும் தனிக் கோப்புறை கொடுங்கள்`,
    sample: { storeId: 'store-1', others: [{ kind: 'box.bn.sharedWith', params: { box: 'box-2', at: '2026-10-28T07:00:00Z' } }] },
  },
  'box.bn.sharedWith': {
    en: (p) => `${s(p['box'])}, last written ${s(p['at'])}`,
    ta: (p) => `${s(p['box'])}, கடைசியாக எழுதியது ${s(p['at'])}`,
    sample: { box: 'box-2', at: '2026-10-28T07:00:00Z' },
  },
  'box.bn.restoreHeld': {
    en: (p) => `store ${s(p['storeId'])}'s computer is numbering under a brand-new prefix since ${opt(p['since']) ?? '?'} because it may have been restored from a backup (${opt(p['because']) ?? 'possible restore'}), until head office's setup reaches it`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி காப்புப் பிரதியிலிருந்து மீட்டெடுக்கப்பட்டிருக்கலாம் என்பதால் (${opt(p['because']) ?? 'மீட்டெடுப்பாக இருக்கலாம்'}), தலைமை அலுவலக அமைப்பு அதை அடையும் வரை ${opt(p['since']) ?? '?'} முதல் புத்தம் புதிய முன்னொட்டின் கீழ் எண்ணிடுகிறது`,
    sample: { storeId: 'store-1', since: '2026-10-28T07:00:00Z', because: null },
  },
  'box.bn.ok': {
    en: (p) => `store ${s(p['storeId'])}'s computer keeps its bill-number witness; nothing to look at`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி தன் பில் எண் சாட்சியை வைத்திருக்கிறது; பார்க்க எதுவும் இல்லை`,
    sample: { storeId: 'store-1' },
  },
  'box.estimate.known': {
    en: (p) => `about ${n(p['hours'])} hours of trading left before it would refuse a sale (the sales log grew ${mb(p['perHour'])} per trading hour over ${n(p['minutes'])} minutes of trading in its reports since ${s(p['from'])}; ${mb(p['room'])} of room left above the reserve)`,
    ta: (p) => `விற்பனையை மறுக்கும் முன் சுமார் ${n(p['hours'])} மணி நேர வியாபாரம் மீதமுள்ளது (${s(p['from'])} முதல் அதன் அறிக்கைகளில் ${n(p['minutes'])} நிமிட வியாபாரத்தில், விற்பனைப் பதிவேடு ஒரு வியாபார மணிக்கு ${mb(p['perHour'])} வளர்ந்தது; இருப்புக்கு மேல் ${mb(p['room'])} இடம் உள்ளது)`,
    sample: { hours: 30.5, perHour: 5_000_000, minutes: 300, from: '2026-10-27T09:00:00Z', room: 150_000_000 },
  },
  'box.estimate.unknown': {
    en: (p) => `hours of trading left: not yet known — the store computer's reports show the sales log growing over ${n(p['gaps'])} gap(s) of at most ${n(p['maxGap'])} minutes and ${n(p['minutes'])} minute(s) of trading; at least ${n(p['minGaps'])} gaps and ${n(p['minMinutes'])} minutes are needed before it can be estimated (never guessed)`,
    ta: (p) => `மீதமுள்ள வியாபார நேரம்: இன்னும் தெரியவில்லை — கடை கணினியின் அறிக்கைகள், அதிகபட்சம் ${n(p['maxGap'])} நிமிட இடைவெளிகளில் ${n(p['gaps'])} இடைவெளி(களிலும்) ${n(p['minutes'])} நிமிட வியாபாரத்திலும் விற்பனைப் பதிவேடு வளர்வதைக் காட்டுகின்றன; மதிப்பிடக் குறைந்தது ${n(p['minGaps'])} இடைவெளிகளும் ${n(p['minMinutes'])} நிமிடங்களும் தேவை (ஒருபோதும் ஊகிக்கப்படாது)`,
    sample: { gaps: 1, maxGap: 60, minutes: 20, minGaps: 2, minMinutes: 60 },
  },
  'box.disk.runningOut': {
    en: (p) => `store ${s(p['storeId'])}'s computer will run out of room for sales soon — ${s(p['estimate'])}, below the owner's warning line of ${n(p['warnHours'])} hours. Make room on it (or give it a bigger disk) before the tills have to refuse sales`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினியில் விற்பனைக்கான இடம் விரைவில் தீர்ந்துவிடும் — ${s(p['estimate'])}; உரிமையாளரின் ${n(p['warnHours'])} மணி நேர எச்சரிக்கை வரம்புக்குக் கீழே. கவுண்டர்கள் விற்பனையை மறுக்கும் முன் அதில் இடம் ஏற்படுத்துங்கள் (அல்லது பெரிய வட்டு கொடுங்கள்)`,
    sample: { storeId: 'store-1', estimate: { kind: 'box.estimate.known', params: { hours: 20, perHour: 5_000_000, minutes: 300, from: '2026-10-27T09:00:00Z', room: 100_000_000 } }, warnHours: 48 },
  },
  'box.disk.can': {
    en: (p) => `store ${s(p['storeId'])}'s computer can record sales: ${mb(p['free'])} free of ${mb(p['total'])}, ${mb(p['headroom'])} of sales-log room left above the reserve; ${s(p['estimate'])}`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி விற்பனையைப் பதிவு செய்ய முடியும்: ${mb(p['total'])} இல் ${mb(p['free'])} காலி; இருப்புக்கு மேல் விற்பனைப் பதிவேட்டில் ${mb(p['headroom'])} இடம் உள்ளது; ${s(p['estimate'])}`,
    sample: { storeId: 'store-1', free: 10_000_000_000, total: 50_000_000_000, headroom: 900_000_000, estimate: { kind: 'box.estimate.unknown', params: { gaps: 1, maxGap: 60, minutes: 20, minGaps: 2, minMinutes: 60 } } },
  },
  'box.disk.full': {
    en: (p) => `store ${s(p['storeId'])}'s computer CANNOT record another sale — its disk is full (${mb(p['free'])} free; sales log ${mb(p['used'])} of ${mb(p['capacity'])} with a ${mb(p['reserve'])} reserve). Its tills refuse sales until room is made`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினியால் இன்னொரு விற்பனையைப் பதிவு செய்ய முடியாது — அதன் வட்டு நிரம்பியுள்ளது (${mb(p['free'])} காலி; விற்பனைப் பதிவேடு ${mb(p['capacity'])} இல் ${mb(p['used'])}, இருப்பு ${mb(p['reserve'])}). இடம் ஏற்படுத்தும் வரை அதன் கவுண்டர்கள் விற்பனையை மறுக்கும்`,
    sample: { storeId: 'store-1', free: 1_000_000, used: 990_000_000, capacity: 1_000_000_000, reserve: 20_000_000 },
  },
  'box.disk.withOthers': {
    en: (p) => `${s(p['says'])}${s(p['others'])}`,
    ta: (p) => `${s(p['says'])}${s(p['others'])}`,
    sample: { says: { kind: 'box.disk.full', params: { storeId: 'store-1', free: 1_000_000, used: 990_000_000, capacity: 1_000_000_000, reserve: 20_000_000 } }, others: '' },
  },
  'box.queue.contradicts': {
    en: (p) => `store ${s(p['storeId'])}'s computer's report contradicts itself — ${s(p['contradiction'])}; head office does not believe its list of bills still to send`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினியின் அறிக்கை தனக்குத் தானே முரண்படுகிறது — ${s(p['contradiction'])}; அனுப்ப வேண்டிய பில்களின் அதன் பட்டியலைத் தலைமை அலுவலகம் நம்பவில்லை`,
    sample: { storeId: 'store-1', contradiction: { kind: 'box.queueContradiction', params: { unsentOver: true, unsent: 9, queueUnsent: 4, deadOver: false, dead: 0, queueDead: 0 } } },
  },
  'box.queue.empty': {
    en: (p) => `store ${s(p['storeId'])}'s computer has sent everything`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி எல்லாவற்றையும் அனுப்பிவிட்டது`,
    sample: { storeId: 'store-1' },
  },
  'box.queue.holds': {
    en: (p) => {
      const waiting = l(p['waiting']).join('. ');
      return `store ${s(p['storeId'])}'s computer holds ${n(p['unsent'])} item(s) still to send${n(p['bills']) > 0 ? ` (${n(p['bills'])} of them bills)` : ''}${n(p['dead']) > 0 ? ` and ${n(p['dead'])} item(s) it gave up sending, waiting for a person (do NOT re-enter those bills from paper)` : ''}${waiting === '' ? '' : `. ${waiting}`}`;
    },
    ta: (p) => {
      const waiting = l(p['waiting']).join('. ');
      return `கடை ${s(p['storeId'])} இன் கணினியில் இன்னும் அனுப்ப வேண்டிய ${n(p['unsent'])} பதிவு(கள்) உள்ளன${n(p['bills']) > 0 ? ` (அவற்றில் ${n(p['bills'])} பில்கள்)` : ''}${n(p['dead']) > 0 ? `; அனுப்புவதைக் கைவிட்ட ${n(p['dead'])} பதிவு(கள்) ஒருவருக்காகக் காத்திருக்கின்றன (அந்தப் பில்களைக் காகிதத்திலிருந்து மீண்டும் பதிவு செய்ய வேண்டாம்)` : ''}${waiting === '' ? '' : `. ${waiting}`}`;
    },
    sample: { storeId: 'store-1', unsent: 5, bills: 3, dead: 1, waiting: [] },
  },
  'box.several.holding': {
    en: (p) => `${s(p['computer'])} (${l(p['prefixes']).join(', ')})`,
    ta: (p) => `${s(p['computer'])} (முன்னொட்டுகள்: ${l(p['prefixes']).join(', ')})`,
    sample: { computer: 'box-1', prefixes: ['R-1-', 'R-2-'] },
  },
  'box.several.each': {
    en: (p) => `${s(p['computer'])}: ${s(p['says'])}`,
    ta: (p) => `${s(p['computer'])}: ${s(p['says'])}`,
    sample: { computer: 'box-1', says: { kind: 'box.queue.empty', params: { storeId: 'store-1' } } },
  },
  'box.disk.several': {
    en: (p) => `store ${s(p['storeId'])} has ${l(p['holding']).length} store computers holding its tills' bill numbers — ${l(p['holding']).join(' and ')}; head office judges each on its own and the worse decides: ${l(p['each']).join(' | ')}${s(p['others'])}`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கவுண்டர்களின் பில் எண்களை ${l(p['holding']).length} கடை கணினிகள் வைத்திருக்கின்றன — ${l(p['holding']).join(', ')}; தலைமை அலுவலகம் ஒவ்வொன்றையும் தனியாக மதிப்பிடுகிறது, மோசமானதே முடிவு செய்கிறது: ${l(p['each']).join(' | ')}${s(p['others'])}`,
    sample: { storeId: 'store-1', holding: [{ kind: 'box.several.holding', params: { computer: 'box-1', prefixes: ['R-1-'] } }, { kind: 'box.several.holding', params: { computer: 'box-2', prefixes: ['R-2-'] } }], each: [{ kind: 'box.several.each', params: { computer: 'box-1', says: { kind: 'box.queue.empty', params: { storeId: 'store-1' } } } }], others: '' },
  },
  'box.queue.several': {
    en: (p) => {
      const past = l(p['pastLine']).join('. ');
      return `store ${s(p['storeId'])} has ${l(p['holding']).length} store computers holding its tills' bill numbers — ${l(p['holding']).join(' and ')}; each judged on its own, the worse decides: ${l(p['each']).join(' | ')}${past === '' ? '' : `. ${past}`}`;
    },
    ta: (p) => {
      const past = l(p['pastLine']).join('. ');
      return `கடை ${s(p['storeId'])} இன் கவுண்டர்களின் பில் எண்களை ${l(p['holding']).length} கடை கணினிகள் வைத்திருக்கின்றன — ${l(p['holding']).join(', ')}; ஒவ்வொன்றும் தனியாக மதிப்பிடப்படுகிறது, மோசமானதே முடிவு செய்கிறது: ${l(p['each']).join(' | ')}${past === '' ? '' : `. ${past}`}`;
    },
    sample: { storeId: 'store-1', holding: [{ kind: 'box.several.holding', params: { computer: 'box-1', prefixes: ['R-1-'] } }], each: [{ kind: 'box.several.each', params: { computer: 'box-1', says: { kind: 'box.queue.empty', params: { storeId: 'store-1' } } } }], pastLine: [] },
  },
  'box.tills.none': {
    en: (p) => `no till at store ${s(p['storeId'])} has reported its scanner, printer, scale, drawer or card machine yet — not known, never "all fine"`,
    ta: (p) => `கடை ${s(p['storeId'])} இல் எந்தக் கவுண்டரும் தன் ஸ்கேனர், அச்சுப்பொறி, தராசு, பணப் பெட்டி, அட்டை இயந்திரம் பற்றி இன்னும் தெரிவிக்கவில்லை — தெரியாது, "எல்லாம் சரி" அல்ல`,
    sample: { storeId: 'store-1' },
  },
  'box.tills.device': {
    en: (p) => `${s(p['lane'])}: ${s(p['kind']).replace('_', ' ')} ${b(p['failed']) ? 'has failed' : 'is not working properly'}${opt(p['detail']) === undefined ? '' : ` — ${s(p['detail'])}`}`,
    ta: (p) => `${s(p['lane'])}: ${DEVICE_TA[s(p['kind'])] ?? s(p['kind'])} ${b(p['failed']) ? 'பழுதாகிவிட்டது' : 'சரியாக வேலை செய்யவில்லை'}${opt(p['detail']) === undefined ? '' : ` — ${s(p['detail'])}`}`,
    sample: { lane: 'lane-1', kind: 'card_terminal', failed: true, detail: 'no response on COM3' },
  },
  'box.tills.freshBad': {
    en: (p) => `store ${s(p['storeId'])}: ${l(p['bad']).join('; ')} — the till still sells; a person should fix it`,
    ta: (p) => `கடை ${s(p['storeId'])}: ${l(p['bad']).join('; ')} — கவுண்டர் இன்னும் விற்கிறது; ஒருவர் இதைச் சரிசெய்ய வேண்டும்`,
    sample: { storeId: 'store-1', bad: [{ kind: 'box.tills.device', params: { lane: 'lane-1', kind: 'printer', failed: false, detail: null } }] },
  },
  'box.tills.allOk': {
    en: (p) => `every till device at store ${s(p['storeId'])} that reported recently said it was working`,
    ta: (p) => `கடை ${s(p['storeId'])} இல் சமீபத்தில் தெரிவித்த ஒவ்வொரு கவுண்டர் கருவியும் வேலை செய்வதாகச் சொன்னது`,
    sample: { storeId: 'store-1' },
  },
  'box.tills.staleLane': {
    en: (p) => {
      const why = s(p['why']);
      const whyWords = why === 'adapter' ? ' — the till is still re-sending, but its device adapter has not observed the devices since then: the adapter may have hung, check that till'
        : why === 'unattended' ? ' — nobody is signed in at that till, so it has stopped re-sending (expected when it is closed or unattended)'
        : why === 'attended' ? ' — a cashier IS signed in there, so it should still be re-sending every few minutes: check that till' : '';
      return `till ${s(p['lane'])} last ${why === 'adapter' ? 'had its devices observed by its device adapter' : 'reported its devices'} ${ago('en', p['agoSeconds'])} ago (${s(p['at'])})${l(p['bad']).length === 0 ? '' : `, then saying ${l(p['bad']).join('; ')}`}${whyWords}`;
    },
    ta: (p) => {
      const why = s(p['why']);
      const whyWords = why === 'adapter' ? ' — கவுண்டர் இன்னும் மீண்டும் அனுப்புகிறது, ஆனால் அதன் கருவி இணைப்பி (adapter) அதன் பிறகு கருவிகளைப் பார்க்கவில்லை: இணைப்பி நின்றிருக்கலாம், அந்தக் கவுண்டரைச் சரிபார்க்கவும்'
        : why === 'unattended' ? ' — அந்தக் கவுண்டரில் யாரும் உள்நுழையவில்லை, எனவே அது மீண்டும் அனுப்புவதை நிறுத்திவிட்டது (மூடியிருக்கும்போது எதிர்பார்க்கக்கூடியது)'
        : why === 'attended' ? ' — அங்கே ஒரு காசாளர் உள்நுழைந்துள்ளார், எனவே அது சில நிமிடங்களுக்கு ஒருமுறை அனுப்ப வேண்டும்: அந்தக் கவுண்டரைச் சரிபார்க்கவும்' : '';
      return `கவுண்டர் ${s(p['lane'])} ${why === 'adapter' ? 'இன் கருவிகளை அதன் இணைப்பி கடைசியாகப் பார்த்தது' : 'கடைசியாகத் தன் கருவிகளைத் தெரிவித்தது'} ${ago('ta', p['agoSeconds'])} முன்பு (${s(p['at'])})${l(p['bad']).length === 0 ? '' : `; அப்போது: ${l(p['bad']).join('; ')}`}${whyWords}`;
    },
    sample: { lane: 'lane-2', why: 'attended', agoSeconds: 4_000, at: '2026-10-28T07:00:00Z', bad: [] },
  },
  'box.tills.stale': {
    en: (p) => `STALE — ${l(p['lanes']).join('; ')}: not heard from since, so its devices are not known now`,
    ta: (p) => `பழைய தகவல் — ${l(p['lanes']).join('; ')}: அதன் பிறகு எதுவும் வரவில்லை, எனவே அதன் கருவிகளின் இப்போதைய நிலை தெரியாது`,
    sample: { lanes: [{ kind: 'box.tills.staleLane', params: { lane: 'lane-2', why: 'unattended', agoSeconds: 4_000, at: '2026-10-28T07:00:00Z', bad: [] } }] },
  },
  'box.door': {
    en: (p) => `${l(p['lines']).join('; ')}. If these are this store computer's own tills, have the IT administrator register its lanes (POST /v1/store-computers/lane-prefixes — docs/runbooks/in-store-install.md, "Register the store computer's own lanes"); if not, check that store computer${b(p['zz']) ? '. ZZ… is a store computer\'s own fallback numbering for a till head office has not issued a prefix to (each such bill is also flagged) — issue that till its prefix (Receipt prefixes)' : ''}`,
    ta: (p) => `${l(p['lines']).join('; ')}. இவை இந்தக் கடை கணினியின் சொந்தக் கவுண்டர்கள் என்றால், IT நிர்வாகியிடம் அதன் கவுண்டர்களைப் பதிவு செய்யச் சொல்லுங்கள் (POST /v1/store-computers/lane-prefixes — docs/runbooks/in-store-install.md, "Register the store computer's own lanes"); இல்லையென்றால், அந்தக் கடை கணினியைச் சரிபார்க்கவும்${b(p['zz']) ? '. ZZ… என்பது தலைமை அலுவலகம் முன்னொட்டு வழங்காத கவுண்டருக்குக் கடை கணினியின் சொந்த மாற்று எண்ணிடல் (அப்படிப்பட்ட ஒவ்வொரு பில்லும் குறிக்கப்படும்) — அந்தக் கவுண்டருக்கு அதன் முன்னொட்டை வழங்குங்கள் (ரசீது முன்னொட்டுகள்)' : ''}`,
    sample: { lines: [{ kind: 'box.door.line', params: { storeId: 'store-1', computer: 'box-1', count: 3, day: '2026-10-28', examples: ['ZZ-1-'], first: '2026-10-28T01:00:00Z', last: '2026-10-28T05:00:00Z' } }], zz: true },
  },
  'box.door.line': {
    en: (p) => `store ${s(p['storeId'])}'s computer ${s(p['computer'])} sent ${n(p['count'])} report(s) on ${s(p['day'])} naming bill-number prefixes head office never issued to this store's tills or registered for this computer (e.g. ${l(p['examples']).join(', ')}; first ${s(p['first'])}, last ${s(p['last'])}) — refused at the door and not kept (owner decision OB-121)`,
    ta: (p) => `கடை ${s(p['storeId'])} இன் கணினி ${s(p['computer'])}, ${s(p['day'])} அன்று ${n(p['count'])} அறிக்கை(களை) அனுப்பியது; அவை, தலைமை அலுவலகம் இந்தக் கடையின் கவுண்டர்களுக்கு ஒருபோதும் வழங்காத அல்லது இந்தக் கணினிக்குப் பதிவு செய்யாத பில் எண் முன்னொட்டுகளைக் குறிப்பிட்டன (எ.கா. ${l(p['examples']).join(', ')}; முதல் ${s(p['first'])}, கடைசி ${s(p['last'])}) — வாசலிலேயே மறுக்கப்பட்டன, வைக்கப்படவில்லை (உரிமையாளர் முடிவு OB-121)`,
    sample: { storeId: 'store-1', computer: 'box-1', count: 3, day: '2026-10-28', examples: ['R-9-'], first: '2026-10-28T01:00:00Z', last: '2026-10-28T05:00:00Z' },
  },
} as const satisfies Readonly<Record<string, AlertTemplate>>;

/** The long-standing English sentences other modules export (word for word as they always were). */
export const BOX_STAYS_ENGLISH = { notChecked: STAYS_NOT_CHECKED_EN, unused: STAYS_UNUSED_EN, refusal: STAYS_REFUSAL_EN } as const;
