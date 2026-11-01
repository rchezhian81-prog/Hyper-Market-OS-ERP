// The Buying page's "Reorder" tab (M09-FR-02 "min/max, safety stock, reorder point and demand-based replenishment" · WF-03
// "demand/min-max/budget → requisition" · hard rule #5 · OB-31 · Round 4b). A tested, DOM-free THIN client over head office:
//   • THE PARAMETERS stored per product at a store (`GET /v1/replenishment/parameters`) — the most to hold, the reorder
//     point, safety stock, lead time, minimum order, pack multiple and daily demand — each with its version history (who set
//     it, when, why); SET a product's parameters (`POST /v1/replenishment/parameters/:storeId/:productId`), every quantity
//     typed in the product's OWN unit ("2.5" kg is 2500 g) through the one shared reading (`typedQuantityMinor`);
//   • THE PROPOSAL worked out by head office on those stored parameters and its own stock, orders and sales
//     (`POST /v1/replenishment/stored-proposal`) — advisory only, never an order;
//   • RAISE A REQUISITION from the lines the buyer ticks (`POST /v1/purchase/requisitions/:id/from-replenishment`), with
//     the parameters head office used, so it works the quantities out again itself; the buyer may change a quantity (kept
//     beside the proposed one); and from an assistant's (A02) purchase draft (`…/from-drafts`) — the draft names no
//     quantity, the buyer does. The requisition is the buyer's; a second person still issues any order.
// A product whose unit this screen was not told is refused by name, never guessed. Nothing is read on open.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { quantityLabel, toDecimalString, normaliseUom, typedQuantityMinor } from '../../../packages/contracts/src/quantity';

export type Lang = 'en' | 'ta';

export const REPLENISHMENT_COPY = {
  en: {
    tab: 'Reorder', title: 'Reorder', lead: 'The reorder settings kept for each item at this store, what head office proposes to reorder on them, and raising a requisition from the lines you choose. Nothing here orders anything.',
    store: 'Store', show: 'Show the settings and the proposal', paramsH: 'Reorder settings', noParams: 'No reorder settings are kept for this store yet — set the most to hold and the reorder point per item below.',
    product: 'Item', maxLevel: 'Most to hold', reorderPoint: 'Reorder when down to', safetyStock: 'Safety stock', leadTimeDays: 'Lead time (days)', minOrderQty: 'Smallest order', orderMultiple: 'Pack multiple', avgDailyDemand: 'Sells a day (blank: from sales)',
    version: 'version', setBy: 'set by', why: 'Why', history: 'Earlier settings', setH: 'Set an item\'s reorder settings', set: 'Save the settings', reason: 'Why these figures',
    savedNow: 'Saved — head office keeps it as a new version; the earlier one stays on record.', unchanged: 'The same figures as now — nothing changed.',
    proposalH: 'What head office proposes to reorder', noProposal: 'Nothing is below its reorder point.', position: 'On hand + on order', suggested: 'Proposed', choose: 'Raise', yourQty: 'Your quantity (blank: as proposed)',
    r_below_reorder_point: 'Below its reorder point', r_held_shelf_life: 'Held — any order would over-stock a perishable', advisory: 'Advisory only — this orders nothing.',
    outOfRange: 'Not in this store\'s range', stopped: 'Not reordered (discontinued or on clearance)',
    raise: 'Raise a requisition from the ticked lines', raisedNow: 'Requisition raised. Next: ask suppliers to quote on the Requisitions page; a second person issues any order.',
    draftH: 'Raise a requisition from an assistant\'s purchase draft', draftId: 'Draft number', draftQty: 'How many (the draft names none — your decision)', raiseDraft: 'Raise from this draft',
    needStore: 'Write the store first.', needParams: 'Write the item, the most to hold (in the item\'s own unit; kg and litres up to 3 decimals; items whole), the other figures the same way or blank, the lead time in whole days, and why.',
    unitUnknown: 'This screen was not told this item\'s unit, so it cannot read the figures — check the item is in the store\'s catalogue.', needTick: 'Tick at least one proposed line (and write any quantity in the item\'s unit).',
    needDraft: 'Write the draft number, the item and how many in the item\'s own unit.', proposalFirst: 'Show the proposal first.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read stock.', cannotSet: 'Your role cannot set reorder settings or raise requisitions.',
    copyFrom: 'Head office cannot be reached — these are the store computer\'s copy from', copyNote: 'Nothing can be saved or proposed until head office answers; the copy may be out of date.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    tab: 'மறு ஆணை', title: 'மறு ஆணை', lead: 'இந்தக் கடையில் ஒவ்வொரு பொருளுக்கும் வைத்துள்ள மறு ஆணை அமைப்புகள், அவற்றின்படி தலைமை அலுவலகம் மறு ஆணையிட முன்மொழிவது, நீங்கள் தேர்ந்தெடுக்கும் வரிகளிலிருந்து கோரிக்கை எழுப்புதல். இங்கே எதுவும் ஆணையிடப்படுவதில்லை.',
    store: 'கடை', show: 'அமைப்புகளையும் முன்மொழிவையும் காட்டு', paramsH: 'மறு ஆணை அமைப்புகள்', noParams: 'இந்தக் கடைக்கு இன்னும் மறு ஆணை அமைப்புகள் இல்லை — கீழே ஒவ்வொரு பொருளுக்கும் அதிகபட்ச இருப்பையும் மறு ஆணை அளவையும் அமையுங்கள்.',
    product: 'பொருள்', maxLevel: 'அதிகபட்ச இருப்பு', reorderPoint: 'இந்த அளவுக்குக் குறைந்தால் மறு ஆணை', safetyStock: 'பாதுகாப்பு இருப்பு', leadTimeDays: 'வழங்கும் காலம் (நாட்கள்)', minOrderQty: 'குறைந்தபட்ச ஆணை', orderMultiple: 'பொதி மடங்கு', avgDailyDemand: 'நாளொன்றுக்கு விற்பனை (வெறுமை: விற்பனையிலிருந்து)',
    version: 'பதிப்பு', setBy: 'அமைத்தவர்', why: 'ஏன்', history: 'முந்தைய அமைப்புகள்', setH: 'ஒரு பொருளின் மறு ஆணை அமைப்புகளை அமை', set: 'அமைப்புகளைச் சேமி', reason: 'இந்த எண்கள் ஏன்',
    savedNow: 'சேமிக்கப்பட்டது — தலைமை அலுவலகம் புதிய பதிப்பாக வைத்தது; முந்தையது பதிவில் இருக்கும்.', unchanged: 'இப்போதுள்ள அதே எண்கள் — எதுவும் மாறவில்லை.',
    proposalH: 'தலைமை அலுவலகம் மறு ஆணையிட முன்மொழிவது', noProposal: 'எதுவும் மறு ஆணை அளவுக்குக் கீழே இல்லை.', position: 'இருப்பு + ஆணையில்', suggested: 'முன்மொழிவு', choose: 'எழுப்பு', yourQty: 'உங்கள் அளவு (வெறுமை: முன்மொழிந்தபடி)',
    r_below_reorder_point: 'மறு ஆணை அளவுக்குக் கீழே', r_held_shelf_life: 'நிறுத்தம் — எந்த ஆணையும் கெடும் பொருளை அதிகமாக்கும்', advisory: 'ஆலோசனை மட்டும் — இது எதையும் ஆணையிடாது.',
    outOfRange: 'இந்தக் கடையின் வரம்பில் இல்லை', stopped: 'மறு ஆணை இல்லை (நிறுத்தப்பட்டது அல்லது விற்றுத் தீர்ப்பு)',
    raise: 'தேர்ந்த வரிகளிலிருந்து கோரிக்கை எழுப்பு', raisedNow: 'கோரிக்கை எழுப்பப்பட்டது. அடுத்து: கோரிக்கைகள் பக்கத்தில் விநியோகஸ்தர்களிடம் விலைப்புள்ளி கேளுங்கள்; எந்த ஆணையையும் இரண்டாமவர் வழங்குவார்.',
    draftH: 'உதவியாளரின் கொள்முதல் வரைவிலிருந்து கோரிக்கை எழுப்பு', draftId: 'வரைவு எண்', draftQty: 'எவ்வளவு (வரைவு எதையும் சொல்லவில்லை — உங்கள் முடிவு)', raiseDraft: 'இந்த வரைவிலிருந்து எழுப்பு',
    needStore: 'முதலில் கடையை எழுதுங்கள்.', needParams: 'பொருள், அதிகபட்ச இருப்பு (பொருளின் அலகில்; கிலோ, லிட்டருக்கு 3 தசம இடங்கள் வரை; பொருட்கள் முழு எண்), மற்ற எண்கள் அதே வகையில் அல்லது வெறுமை, வழங்கும் காலம் முழு நாட்களில், ஏன் — எழுதுங்கள்.',
    unitUnknown: 'இந்தப் பொருளின் அலகு இந்தத் திரைக்குச் சொல்லப்படவில்லை, எனவே எண்களைப் படிக்க முடியாது — பொருள் கடையின் பட்டியலில் உள்ளதா எனப் பாருங்கள்.', needTick: 'குறைந்தது ஒரு முன்மொழிந்த வரியைத் தேர்ந்தெடுங்கள் (அளவு எழுதினால் பொருளின் அலகில்).',
    needDraft: 'வரைவு எண், பொருள், எவ்வளவு என்பதைப் பொருளின் அலகில் எழுதுங்கள்.', proposalFirst: 'முதலில் முன்மொழிவைக் காட்டுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி இருப்பைப் படிக்க முடியாது.', cannotSet: 'உங்கள் பணி மறு ஆணை அமைப்புகளை அமைக்கவோ கோரிக்கை எழுப்பவோ முடியாது.',
    copyFrom: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — இவை கடைக் கணினியின் நகல், பெற்ற நேரம்', copyNote: 'தலைமை அலுவலகம் பதில் அளிக்கும் வரை எதையும் சேமிக்கவோ முன்மொழியவோ முடியாது; நகல் பழையதாக இருக்கலாம்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const replenishmentWords = (lang: Lang, key: string): string =>
  (REPLENISHMENT_COPY[lang] as Record<string, string>)[key] ?? (REPLENISHMENT_COPY.en as Record<string, string>)[key] ?? key;

/** The quantity parameters (in the product's smallest step) and the one that is days. */
export const QTY_FIELDS = ['maxLevel', 'reorderPoint', 'safetyStock', 'minOrderQty', 'orderMultiple', 'avgDailyDemand'] as const;
export interface StoredParameters {
  readonly storeId: string; readonly productId: string; readonly version: number; readonly maxLevel: number; readonly reorderPoint?: number; readonly safetyStock?: number;
  readonly leadTimeDays?: number; readonly minOrderQty?: number; readonly orderMultiple?: number; readonly avgDailyDemand?: number; readonly reason: string; readonly setBy: string; readonly setAt: string;
}
/** OB-630: `copyFrom` is set only when these are the store computer's COPY (head office could not be reached) — when it got it. */
export interface ParametersView { readonly storeId: string; readonly products: readonly { readonly current: StoredParameters; readonly history: readonly StoredParameters[] }[]; readonly copyFrom?: string }
/** OB-630: the reorder settings as head office last sent them in the store pack, and when the store computer received them. */
export interface HeldReorderSettings { readonly storeId: string; readonly products: ParametersView['products']; readonly receivedAt: string }

/** The pack's copy as the buying payload carries it (`reorderSettings`, `reorderSettingsReceivedAt`), or undefined. */
export function heldReorderSettingsOf(raw: unknown): HeldReorderSettings | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as { reorderSettings?: unknown; reorderSettingsReceivedAt?: unknown };
  const s = r.reorderSettings as { storeId?: unknown; products?: unknown } | undefined;
  if (s === undefined || s === null || typeof s.storeId !== 'string' || !Array.isArray(s.products) || typeof r.reorderSettingsReceivedAt !== 'string') return undefined;
  return { storeId: s.storeId, products: s.products as ParametersView['products'], receivedAt: r.reorderSettingsReceivedAt };
}
export interface ProposalLine { readonly productId: string; readonly position: number; readonly reorderPoint: number; readonly suggestedQty: number; readonly reason: string }
export interface StoredProposal {
  readonly storeId: string; readonly proposals: readonly ProposalLine[]; readonly items: readonly Record<string, unknown>[]; readonly parametersNotSet: boolean;
  readonly outOfRange?: readonly { readonly productId: string; readonly status: string }[]; readonly stoppedByLifecycle?: readonly { readonly productId: string; readonly lifecycle: string }[]; readonly asAt: string;
}
export type ParameterForm = Readonly<Record<(typeof QTY_FIELDS)[number] | 'leadTimeDays' | 'productId' | 'reason', string>>;

type Why = 'nobody' | 'cannotRead' | 'cannotSet' | 'needStore' | 'needParams' | 'unitUnknown' | 'needTick' | 'needDraft' | 'proposalFirst';
type Done<T = Record<string, unknown>> = Promise<Outcome<T, Why>>;
const seg = (s: string): string => encodeURIComponent(s.trim());

/** A held quantity in the item's own unit ("2.500 kg", "12"); the raw figure beside the unit when the unit is not known. */
export const qtyIn = (minor: number, uom: string | undefined): string => quantityLabel(minor, uom ?? '');
/** The figure a person edits, in the item's unit ("2.500"), or '' when absent or the unit is unknown. */
export function editable(minor: number | undefined, uom: string | undefined): string {
  const u = normaliseUom(uom ?? '');
  return minor === undefined || u === undefined ? '' : toDecimalString({ minor, uom: u });
}

/** The parameters body head office reads — every quantity in the item's smallest step — or the word key of what is wrong. */
export function parametersBody(form: ParameterForm, uom: string | undefined): { readonly productId: string; readonly body: Record<string, unknown> } | { readonly why: Why } {
  const productId = form.productId.trim();
  if (productId === '' || form.reason.trim() === '') return { why: 'needParams' };
  if (uom === undefined || normaliseUom(uom) === undefined) return { why: 'unitUnknown' };
  const body: Record<string, unknown> = {};
  for (const f of QTY_FIELDS) {
    const typed = form[f].trim();
    if (typed === '') { if (f === 'maxLevel') return { why: 'needParams' }; continue; }
    const q = typedQuantityMinor(typed, uom, { allowZero: f !== 'maxLevel' && f !== 'orderMultiple' });
    if (q === undefined) return { why: 'needParams' };
    body[f] = q;
  }
  const lead = form.leadTimeDays.trim();
  if (lead !== '') { if (!/^\d{1,3}$/.test(lead)) return { why: 'needParams' }; body['leadTimeDays'] = Number(lead); }
  body['reason'] = form.reason.trim();
  return { productId, body };
}

export const replenishmentOutcomeWords = (lang: Lang, out: Outcome<unknown>, good: string): string => {
  if (out.result !== 'ok') return outcomeIn((k) => replenishmentWords(lang, k), out);
  return replenishmentWords(lang, (out.value as { unchanged?: boolean } | undefined)?.unchanged === true ? 'unchanged' : good);
};

export interface ReplenishmentSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly set: boolean };
  readonly uomOf: (productId: string) => string | undefined;
  parameters(storeId: string): Done<ParametersView>;
  setParameters(storeId: string, form: ParameterForm): Done<{ readonly unchanged: boolean }>;
  proposal(storeId: string): Done<StoredProposal>;
  raise(proposal: StoredProposal | null, ticked: readonly { readonly productId: string; readonly qtyText: string }[]): Done<{ readonly requisition: { readonly requisitionId: string } }>;
  raiseFromDraft(form: { readonly proposalId: string; readonly productId: string; readonly qtyText: string }): Done<{ readonly requisition: { readonly requisitionId: string } }>;
}

export function createReplenishmentSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  /** The items' units as the store computer was told them (the buying payload's `productUoms`). */
  readonly productUoms?: Readonly<Record<string, string>>;
  /** OB-630: the store computer's copy of the reorder settings — shown only when head office cannot be reached. */
  readonly held?: HeldReorderSettings;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newId?: (prefix: string) => string;
}): ReplenishmentSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('inventory.availability.read'), set: named && held.has('purchase.order.propose') };
  const call = makeCaller({ keyPrefix: 'replenishment', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const idOf = input.newId ?? newId;
  const uomOf = (productId: string): string | undefined => input.productUoms?.[productId.trim()];
  const gate = (need: 'read' | 'set'): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : 'cannotSet' } : undefined;
  return {
    may, uomOf,
    parameters: async (storeId) => {
      const no = gate('read'); if (no !== undefined) return no;
      if (storeId.trim() === '') return { result: 'invalid', why: 'needStore' };
      const out = await call<ParametersView>('GET', `/v1/replenishment/parameters?storeId=${seg(storeId)}`);
      // OB-630 (P-01 · P-08): head office cannot be reached — this store's copy from the store pack, said as a copy and when
      // it was received; never for another store, and never when head office answered (a refusal stays a refusal).
      if (out.result === 'lost_link' && input.held !== undefined && input.held.storeId === storeId.trim()) {
        return { result: 'ok', value: { storeId: input.held.storeId, products: input.held.products, copyFrom: input.held.receivedAt } };
      }
      return out;
    },
    setParameters: async (storeId, form) => {
      const no = gate('set'); if (no !== undefined) return no;
      if (storeId.trim() === '') return { result: 'invalid', why: 'needStore' };
      const made = parametersBody(form, uomOf(form.productId));
      if ('why' in made) return { result: 'invalid', why: made.why };
      return call('POST', `/v1/replenishment/parameters/${seg(storeId)}/${seg(made.productId)}`, made.body);
    },
    proposal: async (storeId) => {
      const no = gate('read'); if (no !== undefined) return no;
      if (storeId.trim() === '') return { result: 'invalid', why: 'needStore' };
      return call('POST', `/v1/replenishment/stored-proposal?storeId=${seg(storeId)}`, {});
    },
    // Head office works the quantities out again on exactly the parameters it proposed on (`items`); the buyer's own
    // quantity, when typed, is read in the item's unit and kept beside the proposed one.
    raise: async (proposal, ticked) => {
      const no = gate('set'); if (no !== undefined) return no;
      if (proposal === null) return { result: 'invalid', why: 'proposalFirst' };
      if (ticked.length === 0) return { result: 'invalid', why: 'needTick' };
      const accept: Record<string, unknown>[] = [];
      for (const t of ticked) {
        if (t.qtyText.trim() === '') { accept.push({ productId: t.productId }); continue; }
        const uom = uomOf(t.productId);
        if (uom === undefined || normaliseUom(uom) === undefined) return { result: 'invalid', why: 'unitUnknown' };
        const q = typedQuantityMinor(t.qtyText, uom);
        if (q === undefined) return { result: 'invalid', why: 'needTick' };
        accept.push({ productId: t.productId, quantity: q });
      }
      return call('POST', `/v1/purchase/requisitions/${encodeURIComponent(idOf('rq'))}/from-replenishment`, { storeId: proposal.storeId, currency: 'INR', items: proposal.items, accept });
    },
    raiseFromDraft: async (f) => {
      const no = gate('set'); if (no !== undefined) return no;
      if (f.proposalId.trim() === '' || f.productId.trim() === '') return { result: 'invalid', why: 'needDraft' };
      const uom = uomOf(f.productId);
      if (uom === undefined || normaliseUom(uom) === undefined) return { result: 'invalid', why: 'unitUnknown' };
      const quantity = typedQuantityMinor(f.qtyText, uom);
      if (quantity === undefined) return { result: 'invalid', why: 'needDraft' };
      return call('POST', `/v1/purchase/requisitions/${encodeURIComponent(idOf('rq'))}/from-drafts`, { currency: 'INR', lines: [{ proposalId: f.proposalId.trim(), productId: f.productId.trim(), quantity }] });
    },
  };
}
