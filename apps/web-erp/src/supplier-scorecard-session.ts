// D-10 (R4, OB-227) — the Supplier scorecard page's tested, DOM-free session. A thin client over head office's own route
// (`GET /v1/purchase/suppliers/:supplierId/scorecard?from=&to=`): fill rate, on time in full, lead-time reliability,
// invoice accuracy and rejection rate, each BUILT from the supplier's own purchase orders, goods receipts and matched
// invoices. Nothing is typed in and nothing is written: a figure head office cannot rate is shown as "not rated" with
// its reason, never as a number (P-08). The session refuses only the cheap things before a request (nobody signed in, no
// supplier named, a period that runs backwards).
//
// FG-4 · D03-FR-05: the same page carries the PURCHASE-PRICE VARIANCE — head office's `GET /v1/purchase/price-variance`:
// each goods-receipt line's cost as received against the order's price and the contract price on the day, per product and
// per receipt, and (drill-through) the receipt lines behind any row. A line head office could not compare is counted by
// its reason; a product with no contract price says so — never a zero.

import type { ViewerIdentity } from './browser-entry';

export type Lang = 'en' | 'ta';
export type Outcome<T> =
  | { readonly result: 'ok'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string }
  | { readonly result: 'invalid'; readonly why: ScorecardCopyKey }
  | { readonly result: 'lost_link' };

export type RatingView = { readonly kind: 'rated'; readonly bp: number } | { readonly kind: 'not_rated'; readonly because: string };
export interface ScorecardView {
  readonly supplierId: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly deliveries: number; readonly ordersInScope: number; readonly ordersWithNothingReceived: readonly string[];
  readonly fillRate: RatingView; readonly onTimeInFull: RatingView; readonly leadTimeReliability: RatingView;
  readonly invoiceAccuracy: RatingView; readonly rejectionRate: RatingView;
  readonly agreedLeadTimeDays: number | null; readonly averageLeadTimeDays: number | null; readonly worstLeadTimeDays: number | null;
  readonly orderLines: number; readonly orderLinesOnTimeInFull: number; readonly invoiceLinesChecked: number; readonly invoiceLinesAboveAgreedPrice: number;
  readonly sources: readonly string[]; readonly summary: string;
}

/** The five figures, in the order the page shows them. */
export const SCORECARD_FIGURES = ['fillRate', 'onTimeInFull', 'leadTimeReliability', 'invoiceAccuracy', 'rejectionRate'] as const;
export type ScorecardFigure = (typeof SCORECARD_FIGURES)[number];

export const SCORECARD_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Supplier scorecard',
    lead: 'How a supplier really performed, built from its purchase orders, the goods received and the invoices checked against them. Nothing on this page is typed in.',
    supplier: 'Supplier code', from: 'From', to: 'To', show: 'Show the scorecard',
    fillRate: 'Fill rate', onTimeInFull: 'On time in full', leadTimeReliability: 'Lead-time reliability', invoiceAccuracy: 'Invoice accuracy', rejectionRate: 'Rejection rate',
    fillRateHint: 'what arrived of what was ordered', onTimeInFullHint: 'order lines complete by the agreed date', leadTimeReliabilityHint: 'how steady the delivery time is',
    invoiceAccuracyHint: 'invoice lines at the agreed price', rejectionRateHint: 'of what arrived, held back or refused (lower is better)',
    notRated: 'Not rated', deliveries: 'deliveries', orders: 'orders', lines: 'order lines', onTimeLines: 'on time in full', invoiceLines: 'invoice lines checked', aboveAgreed: 'above the agreed price',
    agreedLead: 'Agreed lead time', days: 'days', noContract: 'no contract lead time on file', averageLead: 'average', worstLead: 'slowest',
    nothingReceived: 'Orders with nothing received:', sources: 'Built from: purchase orders, goods receipts and matched invoices.', summary: 'In short',
    nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot read supplier scorecards.',
    needSupplier: 'Type the supplier code first. Nothing was sent.', backwards: 'The period runs backwards — "From" must be on or before "To". Nothing was sent.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing is shown rather than an old figure.',
    ppvTitle: 'Purchase price variance', ppvLead: 'What each delivery cost against the order\'s price and the contract price on the day. Above zero means the shop paid more than agreed.',
    ppvShow: 'Show the price variance', ppvByProduct: 'By product', ppvByReceipt: 'By goods receipt', ppvLines: 'The receipt lines behind it',
    ppvProduct: 'Product', ppvReceipt: 'Receipt', ppvOrder: 'Order', ppvKept: 'Kept', ppvReceived: 'Cost as received', ppvAgreed: 'Order price', ppvContract: 'Contract price',
    ppvVariance: 'Against the order', ppvVsContract: 'Against the contract', ppvNoContract: 'no contract price on file', ppvCompared: 'lines compared', ppvOpen: 'Show the lines',
    ppvTotal: 'In all', ppvNothing: 'No goods were received from this supplier in the period.', ppvBack: 'Back to the roll-ups',
    ppvNotCompared: 'Not compared:', nc_no_purchase_order: 'no order on the receipt', nc_order_not_held: 'order not held at head office', nc_product_not_on_order: 'product not on the order', nc_currency_differs: 'a different currency',
    ppvBlanket: 'priced by the blanket agreement',
  },
  ta: {
    lang: 'English', title: 'விநியோகஸ்தர் மதிப்பெண் அட்டை',
    lead: 'ஒரு விநியோகஸ்தர் உண்மையில் எப்படிச் செயல்பட்டார் — கொள்முதல் ஆணைகள், பெறப்பட்ட சரக்கு, சரிபார்க்கப்பட்ட பில்களிலிருந்து கணக்கிடப்பட்டது. இந்தப் பக்கத்தில் எதுவும் தட்டச்சு செய்யப்படவில்லை.',
    supplier: 'விநியோகஸ்தர் குறியீடு', from: 'முதல்', to: 'வரை', show: 'மதிப்பெண் அட்டையைக் காட்டு',
    fillRate: 'நிரப்பு விகிதம்', onTimeInFull: 'நேரத்தில் முழுமையாக', leadTimeReliability: 'விநியோக நேர நம்பகத்தன்மை', invoiceAccuracy: 'பில் துல்லியம்', rejectionRate: 'நிராகரிப்பு விகிதம்',
    fillRateHint: 'ஆணையிட்டதில் வந்தது', onTimeInFullHint: 'ஒப்புக்கொண்ட தேதிக்குள் முழுமையான ஆணை வரிகள்', leadTimeReliabilityHint: 'விநியோக நேரம் எவ்வளவு சீராக உள்ளது',
    invoiceAccuracyHint: 'ஒப்புக்கொண்ட விலையில் பில் வரிகள்', rejectionRateHint: 'வந்ததில் நிறுத்தப்பட்டது அல்லது மறுக்கப்பட்டது (குறைவு நல்லது)',
    notRated: 'மதிப்பிடப்படவில்லை', deliveries: 'விநியோகங்கள்', orders: 'ஆணைகள்', lines: 'ஆணை வரிகள்', onTimeLines: 'நேரத்தில் முழுமையாக', invoiceLines: 'சரிபார்த்த பில் வரிகள்', aboveAgreed: 'ஒப்புக்கொண்ட விலைக்கு மேல்',
    agreedLead: 'ஒப்புக்கொண்ட விநியோக நேரம்', days: 'நாட்கள்', noContract: 'ஒப்பந்த விநியோக நேரம் பதிவில் இல்லை', averageLead: 'சராசரி', worstLead: 'மிக மெதுவானது',
    nothingReceived: 'எதுவும் வராத ஆணைகள்:', sources: 'கணக்கிடப்பட்டது: கொள்முதல் ஆணைகள், சரக்கு வரவுகள், பொருத்திய பில்கள்.', summary: 'சுருக்கமாக',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு விநியோகஸ்தர் மதிப்பெண் அட்டைகளைப் படிக்க முடியாது.',
    needSupplier: 'முதலில் விநியோகஸ்தர் குறியீட்டைத் தட்டச்சு செய்யவும். எதுவும் அனுப்பப்படவில்லை.', backwards: 'காலம் பின்னோக்கி உள்ளது — "முதல்" தேதி "வரை" தேதிக்கு முன் இருக்க வேண்டும். எதுவும் அனுப்பப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — பழைய எண்ணிக்கைக்குப் பதிலாக எதுவும் காட்டப்படவில்லை.',
    ppvTitle: 'கொள்முதல் விலை மாறுபாடு', ppvLead: 'ஒவ்வொரு வரவும் ஆணை விலை மற்றும் அன்றைய ஒப்பந்த விலைக்கு எதிராக எவ்வளவு ஆனது. பூஜ்ஜியத்துக்கு மேல் என்றால் ஒப்புக்கொண்டதை விடக் கடை அதிகம் செலுத்தியது.',
    ppvShow: 'விலை மாறுபாட்டைக் காட்டு', ppvByProduct: 'பொருள் வாரியாக', ppvByReceipt: 'சரக்கு வரவு வாரியாக', ppvLines: 'அதன் பின்னுள்ள வரவு வரிகள்',
    ppvProduct: 'பொருள்', ppvReceipt: 'வரவு', ppvOrder: 'ஆணை', ppvKept: 'வைத்தது', ppvReceived: 'வந்த விலை', ppvAgreed: 'ஆணை விலை', ppvContract: 'ஒப்பந்த விலை',
    ppvVariance: 'ஆணைக்கு எதிராக', ppvVsContract: 'ஒப்பந்தத்துக்கு எதிராக', ppvNoContract: 'ஒப்பந்த விலை பதிவில் இல்லை', ppvCompared: 'ஒப்பிட்ட வரிகள்', ppvOpen: 'வரிகளைக் காட்டு',
    ppvTotal: 'மொத்தம்', ppvNothing: 'இந்தக் காலத்தில் இந்த விநியோகஸ்தரிடமிருந்து எந்தச் சரக்கும் வரவில்லை.', ppvBack: 'சுருக்கத்துக்குத் திரும்பு',
    ppvNotCompared: 'ஒப்பிடப்படவில்லை:', nc_no_purchase_order: 'வரவில் ஆணை இல்லை', nc_order_not_held: 'தலைமை அலுவலகத்தில் ஆணை இல்லை', nc_product_not_on_order: 'பொருள் ஆணையில் இல்லை', nc_currency_differs: 'வேறு நாணயம்',
    ppvBlanket: 'நிலை ஒப்பந்த விலையில்',
  },
} as const;
export type ScorecardCopyKey = keyof typeof SCORECARD_COPY.en;

export const scorecardWords = (lang: Lang, key: ScorecardCopyKey | string): string =>
  (SCORECARD_COPY[lang] as Record<string, string>)[key] ?? (SCORECARD_COPY.en as Record<string, string>)[key] ?? key;
export function scorecardOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'refused') return `${scorecardWords(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return scorecardWords(lang, out.why);
  if (out.result === 'lost_link') return scorecardWords(lang, 'unreachable');
  return '';
}
/** A rating as the page says it: a percentage to one place, or "Not rated — <the reason>". Never a zero for not rated. */
export function ratingWords(lang: Lang, r: RatingView): string {
  return r.kind === 'rated' ? `${(r.bp / 100).toFixed(1)}%` : `${scorecardWords(lang, 'notRated')} — ${r.because}`;
}

/** FG-4 · D03-FR-05: the price-variance answer as head office gives it (only what the page shows). */
export interface PpvCost { readonly minor: number; readonly per?: number }
export interface PpvLineView {
  readonly grnId: string; readonly receiptNumber: string; readonly lineId: string; readonly productId: string; readonly poNumber: string | null;
  readonly receivedOn: string; readonly keptMinor: number; readonly uom: string; readonly receivedUnitCost: PpvCost; readonly receivedValueMinor: number;
  readonly order?: { readonly unitCost: PpvCost; readonly varianceMinor: number; readonly varianceBps: number | null; readonly basis: 'purchase_order' | 'blanket_release' };
  readonly notCompared?: 'no_purchase_order' | 'order_not_held' | 'product_not_on_order' | 'currency_differs';
  readonly contract?: { readonly agreementId: string; readonly unitCost: PpvCost; readonly varianceMinor: number };
}
export interface PpvRollupView {
  readonly key: string; readonly lines: number; readonly comparedLines: number; readonly receivedValueMinor: number; readonly orderValueMinor: number;
  readonly varianceMinor: number; readonly varianceBps: number | null; readonly contractLines: number; readonly contractVarianceMinor: number;
}
export interface PriceVarianceView {
  readonly period: { readonly from: string; readonly to: string };
  readonly lines: readonly PpvLineView[]; readonly byProduct: readonly PpvRollupView[]; readonly byReceipt: readonly PpvRollupView[];
  readonly totals: Omit<PpvRollupView, 'key'> & { readonly notCompared: Readonly<Record<string, number>> };
  readonly receipts: number;
}

/** Money in rupees with its sign: "+₹20.00", "−₹4.00", "₹0.00". */
export function signedRupees(minor: number): string {
  const r = `₹${(Math.abs(minor) / 100).toFixed(2)}`;
  return minor > 0 ? `+${r}` : minor < 0 ? `−${r}` : r;
}
/** A unit cost as the page says it: "₹52.00", or "₹250.00 per 24" for a case cost carried exactly (OB-46). */
export function costWords(c: PpvCost): string {
  return `₹${(c.minor / 100).toFixed(2)}${c.per === undefined || c.per === 1 ? '' : ` / ${c.per}`}`;
}
/** The not-compared counts in words — only the reasons that occurred; empty when every line was compared. */
export function notComparedWords(lang: Lang, counts: Readonly<Record<string, number>>): string {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} — ${scorecardWords(lang, `nc_${k}`)}`);
  return parts.length === 0 ? '' : `${scorecardWords(lang, 'ppvNotCompared')} ${parts.join('; ')}`;
}

export interface ScorecardSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  scorecard(supplierId: string, from: string, to: string): Promise<Outcome<{ readonly scorecard: ScorecardView; readonly contractId: string | null }>>;
  /** D03-FR-05: the supplier's price variance for the period; `drill` narrows to the lines behind one product or receipt. */
  priceVariance(supplierId: string, from: string, to: string, drill?: { readonly productId?: string; readonly grnId?: string }): Promise<Outcome<PriceVarianceView>>;
}

export function createScorecardSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch }): ScorecardSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('purchase.commitment.read') };
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  return {
    may,
    scorecard: async (supplierId, from, to) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      const s = supplierId.trim();
      if (s === '') return { result: 'invalid', why: 'needSupplier' };
      if (DAY.test(from) && DAY.test(to) && from > to) return { result: 'invalid', why: 'backwards' };
      const q = [DAY.test(from) ? `from=${from}` : '', DAY.test(to) ? `to=${to}` : ''].filter((x) => x !== '').join('&');
      try {
        const res = await http(`/v1/purchase/suppliers/${encodeURIComponent(s)}/scorecard${q === '' ? '' : `?${q}`}`, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) { const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string }; return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` }; }
        return { result: 'ok', value: json as unknown as { scorecard: ScorecardView; contractId: string | null } };
      } catch { return { result: 'lost_link' }; }
    },
    priceVariance: async (supplierId, from, to, drill) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      const s = supplierId.trim();
      if (s === '') return { result: 'invalid', why: 'needSupplier' };
      if (DAY.test(from) && DAY.test(to) && from > to) return { result: 'invalid', why: 'backwards' };
      const q = new URLSearchParams({ supplierId: s });
      if (DAY.test(from)) q.set('from', from);
      if (DAY.test(to)) q.set('to', to);
      if (drill?.productId !== undefined) q.set('productId', drill.productId);
      if (drill?.grnId !== undefined) q.set('grnId', drill.grnId);
      try {
        const res = await http(`/v1/purchase/price-variance?${q.toString()}`, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) { const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string }; return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` }; }
        return { result: 'ok', value: json as unknown as PriceVarianceView };
      } catch { return { result: 'lost_link' }; }
    },
  };
}
