// FG-4 · D03-FR-04 — the buyer's supplier-managed stock (VMI) desk, on the Supplier submissions page. A tested, DOM-free
// session over head office's own routes:
//   • a supplier's managed ITEMS — each with the buyer's minimum and maximum at a store, on hand, on order and the room
//     left (GET /v1/purchase/vmi/:supplierId); "not set" until the buyer sets one;
//   • SET a limit (POST /v1/purchase/vmi/limits/:supplierId/:storeId/:productId) — whole numbers, the minimum not above the
//     maximum, checked here first;
//   • the PROPOSALS waiting for a buyer (GET /v1/purchase/vmi-proposals) and the DECISION (POST …/decide): accept — into a
//     purchase-order PROPOSAL the buyer prices, which a second person still issues — or reject, always with a reason.
// Nothing is read or written on open; every write is a person's click.

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const VMI_DESK_COPY = {
  en: {
    vmiH: 'Supplier-managed stock (VMI)', vmiLead: 'A supplier watches its own items at your store and proposes a top-up inside the minimum and maximum you set. Nothing is ordered until a buyer accepts it — and then it is an order proposal a second person still issues.',
    supplier: 'Supplier code', show: 'Show its items', itemsNone: 'Not set: you have set no minimum and maximum for this supplier yet, so it can propose nothing.',
    store: 'Store', product: 'Product', min: 'Minimum', max: 'Maximum', uom: 'Unit', setLimit: 'Set the limit',
    onHand: 'on hand', onOrder: 'on order', room: 'room', belowMin: 'below the minimum', aboveMin: 'at or above the minimum',
    proposalsH: 'Top-ups waiting for a buyer', proposalsNone: 'No supplier top-up is waiting.', proposed: 'proposed',
    poId: 'Order number to raise', unitCost: 'Unit cost (₹)', reason: 'Reason (required)', accept: 'Accept into an order proposal', reject: 'Reject',
    needSupplier: 'Type the supplier code first. Nothing was sent.', needAll: 'Fill the store, product, minimum, maximum and unit. Nothing was sent.',
    badLimit: 'The minimum and maximum are whole numbers, the minimum not above the maximum. Nothing was sent.',
    needReason: 'Write the reason first — the supplier sees it.', needPo: 'Type the order number to raise. Nothing was sent.', needCost: 'Type a unit cost for every item — the supplier never sets the price. Nothing was sent.',
    saved: 'Saved.', nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot read supplier-managed stock.', cannotDecide: 'Your role cannot set limits or decide top-ups.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    vmiH: 'சப்ளையர் நிர்வகிக்கும் சரக்கு (VMI)', vmiLead: 'ஒரு சப்ளையர் உங்கள் கடையில் தன் பொருட்களைக் கவனித்து, நீங்கள் அமைத்த குறைந்தபட்சம் மற்றும் அதிகபட்சத்துக்குள் நிரப்பலை முன்மொழிகிறார். வாங்குபவர் ஏற்கும் வரை எதுவும் ஆர்டர் ஆகாது — ஏற்றாலும் அது இரண்டாம் நபர் வெளியிட வேண்டிய ஆர்டர் முன்மொழிவு மட்டுமே.',
    supplier: 'சப்ளையர் குறியீடு', show: 'அதன் பொருட்களைக் காட்டு', itemsNone: 'அமைக்கப்படவில்லை: இந்தச் சப்ளையருக்கு நீங்கள் இன்னும் குறைந்தபட்சம், அதிகபட்சம் அமைக்கவில்லை; அவர் எதையும் முன்மொழிய முடியாது.',
    store: 'கடை', product: 'பொருள்', min: 'குறைந்தபட்சம்', max: 'அதிகபட்சம்', uom: 'அலகு', setLimit: 'வரம்பை அமை',
    onHand: 'கையிருப்பு', onOrder: 'ஆர்டரில்', room: 'இடம்', belowMin: 'குறைந்தபட்சத்துக்குக் கீழ்', aboveMin: 'குறைந்தபட்சம் அல்லது மேல்',
    proposalsH: 'வாங்குபவருக்காகக் காத்திருக்கும் நிரப்பல்கள்', proposalsNone: 'எந்தச் சப்ளையர் நிரப்பலும் காத்திருக்கவில்லை.', proposed: 'முன்மொழிந்தது',
    poId: 'உருவாக்க வேண்டிய ஆர்டர் எண்', unitCost: 'அலகு விலை (₹)', reason: 'காரணம் (தேவை)', accept: 'ஆர்டர் முன்மொழிவாக ஏற்கவும்', reject: 'நிராகரி',
    needSupplier: 'முதலில் சப்ளையர் குறியீட்டைத் தட்டச்சு செய்யவும். எதுவும் அனுப்பப்படவில்லை.', needAll: 'கடை, பொருள், குறைந்தபட்சம், அதிகபட்சம், அலகு ஆகியவற்றை நிரப்பவும். எதுவும் அனுப்பப்படவில்லை.',
    badLimit: 'குறைந்தபட்சமும் அதிகபட்சமும் முழு எண்கள்; குறைந்தபட்சம் அதிகபட்சத்தை விட அதிகமாக இருக்கக்கூடாது. எதுவும் அனுப்பப்படவில்லை.',
    needReason: 'முதலில் காரணத்தை எழுதவும் — சப்ளையர் அதைப் பார்ப்பார்.', needPo: 'உருவாக்க வேண்டிய ஆர்டர் எண்ணைத் தட்டச்சு செய்யவும். எதுவும் அனுப்பப்படவில்லை.', needCost: 'ஒவ்வொரு பொருளுக்கும் அலகு விலையைத் தட்டச்சு செய்யவும் — சப்ளையர் விலையை அமைப்பதில்லை. எதுவும் அனுப்பப்படவில்லை.',
    saved: 'சேமிக்கப்பட்டது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு சப்ளையர் நிர்வகிக்கும் சரக்கைப் படிக்க முடியாது.', cannotDecide: 'உங்கள் பங்கு வரம்புகளை அமைக்கவோ நிரப்பல்களை முடிவு செய்யவோ முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const vmiDeskWords = (lang: Lang, key: string): string =>
  (VMI_DESK_COPY[lang] as Record<string, string>)[key] ?? (VMI_DESK_COPY.en as Record<string, string>)[key] ?? key;
export const vmiDeskOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => (out.result === 'ok' ? vmiDeskWords(lang, 'saved') : outcomeIn((k) => vmiDeskWords(lang, k), out));

export interface VmiItemView { readonly storeId: string; readonly productId: string; readonly minQty: number; readonly maxQty: number; readonly uom: string; readonly onHand: number; readonly onOrder: number; readonly room: number; readonly belowMinimum: boolean }
export interface VmiProposalView { readonly proposalId: string; readonly supplierId: string; readonly storeId: string; readonly lines: readonly { readonly productId: string; readonly quantity: number }[]; readonly note: string; readonly proposedAt: string; readonly status: string }

/** One managed item in words: "p-rice at store-1 · min 20 / max 50 · on hand 15 · on order 0 · room 35 · below the minimum". */
export function itemWords(lang: Lang, i: VmiItemView): string {
  const w = (k: string) => vmiDeskWords(lang, k);
  return `${i.productId} · ${w('store')} ${i.storeId} · ${w('min')} ${i.minQty} / ${w('max')} ${i.maxQty} ${i.uom} · ${w('onHand')} ${i.onHand} · ${w('onOrder')} ${i.onOrder} · ${w('room')} ${i.room} · ${w(i.belowMinimum ? 'belowMin' : 'aboveMin')}`;
}

/** Rupees typed by the buyer → whole paise, or undefined when it is not a price. */
export function paiseOf(typed: string): number | undefined {
  const s = typed.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  return Math.round(Number(s) * 100);
}

type Why = 'nobody' | 'cannotRead' | 'cannotDecide' | 'needSupplier' | 'needAll' | 'badLimit' | 'needReason' | 'needPo' | 'needCost';

export interface VmiDeskSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly decide: boolean };
  items(supplierId: string): Promise<Outcome<{ readonly items: readonly VmiItemView[]; readonly notSet?: string }, Why>>;
  setLimit(input: { readonly supplierId: string; readonly storeId: string; readonly productId: string; readonly min: string; readonly max: string; readonly uom: string }): Promise<Outcome<unknown, Why>>;
  queue(): Promise<Outcome<{ readonly proposals: readonly VmiProposalView[]; readonly awaiting: number }, Why>>;
  /** Accept (with the order number and a unit cost in rupees per item) or reject, always with a reason. */
  decide(p: VmiProposalView, decision: 'accept' | 'reject', reason: string, poId?: string, rupeesByProduct?: Readonly<Record<string, string>>): Promise<Outcome<unknown, Why>>;
}

export function createVmiDeskSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): VmiDeskSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('purchase.commitment.read'), decide: named && held.has('purchase.order.propose') };
  const call = makeCaller({ keyPrefix: 'vmi-desk', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const enc = encodeURIComponent;
  const gate = (need: 'read' | 'decide'): Outcome<never, Why> | undefined =>
    (!named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : 'cannotDecide' } : undefined);
  const whole = (s: string): number | undefined => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);
  return {
    may,
    items: async (supplierId) => gate('read') ?? (supplierId.trim() === '' ? { result: 'invalid', why: 'needSupplier' } : call('GET', `/v1/purchase/vmi/${enc(supplierId.trim())}`)),
    setLimit: async (i) => {
      const g = gate('decide'); if (g !== undefined) return g;
      if ([i.supplierId, i.storeId, i.productId, i.min, i.max, i.uom].some((x) => x.trim() === '')) return { result: 'invalid', why: 'needAll' };
      const min = whole(i.min); const max = whole(i.max);
      if (min === undefined || max === undefined || max === 0 || min > max) return { result: 'invalid', why: 'badLimit' };
      return call('POST', `/v1/purchase/vmi/limits/${enc(i.supplierId.trim())}/${enc(i.storeId.trim())}/${enc(i.productId.trim())}`, { minQty: min, maxQty: max, uom: i.uom.trim() });
    },
    queue: async () => gate('read') ?? call('GET', '/v1/purchase/vmi-proposals'),
    decide: async (p, decision, reason, poId, rupeesByProduct) => {
      const g = gate('decide'); if (g !== undefined) return g;
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      if (decision === 'reject') return call('POST', `/v1/purchase/vmi-proposals/${enc(p.proposalId)}/decide`, { decision, reason: reason.trim() });
      const po = (poId ?? '').trim() === '' ? newId('po-vmi') : (poId as string).trim();
      const lines: { productId: string; unitCost: { minor: number; currency: 'INR' } }[] = [];
      for (const l of p.lines) {
        const minor = paiseOf(rupeesByProduct?.[l.productId] ?? '');
        if (minor === undefined) return { result: 'invalid', why: 'needCost' };
        lines.push({ productId: l.productId, unitCost: { minor, currency: 'INR' } });
      }
      return call('POST', `/v1/purchase/vmi-proposals/${enc(p.proposalId)}/decide`, { decision, reason: reason.trim(), poId: po, lines });
    },
  };
}
