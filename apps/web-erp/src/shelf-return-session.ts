// RETURN SHELF STOCK TO THE SUPPLIER — the page model behind the "Return to supplier" box on Quarantine (and the link from
// each Expiry row). S1 · batch 18c · roadmap §29 purchase_return · API-03 · M10-FR-01 · OB-872.
//
// The person picks the item, the place, the batch (optional), how many, the supplier and why (expired / near expiry /
// damaged). One press of "Return to supplier" sends ONE `POST /v1/inventory/shelf-returns/:returnId`; head office numbers
// it (RTS), takes the stock off, issues the supplier's debit note (SDN) and applies the e-way-bill rule. When head office
// says a second person must approve it (the same as a write-off of that value), "Ask for approval" sends the request for
// exactly this return — its value read from head office first — and, once approved, the same press sends it with the
// approval. The return id is kept for the form, so a press after the approval is the same return. Holds no rule of its
// own; DOM-free and tested.

import type { HeadOfficeHttp, HttpAnswer } from './head-office-http';
import { rupees } from './head-office-http';

type Lang = 'en' | 'ta';

export const SHELF_RETURN_WORDS = Object.freeze({
  en: {
    heading: 'Return to supplier', lede: 'Expired, near-expiry or damaged stock found on the shelf goes back to the supplier. Head office gives it a return number, takes the stock off and issues the supplier\'s debit note.',
    item: 'Item code', place: 'Place', batch: 'Batch (if known)', qty: 'How many', supplier: 'Supplier', why: 'Why it goes back', note: 'Note (what you found)',
    value: 'Value in ₹ (only if head office has no cost for it)', expired: 'Expired', near_expiry: 'Near expiry', damaged: 'Damaged',
    send: 'Return to supplier', ask: 'Ask for approval', pickSupplier: 'Choose the supplier',
    fillAll: 'Fill in the item, the place, how many (a whole number above 0), the supplier and why.',
    done: 'Returned', debitNote: 'debit note', askFirst: 'A second person must approve this return first. Press "Ask for approval".',
    asked: 'Asked — once another person approves it on Approvals, press "Return to supplier" again.',
    notAsked: 'The approval was not asked:', refused: 'Head office did not return it:', lost: 'Head office could not be reached, so nothing was returned.',
    nobody: 'Nobody is signed in on this page.', cannot: 'Your role does not return stock to a supplier.',
    listHeading: 'Returned to suppliers', none: 'Nothing has been returned to a supplier from the shelf yet.',
    returnThis: 'Return to supplier', gstNote: 'Its GST treatment is not decided yet: the debit note is shown on the supplier\'s account, not taken off what is owed.',
  },
  ta: {
    heading: 'விநியோகஸ்தருக்குத் திருப்பு', lede: 'அலமாரியில் காலாவதியான, காலாவதி நெருங்கிய அல்லது சேதமான பொருள் விநியோகஸ்தருக்குத் திரும்பும். தலைமை அலுவலகம் திருப்பு எண் தந்து, இருப்பைக் குறைத்து, பற்றுக் குறிப்பை வழங்கும்.',
    item: 'பொருள் குறியீடு', place: 'இடம்', batch: 'தொகுதி (தெரிந்தால்)', qty: 'எத்தனை', supplier: 'விநியோகஸ்தர்', why: 'ஏன் திருப்புகிறது', note: 'குறிப்பு (என்ன கண்டீர்கள்)',
    value: '₹ மதிப்பு (தலைமை அலுவலகத்திடம் விலை இல்லையெனில் மட்டும்)', expired: 'காலாவதியானது', near_expiry: 'காலாவதி நெருங்கியது', damaged: 'சேதமானது',
    send: 'விநியோகஸ்தருக்குத் திருப்பு', ask: 'ஒப்புதல் கேள்', pickSupplier: 'விநியோகஸ்தரைத் தேர்ந்தெடுக்கவும்',
    fillAll: 'பொருள், இடம், எத்தனை (0-க்கு மேல் முழு எண்), விநியோகஸ்தர், காரணம் ஆகியவற்றை நிரப்பவும்.',
    done: 'திருப்பப்பட்டது', debitNote: 'பற்றுக் குறிப்பு', askFirst: 'இதை முதலில் இரண்டாவது நபர் ஒப்புக்கொள்ள வேண்டும். "ஒப்புதல் கேள்" அழுத்தவும்.',
    asked: 'கேட்கப்பட்டது — மற்றொருவர் ஒப்புதல்கள் பக்கத்தில் ஒப்புக்கொண்டதும், மீண்டும் "விநியோகஸ்தருக்குத் திருப்பு" அழுத்தவும்.',
    notAsked: 'ஒப்புதல் கேட்கப்படவில்லை:', refused: 'தலைமை அலுவலகம் திருப்பவில்லை:', lost: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எதுவும் திருப்பப்படவில்லை.',
    nobody: 'இந்தப் பக்கத்தில் யாரும் உள்நுழையவில்லை.', cannot: 'உங்கள் பங்கு விநியோகஸ்தருக்கு இருப்பைத் திருப்புவதில்லை.',
    listHeading: 'விநியோகஸ்தருக்குத் திருப்பியவை', none: 'அலமாரியிலிருந்து இன்னும் எதுவும் திருப்பப்படவில்லை.',
    returnThis: 'விநியோகஸ்தருக்குத் திருப்பு', gstNote: 'இதன் GST முறை இன்னும் முடிவாகவில்லை: பற்றுக் குறிப்பு கணக்கில் காட்டப்படும், நிலுவையிலிருந்து கழிக்கப்படாது.',
  },
} as const);

export type ShelfReturnWord = keyof typeof SHELF_RETURN_WORDS.en;
export const SHELF_RETURN_REASONS = ['expired', 'near_expiry', 'damaged'] as const;

export interface ShelfReturnForm {
  readonly productId: string;
  readonly locationId: string;
  readonly batchId?: string;
  /** Whole units (the item's smallest step). */
  readonly qty: string;
  readonly uom?: string;
  readonly supplierId: string;
  readonly reason: string;
  readonly note?: string;
  /** ₹, typed only when head office holds no cost. */
  readonly valueRupees?: string;
}

export interface ShelfReturnRow {
  readonly returnId: string;
  readonly documentNumber: string;
  readonly productId: string;
  readonly quantityMinor: number;
  readonly supplierId: string;
  readonly reason: string;
  readonly valueMinor: number;
  readonly debitNoteNumber: string;
  readonly at: string;
  readonly approvedBy: string | null;
}

export type ShelfReturnOutcome =
  | { readonly kind: 'returned'; readonly row: ShelfReturnRow }
  | { readonly kind: 'needs_approval'; readonly whatHappened: string }
  | { readonly kind: 'asked' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'not_permitted' }
  | { readonly kind: 'refused'; readonly whatHappened: string }
  | { readonly kind: 'not_asked'; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function rowOf(raw: unknown): ShelfReturnRow | null {
  if (!isRec(raw) || str(raw['returnId']) === '') return null;
  const dn = isRec(raw['debitNote']) ? raw['debitNote'] : {};
  return {
    returnId: str(raw['returnId']), documentNumber: str(raw['documentNumber']) || str(raw['returnId']), productId: str(raw['productId']),
    quantityMinor: num(raw['quantityMinor']), supplierId: str(raw['supplierId']), reason: str(raw['reason']), valueMinor: num(raw['valueMinor']),
    debitNoteNumber: str(dn['number']), at: str(raw['at']), approvedBy: typeof raw['approvedBy'] === 'string' ? raw['approvedBy'] : null,
  };
}

/** The body head office reads — exactly what an approval is asked for, so the two always agree. */
export function shelfReturnBody(form: ShelfReturnForm): Record<string, unknown> | null {
  const qty = Number(form.qty);
  const t = (s: string | undefined): string => (s ?? '').trim();
  if (t(form.productId) === '' || t(form.locationId) === '' || t(form.supplierId) === '' || !Number.isSafeInteger(qty) || qty <= 0
    || !(SHELF_RETURN_REASONS as readonly string[]).includes(form.reason)) return null;
  const value = t(form.valueRupees);
  const valueMinor = value === '' ? undefined : Math.round(Number(value) * 100);
  if (valueMinor !== undefined && (!Number.isSafeInteger(valueMinor) || valueMinor < 0)) return null;
  return {
    productId: t(form.productId), locationId: t(form.locationId), qty, uom: t(form.uom) || 'ea', supplierId: t(form.supplierId), reason: form.reason,
    ...(t(form.batchId) === '' ? {} : { batchId: t(form.batchId) }), ...(t(form.note) === '' ? {} : { note: t(form.note) }),
    ...(valueMinor === undefined ? {} : { valueMinor }),
  };
}

const newId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return `rts-${c?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`}`;
};

export function createShelfReturnSession(viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined, http: HeadOfficeHttp, makeId: () => string = newId) {
  const may = viewer !== undefined && viewer.permissions.includes('inventory.movement.append');
  // One return id per form content: the same form pressed again (after the approval) is the same return.
  let current: { readonly key: string; readonly returnId: string; approvalId?: string } | null = null;
  const idFor = (body: Record<string, unknown>): { readonly key: string; readonly returnId: string; approvalId?: string } => {
    const key = JSON.stringify(body);
    if (current === null || current.key !== key) current = { key, returnId: makeId() };
    return current;
  };
  const words = (lang: Lang, k: ShelfReturnWord): string => (SHELF_RETURN_WORDS[lang] ?? SHELF_RETURN_WORDS.en)[k];
  const refusal = (a: HttpAnswer): string => (a.result === 'refused' ? a.whatHappened || a.code : '');
  return {
    may, words,
    async read(): Promise<{ readonly rows: readonly ShelfReturnRow[]; readonly suppliers: readonly { readonly supplierId: string; readonly name: string }[] } | null> {
      if (!may) return null;
      const got = await http.get('/v1/inventory/shelf-returns');
      if (got.result !== 'ok') return null;
      const rows = (isRec(got.body) && Array.isArray(got.body['returns']) ? got.body['returns'] as unknown[] : []).map(rowOf).filter((r): r is ShelfReturnRow => r !== null);
      const sup = await http.get('/v1/purchase/suppliers');
      const list = sup.result === 'ok' && isRec(sup.body) && Array.isArray(sup.body['suppliers']) ? sup.body['suppliers'] as unknown[] : [];
      const suppliers = list.filter(isRec).filter((s) => str(s['supplierId']) !== '' && (s['status'] === undefined || s['status'] === 'active'))
        .map((s) => ({ supplierId: str(s['supplierId']), name: str(s['name']) || str(s['supplierId']) }));
      return { rows, suppliers };
    },
    /** One press of "Return to supplier". */
    async send(form: ShelfReturnForm): Promise<ShelfReturnOutcome> {
      if (!may) return { kind: 'not_permitted' };
      const body = shelfReturnBody(form);
      if (body === null) return { kind: 'invalid' };
      const id = idFor(body);
      const got = await http.post(`/v1/inventory/shelf-returns/${encodeURIComponent(id.returnId)}`, { ...body, ...(id.approvalId === undefined ? {} : { approvalId: id.approvalId }) });
      if (got.result === 'lost_link') return { kind: 'lost_link' };
      if (got.result === 'refused') return got.code === 'shelf_return_needs_approval' ? { kind: 'needs_approval', whatHappened: got.whatHappened } : { kind: 'refused', whatHappened: refusal(got) };
      const row = rowOf(isRec(got.body) ? got.body['shelfReturn'] : null);
      current = null;
      return row === null ? { kind: 'refused', whatHappened: 'unreadable answer' } : { kind: 'returned', row };
    },
    /** "Ask for approval": the request for exactly this return, at head office's own value of it. */
    async askApproval(form: ShelfReturnForm, summary: string): Promise<ShelfReturnOutcome> {
      if (!may) return { kind: 'not_permitted' };
      const body = shelfReturnBody(form);
      if (body === null) return { kind: 'invalid' };
      const id = idFor(body);
      let valueMinor = typeof body['valueMinor'] === 'number' ? body['valueMinor'] as number : null;
      if (valueMinor === null) {
        const v = await http.get(`/v1/inventory/write-off-value?productId=${encodeURIComponent(String(body['productId']))}&locationId=${encodeURIComponent(String(body['locationId']))}&qty=${String(body['qty'])}&uom=${encodeURIComponent(String(body['uom']))}`);
        if (v.result === 'lost_link') return { kind: 'lost_link' };
        if (v.result === 'refused') return { kind: 'not_asked', whatHappened: refusal(v) };
        valueMinor = isRec(v.body) && typeof v.body['valueMinor'] === 'number' ? v.body['valueMinor'] : null;
      }
      const asked = await http.post('/v1/approvals/requests', {
        kind: 'stock_write_off', subjectRef: id.returnId, details: { ...body, returnId: id.returnId }, valueMinor,
        summary: `${summary}${valueMinor === null ? '' : ` (${rupees(valueMinor)})`}`, reason: String(body['note'] ?? body['reason']),
      });
      if (asked.result === 'lost_link') return { kind: 'lost_link' };
      if (asked.result === 'refused') return { kind: 'not_asked', whatHappened: refusal(asked) };
      const requestId = isRec(asked.body) ? str(asked.body['requestId']) : '';
      if (requestId !== '') id.approvalId = requestId;
      return { kind: 'asked' };
    },
    outcomeWords(lang: Lang, o: ShelfReturnOutcome): string {
      const w = (k: ShelfReturnWord): string => words(lang, k);
      switch (o.kind) {
        case 'returned': return `${w('done')}: ${o.row.documentNumber} · ${w('debitNote')} ${o.row.debitNoteNumber} · ${rupees(o.row.valueMinor)}. ${w('gstNote')}`;
        case 'needs_approval': return `${o.whatHappened} ${w('askFirst')}`;
        case 'asked': return w('asked');
        case 'invalid': return w('fillAll');
        case 'not_permitted': return viewer === undefined ? w('nobody') : w('cannot');
        case 'refused': return `${w('refused')} ${o.whatHappened}`;
        case 'not_asked': return `${w('notAsked')} ${o.whatHappened}`;
        case 'lost_link': return w('lost');
      }
    },
  };
}

export type ShelfReturnSession = ReturnType<typeof createShelfReturnSession>;
