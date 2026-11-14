// EPR registers — the records a person keeps (W5 · OB-212 · R4 B20–B22 · hard rules #2, #6) — a tested, DOM-free session for
// the forms the EPR registers page lacked. The page already showed the plastic return, the take-back stock and its
// exceptions, and recorded a take-back and a take-back handover; every OTHER record on the registers could only be made by a
// programmer:
//   • CONFIRM AN ANSWER — the registration number, any exemption, and whether the shop is an e-waste or battery brand owner,
//     with who confirmed it and their reference (`POST /v1/compliance/epr/settings/:key`, `epr.settings.configure` — the
//     owner and the CA; the store manager may not). "Not confirmed" until both are given — the page never fills one in;
//   • OWN-BRAND PACKAGING — mark a product the shop's own brand with the plastic in one unit per packaging category
//     (`POST …/own-brand/:productId`) and read the register (`GET …/own-brand`). A mark with no packaging is allowed and is
//     listed as an exception — never counted as zero;
//   • RECYCLERS — add one, or record the registration number of one already listed (`POST …/recyclers/:id`). With no number
//     nothing may be handed to it;
//   • THE SHOP'S OWN E-WASTE — an old till, scale or light handed to a registered recycler, naming the fixed asset it disposes
//     of (`POST …/handovers/:id`);
//   • COUNT THE TAKE-BACK BIN — a difference from the register is an exception (`POST …/take-back-stock/counts/:id`);
//   • NOT E-WASTE — a person records, with a reason, that a disposed asset was not electrical or electronic
//     (`POST …/assets/:assetId/not-e-waste`).
// Recording needs `epr.register.record`. Head office re-checks every act and refuses in its own words (OB-553); a write
// whose answer was lost is sent again as the SAME record. Every word this section adds has a Tamil twin.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { steadyWriter } from './compliance-registers-session';

export type Lang = 'en' | 'ta';

export const EPR_RECORDS_COPY = {
  en: {
    confirmH: 'Confirm an answer', confirmLead: 'Write the answer the CA or EPR consultant gave and who confirmed it, with their reference. It stays "Not confirmed" until both are written.',
    setting: 'Which answer', value: 'The answer', confirmation: 'Confirmed by (name and reference)', confirmGo: 'Save the answer',
    plasticRegistration: 'Plastic EPR registration number', plasticExemption: 'Plastic EPR exemption', eWasteBrandOwner: 'E-waste brand owner?', batteryBrandOwner: 'Battery brand owner?',
    cannotConfirm: 'Only the owner or the CA confirms these answers.',
    ownBrandH: 'Own-brand packaging', ownBrandLead: 'Mark a product the shop\'s own brand and write the plastic in one unit, per packaging category. A product with no packaging written is listed as an exception, never counted as nothing.',
    product: 'Product id', isOwnBrand: 'Own brand', yes: 'Yes', no: 'No', category: 'Category', gramsPerUnit: 'Plastic in one unit (grams)', part: 'Which part (optional)', declareGo: 'Save the declaration',
    register: 'The register', noDeclarations: 'No product has been marked own brand yet.', missing: 'packaging not declared', notOwnBrand: 'not own brand', perUnit: 'g per unit',
    recyclerH: 'Recyclers', recyclerLead: 'Nothing is handed to a recycler with no registration number.', recycler: 'Recycler', newRecycler: 'A new recycler', recyclerName: 'Name', registrationNumber: 'Registration number', recyclerGo: 'Save the recycler',
    noNumber: 'no registration number',
    shopH: 'Hand over the shop\'s own e-waste', shopLead: 'An old till, scale, light or battery the shop used, handed to a registered recycler.', kind: 'Kind', battery: 'Battery', e_waste: 'E-waste',
    what: 'What is handed over', weight: 'Weight (grams)', batteryType: 'Battery type', asset: 'Fixed asset it disposes of (optional)', noAsset: 'None', note: 'Handover note number', shopGo: 'Record the handover',
    countH: 'Count the take-back bin', countLead: 'Weigh what is in the take-back bin now. A difference from the register is shown as an exception.', counted: 'Counted (grams)', countGo: 'Record the count',
    notEWasteH: 'A disposed asset that was not e-waste', notEWasteLead: 'Only for a disposed fixed asset with nothing electrical or electronic in it.', why: 'Why it is not e-waste', notEWasteGo: 'Record it', noAssets: 'No disposed asset is waiting for an e-waste handover.',
    saved: 'Saved', countSame: 'The count matches the register.', countDiffers: 'The count differs from the register — it is listed as an exception.',
    needSetting: 'Choose the answer and write it.', needDeclaration: 'Write the product id, and the plastic per unit as grams with at most three decimals.', needRecycler: 'Write the recycler\'s name.',
    needShop: 'Choose the recycler, and write what is handed over, its weight in whole grams, the battery type for a battery, and the handover note number.',
    needCount: 'Write the counted weight in whole grams, and the battery type for batteries.', needReason: 'Choose the asset and write why it is not e-waste.',
    cannotRecord: 'Your role can read the EPR registers but not record on them.', nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the EPR registers.',
    refused: 'Not recorded:', unreachable: 'Head office could not be reached. Nothing was recorded — try again: the same record is sent, never a second one.', reading: 'Asking head office…',
  },
  ta: {
    confirmH: 'பதிலை உறுதிசெய்', confirmLead: 'CA அல்லது EPR ஆலோசகர் தந்த பதிலையும், உறுதிசெய்தவரையும் அவரது குறிப்புடன் எழுதுங்கள். இரண்டும் எழுதப்படும் வரை "உறுதிசெய்யப்படவில்லை" என்றே இருக்கும்.',
    setting: 'எந்தப் பதில்', value: 'பதில்', confirmation: 'உறுதிசெய்தவர் (பெயர் மற்றும் குறிப்பு)', confirmGo: 'பதிலைச் சேமி',
    plasticRegistration: 'பிளாஸ்டிக் EPR பதிவு எண்', plasticExemption: 'பிளாஸ்டிக் EPR விலக்கு', eWasteBrandOwner: 'மின்கழிவு பிராண்ட் உரிமையாளரா?', batteryBrandOwner: 'பேட்டரி பிராண்ட் உரிமையாளரா?',
    cannotConfirm: 'உரிமையாளர் அல்லது CA மட்டுமே இந்தப் பதில்களை உறுதிசெய்வார்.',
    ownBrandH: 'சொந்த பிராண்ட் பொதி', ownBrandLead: 'ஒரு பொருளைக் கடையின் சொந்த பிராண்ட் எனக் குறித்து, ஒவ்வொரு பொதி வகைக்கும் ஒரு அலகில் உள்ள பிளாஸ்டிக்கை எழுதுங்கள். பொதி எழுதப்படாத பொருள் விதிவிலக்காகக் காட்டப்படும், பூஜ்யமாகக் கணக்கிடப்படாது.',
    product: 'பொருள் அடையாளம்', isOwnBrand: 'சொந்த பிராண்ட்', yes: 'ஆம்', no: 'இல்லை', category: 'வகை', gramsPerUnit: 'ஒரு அலகில் பிளாஸ்டிக் (கிராம்)', part: 'எந்தப் பகுதி (விருப்பம்)', declareGo: 'அறிவிப்பைச் சேமி',
    register: 'பதிவேடு', noDeclarations: 'இன்னும் எந்தப் பொருளும் சொந்த பிராண்ட் எனக் குறிக்கப்படவில்லை.', missing: 'பொதி அறிவிக்கப்படவில்லை', notOwnBrand: 'சொந்த பிராண்ட் அல்ல', perUnit: 'கி ஒரு அலகுக்கு',
    recyclerH: 'மறுசுழற்சியாளர்கள்', recyclerLead: 'பதிவு எண் இல்லாத மறுசுழற்சியாளரிடம் எதுவும் ஒப்படைக்கப்படாது.', recycler: 'மறுசுழற்சியாளர்', newRecycler: 'புதிய மறுசுழற்சியாளர்', recyclerName: 'பெயர்', registrationNumber: 'பதிவு எண்', recyclerGo: 'மறுசுழற்சியாளரைச் சேமி',
    noNumber: 'பதிவு எண் இல்லை',
    shopH: 'கடையின் சொந்த மின்கழிவை ஒப்படை', shopLead: 'கடை பயன்படுத்திய பழைய பில் இயந்திரம், தராசு, விளக்கு அல்லது பேட்டரி — பதிவுபெற்ற மறுசுழற்சியாளரிடம் ஒப்படைக்கப்பட்டது.', kind: 'வகை', battery: 'பேட்டரி', e_waste: 'மின்கழிவு',
    what: 'ஒப்படைக்கப்படுவது', weight: 'எடை (கிராம்)', batteryType: 'பேட்டரி வகை', asset: 'இது அகற்றும் நிலைச் சொத்து (விருப்பம்)', noAsset: 'எதுவும் இல்லை', note: 'ஒப்படைப்புச் சீட்டு எண்', shopGo: 'ஒப்படைப்பைப் பதிவு செய்',
    countH: 'திரும்பப் பெறும் தொட்டியை எண்ணு', countLead: 'திரும்பப் பெறும் தொட்டியில் இப்போது உள்ளதை எடைபோடுங்கள். பதிவேட்டிலிருந்து வேறுபாடு விதிவிலக்காகக் காட்டப்படும்.', counted: 'எண்ணியது (கிராம்)', countGo: 'எண்ணிக்கையைப் பதிவு செய்',
    notEWasteH: 'மின்கழிவு அல்லாத அகற்றப்பட்ட சொத்து', notEWasteLead: 'மின்சார அல்லது மின்னணு பாகம் இல்லாத அகற்றப்பட்ட நிலைச் சொத்துக்கு மட்டும்.', why: 'ஏன் மின்கழிவு அல்ல', notEWasteGo: 'பதிவு செய்', noAssets: 'மின்கழிவு ஒப்படைப்புக்காகக் காத்திருக்கும் அகற்றப்பட்ட சொத்து இல்லை.',
    saved: 'சேமிக்கப்பட்டது', countSame: 'எண்ணிக்கை பதிவேட்டுடன் பொருந்துகிறது.', countDiffers: 'எண்ணிக்கை பதிவேட்டிலிருந்து வேறுபடுகிறது — விதிவிலக்காகக் காட்டப்படுகிறது.',
    needSetting: 'பதிலைத் தேர்ந்தெடுத்து எழுதுங்கள்.', needDeclaration: 'பொருள் அடையாளத்தையும், ஒரு அலகுக்கான பிளாஸ்டிக்கை அதிகபட்சம் மூன்று தசம இடங்களுடன் கிராமில் எழுதுங்கள்.', needRecycler: 'மறுசுழற்சியாளரின் பெயரை எழுதுங்கள்.',
    needShop: 'மறுசுழற்சியாளரைத் தேர்ந்தெடுத்து, ஒப்படைக்கப்படுவது, முழு கிராமில் எடை, பேட்டரி என்றால் வகை, ஒப்படைப்புச் சீட்டு எண் ஆகியவற்றை எழுதுங்கள்.',
    needCount: 'எண்ணிய எடையை முழு கிராமில் எழுதுங்கள்; பேட்டரி என்றால் வகையையும்.', needReason: 'சொத்தைத் தேர்ந்தெடுத்து ஏன் மின்கழிவு அல்ல என்று எழுதுங்கள்.',
    cannotRecord: 'உங்கள் பங்கு EPR பதிவேடுகளைப் படிக்கலாம், பதிவு செய்ய முடியாது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு EPR பதிவேடுகளைப் படிக்க முடியாது.',
    refused: 'பதிவு செய்யப்படவில்லை:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் பதிவு செய்யப்படவில்லை — மீண்டும் முயலுங்கள்: அதே பதிவுதான் அனுப்பப்படும், இரண்டாவது அல்ல.', reading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
  },
} as const;

export const eprRecordsWords = (lang: Lang, key: string): string =>
  (EPR_RECORDS_COPY[lang] as Record<string, string>)[key] ?? (EPR_RECORDS_COPY.en as Record<string, string>)[key] ?? key;
export const eprRecordsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => eprRecordsWords(lang, k), out);

/** The answers' keys as the register names them, and as the route's path names them. */
/**
 * U3 · OB-699: the four questions a CA or EPR consultant answers, and the take-back rule, are the PRODUCT's own words — the
 * same sentences head office keeps in English (`packages/epr/src/packaging-register.ts` EPR_SETTINGS, the take-back
 * register's rule) — so the page says them in the reader's language; head office's English stays the fallback for a key
 * this session does not know.
 */
export const EPR_SETTING_QUESTIONS: Readonly<Record<string, { readonly en: string; readonly ta: string }>> = Object.freeze({
  plasticRegistration: { en: 'Plastic EPR registration number on the CPCB portal', ta: 'CPCB தளத்தில் பிளாஸ்டிக் EPR பதிவு எண்' },
  plasticExemption: { en: 'Any plastic EPR exemption (for example, as a micro or small enterprise)', ta: 'பிளாஸ்டிக் EPR விலக்கு ஏதேனும் (எடுத்துக்காட்டாக, குறு அல்லது சிறு நிறுவனமாக)' },
  eWasteBrandOwner: { en: 'Whether the shop must register as an e-waste producer or brand owner', ta: 'கடை மின்கழிவு உற்பத்தியாளர் அல்லது பிராண்ட் உரிமையாளராகப் பதிவு செய்ய வேண்டுமா' },
  batteryBrandOwner: { en: 'Whether the shop must register as a battery producer or brand owner', ta: 'கடை பேட்டரி உற்பத்தியாளர் அல்லது பிராண்ட் உரிமையாளராகப் பதிவு செய்ய வேண்டுமா' },
});
export const eprSettingQuestion = (lang: Lang, key: string, fallback: string): string => EPR_SETTING_QUESTIONS[key]?.[lang] ?? fallback;
export const TAKE_BACK_RULE = Object.freeze({
  en: 'Take-back stock is never saleable. It leaves only on a handover to a recycler with a recorded registration number.',
  ta: 'திரும்பப் பெற்ற சரக்கு ஒருபோதும் விற்பனைக்கு இல்லை. பதிவு எண் பதிவான மறுசுழற்சியாளரிடம் ஒப்படைத்தால் மட்டுமே அது வெளியேறும்.',
});
export const takeBackRule = (lang: Lang): string => TAKE_BACK_RULE[lang];

export const EPR_SETTING_PATHS = Object.freeze({
  plasticRegistration: 'plastic-registration', plasticExemption: 'plastic-exemption', eWasteBrandOwner: 'e-waste-brand-owner', batteryBrandOwner: 'battery-brand-owner',
} as const);
export type EprSettingKey = keyof typeof EPR_SETTING_PATHS;
export const PLASTIC_CATEGORIES = Object.freeze(['I', 'II', 'III', 'IV'] as const);
export const TAKE_BACK_KINDS = Object.freeze(['battery', 'e_waste'] as const);

/**
 * Grams with at most three decimals ("12.5", "0.250") as whole milligrams, by the digits — never through a binary fraction,
 * so 0.1 g is 100 mg exactly. Anything else (blank, negative, four decimals, zero) is undefined.
 */
export function milligramsOf(grams: string): number | undefined {
  const m = /^(\d{1,9})(?:\.(\d{1,3}))?$/.exec(grams.trim());
  if (m === null) return undefined;
  const mg = Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0'));
  return mg > 0 ? mg : undefined;
}
/** Whole milligrams written back as grams ("12.5"), for the register. */
export const gramsOfMg = (mg: number): string => (mg / 1000).toFixed(3).replace(/\.?0+$/, '');

export interface DeclarationRow { readonly productId: string; readonly ownBrand: boolean; readonly packaging: readonly { readonly category: string; readonly weightPerUnitMg: number; readonly description?: string }[] }
export interface RecyclerRow { readonly recyclerId: string; readonly name: string; readonly registrationNumber: string | null }
export interface WaitingAsset { readonly assetId: string; readonly name: string; readonly disposedOn: string }

type Why = 'nobody' | 'cannotRead' | 'cannotRecord' | 'cannotConfirm' | 'needSetting' | 'needDeclaration' | 'needRecycler' | 'needShop' | 'needCount' | 'needReason';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): readonly Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const wholeGrams = (v: string, min: number): number | undefined => (/^\d{1,9}$/.test(v.trim()) && Number(v) >= min ? Number(v) : undefined);

export interface EprRecordsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly record: boolean; readonly confirm: boolean };
  confirmSetting(key: string, value: string, confirmation: string): Done<{ readonly changed: string }>;
  ownBrand(): Done<readonly DeclarationRow[]>;
  declare(d: { readonly productId: string; readonly ownBrand: boolean; readonly lines: readonly { readonly category: string; readonly grams: string; readonly description?: string }[] }): Done<{ readonly packagingDeclared: boolean }>;
  recyclersAndAssets(): Done<{ readonly recyclers: readonly RecyclerRow[]; readonly waitingAssets: readonly WaitingAsset[] }>;
  saveRecycler(r: { readonly recyclerId?: string; readonly name: string; readonly registrationNumber?: string }): Done<{ readonly registered: boolean }>;
  shopHandover(h: { readonly kind: string; readonly recyclerId: string; readonly description: string; readonly weightGrams: string; readonly batteryType?: string; readonly assetId?: string; readonly note: string }): Done<{ readonly registrationNumber: string }>;
  countBin(c: { readonly kind: string; readonly batteryType?: string; readonly countedGrams: string }): Done<{ readonly differs: boolean }>;
  notEWaste(assetId: string, reason: string): Done<{ readonly assetId: string }>;
}

export function createEprRecordsSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): EprRecordsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = Object.freeze({ named, read: named && held.has('epr.register.read'), record: named && held.has('epr.register.record'), confirm: named && held.has('epr.settings.configure') });
  const call = makeCaller({ keyPrefix: 'epr', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const write = steadyWriter({ keyPrefix: 'epr', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const need = (what: 'read' | 'record' | 'confirm') => (!named ? no('nobody') : !may[what] ? no(what === 'read' ? 'cannotRead' : what === 'record' ? 'cannotRecord' : 'cannotConfirm') : undefined);
  const enc = encodeURIComponent;
  const isKind = (k: string): k is typeof TAKE_BACK_KINDS[number] => (TAKE_BACK_KINDS as readonly string[]).includes(k);

  return {
    may,

    confirmSetting: async (key, value, confirmation) => {
      const g = need('confirm'); if (g) return g;
      const path = (EPR_SETTING_PATHS as Record<string, string>)[key];
      if (path === undefined || !filled(value)) return no('needSetting');
      const body = { value: value.trim(), ...(filled(confirmation) ? { confirmation: confirmation.trim() } : {}) };
      const out = await write<{ changed?: unknown }>(`setting:${key}`, 'set', () => `/v1/compliance/epr/settings/${path}`, body);
      return out.result === 'ok' ? { result: 'ok', value: { changed: str(out.value.changed) } } : out;
    },

    ownBrand: async () => {
      const g = need('read'); if (g) return g;
      const out = await call<{ declarations?: unknown }>('GET', '/v1/compliance/epr/own-brand');
      if (out.result !== 'ok') return out;
      return {
        result: 'ok',
        value: list(out.value.declarations).map((d) => ({
          productId: str(d['productId']), ownBrand: d['ownBrand'] === true,
          packaging: list(d['packaging']).map((l) => ({ category: str(l['category']), weightPerUnitMg: typeof l['weightPerUnitMg'] === 'number' ? l['weightPerUnitMg'] : 0, ...(filled(l['description']) ? { description: l['description'] } : {}) })),
        })),
      };
    },

    declare: async (d) => {
      const g = need('record'); if (g) return g;
      if (!filled(d.productId)) return no('needDeclaration');
      // A row with nothing typed in is no row; a row half filled is a mistake to say, not to drop.
      const rows = d.lines.filter((l) => filled(l.grams) || filled(l.description));
      const packaging: { category: string; weightPerUnitMg: number; description?: string }[] = [];
      for (const l of rows) {
        const mg = milligramsOf(l.grams);
        if (mg === undefined || !(PLASTIC_CATEGORIES as readonly string[]).includes(l.category)) return no('needDeclaration');
        packaging.push({ category: l.category, weightPerUnitMg: mg, ...(filled(l.description) ? { description: l.description.trim() } : {}) });
      }
      const out = await write<{ packagingDeclared?: unknown }>(`declare:${d.productId.trim()}`, 'ob', () => `/v1/compliance/epr/own-brand/${enc(d.productId.trim())}`, { ownBrand: d.ownBrand, packaging });
      return out.result === 'ok' ? { result: 'ok', value: { packagingDeclared: out.value.packagingDeclared === true } } : out;
    },

    recyclersAndAssets: async () => {
      const g = need('read'); if (g) return g;
      const out = await call<{ recyclers?: unknown; exceptions?: { assets?: unknown } }>('GET', '/v1/compliance/epr/take-back');
      if (out.result !== 'ok') return out;
      return {
        result: 'ok',
        value: {
          recyclers: list(out.value.recyclers).map((r) => ({ recyclerId: str(r['recyclerId']), name: str(r['name']), registrationNumber: filled(r['registrationNumber']) ? r['registrationNumber'] : null })),
          waitingAssets: list(out.value.exceptions?.assets).map((a) => ({ assetId: str(a['assetId']), name: str(a['name']), disposedOn: str(a['disposedOn']) })),
        },
      };
    },

    saveRecycler: async (r) => {
      const g = need('record'); if (g) return g;
      if (!filled(r.name)) return no('needRecycler');
      const body = { name: r.name.trim(), ...(filled(r.registrationNumber) ? { registrationNumber: r.registrationNumber.trim() } : {}) };
      const id = filled(r.recyclerId) ? r.recyclerId.trim() : undefined;
      const out = await write<{ registered?: unknown }>('recycler', 'rc', (x) => `/v1/compliance/epr/recyclers/${enc(x)}`, body, 'POST', id);
      return out.result === 'ok' ? { result: 'ok', value: { registered: out.value.registered === true } } : out;
    },

    shopHandover: async (h) => {
      const g = need('record'); if (g) return g;
      const grams = wholeGrams(h.weightGrams, 1);
      if (!isKind(h.kind) || ![h.recyclerId, h.description, h.note].every(filled) || grams === undefined || (h.kind === 'battery' && !filled(h.batteryType))) return no('needShop');
      const line = { description: h.description.trim(), weightGrams: grams, ...(h.kind === 'battery' ? { batteryType: (h.batteryType ?? '').trim() } : {}), ...(filled(h.assetId) ? { assetId: h.assetId.trim() } : {}) };
      const out = await write<{ handover?: { registrationNumber?: unknown } }>('shop-handover', 'sh', (x) => `/v1/compliance/epr/handovers/${enc(x)}`,
        { kind: h.kind, recyclerId: h.recyclerId.trim(), lines: [line], note: h.note.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { registrationNumber: str(out.value.handover?.registrationNumber) } } : out;
    },

    countBin: async (c) => {
      const g = need('record'); if (g) return g;
      const grams = wholeGrams(c.countedGrams, 0);
      if (!isKind(c.kind) || grams === undefined || (c.kind === 'battery' && !filled(c.batteryType))) return no('needCount');
      const body = { kind: c.kind, countedGrams: grams, ...(c.kind === 'battery' ? { batteryType: (c.batteryType ?? '').trim() } : {}) };
      const out = await write<{ count?: { countId?: unknown }; exceptions?: { stock?: unknown } }>('count', 'cnt', (x) => `/v1/compliance/epr/take-back-stock/counts/${enc(x)}`, body);
      if (out.result !== 'ok') return out;
      const countId = str(out.value.count?.countId);
      return { result: 'ok', value: { differs: list(out.value.exceptions?.stock).some((e) => e['countId'] === countId) } };
    },

    notEWaste: async (assetId, reason) => {
      const g = need('record'); if (g) return g;
      if (![assetId, reason].every(filled)) return no('needReason');
      const out = await write<{ notEWaste?: { assetId?: unknown } }>(`not-e-waste:${assetId}`, 'ne', () => `/v1/compliance/epr/assets/${enc(assetId.trim())}/not-e-waste`, { reason: reason.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { assetId: str(out.value.notEWaste?.assetId) } } : out;
    },
  };
}
