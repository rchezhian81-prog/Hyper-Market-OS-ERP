// CORRECT A SAVED GOODS RECEIPT — the page model behind the "Correct a saved receipt" box on Goods receipt review (R2 · batch
// 18c · M07-FR-01/03 · M08-FR-01 · hard rules #2, #10 · OB-873).
//
// The person types the receipt's number (GRN1/26-27/00001, or its older number), sees each line as it was saved and as it
// stands after any correction, picks the line, types the right quantity and why. "Save correction" sends ONE
// `POST /v1/inventory/goods-receipt/:grnId/corrections/:correctionId`; head office answers that a second person must
// approve it first, so "Ask for approval" sends the request for exactly this correction; once another person approves it,
// the same press saves it. The correction id is kept for the form, so a press after the approval is the same correction.
// A bill already matched against the old quantity comes back as a visible exception (debit note / re-match) — shown as said.
// Holds no rule of its own; DOM-free and tested.

import type { HeadOfficeHttp, HttpAnswer } from './head-office-http';
import { rupees } from './head-office-http';

type Lang = 'en' | 'ta';

export const RECEIPT_CORRECTION_WORDS = Object.freeze({
  en: {
    heading: 'Correct a saved receipt', lede: 'A wrong quantity keyed on a saved receipt is corrected by a correction of its own — the receipt keeps its number and its lines. Stock, the order and the bill match follow the correction. A second person approves it.',
    receipt: 'Receipt number', open: 'Show the receipt', line: 'Line', right: 'The right quantity', why: 'What was keyed wrong (required)',
    save: 'Save correction', ask: 'Ask for approval', saved: 'Saved', asked: 'Asked — once another person approves it on Approvals, press "Save correction" again.',
    notFound: 'No receipt with that number is on file.', fill: 'Choose the line, type the right quantity (a whole number) and why.',
    refused: 'Head office did not save it:', notAsked: 'The approval was not asked:', lost: 'Head office could not be reached, so nothing was changed.',
    askFirst: 'Press "Ask for approval".', cannot: 'Your role does not correct receipts.', received: 'saved as', now: 'now',
    corrections: 'Corrections of this receipt', none: 'This receipt has not been corrected.', by: 'asked by', approved: 'approved by',
    exception: 'Needs a person:',
  },
  ta: {
    heading: 'சேமித்த வரவைத் திருத்து', lede: 'சேமித்த வரவில் தவறாகப் பதிந்த அளவு தனித் திருத்தத்தால் சரிசெய்யப்படும் — வரவு அதன் எண்ணையும் வரிகளையும் வைத்திருக்கும். இருப்பு, ஆணை, பில் ஒப்பீடு திருத்தத்தைப் பின்பற்றும். இரண்டாவது நபர் ஒப்புக்கொள்வார்.',
    receipt: 'வரவு எண்', open: 'வரவைக் காட்டு', line: 'வரி', right: 'சரியான அளவு', why: 'என்ன தவறாகப் பதிந்தது (கட்டாயம்)',
    save: 'திருத்தத்தைச் சேமி', ask: 'ஒப்புதல் கேள்', saved: 'சேமிக்கப்பட்டது', asked: 'கேட்கப்பட்டது — மற்றொருவர் ஒப்புதல்கள் பக்கத்தில் ஒப்புக்கொண்டதும், மீண்டும் "திருத்தத்தைச் சேமி" அழுத்தவும்.',
    notFound: 'அந்த எண்ணுடன் எந்த வரவும் பதிவில் இல்லை.', fill: 'வரியைத் தேர்ந்தெடுத்து, சரியான அளவையும் (முழு எண்) காரணத்தையும் எழுதுங்கள்.',
    refused: 'தலைமை அலுவலகம் சேமிக்கவில்லை:', notAsked: 'ஒப்புதல் கேட்கப்படவில்லை:', lost: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எதுவும் மாறவில்லை.',
    askFirst: '"ஒப்புதல் கேள்" அழுத்தவும்.', cannot: 'உங்கள் பங்கு வரவுகளைத் திருத்துவதில்லை.', received: 'சேமித்தது', now: 'இப்போது',
    corrections: 'இந்த வரவின் திருத்தங்கள்', none: 'இந்த வரவு திருத்தப்படவில்லை.', by: 'கேட்டவர்', approved: 'ஒப்புக்கொண்டவர்',
    exception: 'ஒருவர் கவனிக்க வேண்டும்:',
  },
} as const);

export type ReceiptCorrectionWord = keyof typeof RECEIPT_CORRECTION_WORDS.en;

export interface ReceiptLineNow { readonly lineId: string; readonly productId: string; readonly uom: string; readonly receivedMinor: number; readonly nowMinor: number }
export interface CorrectionRow {
  readonly correctionId: string; readonly documentNumber: string; readonly lineId: string; readonly productId: string;
  readonly wasMinor: number; readonly nowMinor: number; readonly deltaMinor: number; readonly valueMinor: number;
  readonly requestedBy: string; readonly approvedBy: string; readonly reason: string; readonly at: string;
  readonly exceptions: readonly string[];
}
export interface ReceiptView { readonly grnId: string; readonly receiptNumber: string; readonly lines: readonly ReceiptLineNow[]; readonly corrections: readonly CorrectionRow[] }

export type CorrectionOutcome =
  | { readonly kind: 'saved'; readonly row: CorrectionRow }
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

export function correctionRowOf(raw: unknown): CorrectionRow | null {
  if (!isRec(raw) || str(raw['correctionId']) === '') return null;
  const ex = Array.isArray(raw['billExceptions']) ? (raw['billExceptions'] as unknown[]).filter(isRec).map((x) => str(x['says'])).filter((s) => s !== '') : [];
  return {
    correctionId: str(raw['correctionId']), documentNumber: str(raw['documentNumber']) || str(raw['correctionId']), lineId: str(raw['lineId']), productId: str(raw['productId']),
    wasMinor: num(raw['wasMinor']), nowMinor: num(raw['nowMinor']), deltaMinor: num(raw['deltaMinor']), valueMinor: num(raw['valueMinor']),
    requestedBy: str(raw['requestedBy']), approvedBy: str(raw['approvedBy']), reason: str(raw['reason']), at: str(raw['at']), exceptions: ex,
  };
}

const newId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return `grc-${c?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`}`;
};

export function createReceiptCorrectionSession(viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined, http: HeadOfficeHttp, makeId: () => string = newId) {
  const may = viewer !== undefined && viewer.permissions.includes('inventory.movement.append');
  let current: { readonly key: string; readonly correctionId: string; approvalId?: string } | null = null;
  const idFor = (key: string) => { if (current === null || current.key !== key) current = { key, correctionId: makeId() }; return current; };
  const words = (lang: Lang, k: ReceiptCorrectionWord): string => (RECEIPT_CORRECTION_WORDS[lang] ?? RECEIPT_CORRECTION_WORDS.en)[k];
  const refusal = (a: HttpAnswer): string => (a.result === 'refused' ? a.whatHappened || a.code : '');
  const bodyOf = (form: { readonly lineId: string; readonly right: string; readonly why: string }): Record<string, unknown> | null => {
    const q = Number(form.right);
    if (form.lineId.trim() === '' || form.right.trim() === '' || !Number.isSafeInteger(q) || q < 0 || form.why.trim() === '') return null;
    return { lineId: form.lineId.trim(), correctQuantityMinor: q, reason: form.why.trim() };
  };
  return {
    may, words,
    /** The receipt by its number (or id): each line as saved and as it stands, and every correction. */
    async open(ref: string): Promise<ReceiptView | 'not_found' | 'lost_link'> {
      const want = ref.trim();
      if (want === '') return 'not_found';
      const list = await http.get('/v1/inventory/goods-receipt');
      if (list.result === 'lost_link') return 'lost_link';
      const receipts = list.result === 'ok' && isRec(list.body) && Array.isArray(list.body['receipts']) ? (list.body['receipts'] as unknown[]).filter(isRec) : [];
      const hit = receipts.find((r) => [str(r['grnId']), str(r['documentNumber']), str(r['number'])].includes(want));
      if (hit === undefined) return 'not_found';
      const got = await http.get(`/v1/inventory/goods-receipt/${encodeURIComponent(str(hit['grnId']))}/corrections`);
      if (got.result === 'lost_link') return 'lost_link';
      if (got.result !== 'ok' || !isRec(got.body)) return 'not_found';
      const b = got.body;
      return {
        grnId: str(b['grnId']), receiptNumber: str(b['receiptNumber']),
        lines: (Array.isArray(b['lines']) ? b['lines'] as unknown[] : []).filter(isRec).map((l) => ({ lineId: str(l['lineId']), productId: str(l['productId']), uom: str(l['uom']) || 'ea', receivedMinor: num(l['receivedMinor']), nowMinor: num(l['nowMinor']) })),
        corrections: (Array.isArray(b['corrections']) ? b['corrections'] as unknown[] : []).map(correctionRowOf).filter((r): r is CorrectionRow => r !== null),
      };
    },
    async save(grnId: string, form: { readonly lineId: string; readonly right: string; readonly why: string }): Promise<CorrectionOutcome> {
      if (!may) return { kind: 'not_permitted' };
      const body = bodyOf(form);
      if (body === null || grnId === '') return { kind: 'invalid' };
      const id = idFor(JSON.stringify([grnId, body]));
      const got = await http.post(`/v1/inventory/goods-receipt/${encodeURIComponent(grnId)}/corrections/${encodeURIComponent(id.correctionId)}`, { ...body, ...(id.approvalId === undefined ? {} : { approvalId: id.approvalId }) });
      if (got.result === 'lost_link') return { kind: 'lost_link' };
      if (got.result === 'refused') return got.code === 'correction_needs_approval' ? { kind: 'needs_approval', whatHappened: got.whatHappened } : { kind: 'refused', whatHappened: refusal(got) };
      const row = correctionRowOf(isRec(got.body) ? got.body['correction'] : null);
      current = null;
      return row === null ? { kind: 'refused', whatHappened: 'unreadable answer' } : { kind: 'saved', row };
    },
    /** "Ask for approval": the request for exactly this correction (its line, quantity and reason — head office values it). */
    async askApproval(grnId: string, form: { readonly lineId: string; readonly right: string; readonly why: string }, summary: string): Promise<CorrectionOutcome> {
      const valueMinor = null;
      if (!may) return { kind: 'not_permitted' };
      const body = bodyOf(form);
      if (body === null || grnId === '') return { kind: 'invalid' };
      const id = idFor(JSON.stringify([grnId, body]));
      const asked = await http.post('/v1/approvals/requests', {
        kind: 'goods_receipt_correction', subjectRef: id.correctionId, details: { ...body, grnId, correctionId: id.correctionId }, valueMinor, summary, reason: String(body['reason']),
      });
      if (asked.result === 'lost_link') return { kind: 'lost_link' };
      if (asked.result === 'refused') return { kind: 'not_asked', whatHappened: refusal(asked) };
      const requestId = isRec(asked.body) ? str(asked.body['requestId']) : '';
      if (requestId !== '') id.approvalId = requestId;
      return { kind: 'asked' };
    },
    outcomeWords(lang: Lang, o: CorrectionOutcome): string {
      const w = (k: ReceiptCorrectionWord): string => words(lang, k);
      switch (o.kind) {
        case 'saved': return `${w('saved')}: ${o.row.documentNumber} · ${o.row.wasMinor} → ${o.row.nowMinor} · ${rupees(o.row.valueMinor)}${o.row.exceptions.length === 0 ? '' : ` · ${w('exception')} ${o.row.exceptions.join(' ')}`}`;
        case 'needs_approval': return `${o.whatHappened} ${w('askFirst')}`;
        case 'asked': return w('asked');
        case 'invalid': return w('fill');
        case 'not_permitted': return w('cannot');
        case 'refused': return `${w('refused')} ${o.whatHappened}`;
        case 'not_asked': return `${w('notAsked')} ${o.whatHappened}`;
        case 'lost_link': return w('lost');
      }
    },
  };
}

export type ReceiptCorrectionSession = ReturnType<typeof createReceiptCorrectionSession>;
