// Tobacco health warning (W3 · D01-FR-05 "regulated-item flags" · roadmap v2.1 B16 · COTPA 2003 s.7 · OB-140 "A") — a tested,
// DOM-free session for the Product details page's tobacco section. Before this no screen reached these routes, so a tobacco
// product could not be put on sale through the screens: head office's publish refuses it until a NAMED person confirms its
// packs carry the government's warning picture in force.
//   • READ — `GET /v1/catalogue/tobacco-warning-pictures` (the pictures on record, the one in force today, the next one) and
//     `GET /v1/catalogue/tobacco-warning` (every tobacco product's standing: confirmed and until when, or not sellable and why).
//   • RECORD a picture the government notified — `POST /v1/catalogue/tobacco-warning-pictures/:imageId` { effectiveFrom,
//     notifiedOn, reference, evidenceRef } (`catalogue.tobacco.picture.record`, the owner). A recorded picture is never
//     changed; a correction is a new picture id.
//   • CONFIRM one product's packs carry a picture — `POST /v1/catalogue/products/:productId/tobacco-warning-confirmation`
//     { imageId, evidenceRef } (`catalogue.tobacco.warning.confirm`). One product, one picture, the signed-in person's own
//     name (head office takes it from the session). There is no "confirm all" and no override.
// Head office re-checks every permission and every rule; its own sentences are shown as it said them.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export interface WarningPicture { readonly imageId: string; readonly effectiveFrom: string; readonly notifiedOn: string; readonly reference: string; readonly evidenceRef: string; readonly recordedBy: string | null }
export interface TobaccoStanding {
  readonly productId: string; readonly name: string; readonly sellable: boolean; readonly standing: string; readonly picture: string | null;
  readonly confirmedBy: string | null; readonly goodUntil: string | null; readonly detail: string | null;
}
export interface TobaccoRead {
  readonly today: string; readonly pictures: readonly WarningPicture[]; readonly inForce: string | null; readonly next: string | null;
  readonly products: readonly TobaccoStanding[]; readonly notSellable: number;
}

export const TOBACCO_WARNING_COPY = {
  en: {
    h: 'Tobacco health warning', lead: 'A tobacco product goes on sale only when a named person has checked that its packs carry the government\'s warning picture in force. When a new picture is notified, each product must be checked again before the day it comes in, or it comes off sale that day.',
    picturesH: 'Warning pictures on record', inForce: 'In force today', next: 'Next, notified', none: 'none', noPictures: 'No warning picture is on record yet. Record the one the government notified first.',
    colPicture: 'Picture', colFrom: 'In force from', colNotified: 'Notified on', colReference: 'Notification',
    recordH: 'Record a warning picture the government notified', imageId: 'Picture id (e.g. GSR-458-2026)', notifiedOn: 'Notified on', effectiveFrom: 'In force from', reference: 'Notification reference (e.g. G.S.R. 458(E))', evidenceRef: 'Where the notification is kept',
    record: 'Record the picture', recorded: 'Recorded:', recordNote: 'A recorded picture is never changed; a correction is a new picture id.',
    productsH: 'Tobacco products', noProducts: 'No product is recorded as tobacco.', sellable: 'On sale', notSellable: 'Not on sale', goodUntil: 'confirmed until', confirmedBy: 'confirmed by',
    confirmH: 'Confirm the packs carry the picture', confirmPicture: 'Picture the packs carry', confirmEvidence: 'What you looked at (e.g. a photo of the pack front)', confirm: 'Confirm, in my name', confirmed: 'Confirmed, in your name. Save the product again on its Record tab to put it on sale.',
    st_no_picture_notified: 'no warning picture on record', st_never_confirmed: 'its packs were never confirmed', st_confirmation_expired: 'a new picture is in force and it was not confirmed for it', st_confirmed: 'confirmed',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the tobacco records.', cannotRecord: 'Only the owner records a government warning picture.', cannotConfirm: 'Your role cannot confirm tobacco packs.',
    badId: 'Type a picture id: letters, numbers, dots or dashes.', badDate: 'Give both dates.', needReference: 'Type the notification reference.', needEvidence: 'Say where the evidence is kept.', needPicture: 'Choose the picture the packs carry.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.', reading: 'Reading from head office…', saving: 'Saving…',
  },
  ta: {
    h: 'புகையிலை சுகாதார எச்சரிக்கை', lead: 'ஒரு புகையிலைப் பொருள், அதன் பொதிகளில் நடைமுறையில் உள்ள அரசின் எச்சரிக்கைப் படம் இருப்பதை ஒரு பெயர் குறிப்பிட்ட நபர் சரிபார்த்த பிறகுதான் விற்பனைக்கு வரும். புதிய படம் அறிவிக்கப்பட்டால், அது நடைமுறைக்கு வரும் நாளுக்கு முன் ஒவ்வொரு பொருளும் மீண்டும் சரிபார்க்கப்பட வேண்டும், இல்லையெனில் அன்றே விற்பனையிலிருந்து நீங்கும்.',
    picturesH: 'பதிவில் உள்ள எச்சரிக்கைப் படங்கள்', inForce: 'இன்று நடைமுறையில்', next: 'அடுத்து, அறிவிக்கப்பட்டது', none: 'இல்லை', noPictures: 'இன்னும் எந்த எச்சரிக்கைப் படமும் பதிவில் இல்லை. முதலில் அரசு அறிவித்ததைப் பதிவு செய்யுங்கள்.',
    colPicture: 'படம்', colFrom: 'நடைமுறை தொடக்கம்', colNotified: 'அறிவித்த நாள்', colReference: 'அறிவிப்பு',
    recordH: 'அரசு அறிவித்த எச்சரிக்கைப் படத்தைப் பதிவு செய்', imageId: 'படக் குறியீடு (எ.கா. GSR-458-2026)', notifiedOn: 'அறிவித்த நாள்', effectiveFrom: 'நடைமுறை தொடக்கம்', reference: 'அறிவிப்பு எண் (எ.கா. G.S.R. 458(E))', evidenceRef: 'அறிவிப்பு எங்கே வைக்கப்பட்டுள்ளது',
    record: 'படத்தைப் பதிவு செய்', recorded: 'பதிவு செய்யப்பட்டது:', recordNote: 'பதிவு செய்த படம் ஒருபோதும் மாற்றப்படாது; திருத்தம் என்றால் புதிய படக் குறியீடு.',
    productsH: 'புகையிலைப் பொருட்கள்', noProducts: 'எந்தப் பொருளும் புகையிலை எனப் பதிவில் இல்லை.', sellable: 'விற்பனையில்', notSellable: 'விற்பனையில் இல்லை', goodUntil: 'வரை உறுதிப்படுத்தப்பட்டது', confirmedBy: 'உறுதிப்படுத்தியவர்',
    confirmH: 'பொதிகளில் படம் உள்ளதை உறுதிப்படுத்து', confirmPicture: 'பொதிகளில் உள்ள படம்', confirmEvidence: 'நீங்கள் பார்த்தது (எ.கா. பொதியின் முன்பக்கப் புகைப்படம்)', confirm: 'என் பெயரில் உறுதிப்படுத்து', confirmed: 'உங்கள் பெயரில் உறுதிப்படுத்தப்பட்டது. விற்பனைக்கு வைக்க, பொருளை அதன் பதிவுத் தாவலில் மீண்டும் சேமியுங்கள்.',
    st_no_picture_notified: 'எச்சரிக்கைப் படம் பதிவில் இல்லை', st_never_confirmed: 'அதன் பொதிகள் ஒருபோதும் உறுதிப்படுத்தப்படவில்லை', st_confirmation_expired: 'புதிய படம் நடைமுறையில் உள்ளது, அதற்கு உறுதிப்படுத்தவில்லை', st_confirmed: 'உறுதிப்படுத்தப்பட்டது',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கால் புகையிலைப் பதிவுகளைப் பார்க்க முடியாது.', cannotRecord: 'அரசின் எச்சரிக்கைப் படத்தை உரிமையாளர் மட்டுமே பதிவு செய்வார்.', cannotConfirm: 'உங்கள் பங்கால் புகையிலைப் பொதிகளை உறுதிப்படுத்த முடியாது.',
    badId: 'படக் குறியீட்டைத் தட்டச்சு செய்யுங்கள்: எழுத்துகள், எண்கள், புள்ளிகள் அல்லது கோடுகள்.', badDate: 'இரண்டு தேதிகளையும் கொடுங்கள்.', needReference: 'அறிவிப்பு எண்ணைத் தட்டச்சு செய்யுங்கள்.', needEvidence: 'சான்று எங்கே வைக்கப்பட்டுள்ளது என்று சொல்லுங்கள்.', needPicture: 'பொதிகளில் உள்ள படத்தைத் தேர்ந்தெடுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', saving: 'சேமிக்கிறது…',
  },
} as const;

export const tobaccoWarningWords = (lang: Lang, key: string): string =>
  (TOBACCO_WARNING_COPY[lang] as Record<string, string>)[key] ?? (TOBACCO_WARNING_COPY.en as Record<string, string>)[key] ?? key;
export const tobaccoWarningOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => tobaccoWarningWords(lang, k), out);

type Why = 'nobody' | 'cannotRead' | 'cannotRecord' | 'cannotConfirm' | 'badId' | 'badDate' | 'needReference' | 'needEvidence' | 'needPicture';

export interface TobaccoWarningSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly record: boolean; readonly confirm: boolean };
  read(): Promise<Outcome<TobaccoRead, Why>>;
  recordPicture(p: { readonly imageId: string; readonly notifiedOn: string; readonly effectiveFrom: string; readonly reference: string; readonly evidenceRef: string }): Promise<Outcome<{ readonly imageId: string; readonly productsToConfirmAgain: readonly string[]; readonly alreadyRecorded: boolean }, Why>>;
  confirm(productId: string, imageId: string, evidenceRef: string): Promise<Outcome<{ readonly productId: string; readonly imageId: string; readonly sellable: boolean }, Why>>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const pictureOf = (p: Record<string, unknown>): WarningPicture => ({
  imageId: str(p['imageId']), effectiveFrom: str(p['effectiveFrom']), notifiedOn: str(p['notifiedOn']), reference: str(p['reference']), evidenceRef: str(p['evidenceRef']), recordedBy: strOrNull(p['recordedBy']),
});

export function createTobaccoWarningSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): TobaccoWarningSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = {
    named, read: named && held.has('catalogue.pack.read'),
    record: named && held.has('catalogue.tobacco.picture.record'), confirm: named && held.has('catalogue.tobacco.warning.confirm'),
  };
  const call = makeCaller({ keyPrefix: 'tobacco', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): Outcome<never, Why> => ({ result: 'invalid', why });
  return {
    may,
    read: async () => {
      if (!named) return no('nobody');
      if (!may.read) return no('cannotRead');
      const pics = await call<Record<string, unknown>>('GET', '/v1/catalogue/tobacco-warning-pictures');
      if (pics.result !== 'ok') return pics;
      const prods = await call<Record<string, unknown>>('GET', '/v1/catalogue/tobacco-warning');
      if (prods.result !== 'ok') return prods;
      const pictures = (Array.isArray(pics.value['pictures']) ? pics.value['pictures'] : []).filter(isObj).map(pictureOf);
      const products = (Array.isArray(prods.value['products']) ? prods.value['products'] : []).filter(isObj).map((p): TobaccoStanding => ({
        productId: str(p['productId']), name: str(p['name']), sellable: p['sellable'] === true, standing: str(p['standing']), picture: strOrNull(p['picture']),
        confirmedBy: strOrNull(p['confirmedBy']), goodUntil: strOrNull(p['goodUntil']), detail: strOrNull(p['detail']),
      }));
      return {
        result: 'ok', value: {
          today: str(pics.value['today']) || str(prods.value['today']), pictures,
          inForce: isObj(pics.value['inForce']) ? str(pics.value['inForce']['imageId']) : null, next: isObj(pics.value['next']) ? str(pics.value['next']['imageId']) : null,
          products, notSellable: products.filter((p) => !p.sellable).length,
        },
      };
    },
    recordPicture: async (p) => {
      if (!named) return no('nobody');
      if (!may.record) return no('cannotRecord');
      const imageId = p.imageId.trim();
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(imageId)) return no('badId');
      if (!DAY.test(p.notifiedOn) || !DAY.test(p.effectiveFrom)) return no('badDate');
      if (p.reference.trim() === '') return no('needReference');
      if (p.evidenceRef.trim() === '') return no('needEvidence');
      const out = await call<{ productsToConfirmAgain?: unknown; alreadyRecorded?: unknown }>('POST', `/v1/catalogue/tobacco-warning-pictures/${encodeURIComponent(imageId)}`, {
        notifiedOn: p.notifiedOn, effectiveFrom: p.effectiveFrom, reference: p.reference.trim(), evidenceRef: p.evidenceRef.trim(),
      });
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: { imageId, productsToConfirmAgain: (Array.isArray(out.value.productsToConfirmAgain) ? out.value.productsToConfirmAgain : []).filter((x): x is string => typeof x === 'string'), alreadyRecorded: out.value.alreadyRecorded === true } };
    },
    confirm: async (productId, imageId, evidenceRef) => {
      if (!named) return no('nobody');
      if (!may.confirm) return no('cannotConfirm');
      if (imageId.trim() === '') return no('needPicture');
      if (evidenceRef.trim() === '') return no('needEvidence');
      const out = await call<{ standing?: unknown }>('POST', `/v1/catalogue/products/${encodeURIComponent(productId.trim())}/tobacco-warning-confirmation`, { imageId: imageId.trim(), evidenceRef: evidenceRef.trim() });
      if (out.result !== 'ok') return out;
      const s = isObj(out.value.standing) ? out.value.standing : {};
      return { result: 'ok', value: { productId: productId.trim(), imageId: imageId.trim(), sellable: s['sellable'] === true } };
    },
  };
}
