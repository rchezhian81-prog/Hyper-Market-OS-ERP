// Price checks on the floor (W3 · D06-FR-06 "shelf / POS / app price integrity" · D-7 · B25) — a tested, DOM-free session for
// the Price mismatches page, which until now only READ the ageing report. Two acts:
//   • RECORD what a surface was seen showing — `POST /v1/pricing/integrity/observations/:observationId` { branchId,
//     productId, surface, priceMinor, shelfAddress? }. Who saw it is the signed-in person (head office takes it from the
//     session, never from the page). Append-only; the id is made here once, so a retry is the same observation.
//   • CHECK what was just recorded — `POST /v1/pricing/integrity/audit`: the till's price for each product is head office's
//     own price of record for the store (`GET /v1/prices/list/:id/resolve`), never typed; the displayed prices are the
//     observations just recorded. Head office's engine gives the verdict: a shelf showing LESS than the till is a legal
//     exposure and comes first, whatever its value.
// Nothing here changes a price (hard rule #5): a person fixes the label or the list. Both acts need `price.integrity.audit`;
// head office re-checks it and the store's scope. Every word has a Tamil twin; head office's own sentences stay English.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export const CHECK_SURFACES = ['shelf_label', 'app', 'kiosk', 'website', 'esl'] as const;
export type CheckSurface = (typeof CHECK_SURFACES)[number];

export interface RecordedObservation {
  readonly observationId: string; readonly branchId: string; readonly productId: string; readonly surface: string;
  readonly priceMinor: number; readonly observedAt: string; readonly observedBy: string; readonly shelfAddress?: string;
}
export interface CheckFinding {
  readonly productId: string; readonly surface: string; readonly kind: string; readonly posPriceMinor: number;
  readonly displayedMinor: number | null; readonly differenceMinor: number; readonly shelfAddress: string | null; readonly detail: string;
}
export interface CheckReport {
  readonly productsChecked: number; readonly overchargeRisks: readonly CheckFinding[]; readonly other: readonly CheckFinding[];
  /** Products head office holds no price of record for at this store — named, never judged against a zero. */
  readonly noPriceOfRecord: readonly string[];
}

export const PRICE_CHECKS_COPY = {
  en: {
    recordH: 'Record what a shelf shows', recordLead: 'Walk the shelf and write down the price a label, the app or a kiosk shows. Your name goes on it. Recording changes no price.',
    branch: 'Store', product: 'Product code', surface: 'Where you saw it', shown: 'Price shown (₹)', shelfAddress: 'Shelf (optional, e.g. A3-02)',
    record: 'Record this price', recorded: 'Recorded:', recordedList: 'Recorded in this walk', noneRecorded: 'Nothing recorded yet in this walk.',
    s_shelf_label: 'Shelf label', s_app: 'Customer app', s_kiosk: 'Price-check kiosk', s_website: 'Website', s_esl: 'Electronic shelf label',
    checkH: 'Check this walk against the till', checkLead: 'Head office compares each price you recorded with its own price of record for the store — what the till charges. A shelf showing less than the till comes first: that price is what the customer was offered.',
    check: 'Check the prices recorded', checked: '{n} product(s) checked.', allAgree: 'Every price recorded agrees with the till.',
    risksH: 'Shelf shows LESS than the till — honour it and fix the label today', otherH: 'Other differences',
    k_overcharge_risk: 'shows less than the till', k_undercharge: 'shows more than the till', k_stale_surface: 'not confirmed lately', k_surface_missing: 'no price shown', k_esl_unreachable: 'label not reporting',
    till: 'till', shownWord: 'shown', noPriceOfRecord: 'Head office has no price for these at this store, so they were not checked:',
    nobody: 'Nobody is signed in on this screen.', cannotAudit: 'Your role cannot record or check shelf prices.',
    needBranch: 'Type the store.', needProduct: 'Type the product code.', needSurface: 'Choose where you saw it.', badPrice: 'Type the price shown in rupees, e.g. 49.50.', nothingToCheck: 'Record at least one price first.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was recorded or checked.', saving: 'Recording…', checking: 'Checking…',
  },
  ta: {
    recordH: 'அடுக்கில் காட்டும் விலையைப் பதிவு செய்', recordLead: 'அடுக்கில் நடந்து லேபிள், செயலி அல்லது கியோஸ்க் காட்டும் விலையை எழுதுங்கள். உங்கள் பெயர் அதில் இருக்கும். பதிவு செய்வது எந்த விலையையும் மாற்றாது.',
    branch: 'கடை', product: 'பொருள் குறியீடு', surface: 'எங்கே பார்த்தீர்கள்', shown: 'காட்டிய விலை (₹)', shelfAddress: 'அடுக்கு (விருப்பம், எ.கா. A3-02)',
    record: 'இந்த விலையைப் பதிவு செய்', recorded: 'பதிவு செய்யப்பட்டது:', recordedList: 'இந்த நடையில் பதிவு செய்தவை', noneRecorded: 'இந்த நடையில் இன்னும் எதுவும் பதிவாகவில்லை.',
    s_shelf_label: 'அடுக்கு லேபிள்', s_app: 'வாடிக்கையாளர் செயலி', s_kiosk: 'விலை சரிபார்ப்புக் கியோஸ்க்', s_website: 'இணையதளம்', s_esl: 'மின்னணு அடுக்கு லேபிள்',
    checkH: 'இந்த நடையை கல்லாவுடன் சரிபார்', checkLead: 'நீங்கள் பதிவு செய்த ஒவ்வொரு விலையையும் தலைமை அலுவலகம் கடைக்கான தன் சொந்த விலையுடன் — கல்லா வசூலிப்பதுடன் — ஒப்பிடும். கல்லாவை விடக் குறைவாகக் காட்டும் அடுக்கு முதலில் வரும்: அதுவே வாடிக்கையாளருக்குச் சொன்ன விலை.',
    check: 'பதிவு செய்த விலைகளைச் சரிபார்', checked: '{n} பொருள்(கள்) சரிபார்க்கப்பட்டன.', allAgree: 'பதிவு செய்த ஒவ்வொரு விலையும் கல்லாவுடன் ஒத்துப்போகிறது.',
    risksH: 'அடுக்கு கல்லாவை விடக் குறைவாகக் காட்டுகிறது — அதை மதித்து இன்றே லேபிளைச் சரிசெய்யுங்கள்', otherH: 'பிற வேறுபாடுகள்',
    k_overcharge_risk: 'கல்லாவை விடக் குறைவாகக் காட்டுகிறது', k_undercharge: 'கல்லாவை விட அதிகமாகக் காட்டுகிறது', k_stale_surface: 'சமீபத்தில் உறுதிப்படுத்தவில்லை', k_surface_missing: 'விலை காட்டவில்லை', k_esl_unreachable: 'லேபிள் தகவல் அனுப்பவில்லை',
    till: 'கல்லா', shownWord: 'காட்டியது', noPriceOfRecord: 'இந்தக் கடையில் இவற்றுக்குத் தலைமை அலுவலகத்திடம் விலை இல்லை, எனவே சரிபார்க்கப்படவில்லை:',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotAudit: 'உங்கள் பங்கால் அடுக்கு விலைகளைப் பதிவு செய்யவோ சரிபார்க்கவோ முடியாது.',
    needBranch: 'கடையைத் தட்டச்சு செய்யுங்கள்.', needProduct: 'பொருள் குறியீட்டைத் தட்டச்சு செய்யுங்கள்.', needSurface: 'எங்கே பார்த்தீர்கள் என்று தேர்ந்தெடுங்கள்.', badPrice: 'காட்டிய விலையை ரூபாயில் தட்டச்சு செய்யுங்கள், எ.கா. 49.50.', nothingToCheck: 'முதலில் குறைந்தது ஒரு விலையைப் பதிவு செய்யுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் பதிவு செய்யவோ சரிபார்க்கவோ இல்லை.', saving: 'பதிவு செய்கிறது…', checking: 'சரிபார்க்கிறது…',
  },
} as const;

export const priceChecksWords = (lang: Lang, key: string, slots?: Readonly<Record<string, string | number>>): string => {
  const raw = (PRICE_CHECKS_COPY[lang] as Record<string, string>)[key] ?? (PRICE_CHECKS_COPY.en as Record<string, string>)[key] ?? key;
  return Object.entries(slots ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), raw);
};
export const priceChecksOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => priceChecksWords(lang, k), out);

/** Rupees typed ("49.5", "49.50", "₹49") as whole paise, or undefined — never rounded. */
export function paiseOfTyped(typed: string): number | undefined {
  const s = typed.trim().replace(/^₹\s*/, '').replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return undefined;
  const [r, p = ''] = s.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}

type Why = 'nobody' | 'cannotAudit' | 'needBranch' | 'needProduct' | 'needSurface' | 'badPrice' | 'nothingToCheck';

export interface PriceChecksSession {
  readonly may: { readonly named: boolean; readonly audit: boolean };
  record(input: { readonly branchId: string; readonly productId: string; readonly surface: string; readonly shown: string; readonly shelfAddress: string }): Promise<Outcome<RecordedObservation, Why>>;
  check(branchId: string, observations: readonly RecordedObservation[]): Promise<Outcome<CheckReport, Why>>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function createPriceChecksSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly now?: () => string; readonly newObservationId?: () => string;
}): PriceChecksSession {
  const named = input.viewer?.userId !== undefined;
  const may = { named, audit: named && (input.viewer?.permissions ?? []).includes('price.integrity.audit') };
  const call = makeCaller({ keyPrefix: 'price-check', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const now = input.now ?? (() => new Date().toISOString());
  const newObservationId = input.newObservationId ?? (() => newId('obs'));
  const no = (why: Why): Outcome<never, Why> => ({ result: 'invalid', why });
  const guard = (): Outcome<never, Why> | undefined => (!named ? no('nobody') : !may.audit ? no('cannotAudit') : undefined);
  return {
    may,
    record: async (r) => {
      const stop = guard(); if (stop !== undefined) return stop;
      const branchId = r.branchId.trim(); const productId = r.productId.trim();
      if (branchId === '') return no('needBranch');
      if (productId === '') return no('needProduct');
      if (!(CHECK_SURFACES as readonly string[]).includes(r.surface)) return no('needSurface');
      const priceMinor = paiseOfTyped(r.shown);
      if (priceMinor === undefined) return no('badPrice');
      const observationId = newObservationId();
      const out = await call<{ observation?: unknown }>('POST', `/v1/pricing/integrity/observations/${encodeURIComponent(observationId)}`, {
        branchId, productId, surface: r.surface, priceMinor, ...(r.shelfAddress.trim() === '' ? {} : { shelfAddress: r.shelfAddress.trim() }),
      });
      if (out.result !== 'ok') return out;
      const o = isObj(out.value.observation) ? out.value.observation : {};
      return {
        result: 'ok', value: {
          observationId: str(o['observationId']) || observationId, branchId: str(o['branchId']) || branchId, productId: str(o['productId']) || productId,
          surface: str(o['surface']) || r.surface, priceMinor: typeof o['priceMinor'] === 'number' ? o['priceMinor'] : priceMinor,
          observedAt: str(o['observedAt']) || now(), observedBy: str(o['observedBy']), ...(typeof o['shelfAddress'] === 'string' ? { shelfAddress: o['shelfAddress'] } : {}),
        },
      };
    },
    check: async (branch, observations) => {
      const stop = guard(); if (stop !== undefined) return stop;
      const branchId = branch.trim();
      if (branchId === '') return no('needBranch');
      const seen = observations.filter((o) => o.branchId === branchId);
      if (seen.length === 0) return no('nothingToCheck');
      const asAt = now();
      const products: { productId: string; name: string; posPriceMinor: number }[] = [];
      const noPriceOfRecord: string[] = [];
      for (const productId of [...new Set(seen.map((o) => o.productId))].sort()) {
        const price = await call<{ priceMinor?: unknown }>('GET', `/v1/prices/list/${encodeURIComponent(productId)}/resolve?storeId=${encodeURIComponent(branchId)}&at=${encodeURIComponent(asAt)}`);
        if (price.result === 'refused' && price.status === 404) { noPriceOfRecord.push(productId); continue; }
        if (price.result !== 'ok') return price;
        if (typeof price.value.priceMinor !== 'number') { noPriceOfRecord.push(productId); continue; }
        products.push({ productId, name: productId, posPriceMinor: price.value.priceMinor });
      }
      const judged = new Set(products.map((p) => p.productId));
      const out = await call<{ productsChecked?: unknown; overchargeRisks?: unknown; other?: unknown }>('POST', '/v1/pricing/integrity/audit', {
        branchId, asAt, products, requiredSurfaces: [],
        displayed: seen.filter((o) => judged.has(o.productId)).map((o) => ({
          surface: o.surface, productId: o.productId, branchId, priceMinor: o.priceMinor, lastConfirmedAt: o.observedAt, ...(o.shelfAddress === undefined ? {} : { shelfAddress: o.shelfAddress }),
        })),
      });
      if (out.result !== 'ok') return out;
      const findings = (v: unknown): CheckFinding[] => (Array.isArray(v) ? v : []).filter(isObj).map((f) => ({
        productId: str(f['productId']), surface: str(f['surface']), kind: str(f['kind']), posPriceMinor: Number(f['posPriceMinor'] ?? 0),
        displayedMinor: typeof f['displayedMinor'] === 'number' ? f['displayedMinor'] : null, differenceMinor: Number(f['differenceMinor'] ?? 0),
        shelfAddress: typeof f['shelfAddress'] === 'string' ? f['shelfAddress'] : null, detail: str(f['detail']),
      }));
      return { result: 'ok', value: { productsChecked: Number(out.value.productsChecked ?? 0), overchargeRisks: findings(out.value.overchargeRisks), other: findings(out.value.other), noPriceOfRecord } };
    },
  };
}
