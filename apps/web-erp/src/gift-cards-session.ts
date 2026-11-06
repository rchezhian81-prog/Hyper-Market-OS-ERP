// Gift cards (W3 · D07-FR-04 · M17-FR-03 · hard rules #2 #10) — the office screen over head office's stored-value routes
// (services/customer/src/stored-value.ts), which no screen called. The Stored-value oversight page only watches for loss;
// nobody could issue a card, read its balance or take a payment from it.
//   • LOOK UP — `GET /v1/stored-value/instruments/:id` (`loyalty.value.read`): the balance (folded from every movement, never
//     a stored number), the expiry, and every redemption with when it was taken;
//   • ISSUE — `POST /v1/stored-value/instruments` { instrumentId, kind: 'gift_card', ownerRef, faceValueMinor, expiresOn? }
//     (`loyalty.value.issue`): a card number already issued is refused (it would create money the shop never took). Its GST
//     time of supply is decided by head office at issue (A12);
//   • REDEEM — `POST /v1/stored-value/instruments/:id/redeem` { movementId, amountMinor, channel } (`loyalty.value.redeem`):
//     head office takes it only if the card has the balance and has not expired; a redemption decided on a balance that
//     changed meanwhile is refused and re-read (never two spends of the same money). The movement id is made ONCE per
//     press, so a re-sent press is the same redemption, not a second one.
// This page needs head office; when it cannot be reached it says so and nothing is taken. Head office's own sentences stay in
// English (OB-553); every word this page adds has a Tamil twin.

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';
import { paiseOf } from './message-queue-session';

export type Lang = 'en' | 'ta';

export const REDEEM_CHANNELS = ['store', 'phone', 'app', 'web'] as const;

export const GIFT_CARDS_COPY = {
  en: {
    title: 'Gift cards',
    lead: 'Look up a gift card\'s balance, issue a new card, and take a payment from one. Every rupee on a card is money the shop owes; a card can never go below zero or be spent after it expires, and the same payment is never taken twice. This page needs head office: without it nothing is issued or taken.',
    lookH: 'Look up a card', card: 'Card number', look: 'Show the balance', balance: 'Balance', expires: 'Expires', noExpiry: 'no expiry date', owner: 'Bought by', redemptions: 'Payments taken from it', noRedemptions: 'No payment has been taken from this card.',
    issueH: 'Issue a new card', boughtBy: 'Bought by (customer code)', value: 'Value (₹)', expiresOn: 'Expires on (leave empty for none)', issue: 'Issue the card', issued: 'Issued. The card holds',
    redeemH: 'Take a payment from a card', amount: 'Amount (₹)', channel: 'Where', redeem: 'Take the payment', redeemed: 'Taken. The card now holds', already: 'This payment was already taken — nothing more was taken. The card holds',
    ch_store: 'in the shop', ch_phone: 'phone order', ch_app: 'the app', ch_web: 'the website',
    needCard: 'Type or scan the card number.', needOwner: 'Type the customer code of who bought it.', needMoney: 'Type the amount in rupees, like 500 or 250.50.', needDate: 'Type the expiry as a date (YYYY-MM-DD), or leave it empty.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see gift cards.', cannotIssue: 'Your role cannot issue a gift card.', cannotRedeem: 'Your role cannot take a payment from a gift card.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was issued or taken.', reading: 'Asking head office…',
  },
  ta: {
    title: 'பரிசு அட்டைகள்',
    lead: 'பரிசு அட்டையின் இருப்பைப் பாருங்கள், புதிய அட்டையை வழங்குங்கள், அட்டையிலிருந்து பணம் பெறுங்கள். அட்டையில் உள்ள ஒவ்வொரு ரூபாயும் கடை கடன்பட்ட பணம்; அட்டை ஒருபோதும் பூஜ்ஜியத்திற்குக் கீழே போகாது, காலாவதியான பின் செலவழிக்க முடியாது, அதே பணம் இருமுறை எடுக்கப்படாது. இந்தப் பக்கத்திற்குத் தலைமை அலுவலகம் தேவை: அது இல்லாமல் எதுவும் வழங்கப்படாது, எடுக்கப்படாது.',
    lookH: 'அட்டையைத் தேடு', card: 'அட்டை எண்', look: 'இருப்பைக் காட்டு', balance: 'இருப்பு', expires: 'காலாவதி', noExpiry: 'காலாவதி தேதி இல்லை', owner: 'வாங்கியவர்', redemptions: 'இதிலிருந்து பெற்ற பணம்', noRedemptions: 'இந்த அட்டையிலிருந்து இன்னும் பணம் பெறப்படவில்லை.',
    issueH: 'புதிய அட்டையை வழங்கு', boughtBy: 'வாங்கியவர் (வாடிக்கையாளர் குறியீடு)', value: 'மதிப்பு (₹)', expiresOn: 'காலாவதி தேதி (இல்லையெனில் காலியாக விடுங்கள்)', issue: 'அட்டையை வழங்கு', issued: 'வழங்கப்பட்டது. அட்டையில் உள்ளது',
    redeemH: 'அட்டையிலிருந்து பணம் பெறு', amount: 'தொகை (₹)', channel: 'எங்கே', redeem: 'பணத்தைப் பெறு', redeemed: 'பெறப்பட்டது. அட்டையில் இப்போது உள்ளது', already: 'இந்தப் பணம் ஏற்கனவே பெறப்பட்டது — மேலும் எதுவும் எடுக்கப்படவில்லை. அட்டையில் உள்ளது',
    ch_store: 'கடையில்', ch_phone: 'தொலைபேசி ஆர்டர்', ch_app: 'செயலி', ch_web: 'இணையதளம்',
    needCard: 'அட்டை எண்ணைத் தட்டச்சு செய்யுங்கள் அல்லது ஸ்கேன் செய்யுங்கள்.', needOwner: 'வாங்கியவரின் வாடிக்கையாளர் குறியீட்டைத் தட்டச்சு செய்யுங்கள்.', needMoney: 'தொகையை ரூபாயில் தட்டச்சு செய்யுங்கள், எ.கா. 500 அல்லது 250.50.', needDate: 'காலாவதியைத் தேதியாக (YYYY-MM-DD) தட்டச்சு செய்யுங்கள், அல்லது காலியாக விடுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு பரிசு அட்டைகளைப் பார்க்க முடியாது.', cannotIssue: 'உங்கள் பங்கு பரிசு அட்டையை வழங்க முடியாது.', cannotRedeem: 'உங்கள் பங்கு பரிசு அட்டையிலிருந்து பணம் பெற முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் வழங்கப்படவில்லை, எடுக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
  },
} as const;

export const giftCardsWords = (lang: Lang, key: string): string =>
  (GIFT_CARDS_COPY[lang] as Record<string, string>)[key] ?? (GIFT_CARDS_COPY.en as Record<string, string>)[key] ?? key;
export const giftCardsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => giftCardsWords(lang, k), out);

export interface CardView {
  readonly instrumentId: string; readonly kind: string; readonly ownerRef: string; readonly balanceMinor: number; readonly expiresOn?: string;
  readonly redemptions: readonly { readonly movementId: string; readonly amountMinor: number; readonly at: string }[];
}

type Why = 'nobody' | 'cannotRead' | 'cannotIssue' | 'cannotRedeem' | 'needCard' | 'needOwner' | 'needMoney' | 'needDate';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export interface GiftCardsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly issue: boolean; readonly redeem: boolean };
  look(card: string): Done<CardView>;
  issue(typed: { readonly card: string; readonly boughtBy: string; readonly value: string; readonly expiresOn: string }): Done<{ readonly balanceMinor: number }>;
  /** One press of "take the payment": a fresh redemption the first time, and the SAME one if the press is sent again. */
  redeem(typed: { readonly card: string; readonly amount: string; readonly channel: string }, pressId?: string): Done<{ readonly balanceMinor: number; readonly alreadyApplied: boolean; readonly movementId: string }>;
}

export function createGiftCardsSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): GiftCardsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('loyalty.value.read'), issue: named && held.has('loyalty.value.issue'), redeem: named && held.has('loyalty.value.redeem') };
  const call = makeCaller({ keyPrefix: 'giftcard', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const enc = encodeURIComponent;
  const gate = (need: 'read' | 'issue' | 'redeem') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : need === 'issue' ? 'cannotIssue' : 'cannotRedeem') : undefined);
  return {
    may,
    look: async (card) => {
      const g = gate('read'); if (g) return g;
      const id = card.trim();
      if (id === '') return no('needCard');
      const out = await call<Record<string, unknown>>('GET', `/v1/stored-value/instruments/${enc(id)}`);
      if (out.result !== 'ok') return out;
      const v = out.value;
      return {
        result: 'ok',
        value: {
          instrumentId: String(v['instrumentId'] ?? id), kind: String(v['kind'] ?? ''), ownerRef: String(v['ownerRef'] ?? ''), balanceMinor: num(v['balanceMinor']),
          ...(typeof v['expiresOn'] === 'string' ? { expiresOn: v['expiresOn'] } : {}),
          redemptions: (Array.isArray(v['redemptions']) ? v['redemptions'] : []).flatMap((r) => (isObj(r) ? [{ movementId: String(r['movementId'] ?? ''), amountMinor: num(r['amountMinor']), at: String(r['at'] ?? '') }] : [])),
        },
      };
    },
    issue: async (typed) => {
      const g = gate('issue'); if (g) return g;
      if (typed.card.trim() === '') return no('needCard');
      if (typed.boughtBy.trim() === '') return no('needOwner');
      const faceValueMinor = paiseOf(typed.value);
      if (faceValueMinor === undefined || faceValueMinor <= 0) return no('needMoney');
      const expiresOn = typed.expiresOn.trim();
      if (expiresOn !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return no('needDate');
      const out = await call<{ balanceMinor?: unknown }>('POST', '/v1/stored-value/instruments', {
        instrumentId: typed.card.trim(), kind: 'gift_card', ownerRef: typed.boughtBy.trim(), faceValueMinor, channel: 'store',
        ...(expiresOn === '' ? {} : { expiresOn }),
      });
      return out.result === 'ok' ? { result: 'ok', value: { balanceMinor: num(out.value.balanceMinor) } } : out;
    },
    redeem: async (typed, pressId) => {
      const g = gate('redeem'); if (g) return g;
      if (typed.card.trim() === '') return no('needCard');
      const amountMinor = paiseOf(typed.amount);
      if (amountMinor === undefined || amountMinor <= 0) return no('needMoney');
      const channel = (REDEEM_CHANNELS as readonly string[]).includes(typed.channel) ? typed.channel : 'store';
      const movementId = pressId ?? newId('gcr');
      const out = await call<{ balanceMinor?: unknown; alreadyApplied?: unknown }>('POST', `/v1/stored-value/instruments/${enc(typed.card.trim())}/redeem`, { movementId, amountMinor, channel });
      return out.result === 'ok' ? { result: 'ok', value: { balanceMinor: num(out.value.balanceMinor), alreadyApplied: out.value.alreadyApplied === true, movementId } } : out;
    },
  };
}
