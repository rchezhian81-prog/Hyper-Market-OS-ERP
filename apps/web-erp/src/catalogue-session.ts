// The product and pricing surface (docs/design/screens/product-merchandising.md · M03 · M05 · D01 · D06 · §28).
//
// The rules exist and are tested: `packages/product` validates and publishes a record, checks
// barcode uniqueness and finds duplicates; `packages/price-guard` enforces the MRP ceiling and the
// margin floor; `packages/price-list` resolves an effective-dated price and reports its history;
// `packages/promotions` simulates an offer and gates its launch. What has never existed is anybody
// **making** a product or a price — the only `PriceEntry` values in this repository were test
// fixtures, so the catalogue snapshot builder has never had a real price to ship to a lane.
//
// ── The three things this screen must not let happen ────────────────────────
//
// **1. A price above MRP, ever.** It is a legal ceiling in India, not a shop policy, so there is no
// approval path and no override. It is the one refusal on this screen that nobody can authorise.
//
// **2. A margin checked against a cost nobody has.** `checkPrice` needs a landed cost. A product
// with none — a new line, a first delivery not yet booked in — has no knowable margin, and costing
// it at zero makes every price look like 100% margin: the floor check passes, confidently and
// wrongly, at exactly the moment a buyer is relying on it. So an unknown cost is its own refusal
// and goes to an approver rather than being assumed away.
//
// **3. A price set and approved by one person.** §28 · ADR-0024. A below-cost / below-floor price and a
// margin-losing offer go through head office's maker-checker engine: the person setting it ASKS
// (`POST /v1/approvals/requests`) for exactly the change they will send; a DIFFERENT person who may approve
// prices approves or rejects it on their own Approvals page, in their own session; then the change is sent
// naming that approval (`approvalId`), and head office uses it once. Nobody's name is typed or picked here —
// a typed name is not an approval, and head office refuses one by name.
//
// ── And the thing it must not let happen quietly ────────────────────────────
//
// **A product that cannot be scored is not a product scoring zero.** An item in a department this
// screen has not been told about cannot be measured at all — nobody can say what it is missing
// without knowing what that department requires. Reported as *not knowable*, with the reason, so
// nobody is sent to fix a record that may already be finished.

import { money, type CurrencyCode, type Money } from '../../../packages/contracts/src/money';
import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import {
  completeness, detectDuplicateProducts, publishProduct, sellability, validateProduct, worklist,
  BarcodeRegistry, DuplicateBarcodeError, NotPublishableError,
  type Category, type CompletenessScore, type DuplicatePair, type ProductRecord,
  type SellRefusal, type ValidationResult,
} from '../../../packages/product/src/index';
import {
  activatePriceChange, priceHistory, proposePriceChange, resolvePrice, rollBackPrice,
  type CostRegister, type PriceChangeOutcome, type PriceEntry, type PriceProposal, type PriceScope,
} from '../../../packages/price-list/src/index';
import {
  ShelfMappingError,
  type ShelfAssignment, type ShelfLocation, type ShelfMap, type WalkOrdering,
} from '../../../packages/merchandising/src/index';
import {
  approveForLaunch, bestPrice, simulatePromotion,
  PromotionApprovalRequiredError,
  type BasketLine, type Promotion, type PromotionResult, type SimulationResult,
} from '../../../packages/promotions/src/index';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { queueProductPublish, type PublishQueueResult, type ProductPublishBarcode } from './catalogue-publish-command';
import {
  rupees,
  type ApprovalAsk, type ApprovalRequestView, type AskResult, type InboxRead,
} from './approvals-session';

/** The simulation input an offer is worked out (and launched) from. */
export type PromotionSimulationInput = Parameters<typeof simulatePromotion>[0];

/** The approval kinds this screen asks under (head office's maker-checker engine, ADR-0024). */
export const PRICE_APPROVAL_KIND = 'price_change';
export const PROMOTION_APPROVAL_KIND = 'promotion_launch';

/**
 * A promotion launch to record at head office (M05-FR-03/04) — the simulation INPUT (the cloud re-simulates
 * from it, never trusting a client's numbers) plus, for a margin-losing offer, the `approvalId` of the caller's
 * OWN approved `promotion_launch` request for exactly this input (ADR-0024). Never a typed approver.
 */
export interface PromotionLaunchInput {
  readonly input: PromotionSimulationInput;
  /** Present only for a margin-losing offer: the requestId a DIFFERENT person approved in their own session. */
  readonly approvalId?: string;
}

/** What head office said when asked to launch — its own verdict, or the reason (and its code) it did not. */
export type PromotionLaunchOutcome =
  | { readonly launched: true; readonly verdict: string; readonly approvedBy: string | null }
  | { readonly launched: false; readonly reason: string; readonly code?: string };

/** The authenticated POST that records a launch at head office. Injected, so the model opens no socket itself;
 *  the cloud re-simulates and checks the approval (a margin-losing offer needs a different person's own approval). */
export interface PromotionLaunchPort {
  post(input: PromotionLaunchInput): Promise<PromotionLaunchOutcome>;
}

/**
 * A governed price change to record at head office (M05-FR-02, API-02): what the operator typed — the product
 * and the new price. The MRP ceiling, the landed cost, the currency and the margin floor are assembled by the
 * session from the same authoritative sources the local proposal uses, never typed here; the cloud re-runs
 * `checkPrice` over them. A price that needs a second person goes through `savePriceWithApproval` instead.
 */
export interface PriceChangeCloudInput {
  readonly productId: string;
  readonly priceMinor: number;
}

/** EXACTLY the body `POST /v1/prices/changes` receives (less the `approvalId`) — and therefore exactly what an
 *  approval for it is FOR. Built in one place (`priceChangeRequestBody`), so the ask and the send never drift. */
export interface PriceChangeBody {
  readonly productId: string;
  readonly priceMinor: number;
  readonly mrpMinor: number;
  readonly costMinor: number;
  readonly currency: string;
  readonly marginFloorBps: number;
}

/** What head office said when asked to change a price — its own verdict, or the reason (and its code) it did not. */
export type PriceChangeCloudOutcome =
  | { readonly saved: true; readonly verdict: string; readonly approvedBy: string | null }
  | { readonly saved: false; readonly reason: string; readonly code?: string };

/** The authenticated POST that records a governed price change at head office (M05-FR-02, API-02). Injected, so
 *  the model opens no socket itself; the cloud re-runs `checkPrice` (MRP ceiling, cost, margin floor) and checks
 *  the approval it names (ADR-0024). It receives the raw figures the session assembled — a price above MRP or
 *  below cost is the cloud's to refuse, never the screen's to wave through. */
export interface PriceChangeCloudPort {
  post(input: PriceChangeBody & { readonly approvalId?: string }): Promise<PriceChangeCloudOutcome>;
}

// ── What an approval is FOR — one rule, the engine's own (ADR-0024) ─────────────────────────────────────────
//
// Head office's engine fingerprints what the maker asked for, and the action's route recomputes the fingerprint
// from the body it receives: "the action's JSON body without approvalId / approval / approvedBy / rationale, plus
// the route's path ids" (`actionDetails` in services/identity/src/approval-requests.ts). The browser bundle cannot
// import that file (it is server code), so the same rule is written once here and proved equal to the engine's by
// tests/unit/erp-catalogue-approvals.test.ts. The body the port SENDS and the details the screen ASKS for come from
// the same functions below, so they cannot drift apart.

/** Fields that are never part of the action itself (the engine's own list). */
const CONTROL_FIELDS: ReadonlySet<string> = new Set(['approvalId', 'approval', 'approvedBy', 'rationale']);

function detailsOfBody(body: Readonly<Record<string, unknown>>, pathIds: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (!CONTROL_FIELDS.has(k)) out[k] = v;
  return { ...out, ...pathIds };
}

/** The JSON body of `POST /v1/prices/changes`: the six figures, and the approval it names when it needs one. */
export function priceChangeRequestBody(body: PriceChangeBody, approvalId?: string): Record<string, unknown> {
  return {
    productId: body.productId, priceMinor: body.priceMinor, mrpMinor: body.mrpMinor, costMinor: body.costMinor,
    currency: body.currency, marginFloorBps: body.marginFloorBps,
    ...(approvalId === undefined ? {} : { approvalId }),
  };
}

/** What a `price_change` approval is for: exactly the body the change will send (the route has no path ids). */
export function priceChangeDetails(body: PriceChangeBody): Record<string, unknown> {
  return detailsOfBody(priceChangeRequestBody(body));
}

/** The JSON body of `POST /v1/promotions/:promotionId/launch`: the simulation input, and the approval it names. */
export function promotionLaunchBody(launch: PromotionLaunchInput): Record<string, unknown> {
  return { ...launch.input, ...(launch.approvalId === undefined ? {} : { approvalId: launch.approvalId }) };
}

/** What a `promotion_launch` approval is for: exactly the launch body, plus the offer's id from the route's path. */
export function promotionLaunchDetails(input: PromotionSimulationInput): Record<string, unknown> {
  return detailsOfBody(promotionLaunchBody({ input }), { promotionId: input.promotionId });
}

/** A stable text for any JSON value (object keys sorted, undefined dropped) — the engine's own canonical form. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/** True when two sets of details are the same action — the same test head office's fingerprint makes. */
export function sameDetails(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

// ── The two-person flow's outcomes, and their words ─────────────────────────────────────────────────────────

/** Which governed action an approval is for: a price change, or an offer's launch. */
export type ApprovalSubject = 'price' | 'offer';

/** The outcome of pressing "Ask for approval". Nothing is saved by asking. */
export type ApprovalAskOutcome =
  | { readonly kind: 'asked'; readonly request: ApprovalRequestView }
  | { readonly kind: 'needs_why' }
  | { readonly kind: 'not_connected' }
  | { readonly kind: 'cannot_check'; readonly missing: 'mrp' | 'cost' }
  | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };

/** The outcome of pressing "Save it" / "Start this offer" for a change that needs a second person. */
export type ApprovalUseOutcome =
  | { readonly kind: 'done'; readonly verdict: string; readonly approvedBy: string | null }
  | { readonly kind: 'not_connected' }
  | { readonly kind: 'cannot_check'; readonly missing: 'mrp' | 'cost' }
  | { readonly kind: 'not_asked' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'rejected'; readonly decidedBy: string | null; readonly reason: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'used' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'checker_may_not_approve' }
  | { readonly kind: 'named_not_approved' }
  | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };

/** The approval refusals head office's engine can return when an action names an approval (ADR-0024). */
export const APPROVAL_REFUSAL_CODES = Object.freeze([
  'approval_unknown', 'approval_does_not_match', 'approval_still_waiting', 'approval_rejected',
  'approval_expired', 'approval_already_used', 'checker_may_not_approve', 'approver_named_without_approval',
] as const);

/** The shortest reason a person may write — a sentence the approver (and next year's auditor) can read. */
export const MIN_REASON_LENGTH = 10;

export type ApprovalCopyKey =
  | 'notSaved' | 'notStarted'
  | 'summaryBelowCost' | 'summaryBelowFloor' | 'summaryOffer'
  | 'askedPrice' | 'askedOffer' | 'needsWhy' | 'notConnectedPrice' | 'notConnectedOffer'
  | 'noMrp' | 'noCost' | 'askRefused' | 'askRefusedNoWords' | 'askLostLink'
  | 'savedPrice' | 'startedOffer'
  | 'notAsked' | 'waiting' | 'rejected' | 'rejectedNoName' | 'expired' | 'used' | 'changed'
  | 'checkerMayNot' | 'namedNotApproved' | 'refused' | 'refusedNoWords' | 'lostLink';

/** Every word the two-person flow says, in English and Tamil. `{not}` is "Not saved" / "Not started". */
export const CATALOGUE_APPROVAL_COPY: BilingualCopy<ApprovalCopyKey> = {
  en: {
    notSaved: 'Not saved', notStarted: 'Not started',
    summaryBelowCost: 'Price of {product} to {price} (below cost {cost})',
    summaryBelowFloor: 'Price of {product} to {price} (below the margin floor; cost {cost})',
    summaryOffer: 'Launch offer {offer} — loses margin ({promo} instead of {normal}; it costs us {cost})',
    askedPrice: 'Asked. Waiting for a second person who may approve prices to approve it on the Approvals page. Nothing is saved yet.',
    askedOffer: 'Asked. Waiting for a second person who may approve prices to approve it on the Approvals page. The offer has not started yet.',
    needsWhy: 'Write why this is needed, in a sentence — the person approving reads it. Nothing was asked.',
    notConnectedPrice: 'Not saved — this price needs a second person’s approval at head office, and this screen is not connected to head office. Nothing was saved.',
    notConnectedOffer: 'Not started — this offer needs a second person’s approval at head office, and this screen is not connected to head office. Nothing was saved.',
    noMrp: 'Nothing was sent — no MRP is recorded for this item, so the legal ceiling cannot be checked.',
    noCost: 'Nothing was sent — this screen has not been told what this item cost, so the margin cannot be checked.',
    askRefused: 'Not asked:', askRefusedNoWords: 'Not asked — head office refused the request.',
    askLostLink: 'No connection — nothing was asked. Try again.',
    savedPrice: 'Price saved: {price}. The approval has now been used — another change needs a new approval.',
    startedOffer: 'Offer started: {offer}. The approval has now been used — another launch needs a new approval.',
    notAsked: '{not} — nobody has been asked to approve exactly this yet. Write why and press “Ask for approval” first.',
    waiting: '{not} — still waiting for a second person who may approve prices (not you) to approve it on their Approvals page.',
    rejected: '{not} — {who} rejected it: “{reason}”. Change what they said and ask again.',
    rejectedNoName: '{not} — it was rejected: {reason} Change what they said and ask again.',
    expired: '{not} — the approval ran out of time before it was used. Ask again.',
    used: '{not} — that approval was already used once. One approval allows one change; ask again.',
    changed: '{not} — this is not exactly what was approved (a figure changed after you asked). Ask for approval again for exactly this.',
    checkerMayNot: '{not} — the person who approved it no longer may approve prices, so their approval does not count. Ask again.',
    namedNotApproved: '{not} — naming a person is not their approval. Ask for approval, and wait for a second person to approve it on their Approvals page.',
    refused: '{not}: {words}', refusedNoWords: '{not} — head office refused it.',
    lostLink: '{not} — no connection to head office. Try again.',
  },
  ta: {
    notSaved: 'சேமிக்கப்படவில்லை', notStarted: 'தொடங்கப்படவில்லை',
    summaryBelowCost: '{product} விலையை {price} ஆக்குதல் (அடக்க விலை {cost}-ஐ விடக் குறைவு)',
    summaryBelowFloor: '{product} விலையை {price} ஆக்குதல் (குறைந்தபட்ச லாபத்தை விடக் குறைவு; அடக்க விலை {cost})',
    summaryOffer: '{offer} சலுகையைத் தொடங்குதல் — லாபம் குறையும் ({normal}-க்குப் பதில் {promo}; நமக்கு ஆகும் செலவு {cost})',
    askedPrice: 'கேட்கப்பட்டது. விலைகளை அனுமதிக்கக்கூடிய இரண்டாம் நபர் அனுமதிகள் பக்கத்தில் அனுமதிக்கக் காத்திருக்கிறது. இன்னும் எதுவும் சேமிக்கப்படவில்லை.',
    askedOffer: 'கேட்கப்பட்டது. விலைகளை அனுமதிக்கக்கூடிய இரண்டாம் நபர் அனுமதிகள் பக்கத்தில் அனுமதிக்கக் காத்திருக்கிறது. சலுகை இன்னும் தொடங்கவில்லை.',
    needsWhy: 'இது ஏன் தேவை என்று ஒரு வாக்கியத்தில் எழுதுங்கள் — அனுமதிப்பவர் அதைப் படிப்பார். எதுவும் கேட்கப்படவில்லை.',
    notConnectedPrice: 'சேமிக்கப்படவில்லை — இந்த விலைக்குத் தலைமை அலுவலகத்தில் இரண்டாம் நபரின் அனுமதி தேவை, இந்தத் திரை தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை. எதுவும் சேமிக்கப்படவில்லை.',
    notConnectedOffer: 'தொடங்கப்படவில்லை — இந்தச் சலுகைக்குத் தலைமை அலுவலகத்தில் இரண்டாம் நபரின் அனுமதி தேவை, இந்தத் திரை தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை. எதுவும் சேமிக்கப்படவில்லை.',
    noMrp: 'எதுவும் அனுப்பப்படவில்லை — இந்தப் பொருளுக்கு MRP பதிவு செய்யப்படவில்லை, எனவே சட்ட வரம்பைச் சரிபார்க்க முடியாது.',
    noCost: 'எதுவும் அனுப்பப்படவில்லை — இந்தப் பொருளின் அடக்க விலை இந்தத் திரைக்குத் தெரியவில்லை, எனவே லாபத்தைச் சரிபார்க்க முடியாது.',
    askRefused: 'கேட்கப்படவில்லை:', askRefusedNoWords: 'கேட்கப்படவில்லை — தலைமை அலுவலகம் கோரிக்கையை ஏற்கவில்லை.',
    askLostLink: 'இணைப்பு இல்லை — எதுவும் கேட்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    savedPrice: 'விலை சேமிக்கப்பட்டது: {price}. அனுமதி இப்போது பயன்படுத்தப்பட்டுவிட்டது — இன்னொரு மாற்றத்திற்குப் புதிய அனுமதி தேவை.',
    startedOffer: 'சலுகை தொடங்கியது: {offer}. அனுமதி இப்போது பயன்படுத்தப்பட்டுவிட்டது — இன்னொரு தொடக்கத்திற்குப் புதிய அனுமதி தேவை.',
    notAsked: '{not} — இதற்கே இன்னும் யாரிடமும் அனுமதி கேட்கப்படவில்லை. ஏன் என்று எழுதி, முதலில் “அனுமதி கேள்” அழுத்தவும்.',
    waiting: '{not} — விலைகளை அனுமதிக்கக்கூடிய இரண்டாம் நபர் (நீங்கள் அல்ல) தனது அனுமதிகள் பக்கத்தில் அனுமதிக்க இன்னும் காத்திருக்கிறது.',
    rejected: '{not} — {who} மறுத்தார்: “{reason}”. அவர் சொன்னதை மாற்றி மீண்டும் கேளுங்கள்.',
    rejectedNoName: '{not} — மறுக்கப்பட்டது: {reason} அவர் சொன்னதை மாற்றி மீண்டும் கேளுங்கள்.',
    expired: '{not} — பயன்படுத்தும் முன்பே அனுமதியின் நேரம் முடிந்துவிட்டது. மீண்டும் கேளுங்கள்.',
    used: '{not} — அந்த அனுமதி ஏற்கனவே ஒருமுறை பயன்படுத்தப்பட்டது. ஒரு அனுமதி ஒரு மாற்றத்திற்கு மட்டுமே; மீண்டும் கேளுங்கள்.',
    changed: '{not} — அனுமதிக்கப்பட்டது சரியாக இது அல்ல (நீங்கள் கேட்ட பிறகு ஒரு எண் மாறிவிட்டது). இதற்கே மீண்டும் அனுமதி கேளுங்கள்.',
    checkerMayNot: '{not} — அனுமதித்தவருக்கு இப்போது விலைகளை அனுமதிக்கும் அதிகாரம் இல்லை, எனவே அவரது அனுமதி செல்லாது. மீண்டும் கேளுங்கள்.',
    namedNotApproved: '{not} — ஒருவரின் பெயரைக் குறிப்பிடுவது அவரது அனுமதி ஆகாது. அனுமதி கேட்டு, இரண்டாம் நபர் தனது அனுமதிகள் பக்கத்தில் அனுமதிக்கும் வரை காத்திருங்கள்.',
    refused: '{not}: {words}', refusedNoWords: '{not} — தலைமை அலுவலகம் ஏற்கவில்லை.',
    lostLink: '{not} — தலைமை அலுவலகத்துடன் இணைப்பு இல்லை. மீண்டும் முயற்சிக்கவும்.',
  },
};

export const APPROVAL_COPY_KEYS: readonly ApprovalCopyKey[] = Object.freeze(Object.keys(CATALOGUE_APPROVAL_COPY.en) as ApprovalCopyKey[]);

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

/** A refusal from the action's route, in the same plain words the inbox gives (ADR-0024's codes, mapped once). */
export function useOutcomeOfRefusal(code: string | undefined, whatHappened: string): ApprovalUseOutcome {
  switch (code) {
    case 'lost_link': return { kind: 'lost_link' };
    case 'approval_unknown': return { kind: 'not_asked' };
    case 'approval_does_not_match': return { kind: 'changed' };
    case 'approval_still_waiting': return { kind: 'waiting' };
    case 'approval_rejected': return { kind: 'rejected', decidedBy: null, reason: whatHappened };
    case 'approval_expired': return { kind: 'expired' };
    case 'approval_already_used': return { kind: 'used' };
    case 'checker_may_not_approve': return { kind: 'checker_may_not_approve' };
    case 'approver_named_without_approval': return { kind: 'named_not_approved' };
    // Anything else (an above-MRP price, a malformed offer, no permission): head office's own words.
    default: return { kind: 'refused', code: code ?? 'refused', whatHappened };
  }
}

/** Where an ask stands, in words — tone + icon + words, never colour alone. */
export function presentAskOutcome(lang: Lang, subject: ApprovalSubject, o: ApprovalAskOutcome): StatusPresentation {
  const t = translator(CATALOGUE_APPROVAL_COPY, lang);
  const err = (label: string): StatusPresentation => presentStatus({ tone: 'error', icon: '✕', label, needsAttention: true });
  switch (o.kind) {
    // Waiting is a pending state — a person has to come back to it — with its own icon and words.
    case 'asked': return presentScreenState({ state: 'pending', label: `${t(subject === 'price' ? 'askedPrice' : 'askedOffer')} ${o.request.summary}` });
    case 'needs_why': return err(t('needsWhy'));
    case 'not_connected': return err(t(subject === 'price' ? 'notConnectedPrice' : 'notConnectedOffer'));
    case 'cannot_check': return err(t(o.missing === 'mrp' ? 'noMrp' : 'noCost'));
    case 'refused': return err(o.whatHappened.trim() === '' ? t('askRefusedNoWords') : `${t('askRefused')} ${o.whatHappened.trim()}`);
    case 'lost_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('askLostLink'), needsAttention: true });
  }
}

/** Where using an approval stands, in words. `figure` is the price (₹) or the offer's name, for the "done" line. */
export function presentUseOutcome(lang: Lang, subject: ApprovalSubject, o: ApprovalUseOutcome, figure = ''): StatusPresentation {
  const t = translator(CATALOGUE_APPROVAL_COPY, lang);
  const not = t(subject === 'price' ? 'notSaved' : 'notStarted');
  const say = (key: ApprovalCopyKey, values: Readonly<Record<string, string>> = {}): string => fill(t(key), { not, ...values });
  const err = (label: string): StatusPresentation => presentStatus({ tone: 'error', icon: '✕', label, needsAttention: true });
  const warn = (label: string): StatusPresentation => presentStatus({ tone: 'degraded', icon: '⚠', label, needsAttention: true });
  switch (o.kind) {
    case 'done':
      return presentStatus({ tone: 'ok', icon: '✓', needsAttention: false,
        label: subject === 'price' ? say('savedPrice', { price: figure }) : say('startedOffer', { offer: figure }) });
    case 'not_connected': return err(t(subject === 'price' ? 'notConnectedPrice' : 'notConnectedOffer'));
    case 'cannot_check': return err(t(o.missing === 'mrp' ? 'noMrp' : 'noCost'));
    case 'not_asked': return warn(say('notAsked'));
    case 'waiting': return presentScreenState({ state: 'pending', label: say('waiting') });
    case 'rejected':
      return err(o.decidedBy === null || o.decidedBy.trim() === ''
        ? say('rejectedNoName', { reason: o.reason.trim() === '' ? '—' : o.reason.trim() })
        : say('rejected', { who: o.decidedBy, reason: o.reason.trim() === '' ? '—' : o.reason.trim() }));
    case 'expired': return warn(say('expired'));
    case 'used': return warn(say('used'));
    case 'changed': return warn(say('changed'));
    case 'checker_may_not_approve': return err(say('checkerMayNot'));
    case 'named_not_approved': return err(say('namedNotApproved'));
    case 'refused': return err(o.whatHappened.trim() === '' ? say('refusedNoWords') : say('refused', { words: o.whatHappened.trim() }));
    case 'lost_link': return warn(say('lostLink'));
  }
}

/** What this surface can see about the shop, and what it honestly cannot. */
export interface CataloguePorts {
  /** The tenant's own department hierarchy. Which fields matter is theirs to say, never ours. */
  categories(): readonly Category[];
  products(): readonly ProductRecord[];
  /** Every price entry ever recorded, any status — the append-only history. */
  priceEntries(): readonly PriceEntry[];
  /**
   * What one unit cost us.
   *
   * A register rather than a number: "we have never bought this" and "it cost nothing" are
   * different facts, and only one of them makes a margin computable.
   */
  costOf(productId: string): CostRegister;
  /** Barcodes already in use, so the same one cannot be given to two items (M03-FR-02). */
  barcodesInUse(): readonly { readonly barcode: string; readonly productId: string }[];
  /** Promotions this tenant has defined. */
  promotions(): readonly Promotion[];
  /**
   * The shop's shelf map, or `null` when this box has none (M04-FR-02).
   *
   * `null` is a real state and not a degraded one: a shop that has not addressed its shelves yet
   * has pick lists in whatever order the wave arrived, and the picker's screen says so. What must
   * never happen is an empty map presented as a finished one, which would report every product as
   * unmapped and read as the shelf data having been lost.
   */
  shelfMap(): ShelfMap | null;
  /**
   * The offline command queue the Save button commits a publish to (P-01, §31). Optional: a read-only
   * viewing of the catalogue (or a test that never publishes) need not provide one; `requestPublish` says so
   * plainly when it is absent rather than dropping the intent silently.
   */
  outbox?(): SyncOutbox;
  /**
   * Records a promotion launch at head office (M05-FR-03/04). Absent for a read-only screen (or a test that
   * never launches): `launchToCloud` then refuses rather than pretending. The cloud is the authority — it
   * re-simulates and checks the approval — so this only carries the ask and reports back what head office decided.
   */
  launchPromotion?(): PromotionLaunchPort;
  /**
   * Records a governed price change at head office (M05-FR-02). Absent for a read-only screen (or a test that
   * never changes a price): `changePriceInCloud` then refuses rather than pretending. The cloud is the
   * authority — it re-runs `checkPrice` and checks the approval — so this only carries the ask and reports back
   * what head office decided.
   */
  changePrice?(): PriceChangeCloudPort;
  /** Ask a second person to approve (POST /v1/approvals/requests) — the caller's own session is the maker. Only from
   *  an explicit click. Absent when the screen is not connected to head office: then nothing needing approval moves. */
  askApproval?(ask: ApprovalAsk): Promise<AskResult>;
  /** The caller's approvals inbox (GET /v1/approvals/requests) — read only. Absent when not connected. */
  approvalInbox?(): Promise<InboxRead>;
}

export interface CatalogueConfig {
  readonly tenantId: string;
  readonly storeId: string;
  /** Who is using this screen. They may not approve their own price change (§28). */
  readonly userId: string;
  readonly currency: CurrencyCode;
  /** Today in the shop's own calendar, as YYYY-MM-DD. Injected — never a clock in here. */
  readonly today: string;
  /** Minimum gross margin in basis points. Per-tenant policy (M05-FR-02). */
  readonly marginFloorBps: number;
}

/** What a product record looks like to somebody deciding whether to work on it. */
export interface ProductView {
  readonly product: ProductRecord;
  readonly validation: ValidationResult | null;
  readonly score: CompletenessScore;
  /** Whether it may be sold right now, and why not when it may not. */
  readonly sellable: SellRefusal;
  /** The price running today for this store, or null when it has none. */
  readonly priceToday: PriceEntry | null;
}

export type PublishRefusal = 'not_finished' | 'recall_blocked' | 'barcode_belongs_to_another_item';

export type ShelfRefusal =
  | 'this_box_has_no_shelf_map'
  | 'no_such_shelf_in_this_shop'
  | 'a_shelf_facing_with_no_capacity_holds_nothing'
  | 'it_already_lives_somewhere_else';

const SHELF_REFUSALS: Readonly<Record<ShelfRefusal, ShelfRefusal>> = Object.freeze({
  this_box_has_no_shelf_map: 'this_box_has_no_shelf_map',
  no_such_shelf_in_this_shop: 'no_such_shelf_in_this_shop',
  a_shelf_facing_with_no_capacity_holds_nothing: 'a_shelf_facing_with_no_capacity_holds_nothing',
  it_already_lives_somewhere_else: 'it_already_lives_somewhere_else',
});

export const SHELF_REFUSAL_KINDS: readonly ShelfRefusal[] = Object.freeze(Object.values(SHELF_REFUSALS));

export type ShelfOutcome =
  | { readonly ok: true; readonly assignment: ShelfAssignment }
  | { readonly ok: false; readonly refusal: ShelfRefusal; readonly detail: string };

/** What a picker would actually walk, given the shop's shelf map. */
export interface WalkPreview {
  readonly steps: readonly { readonly productId: string; readonly name: string; readonly shelf: string | null }[];
  readonly ordering: WalkOrdering;
  /** Products with no shelf address at all — each one is a walk back across the shop. */
  readonly unmapped: readonly string[];
}

export type PublishOutcome =
  | { readonly ok: true; readonly product: ProductRecord }
  | { readonly ok: false; readonly refusal: PublishRefusal; readonly detail: string; readonly missing: readonly string[] };

const PUBLISH_REFUSALS: Readonly<Record<PublishRefusal, PublishRefusal>> = Object.freeze({
  not_finished: 'not_finished',
  recall_blocked: 'recall_blocked',
  barcode_belongs_to_another_item: 'barcode_belongs_to_another_item',
});

export const PUBLISH_REFUSAL_KINDS: readonly PublishRefusal[] = Object.freeze(Object.values(PUBLISH_REFUSALS));

/** The outcome of asking to publish to the cloud — the queue result, or `no_outbox` when there is no queue. */
export type RequestPublishResult =
  | PublishQueueResult
  | { readonly ok: false; readonly refusal: 'no_outbox'; readonly detail: string; readonly missing: readonly string[] };

export interface CatalogueSession {
  /** Every product with its completeness, sellability and today's price. */
  shelf(): readonly ProductView[];

  /** The records closest to being sellable, worst blocker first (D01). */
  needsWork(): readonly CompletenessScore[];

  /** One product, checked. Writes nothing — this is what the editor renders against. */
  inspect(product: ProductRecord): ProductView;

  /**
   * Publish a product record (M03-FR-01/03).
   *
   * Refuses with **every** missing field at once rather than one per attempt: a person filling in
   * a record at nine in the evening should not have to discover the requirements one save at a
   * time.
   */
  publish(product: ProductRecord, barcodes?: readonly ProductPublishBarcode[]): PublishOutcome;

  /**
   * Publish a product to the shared truth (M03-FR-01/03) — the Save that reaches the cloud.
   *
   * Validates through the SAME tested engine as `publish` and, if it passes, commits a durable,
   * deduplicated command to the offline outbox (P-01, §31); the sync agent drains it to the compliance-gated
   * cloud route. Never touches the network from here. `no_outbox` when this screen was built without a queue.
   */
  requestPublish(product: ProductRecord, barcodes?: readonly ProductPublishBarcode[]): RequestPublishResult;

  /**
   * Stop an item being sold or ordered anywhere, at once (D01-FR-05).
   *
   * Two taps by design — this is the control somebody reaches for when a supplier rings about
   * glass in a jar, and it is honoured offline because it travels in the catalogue pack.
   */
  setRecallBlock(product: ProductRecord, blocked: boolean): ProductRecord;

  /** Suspected duplicates, for review. Never merged automatically (M03-FR-04). */
  duplicates(): readonly DuplicatePair[];

  /** Every shelf address this shop has, in the order they are walked (M04-FR-02). */
  shelves(): readonly ShelfLocation[];

  /** Where one product lives, or `null` when nothing has said. */
  shelfOf(productId: string): ShelfLocation | null;

  /**
   * Put a product on a shelf.
   *
   * Refuses a **second** primary rather than accepting it: two primaries means the picker's route
   * and the replenishment task disagree about where an item lives, and then both are wrong.
   */
  assignShelf(input: {
    readonly productId: string;
    readonly locationId: string;
    readonly capacityMinor: number;
    readonly primary?: boolean;
  }): ShelfOutcome;

  /**
   * The order a picker would walk this shop, for the products given.
   *
   * The point of the whole shelf map, made visible to the person maintaining it: somebody
   * addressing shelves needs to see the walk change, not take it on trust.
   */
  walk(productIds?: readonly string[]): WalkPreview;

  /** Work out what a price change would do. Writes nothing, activates nothing. */
  proposePrice(input: {
    readonly id: string;
    readonly productId: string;
    readonly priceMinor: number;
    readonly effectiveFrom: string;
    readonly scope?: PriceScope;
    readonly scopeRef?: string;
  }): PriceProposal;

  /**
   * Turn a CLEAN proposal into a price in this browser only (no head office behind the page) — a new entry,
   * never an edit. It takes no approval: a price that needs a second person is never activated here, because a
   * name on this screen is not an approval (ADR-0024); it goes to head office through `savePriceWithApproval`.
   */
  activatePrice(proposal: PriceProposal): PriceChangeOutcome;

  /** Withdraw a price that should not have gone live. Appends; never deletes. */
  rollBack(entry: PriceEntry): PriceEntry;

  /** Who changed this product's price, from what, to what, and when (M05-FR-01). */
  historyFor(productId: string): readonly PriceEntry[];

  /** What a promotion would do to margin before anybody launches it (M05-FR-04). */
  simulate(input: Parameters<typeof simulatePromotion>[0]): SimulationResult;

  /** Launch a promotion LOCALLY — the tested guard. This computes and validates but persists nowhere; the durable
   *  launch is `launchToCloud` when a box is wired. It takes no approval: a margin-losing offer is refused here and
   *  goes to head office through `launchWithApproval` (a name on this screen is not an approval — ADR-0024). */
  launch(simulation: SimulationResult): {
    readonly ok: true;
    readonly approvedBy: string | null;
  } | {
    readonly ok: false;
    readonly detail: string;
  };

  /**
   * True when this screen can record a launch at head office (M05-FR-03/04). The view reads it to choose the
   * path: `launchToCloud` reaches the cloud (recorded, and read back by finance/reporting), where the local
   * `launch` only validates in this browser. False means no cloud is wired (a standalone/demo view).
   */
  readonly canLaunchToCloud: boolean;

  /**
   * Launch a promotion at head office (M05-FR-03/04) — the authoritative launch of an offer that needs NO second
   * person. Sends the simulation INPUT (the cloud re-simulates, never trusting a client's numbers). Returns what the
   * cloud decided; refuses with a reason rather than pretending when no cloud is wired. A margin-losing offer goes
   * through `askLaunchApproval` then `launchWithApproval`.
   */
  launchToCloud(input: PromotionLaunchInput): Promise<PromotionLaunchOutcome>;

  /**
   * True when this screen can record a price change at head office (M05-FR-02). The view reads it to choose the
   * path: `changePriceInCloud` reaches the cloud (recorded, append-only, read back by the lane), where the local
   * `activatePrice` only validates in this browser. False means no cloud is wired (a standalone/demo view).
   */
  readonly canChangePriceInCloud: boolean;

  /**
   * Change a price at head office (M05-FR-02) — the authoritative change of a price that needs NO second person.
   * The session assembles the MRP in force today, the landed cost, the currency and the margin floor from the same
   * sources the local proposal uses (so it refuses cleanly, without a POST, when the cost or MRP is unknown rather
   * than sending a figure that cannot be checked), and sends them with the new price. The cloud re-runs
   * `checkPrice`; this returns what it decided, and refuses with a reason rather than pretending when no cloud is
   * wired. A below-cost / below-floor price goes through `askPriceApproval` then `savePriceWithApproval`.
   */
  changePriceInCloud(input: PriceChangeCloudInput): Promise<PriceChangeCloudOutcome>;

  /** True when this screen can ask head office for a second person's approval, read the answer and send the
   *  change naming it. False means local-only: nothing that needs approval can be saved from here. */
  readonly canAskForApproval: boolean;

  /**
   * Ask a second person to approve EXACTLY this price change (ADR-0024 · §28 · M05-FR-02). The caller is the
   * maker, in their own session; the details are the very body the change will send (`priceChangeDetails`), the
   * amount is the new price, and the summary is in the reader's language. Refused locally (no POST) when the
   * screen is not connected, when no reason is written, or when the MRP or the cost is unknown. Saves nothing.
   */
  askPriceApproval(lang: Lang, input: PriceChangeCloudInput & { readonly why: string }): Promise<ApprovalAskOutcome>;

  /**
   * Save a price that needs a second person: finds the caller's OWN `price_change` request for this product whose
   * details are exactly this change's, and only when it is APPROVED sends the change naming it (`approvalId`). Not
   * asked, waiting, rejected (by whom, and why), expired, used, or changed since asking — each is said plainly, and
   * nothing is sent. Head office checks it all again and uses the approval once.
   */
  savePriceWithApproval(input: PriceChangeCloudInput): Promise<ApprovalUseOutcome>;

  /** Ask a second person to approve EXACTLY this margin-losing offer (`promotionLaunchDetails`). Saves nothing. */
  askLaunchApproval(lang: Lang, input: { readonly input: PromotionSimulationInput; readonly why: string }): Promise<ApprovalAskOutcome>;

  /** Launch a margin-losing offer naming the caller's OWN approved `promotion_launch` request for exactly this
   *  input; otherwise says plainly why not, and sends nothing. */
  launchWithApproval(input: PromotionSimulationInput): Promise<ApprovalUseOutcome>;

  /** The best price a basket would get under the approved rules — the same answer as the lane. */
  quote(lines: readonly BasketLine[], at: string): PromotionResult;
}

export function createCatalogueSession(
  config: CatalogueConfig,
  ports: CataloguePorts,
): CatalogueSession {
  const inr = (minor: number): Money => money(minor, config.currency);

  /** The price running today at this store, resolved by the same engine the lane uses. */
  const priceToday = (productId: string): PriceEntry | null =>
    resolvePrice(ports.priceEntries(), {
      productId,
      // Resolution is instant-based; midday keeps a date-only effective window unambiguous either
      // side of a timezone, and the shop's day is what `today` already encodes.
      at: `${config.today}T12:00:00.000Z`,
      storeId: config.storeId,
    });

  /** The MRP in force TODAY, from the effective-dated history — not the newest one recorded. A future MRP increase
   *  must not raise today's ceiling before the pack it is printed on ships. */
  const mrpToday = (productId: string): Money | undefined =>
    (ports.products().find((p) => p.productId === productId)?.mrpHistory ?? [])
      .filter((m) => m.effectiveFrom <= config.today)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      .at(-1)?.value;

  /**
   * The ONE place the body of a price change is built — for the change sent with no approval, for the change sent
   * naming one, and for the details an approval is asked for. A price with no ceiling or no known cost cannot be
   * checked for the law or the margin, so it is refused here, plainly, rather than sent (P-08).
   */
  const priceBody = (input: PriceChangeCloudInput):
    | { readonly ok: true; readonly body: PriceChangeBody }
    | { readonly ok: false; readonly missing: 'mrp' | 'cost' } => {
    const mrp = mrpToday(input.productId);
    if (mrp === undefined) return { ok: false, missing: 'mrp' };
    const cost = ports.costOf(input.productId);
    if (!cost.known) return { ok: false, missing: 'cost' };
    return {
      ok: true,
      body: {
        productId: input.productId, priceMinor: input.priceMinor, mrpMinor: mrp.minor, costMinor: cost.cost.minor,
        currency: config.currency, marginFloorBps: config.marginFloorBps,
      },
    };
  };

  const connected = (): boolean => ports.askApproval !== undefined && ports.approvalInbox !== undefined;

  /**
   * The caller's OWN request of this kind, about this subject, for EXACTLY these details — approved, or why not.
   * The same reading the import screen makes: a request for exactly this still waiting is the news; otherwise the
   * newest request for exactly this says what happened; with none for exactly this, a rejection still says who and
   * why, and anything else means the change moved after asking.
   */
  const findApproval = async (
    kind: string, subjectRef: string, details: Readonly<Record<string, unknown>>, valueMinor: number | null,
  ): Promise<{ readonly requestId: string } | ApprovalUseOutcome> => {
    const read = ports.approvalInbox;
    if (read === undefined) return { kind: 'not_connected' };
    const inbox = await read();
    if (inbox.result === 'lost_link') return { kind: 'lost_link' };
    if (inbox.result === 'refused') return { kind: 'refused', code: inbox.code, whatHappened: inbox.whatHappened };
    const mine = inbox.inbox.mine.filter((r) => r.kind === kind && r.subjectRef === subjectRef);
    if (mine.length === 0) return { kind: 'not_asked' };
    const newest = (rows: readonly ApprovalRequestView[]): ApprovalRequestView | undefined =>
      rows.slice().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
    const exact = mine.filter((r) => r.valueMinor === valueMinor && sameDetails(r.details, details));
    const approved = newest(exact.filter((r) => r.status === 'approved'));
    if (approved !== undefined) return { requestId: approved.requestId };
    if (exact.some((r) => r.status === 'waiting')) return { kind: 'waiting' };
    const latest = newest(exact) ?? newest(mine)!;
    if (latest.status === 'rejected') return { kind: 'rejected', decidedBy: latest.decidedBy ?? null, reason: latest.decisionReason ?? '' };
    if (exact.length === 0) return { kind: 'changed' };
    return latest.status === 'expired' ? { kind: 'expired' } : { kind: 'used' };
  };

  const ask = async (request: ApprovalAsk): Promise<ApprovalAskOutcome> => {
    const port = ports.askApproval;
    if (port === undefined) return { kind: 'not_connected' };
    const asked = await port(request);
    if (asked.result === 'asked') return { kind: 'asked', request: asked.request };
    if (asked.result === 'lost_link') return { kind: 'lost_link' };
    return { kind: 'refused', code: asked.code, whatHappened: asked.whatHappened };
  };

  const hasReason = (why: string): boolean => why.trim().length >= MIN_REASON_LENGTH;

  const inspect: CatalogueSession['inspect'] = (product) => {
    let validation: ValidationResult | null;
    try {
      validation = validateProduct(product, ports.categories());
    } catch {
      // The department is unknown to this screen. `completeness` reports that as not knowable with
      // the reason; a thrown error here would take the whole list down over one bad record.
      validation = null;
    }
    return {
      product,
      validation,
      score: completeness(product, ports.categories()),
      sellable: sellability(product),
      priceToday: priceToday(product.productId),
    };
  };

  return {
    shelf: () => ports.products().map(inspect),

    needsWork: () => worklist(ports.products(), ports.categories()),

    inspect,

    publish: (product, barcodes = []) => {
      // A recall-blocked item is not a publishing decision at all. Publishing it would put it back
      // on sale, which is the opposite of what somebody set the block for.
      if (product.recallBlocked === true) {
        return {
          ok: false,
          refusal: 'recall_blocked',
          detail: 'this item is recall-blocked. Lift the block first — publishing it would put it back on sale.',
          missing: [],
        };
      }

      // A barcode that already belongs to another item would make one scan ring up two products,
      // and which one is a matter of whichever record happened to be found first.
      if (barcodes.length > 0) {
        const registry = new BarcodeRegistry();
        for (const existing of ports.barcodesInUse()) {
          if (existing.productId === product.productId) continue;
          registry.register({ code: existing.barcode, productId: existing.productId, kind: 'internal' });
        }
        for (const barcode of barcodes) {
          try {
            registry.register({ code: barcode.code, productId: product.productId, kind: barcode.kind });
          } catch (e) {
            if (e instanceof DuplicateBarcodeError) {
              return {
                ok: false,
                refusal: 'barcode_belongs_to_another_item',
                detail: `barcode ${barcode.code} already belongs to another item. One barcode rings up one product — otherwise which one it is depends on which record was found first.`,
                missing: [barcode.code],
              };
            }
            throw e;
          }
        }
      }

      try {
        return { ok: true, product: publishProduct(product, ports.categories()) };
      } catch (e) {
        if (e instanceof NotPublishableError) {
          // Every reason at once. One per attempt is how somebody ends up saving six times.
          const missing = e.issues.map((i) => i.message);
          return {
            ok: false,
            refusal: 'not_finished',
            detail: `${missing.length} thing(s) still needed before this can be sold.`,
            missing,
          };
        }
        throw e;
      }
    },

    requestPublish: (product, barcodes = []) => {
      const queue = ports.outbox?.();
      if (queue === undefined) {
        return { ok: false, refusal: 'no_outbox', detail: 'this screen has no queue to publish through.', missing: [] };
      }
      // The tested compliance gate runs inside queueProductPublish — an invalid product never queues. The
      // command carries the record + this tenant's categories so the cloud validates against the same
      // hierarchy. `today` is the shop's day (never the device clock).
      return queueProductPublish(queue, {
        product,
        categories: ports.categories(),
        barcodes,
        requestedBy: config.userId,
        at: `${config.today}T12:00:00.000Z`,
      });
    },

    setRecallBlock: (product, blocked) => ({ ...product, recallBlocked: blocked }),

    shelves: () => ports.shelfMap()?.allLocations() ?? [],

    shelfOf: (productId) => ports.shelfMap()?.locationOf(productId) ?? null,

    assignShelf: (input) => {
      const map = ports.shelfMap();
      if (map === null) {
        return {
          ok: false,
          refusal: 'this_box_has_no_shelf_map',
          detail: 'this screen has not been told the shop\'s shelf addresses, so there is nowhere to put anything yet.',
        };
      }
      if (input.capacityMinor <= 0) {
        return {
          ok: false,
          refusal: 'a_shelf_facing_with_no_capacity_holds_nothing',
          detail: 'say how many fit on that shelf facing. A facing that holds nothing cannot be refilled.',
        };
      }
      try {
        return {
          ok: true,
          assignment: map.assign({
            storeId: config.storeId,
            productId: input.productId,
            locationId: input.locationId,
            capacityMinor: input.capacityMinor,
            primary: input.primary ?? true,
          }),
        };
      } catch (e) {
        if (e instanceof ShelfMappingError) {
          const already = e.message.includes('already has a primary location');
          return {
            ok: false,
            refusal: already ? 'it_already_lives_somewhere_else' : 'no_such_shelf_in_this_shop',
            detail: already
              ? `${e.message}. Two homes means the picker's route and the refill task disagree about where it lives, and then both are wrong.`
              : e.message,
          };
        }
        throw e;
      }
    },

    walk: (productIds) => {
      const products = ports.products();
      const wanted = productIds === undefined ? products.map((p) => p.productId) : productIds;
      const nameOf = (id: string): string => products.find((p) => p.productId === id)?.name ?? id;
      const map = ports.shelfMap();
      if (map === null) {
        return {
          steps: wanted.map((productId) => ({ productId, name: nameOf(productId), shelf: null })),
          ordering: 'the order the list arrived in — this store has no shelf map',
          unmapped: wanted,
        };
      }
      const route = map.routeFor(wanted.map((productId) => ({ productId })));
      return {
        steps: route.lines.map((line) => ({
          productId: line.productId,
          name: nameOf(line.productId),
          shelf: line.location === undefined ? null : (line.location.label ?? line.location.locationId),
        })),
        ordering: route.ordering,
        unmapped: route.unmapped,
      };
    },

    duplicates: () => detectDuplicateProducts(
      ports.products().map((p) => ({
        productId: p.productId,
        name: p.name,
        ...(p.brand === undefined ? {} : { brand: p.brand }),
        barcodes: ports.barcodesInUse().filter((b) => b.productId === p.productId).map((b) => b.barcode),
      })),
    ),

    proposePrice: (input) => {
      const product = ports.products().find((p) => p.productId === input.productId);
      // The MRP in force today, from the effective-dated history — not the newest one recorded. A
      // future MRP increase must not raise today's ceiling before the pack it is printed on ships.
      const mrp = (product?.mrpHistory ?? [])
        .filter((m) => m.effectiveFrom <= config.today)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
        .at(-1)?.value;

      return proposePriceChange(
        {
          id: input.id,
          productId: input.productId,
          scope: input.scope ?? 'store',
          scopeRef: input.scopeRef ?? config.storeId,
          price: inr(input.priceMinor),
          effectiveFrom: input.effectiveFrom,
          setBy: config.userId,
        },
        {
          today: config.today,
          ...(mrp === undefined ? {} : { mrp }),
          cost: ports.costOf(input.productId),
          marginFloorBps: config.marginFloorBps,
          existing: ports.priceEntries(),
        },
      );
    },

    // No approval is ever passed: a price that needs a second person is refused here (and goes to head office).
    activatePrice: (proposal) => activatePriceChange(proposal, { setBy: config.userId }),

    rollBack: (entry) => rollBackPrice(entry, config.today),

    historyFor: (productId) => priceHistory(ports.priceEntries(), productId),

    simulate: (input) => simulatePromotion(input),

    launch: (simulation) => {
      try {
        // No approval is ever passed: a margin-losing offer is refused here (and goes to head office).
        const result = approveForLaunch(simulation, undefined, config.userId);
        return { ok: true, approvedBy: result.approvedBy ?? null };
      } catch (e) {
        if (e instanceof PromotionApprovalRequiredError) return { ok: false, detail: e.message };
        throw e;
      }
    },

    canLaunchToCloud: ports.launchPromotion !== undefined,

    launchToCloud: async (input) => {
      const port = ports.launchPromotion;
      // No cloud wired: this screen cannot record a launch on its own, and must not say it did. The view
      // falls back to the local `launch` (honest that it only validates in this browser) when it sees
      // `canLaunchToCloud` is false; this guards the case it asked anyway.
      if (port === undefined) {
        return { launched: false, reason: 'this screen is not connected to head office, so it cannot launch the offer' };
      }
      // The cloud is the authority — it re-simulates the input and checks any approval. The screen renders
      // whatever it decides and invents nothing.
      return port().post(input);
    },

    canChangePriceInCloud: ports.changePrice !== undefined,

    changePriceInCloud: async (input) => {
      const port = ports.changePrice;
      // No cloud wired: the view falls back to the local `activatePrice` when `canChangePriceInCloud` is false;
      // this guards the case it asked anyway, and must not claim a change it did not make.
      if (port === undefined) {
        return { saved: false, reason: 'this screen is not connected to head office, so it cannot change the price' };
      }
      const built = priceBody({ productId: input.productId, priceMinor: input.priceMinor });
      if (!built.ok) {
        return built.missing === 'mrp'
          ? { saved: false, reason: 'this product has no MRP recorded, so the legal ceiling cannot be checked' }
          : { saved: false, reason: 'this screen has not been told what this product cost, so the margin cannot be checked' };
      }
      // The cloud is the authority — it re-runs `checkPrice` over these figures. The screen sends the raw figures
      // it already trusts for the local proposal and renders whatever the cloud decides.
      return port().post(built.body);
    },

    canAskForApproval: connected() && ports.changePrice !== undefined && ports.launchPromotion !== undefined,

    // The MAKER's step for a price (ADR-0024): ask for exactly the change that will be sent. Nothing is saved.
    askPriceApproval: async (lang, input) => {
      if (!connected() || ports.changePrice === undefined) return { kind: 'not_connected' };
      if (!hasReason(input.why)) return { kind: 'needs_why' };
      const built = priceBody({ productId: input.productId, priceMinor: input.priceMinor });
      if (!built.ok) return { kind: 'cannot_check', missing: built.missing };
      const body = built.body;
      const t = translator(CATALOGUE_APPROVAL_COPY, lang);
      const product = ports.products().find((p) => p.productId === body.productId);
      const summary = fill(t(body.priceMinor < body.costMinor ? 'summaryBelowCost' : 'summaryBelowFloor'), {
        product: product === undefined || product.name.trim() === '' ? body.productId : product.name,
        price: rupees(body.priceMinor), cost: rupees(body.costMinor),
      });
      return ask({
        kind: PRICE_APPROVAL_KIND, subjectRef: body.productId,
        // EXACTLY the body the change will send — the route fingerprints that body and refuses any difference.
        details: priceChangeDetails(body), valueMinor: body.priceMinor,
        summary, reason: input.why.trim(),
      });
    },

    // The change, naming the caller's own APPROVED request for exactly these figures. Never a typed approver.
    savePriceWithApproval: async (input) => {
      const port = ports.changePrice;
      if (!connected() || port === undefined) return { kind: 'not_connected' };
      const built = priceBody({ productId: input.productId, priceMinor: input.priceMinor });
      if (!built.ok) return { kind: 'cannot_check', missing: built.missing };
      const body = built.body;
      const found = await findApproval(PRICE_APPROVAL_KIND, body.productId, priceChangeDetails(body), body.priceMinor);
      if (!('requestId' in found)) return found;
      const r = await port().post({ ...body, approvalId: found.requestId });
      if (r.saved) return { kind: 'done', verdict: r.verdict, approvedBy: r.approvedBy };
      return useOutcomeOfRefusal(r.code, r.reason);
    },

    // The MAKER's step for a margin-losing offer: ask for exactly the launch that will be sent. Nothing starts.
    askLaunchApproval: async (lang, { input, why }) => {
      if (!connected() || ports.launchPromotion === undefined) return { kind: 'not_connected' };
      if (!hasReason(why)) return { kind: 'needs_why' };
      const t = translator(CATALOGUE_APPROVAL_COPY, lang);
      const summary = fill(t('summaryOffer'), {
        offer: input.promotionId, promo: rupees(input.promoPrice.minor), normal: rupees(input.normalPrice.minor),
        cost: rupees(input.unitCost.minor),
      });
      return ask({
        kind: PROMOTION_APPROVAL_KIND, subjectRef: input.promotionId,
        // EXACTLY the launch body plus the offer's id from the route's path — what the route fingerprints.
        details: promotionLaunchDetails(input), valueMinor: null,
        summary, reason: why.trim(),
      });
    },

    // The launch, naming the caller's own APPROVED request for exactly this offer. Never a typed approver.
    launchWithApproval: async (input) => {
      const port = ports.launchPromotion;
      if (!connected() || port === undefined) return { kind: 'not_connected' };
      const found = await findApproval(PROMOTION_APPROVAL_KIND, input.promotionId, promotionLaunchDetails(input), null);
      if (!('requestId' in found)) return found;
      const r = await port().post({ input, approvalId: found.requestId });
      if (r.launched) return { kind: 'done', verdict: r.verdict, approvedBy: r.approvedBy };
      return useOutcomeOfRefusal(r.code, r.reason);
    },

    // Only ACTIVE promotions, and `bestPrice` checks the window again itself. A draft or stopped
    // offer that quoted here would show a price no lane would ever charge.
    quote: (lines, at) => bestPrice(
      lines,
      ports.promotions().filter((p) => p.status === 'active'),
      { at, currency: config.currency },
    ),
  };
}
