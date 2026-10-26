// The Standing orders page — blanket purchase orders (M06-FR-02 "… PO, blanket PO and approvals" · §28 · QG-02). A tested,
// DOM-free session over head office's own agreements (services/purchase/src/blanket-orders.ts):
//   • READ — every standing agreement with its DRAWDOWN: the ceiling, what released orders have committed, what waits for a
//     second person, what is left, per product, and each release; an expired agreement and one not yet approved are said;
//   • PROPOSE — a buyer proposes an agreement with one supplier: the products at agreed prices, a value ceiling, a validity
//     window. It commits no money by itself; head office refuses an unknown supplier, a discontinued product or terms
//     that do not hold together, by name;
//   • APPROVE — a second person, never the proposer, with a reason (head office refuses a self-approval).
// A call-off is an ordinary purchase order naming the agreement — raised on the Buying page. Nothing is read on open.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const BLANKET_ORDERS_COPY = {
  en: {
    title: 'Standing orders', lead: 'A standing agreement with one supplier: agreed prices, a ceiling and dates. It spends nothing by itself — each delivery is called off as an ordinary purchase order on the Buying page, and nothing passes the ceiling.',
    show: 'Show the agreements', listH: 'Agreements', none: 'No standing agreement yet.', waiting: 'waiting for a second person', approved: 'Approved', proposed: 'Proposed — not approved yet',
    expired: 'Expired', validToday: 'In force today', notInForce: 'Not in force today', ceiling: 'Ceiling', issued: 'Committed', pending: 'Waiting', remaining: 'Left', releases: 'Call-offs',
    product: 'Product', maxQty: 'Most', released: 'Called off', left: 'left', noLimit: 'no quantity limit', proposedBy: 'proposed by', approvedBy: 'approved by',
    proposeH: 'Propose a standing agreement', supplier: 'Supplier code', ceilingRs: 'Ceiling (₹)', validFrom: 'Valid from (YYYY-MM-DD)', validTo: 'Valid to (YYYY-MM-DD)', deliverTo: 'Deliver to (store, optional)',
    lines: 'Products — one per line: product code, agreed cost ₹ a unit, most units (optional)', propose: 'Propose the agreement',
    approveH: 'Approve', reason: 'Why you approve (needed)', approve: 'Approve the agreement', saved: 'Done — head office recorded it.', already: 'Already recorded — nothing changed.',
    needFields: 'Fill in the supplier, the ceiling, both dates and at least one product line.', badLine: 'A product line reads: product code, agreed cost in ₹, and (optional) the most units.', needReason: 'Write why you approve first.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read purchase commitments.', cannotPropose: 'Your role cannot propose an agreement.', cannotApprove: 'Your role cannot approve an agreement.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'நிலையான ஆணைகள்', lead: 'ஒரு விநியோகஸ்தருடன் நிலையான ஒப்பந்தம்: ஒப்புக்கொண்ட விலைகள், உச்சவரம்பு, தேதிகள். அது தானாக எதையும் செலவழிக்காது — ஒவ்வொரு விநியோகமும் வாங்குதல் பக்கத்தில் சாதாரண கொள்முதல் ஆணையாக எடுக்கப்படும்; எதுவும் உச்சவரம்பைத் தாண்டாது.',
    show: 'ஒப்பந்தங்களைக் காட்டு', listH: 'ஒப்பந்தங்கள்', none: 'இன்னும் நிலையான ஒப்பந்தம் இல்லை.', waiting: 'இரண்டாவது நபருக்காகக் காத்திருக்கிறது', approved: 'அனுமதிக்கப்பட்டது', proposed: 'முன்மொழியப்பட்டது — இன்னும் அனுமதிக்கப்படவில்லை',
    expired: 'காலாவதியானது', validToday: 'இன்று நடைமுறையில்', notInForce: 'இன்று நடைமுறையில் இல்லை', ceiling: 'உச்சவரம்பு', issued: 'உறுதியானது', pending: 'காத்திருப்பு', remaining: 'மீதம்', releases: 'எடுப்புகள்',
    product: 'பொருள்', maxQty: 'அதிகபட்சம்', released: 'எடுக்கப்பட்டது', left: 'மீதம்', noLimit: 'அளவு வரம்பு இல்லை', proposedBy: 'முன்மொழிந்தவர்', approvedBy: 'அனுமதித்தவர்',
    proposeH: 'நிலையான ஒப்பந்தத்தை முன்மொழி', supplier: 'விநியோகஸ்தர் குறியீடு', ceilingRs: 'உச்சவரம்பு (₹)', validFrom: 'செல்லுபடி தொடக்கம் (YYYY-MM-DD)', validTo: 'செல்லுபடி முடிவு (YYYY-MM-DD)', deliverTo: 'விநியோக இடம் (கடை, விருப்பம்)',
    lines: 'பொருட்கள் — ஒரு வரிக்கு ஒன்று: பொருள் குறியீடு, ஒரு அலகுக்கு ஒப்புக்கொண்ட விலை ₹, அதிகபட்ச அலகுகள் (விருப்பம்)', propose: 'ஒப்பந்தத்தை முன்மொழி',
    approveH: 'அனுமதி', reason: 'ஏன் அனுமதிக்கிறீர்கள் (தேவை)', approve: 'ஒப்பந்தத்தை அனுமதி', saved: 'முடிந்தது — தலைமை அலுவலகம் பதிவு செய்தது.', already: 'ஏற்கனவே பதிவானது — எதுவும் மாறவில்லை.',
    needFields: 'விநியோகஸ்தர், உச்சவரம்பு, இரு தேதிகள், குறைந்தது ஒரு பொருள் வரி ஆகியவற்றை நிரப்புங்கள்.', badLine: 'பொருள் வரி: பொருள் குறியீடு, ₹ இல் ஒப்புக்கொண்ட விலை, (விருப்பம்) அதிகபட்ச அலகுகள்.', needReason: 'முதலில் ஏன் அனுமதிக்கிறீர்கள் என்று எழுதுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி கொள்முதல் உறுதிப்பாடுகளைப் படிக்க முடியாது.', cannotPropose: 'உங்கள் பணி ஒப்பந்தத்தை முன்மொழிய முடியாது.', cannotApprove: 'உங்கள் பணி ஒப்பந்தத்தை அனுமதிக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const blanketWords = (lang: Lang, key: string): string =>
  (BLANKET_ORDERS_COPY[lang] as Record<string, string>)[key] ?? (BLANKET_ORDERS_COPY.en as Record<string, string>)[key] ?? key;
export const blanketOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => {
  if (out.result !== 'ok') return outcomeIn((k) => blanketWords(lang, k), out);
  const v = out.value as { alreadyProposed?: boolean; alreadyApproved?: boolean };
  return blanketWords(lang, v.alreadyProposed === true || v.alreadyApproved === true ? 'already' : 'saved');
};
/** Paise as rupees, Indian grouping. */
export const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface BlanketView {
  readonly agreement: {
    readonly agreementId: string; readonly supplierId: string; readonly currency: string; readonly ceilingMinor: number; readonly validFrom: string; readonly validTo: string;
    readonly lines: readonly { readonly productId: string; readonly agreedUnitCost: { readonly minor: number; readonly currency: string }; readonly maxQty?: number }[];
    readonly proposedBy: string; readonly proposedAt: string; readonly status: 'proposed' | 'approved'; readonly approvedBy: string | null; readonly approvedAt: string | null; readonly deliverToLocationId?: string;
  };
  readonly drawdown: { readonly ceilingMinor: number; readonly issuedMinor: number; readonly pendingMinor: number; readonly remainingMinor: number; readonly releases: number; readonly byProduct: readonly { readonly productId: string; readonly maxQty: number | null; readonly releasedQty: number; readonly remainingQty: number | null }[] };
  readonly validToday: boolean; readonly expired: boolean;
  readonly releases: readonly { readonly poId: string; readonly number: string; readonly status: string; readonly requisitionedBy: string; readonly approvedBy: string | null }[];
}
export interface ProposeForm { readonly supplierId: string; readonly ceilingRupees: string; readonly validFrom: string; readonly validTo: string; readonly deliverTo: string; readonly lines: string }

/** "₹" text as whole paise; null when it is not a plain amount (never rounded silently past the paise). */
export function paiseOf(rupeesText: string): number | null {
  const v = rupeesText.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** The product lines as typed — "code, cost, most?" one per line — or the first line that does not read. */
export function linesOf(text: string): { readonly ok: true; readonly lines: readonly { readonly productId: string; readonly agreedUnitCost: { readonly minor: number; readonly currency: 'INR' }; readonly maxQty?: number }[] } | { readonly ok: false; readonly line: number } {
  const rows = text.split('\n').map((r) => r.trim()).filter((r) => r !== '');
  const lines = [];
  for (const [i, row] of rows.entries()) {
    const [code = '', cost = '', most] = row.split(',').map((c) => c.trim());
    const minor = paiseOf(cost);
    const max = most === undefined || most === '' ? undefined : /^\d+$/.test(most) && Number(most) > 0 ? Number(most) : null;
    if (code === '' || minor === null || max === null) return { ok: false, line: i + 1 };
    lines.push({ productId: code, agreedUnitCost: { minor, currency: 'INR' as const }, ...(max === undefined ? {} : { maxQty: max }) });
  }
  return { ok: true, lines };
}

export interface BlanketOrdersSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly propose: boolean; readonly approve: boolean };
  list(): Promise<Outcome<{ readonly agreements: readonly BlanketView[]; readonly count: number; readonly awaitingApprovalCount: number }, 'nobody' | 'cannotRead'>>;
  propose(form: ProposeForm): Promise<Outcome<BlanketView & { readonly alreadyProposed: boolean }, 'nobody' | 'cannotPropose' | 'needFields' | 'badLine'>>;
  approve(agreementId: string, reason: string): Promise<Outcome<BlanketView & { readonly alreadyApproved: boolean }, 'nobody' | 'cannotApprove' | 'needReason'>>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createBlanketOrdersSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newAgreementId?: () => string }): BlanketOrdersSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('purchase.commitment.read'), propose: named && held.has('purchase.order.propose'), approve: named && held.has('purchase.order.approve') };
  const call = makeCaller({ keyPrefix: 'blanket', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const idOf = input.newAgreementId ?? (() => newId('BPO'));
  return {
    may,
    list: async () => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      return call('GET', '/v1/purchase/blanket-orders');
    },
    propose: async (f) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.propose) return { result: 'invalid', why: 'cannotPropose' };
      const ceilingMinor = paiseOf(f.ceilingRupees);
      if (f.supplierId.trim() === '' || ceilingMinor === null || ceilingMinor <= 0 || !DATE.test(f.validFrom.trim()) || !DATE.test(f.validTo.trim()) || f.lines.trim() === '') return { result: 'invalid', why: 'needFields' };
      const lines = linesOf(f.lines);
      if (!lines.ok) return { result: 'invalid', why: 'badLine' };
      return call('POST', `/v1/purchase/blanket-orders/${encodeURIComponent(idOf())}`, {
        supplierId: f.supplierId.trim(), currency: 'INR', ceilingMinor, validFrom: f.validFrom.trim(), validTo: f.validTo.trim(), lines: lines.lines,
        ...(f.deliverTo.trim() === '' ? {} : { deliverToLocationId: f.deliverTo.trim() }),
      });
    },
    approve: async (agreementId, reason) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.approve) return { result: 'invalid', why: 'cannotApprove' };
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/purchase/blanket-orders/${encodeURIComponent(agreementId)}/approval`, { reason: reason.trim() });
    },
  };
}
