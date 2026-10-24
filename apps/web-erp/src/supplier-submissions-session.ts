// The Supplier submissions page — the buyer decides what suppliers sent, from one queue (M24-FR-01 · M24-FR-02 · §28 ·
// P-03 · P-07 · OB-288 package 3). A tested, DOM-free session over head office's own routes:
//   • the QUEUE: every supplier's invoices and delivery notes (with their documents), catalogue / cost proposals, RFQ
//     replies and claims still waiting for a buyer, oldest first, and the latest decisions (GET /v1/supplier-portal/review-queue);
//   • a DECISION: accept or reject, always with a reason, in the buyer's own name — never the submitter's (POST …/review);
//     an accepted invoice reaches the three-way match and an accepted delivery note the receiving compare; a proposal or a
//     claim is decided on record and changes nothing by itself;
//   • the DELIVERY STATUS each supplier gave for its orders (dispatched / in transit / delayed, with the date), and one
//     order's updates (GET /v1/supplier-portal/orders/:poId/delivery-status).
// Nothing is read or written on open; every write is a person's click.

import { makeCaller, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const SUPPLIER_SUBMISSIONS_COPY = {
  en: {
    title: 'Supplier submissions', lead: 'What suppliers sent: invoices, delivery notes, price proposals, RFQ replies and claims. Nothing a supplier sends takes effect until a buyer accepts it. Decide each with a reason; you cannot decide your own.',
    queueH: 'Waiting for a buyer', queueNone: 'Nothing is waiting.', decidedH: 'Decided recently', decidedNone: 'Nothing decided yet.',
    deliveriesH: 'Delivery status from suppliers', deliveriesNone: 'No supplier has sent a delivery update.', lookupH: 'Look up an order', poId: 'Purchase order number', lookup: 'Look up', noWord: 'No word from the supplier on this order yet.',
    kind_invoice: 'Invoice', kind_asn: 'Delivery note (ASN)', kind_catalogue: 'Price / catalogue proposal', kind_rfq_response: 'RFQ reply', kind_claim: 'Claim', kind_po_acknowledgement: 'Order acknowledgement', kind_delivery_status: 'Delivery update',
    status_dispatched: 'dispatched', status_in_transit: 'in transit', status_delayed: 'delayed', expected: 'expected', from: 'from', received: 'received', feeds: 'Accepting it puts it on',
    reason: 'Reason (required)', accept: 'Accept', reject: 'Reject', accepted: 'accepted', rejected: 'rejected', by: 'by', needReason: 'Write the reason first — the supplier sees it.', needPo: 'Type the order number.',
    read: 'Read', refresh: 'Read again', saved: 'Saved.', nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot review supplier submissions.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'சப்ளையர் சமர்ப்பிப்புகள்', lead: 'சப்ளையர்கள் அனுப்பியவை: விலைப்பட்டியல்கள், விநியோகக் குறிப்புகள், விலை முன்மொழிவுகள், RFQ பதில்கள், உரிமைகோரல்கள். ஒரு வாங்குபவர் ஏற்கும் வரை சப்ளையர் அனுப்பும் எதுவும் அமலுக்கு வராது. ஒவ்வொன்றையும் காரணத்துடன் முடிவு செய்யவும்; உங்களுடையதை நீங்கள் முடிவு செய்ய முடியாது.',
    queueH: 'வாங்குபவருக்காகக் காத்திருப்பவை', queueNone: 'எதுவும் காத்திருக்கவில்லை.', decidedH: 'சமீபத்தில் முடிவானவை', decidedNone: 'இன்னும் எதுவும் முடிவாகவில்லை.',
    deliveriesH: 'சப்ளையர்களிடமிருந்து டெலிவரி நிலவரம்', deliveriesNone: 'எந்தச் சப்ளையரும் டெலிவரி நிலவரம் அனுப்பவில்லை.', lookupH: 'ஒரு ஆர்டரைத் தேடு', poId: 'கொள்முதல் ஆர்டர் எண்', lookup: 'தேடு', noWord: 'இந்த ஆர்டர் பற்றி சப்ளையரிடமிருந்து இன்னும் தகவல் இல்லை.',
    kind_invoice: 'விலைப்பட்டியல்', kind_asn: 'விநியோகக் குறிப்பு (ASN)', kind_catalogue: 'விலை / பட்டியல் முன்மொழிவு', kind_rfq_response: 'RFQ பதில்', kind_claim: 'உரிமைகோரல்', kind_po_acknowledgement: 'ஆர்டர் ஒப்புகை', kind_delivery_status: 'டெலிவரி நிலவரம்',
    status_dispatched: 'அனுப்பப்பட்டது', status_in_transit: 'வழியில் உள்ளது', status_delayed: 'தாமதம்', expected: 'எதிர்பார்ப்பு', from: 'இருந்து', received: 'பெறப்பட்டது', feeds: 'ஏற்றால் இது சேரும் இடம்',
    reason: 'காரணம் (தேவை)', accept: 'ஏற்கவும்', reject: 'நிராகரி', accepted: 'ஏற்கப்பட்டது', rejected: 'நிராகரிக்கப்பட்டது', by: 'செய்தவர்', needReason: 'முதலில் காரணத்தை எழுதவும் — சப்ளையர் அதைப் பார்ப்பார்.', needPo: 'ஆர்டர் எண்ணைத் தட்டச்சு செய்யவும்.',
    read: 'படி', refresh: 'மீண்டும் படி', saved: 'சேமிக்கப்பட்டது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு சப்ளையர் சமர்ப்பிப்புகளை மதிப்பாய்வு செய்ய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const supplierSubmissionsWords = (lang: Lang, key: string): string =>
  (SUPPLIER_SUBMISSIONS_COPY[lang] as Record<string, string>)[key] ?? (SUPPLIER_SUBMISSIONS_COPY.en as Record<string, string>)[key] ?? key;

export function supplierSubmissionsOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  const w = (k: string) => supplierSubmissionsWords(lang, k);
  if (out.result === 'refused') return `${w('refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return w(out.why);
  if (out.result === 'lost_link') return w('unreachable');
  return w('saved');
}

export interface QueueRow { readonly partnerId: string; readonly submissionId: string; readonly kind: string; readonly receivedAt: string; readonly submittedBy: string | null; readonly document: Record<string, unknown> | null; readonly feeds: string | null }
export interface DecidedRow extends QueueRow { readonly review: { readonly decision: 'accepted' | 'rejected'; readonly reason: string; readonly reviewedBy: string; readonly reviewedAt: string } }
export interface DeliveryRow { readonly poId: string; readonly partnerId: string; readonly status: string; readonly expectedOn: string; readonly note: string | null; readonly receivedAt: string }

/** One line saying what a document is — for an invoice its number and total, for a delivery note its lines. */
export function documentLine(row: QueueRow, rupees: (minor: number) => string = (m) => `₹${(m / 100).toFixed(2)}`): string {
  const d = row.document;
  if (d === null) return '';
  const po = typeof d['poId'] === 'string' ? ` · PO ${d['poId']}` : '';
  if (row.kind === 'invoice') return `${String(d['invoiceId'] ?? '')} · ${rupees(Number(d['declaredTotalMinor'] ?? 0))}${po}`;
  if (row.kind === 'asn') return `${String(d['asnId'] ?? '')} · ${Array.isArray(d['lines']) ? d['lines'].length : 0} line(s)${po}`;
  return Object.entries(d).filter(([k]) => k !== 'poId').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ').slice(0, 300) + po;
}

export interface SupplierSubmissionsSession {
  readonly may: { readonly named: boolean; readonly review: boolean };
  readQueue(): Promise<Outcome<{ readonly waiting: readonly QueueRow[]; readonly decided: readonly DecidedRow[]; readonly deliveries: readonly DeliveryRow[] }>>;
  decide(row: QueueRow, decision: 'accept' | 'reject', reason: string): Promise<Outcome<unknown, 'needReason' | 'nobody'>>;
  readDelivery(poId: string): Promise<Outcome<{ readonly latest: DeliveryRow | null; readonly updates: readonly DeliveryRow[] }, 'needPo'>>;
}

export function createSupplierSubmissionsSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): SupplierSubmissionsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, review: named && held.has('supplier.portal.review') };
  const call = makeCaller({ keyPrefix: 'supplier-review', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const enc = encodeURIComponent;
  return {
    may,
    readQueue: () => call('GET', '/v1/supplier-portal/review-queue'),
    decide: async (row, decision, reason) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/supplier-portal/partners/${enc(row.partnerId)}/submissions/${enc(row.submissionId)}/review`, { decision, reason: reason.trim() });
    },
    readDelivery: async (poId) => (poId.trim() === '' ? { result: 'invalid', why: 'needPo' } : call('GET', `/v1/supplier-portal/orders/${enc(poId.trim())}/delivery-status`)),
  };
}
