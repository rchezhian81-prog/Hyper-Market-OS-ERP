// Batch 18b · R1 / P1 / B2 — the PRINT VIEW of a business document (M31-FR-02 · WF-03 · M07-FR-01).
//
// Head office already issues a purchase order, a goods receipt and a supplier's statement as documents (`resolveSource` in
// services/api/src/document-sources.ts reads each from its own register). What was missing was a page a person can hold:
// a purchase order to hand to the supplier, a GRN for the file. This module is the ONE shape of that page:
//
//   • `PrintView` — the facts head office reads for the document (`GET /v1/documents/print/...`): the shop's name and GSTIN,
//     the supplier's name and GSTIN, the document's own number (format A — `PO/26-27/00001`, `GRN1/26-27/00001`), its date,
//     every line with the item's name, quantity, rate and GST rate, and the total. A fact head office does not hold is
//     `null` and is PRINTED as "Not on record" — never left blank, never guessed.
//   • `printLayout(view, lang)` — the words a person reads on the A4 page, in English or Tamil: the title, the parties,
//     the table (one row per line), the totals, the notes, the signature lines. The browser only draws this plan, then
//     uses the browser's own Print / Save as PDF (no PDF library).
//
// GST: an order and a receipt are valued at their buying rate as recorded; the page shows each item's GST RATE from the
// product master and does not work out a GST amount — whether the buying rate includes GST is the supplier bill's to say
// (open question for the owner, batch 18b). Pure and tested: tests/unit/batch18b-print-view.test.ts.
//
// Pending list 27 Nov, item 5: a RETURN TO SUPPLIER (`supplier_return`, the shelf return of batch 18c) prints on the same
// page: its RTS number, the SDN debit note, the batch and its expiry, why, who returned and approved it, the e-way bill
// when one applies, and where the debit note stands (OB-874 C / OB-879). Valued at the stock's own cost before GST; GST
// RATES only, as on the PO and GRN (OB-876 A). Tested: tests/unit/pending05-the-return-to-supplier-note.test.ts.

import { quantityLabel } from '../../contracts/src/quantity';

export type PrintKind = 'purchase_order' | 'goods_receipt' | 'supplier_statement' | 'supplier_return';
export const PRINT_KINDS: readonly PrintKind[] = Object.freeze(['purchase_order', 'goods_receipt', 'supplier_statement', 'supplier_return']);

/** A party on the page: the shop, or the supplier. `null` = head office holds no such fact (printed as "Not on record"). */
export interface PrintParty {
  readonly id?: string;
  readonly name: string | null;
  /** The legal name on the GST registration, when it differs from the trading name. */
  readonly legalName?: string | null;
  readonly gstin: string | null;
  readonly address: readonly string[];
}

/** One line: what, how much (in its own unit's smallest steps, OB-31), at what rate, the item's GST rate, the value. */
export interface PrintLineView {
  readonly productId: string;
  readonly name: string | null;
  readonly hsn: string | null;
  readonly quantityMinor: number;
  readonly uom: string;
  /** The buying rate per `ratePer` whole units, in paise; `null` when the cost is not known yet (OB-509: waits for the bill). */
  readonly rateMinor: number | null;
  readonly ratePer: number;
  /** The item's GST rate on the product master, in basis points (500 = 5%); `null` when the master has none. */
  readonly gstRateBps: number | null;
  readonly valueMinor: number | null;
  /** Pending 5: a return's batch (`null` = none named) and that batch's expiry (`null` = none on record). Other documents omit both. */
  readonly batchId?: string | null;
  readonly expiry?: string | null;
}

/** A fact under the title (the order a receipt was against, who received it, where it goes…). */
export type PrintFactKey = 'purchaseOrder' | 'reference' | 'deliverTo' | 'receivedBy' | 'approvedBy' | 'warehouse' | 'asAt';
export interface PrintFact { readonly key: PrintFactKey; readonly value: string }

export interface PrintStatementAmounts {
  readonly invoicedMinor: number;
  readonly debitNotesMinor: number;
  readonly paidMinor: number;
  readonly withheldMinor: number;
  readonly owedMinor: number;
}

/**
 * Pending 5: what a return to the supplier says beyond its lines — every fact read from the return's own record, the
 * supplier's acceptance (OB-879) and nothing else.
 */
export interface PrintSupplierReturn {
  /** The supplier's debit note (`SDN/26-27/00001`), issued in the same save as the return; `null` if none on record. */
  readonly debitNoteNumber: string | null;
  readonly reason: string;
  readonly note: string | null;
  /** The place the stock left from. */
  readonly returnedFrom: string;
  readonly raisedBy: string;
  /** The second person who approved it — `null` when none was needed. */
  readonly approvedBy: string | null;
  /** The e-way bill the goods left under — `null` when none applies (at or below the limit). */
  readonly ewbNo: string | null;
  /** `cost_unknown`: head office held no cost; the value is what the person typed (a second person approved it). */
  readonly valueSource: 'stock_cost' | 'cost_unknown';
  /** OB-879: the supplier's acceptance of the debit note, as the accountant recorded it; `null` while waiting. */
  readonly acceptance: null | {
    readonly creditNoteNo: string; readonly creditNoteDate: string; readonly acceptedMinor: number; readonly differenceMinor: number;
    readonly reason: string | null;
    /** OB-881 B: the GST the supplier's credit note showed, if the accountant typed it. */
    readonly gst: { readonly cgstMinor: number; readonly sgstMinor: number; readonly igstMinor: number } | null;
  };
}

export interface PrintView {
  readonly kind: PrintKind;
  /** The document's own number (format A), or `null` when it has none (a statement is numbered only when issued). */
  readonly documentNumber: string | null;
  /** The document's date as the shop reckons it (YYYY-MM-DD), or `null` when the record carries none. */
  readonly date: string | null;
  readonly shop: PrintParty;
  readonly supplier: PrintParty;
  readonly facts: readonly PrintFact[];
  readonly lines: readonly PrintLineView[];
  readonly totalMinor: number | null;
  readonly currency: string;
  readonly statement?: PrintStatementAmounts;
  /** Batch 20e · R6 (M07-FR-04): a goods receipt's photos and scans kept with it (and how many were marked attached by mistake). */
  readonly attachments?: { readonly kept: number; readonly mistaken: number };
  /** Pending 5: a return to the supplier's own facts. */
  readonly supplierReturn?: PrintSupplierReturn;
  /** When head office read it (ISO). */
  readonly readAt: string;
}

export type PrintLang = 'en' | 'ta';

const WORDS = {
  en: {
    purchase_order: 'Purchase order', goods_receipt: 'Goods receipt note (GRN)', supplier_statement: 'Supplier statement of account',
    number: 'Number', date: 'Date', notOnRecord: 'Not on record', notNumbered: 'Not numbered (a statement is numbered when head office issues it)',
    from: 'From (the shop)', to: 'To (the supplier)', supplierOf: 'Supplier', gstin: 'GSTIN',
    purchaseOrder: 'Against purchase order', reference: 'Delivery reference', deliverTo: 'Deliver to', receivedBy: 'Received by', approvedBy: 'Approved by', warehouse: 'Received at', asAt: 'As at',
    colN: 'No.', colItem: 'Item', colHsn: 'HSN', colQty: 'Quantity', colRate: 'Rate (₹)', colGst: 'GST rate', colValue: 'Value (₹)',
    per: 'per', total: 'Total value at these rates', noLines: 'No lines on this document.',
    invoiced: 'Billed by the supplier', debitNotes: 'Less debit notes', paid: 'Less paid', withheld: 'Held back (not yet due)', owed: 'Owed to the supplier',
    gstNote: 'GST rates are each item\'s rate on the product master. GST amounts are stated on the supplier\'s tax invoice.',
    unknownGst: 'Not on record',
    sigPrepared: 'Prepared by', sigApproved: 'Approved by', sigSupplier: 'Supplier\'s acknowledgement', sigReceived: 'Received by (store)', sigChecked: 'Checked by', sigDelivered: 'Delivered by (supplier)', sigAccounts: 'Accounts', sigConfirmed: 'Supplier\'s confirmation',
    attachments: '{n} attachments (photos and scans) are kept with this receipt — see Goods receipt review.', attachmentOne: '1 attachment (a photo or scan) is kept with this receipt — see Goods receipt review.',
    attachmentsNone: 'No photo or scan is kept with this receipt.', attachmentsMistaken: '{n} more marked attached by mistake (kept).',
    printedAt: 'Read from head office at {t}', copyNote: 'Printed from the copy kept on this computer (read from head office at {t}). Head office could not be reached just now.',
    supplier_return: 'Return to supplier', debitNote: 'Debit note', returnedFrom: 'Returned from', why: 'Why it goes back', returnedBy: 'Returned by',
    approvedBySecond: 'Approved by (second person)', ewayBill: 'E-way bill', status: 'Status', colBatch: 'Batch / expiry',
    expired: 'Expired', near_expiry: 'Near expiry', damaged: 'Damaged', noBatch: 'No batch named', expires: 'expires {d}', expiryUnknown: 'expiry not on record',
    waiting: 'Waiting for the supplier to accept — the debit note is not taken off what is owed yet',
    accepted: 'Supplier accepted, credit note {n} dated {d} — {a} taken off what is owed', notAccepted: '{a} not accepted', creditGst: 'GST on the supplier\'s credit note {a}',
    rtsNote: 'Values are at the stock\'s own buying cost, before GST. GST rates are each item\'s rate on the product master; GST amounts are on the debit note.',
    rtsTyped: 'Head office held no cost for this stock: the value was typed by the person who returned it, and a second person approved it.',
    sigHandedOver: 'Handed over by (store)', sigDriver: 'Received by (supplier\'s driver)',
  },
  ta: {
    purchase_order: 'கொள்முதல் ஆணை', goods_receipt: 'சரக்கு பெறுதல் குறிப்பு (GRN)', supplier_statement: 'விநியோகஸ்தர் கணக்கு அறிக்கை',
    number: 'எண்', date: 'தேதி', notOnRecord: 'பதிவில் இல்லை', notNumbered: 'எண் இல்லை (தலைமை அலுவலகம் வெளியிடும்போது அறிக்கைக்கு எண் தரப்படும்)',
    from: 'அனுப்புபவர் (கடை)', to: 'பெறுபவர் (விநியோகஸ்தர்)', supplierOf: 'விநியோகஸ்தர்', gstin: 'GSTIN',
    purchaseOrder: 'கொள்முதல் ஆணை', reference: 'டெலிவரி குறிப்பு', deliverTo: 'அனுப்ப வேண்டிய இடம்', receivedBy: 'பெற்றவர்', approvedBy: 'அனுமதித்தவர்', warehouse: 'பெற்ற இடம்', asAt: 'இந்தத் தேதியில்',
    colN: 'எண்', colItem: 'பொருள்', colHsn: 'HSN', colQty: 'அளவு', colRate: 'விலை (₹)', colGst: 'GST விகிதம்', colValue: 'மதிப்பு (₹)',
    per: 'ஒவ்வொரு', total: 'இந்த விலைகளில் மொத்த மதிப்பு', noLines: 'இந்த ஆவணத்தில் வரிகள் இல்லை.',
    invoiced: 'விநியோகஸ்தர் பில் செய்தது', debitNotes: 'கழிவு: பற்றுக் குறிப்புகள்', paid: 'கழிவு: செலுத்தியது', withheld: 'நிறுத்தி வைத்தது (இன்னும் கொடுக்க வேண்டியதில்லை)', owed: 'விநியோகஸ்தருக்குக் கொடுக்க வேண்டியது',
    gstNote: 'GST விகிதம் ஒவ்வொரு பொருளுக்கும் பொருள் பதிவேட்டில் உள்ளது. GST தொகை விநியோகஸ்தரின் வரி விலைப்பட்டியலில் இருக்கும்.',
    unknownGst: 'பதிவில் இல்லை',
    sigPrepared: 'தயாரித்தவர்', sigApproved: 'அனுமதித்தவர்', sigSupplier: 'விநியோகஸ்தர் ஒப்புகை', sigReceived: 'பெற்றவர் (கடை)', sigChecked: 'சரிபார்த்தவர்', sigDelivered: 'கொடுத்தவர் (விநியோகஸ்தர்)', sigAccounts: 'கணக்குப் பிரிவு', sigConfirmed: 'விநியோகஸ்தர் உறுதிப்படுத்தல்',
    attachments: 'இந்தப் பெறுதலுடன் {n} இணைப்புகள் (புகைப்படங்கள், ஸ்கேன்கள்) வைக்கப்பட்டுள்ளன — சரக்கு பெறுதல் மதிப்பாய்வில் பார்க்கவும்.', attachmentOne: 'இந்தப் பெறுதலுடன் 1 இணைப்பு (புகைப்படம் அல்லது ஸ்கேன்) வைக்கப்பட்டுள்ளது — சரக்கு பெறுதல் மதிப்பாய்வில் பார்க்கவும்.',
    attachmentsNone: 'இந்தப் பெறுதலுடன் புகைப்படமோ ஸ்கேனோ இல்லை.', attachmentsMistaken: 'மேலும் {n} தவறாக இணைக்கப்பட்டது எனக் குறிக்கப்பட்டது (வைக்கப்பட்டுள்ளது).',
    printedAt: 'தலைமை அலுவலகத்திலிருந்து படித்த நேரம் {t}', copyNote: 'இந்தக் கணினியில் வைத்திருந்த நகலிலிருந்து அச்சிடப்பட்டது (தலைமை அலுவலகத்திலிருந்து படித்த நேரம் {t}). இப்போது தலைமை அலுவலகத்தை அடைய முடியவில்லை.',
    supplier_return: 'விநியோகஸ்தருக்குத் திருப்பும் குறிப்பு', debitNote: 'பற்றுக் குறிப்பு', returnedFrom: 'திருப்பிய இடம்', why: 'ஏன் திருப்புகிறது', returnedBy: 'திருப்பியவர்',
    approvedBySecond: 'அனுமதித்தவர் (இரண்டாவது நபர்)', ewayBill: 'இ-வே பில்', status: 'நிலை', colBatch: 'தொகுதி / காலாவதி',
    expired: 'காலாவதியானது', near_expiry: 'காலாவதி நெருங்கியது', damaged: 'சேதமானது', noBatch: 'தொகுதி குறிப்பிடப்படவில்லை', expires: 'காலாவதி {d}', expiryUnknown: 'காலாவதி பதிவில் இல்லை',
    waiting: 'விநியோகஸ்தர் ஏற்கக் காத்திருக்கிறது — பற்றுக் குறிப்பு இன்னும் கொடுக்க வேண்டியதிலிருந்து கழிக்கப்படவில்லை',
    accepted: 'விநியோகஸ்தர் ஏற்றார், வரவுக் குறிப்பு {n}, தேதி {d} — {a} கொடுக்க வேண்டியதிலிருந்து கழிக்கப்பட்டது', notAccepted: '{a} ஏற்கப்படவில்லை', creditGst: 'விநியோகஸ்தரின் வரவுக் குறிப்பில் GST {a}',
    rtsNote: 'மதிப்புகள் இருப்பின் சொந்த கொள்முதல் விலையில், GST-க்கு முன். GST விகிதம் ஒவ்வொரு பொருளுக்கும் பொருள் பதிவேட்டில் உள்ளது; GST தொகை பற்றுக் குறிப்பில் இருக்கும்.',
    rtsTyped: 'இந்த இருப்புக்குத் தலைமை அலுவலகத்திடம் விலை இல்லை: மதிப்பைத் திருப்பியவர் தட்டச்சு செய்தார், இரண்டாவது நபர் அனுமதித்தார்.',
    sigHandedOver: 'ஒப்படைத்தவர் (கடை)', sigDriver: 'பெற்றவர் (விநியோகஸ்தரின் ஓட்டுநர்)',
  },
} as const;

type WordKey = keyof typeof WORDS.en;
export function printWord(lang: PrintLang, key: WordKey): string { return WORDS[lang][key] ?? WORDS.en[key]; }

/** ₹ in the Indian grouping, two decimals, a minus sign in front: 123450 → "1,234.50". */
export function rupeesText(minor: number): string {
  const sign = minor < 0 ? '−' : '';
  return `${sign}${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 2026-11-19 → "19/11/2026" (the shop's own way of writing a date); anything else is returned as it is. */
export function shopDateText(day: string | null): string | null {
  if (day === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  return m === null ? day : `${m[3]}/${m[2]}/${m[1]}`;
}

/** The plan the browser draws on the A4 page. Every string is already in the reader's language. */
export interface PrintLayout {
  readonly title: string;
  readonly kind: PrintKind;
  readonly head: readonly { readonly label: string; readonly value: string }[];
  readonly parties: readonly { readonly heading: string; readonly name: string; readonly lines: readonly string[] }[];
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly table: { readonly head: readonly string[]; readonly end: readonly boolean[]; readonly rows: readonly (readonly string[])[]; readonly empty: string };
  readonly totals: readonly { readonly label: string; readonly value: string; readonly strong?: boolean }[];
  readonly notes: readonly string[];
  readonly signatures: readonly string[];
}

/** Batch 20e · R6: on a printed GRN, how many photos and scans are kept with it (none said too, so the paper is never silent). */
function attachmentNote(view: PrintView, w: (k: WordKey) => string): string[] {
  if (view.kind !== 'goods_receipt' || view.attachments === undefined) return [];
  const { kept, mistaken } = view.attachments;
  const head = kept === 0 ? w('attachmentsNone') : kept === 1 ? w('attachmentOne') : w('attachments').replace('{n}', String(kept));
  return [mistaken > 0 ? `${head} ${w('attachmentsMistaken').replace('{n}', String(mistaken))}` : head];
}

/** Pending 5: the facts under a return's title — the debit note, from where, why, who, the approval, the e-way bill, its status. */
function returnFacts(r: PrintSupplierReturn, w: (k: WordKey) => string, known: (v: string | null | undefined) => string): { label: string; value: string }[] {
  const reasonWord = r.reason === 'expired' || r.reason === 'near_expiry' || r.reason === 'damaged' ? w(r.reason) : known(r.reason);
  const a = r.acceptance;
  let status = w('waiting');
  if (a !== null) {
    status = w('accepted').replace('{n}', a.creditNoteNo).replace('{d}', shopDateText(a.creditNoteDate) ?? a.creditNoteDate).replace('{a}', `₹${rupeesText(a.acceptedMinor)}`);
    if (a.differenceMinor > 0) status += `; ${w('notAccepted').replace('{a}', `₹${rupeesText(a.differenceMinor)}`)}${a.reason === null || a.reason === '' ? '' : ` (${a.reason})`}`;
    const gst = a.gst === null ? 0 : a.gst.cgstMinor + a.gst.sgstMinor + a.gst.igstMinor;
    if (gst > 0) status += `; ${w('creditGst').replace('{a}', `₹${rupeesText(gst)}`)}`;
  }
  return [
    { label: w('debitNote'), value: known(r.debitNoteNumber) },
    { label: w('returnedFrom'), value: known(r.returnedFrom) },
    { label: w('why'), value: r.note === null || r.note.trim() === '' ? reasonWord : `${reasonWord} — ${r.note}` },
    { label: w('returnedBy'), value: known(r.raisedBy) },
    ...(r.approvedBy === null ? [] : [{ label: w('approvedBySecond'), value: r.approvedBy }]),
    ...(r.ewbNo === null ? [] : [{ label: w('ewayBill'), value: r.ewbNo }]),
    { label: w('status'), value: status },
  ];
}

/** The A4 page's words for a document, in English or Tamil. Nothing is invented: a missing fact reads "Not on record". */
export function printLayout(view: PrintView, lang: PrintLang): PrintLayout {
  const w = (k: WordKey): string => printWord(lang, k);
  const known = (v: string | null | undefined): string => (v === null || v === undefined || v.trim() === '' ? w('notOnRecord') : v);
  const party = (heading: string, p: PrintParty): { heading: string; name: string; lines: string[] } => ({
    heading,
    name: known(p.name),
    lines: [
      ...(p.legalName !== undefined && p.legalName !== null && p.legalName !== '' && p.legalName !== p.name ? [p.legalName] : []),
      ...p.address.filter((l) => l.trim() !== ''),
      `${w('gstin')}: ${known(p.gstin)}`,
    ],
  });
  const isStatement = view.kind === 'supplier_statement';
  const isReturn = view.kind === 'supplier_return';
  const batchText = (l: PrintLineView): string => {
    if (l.batchId === undefined || l.batchId === null || l.batchId.trim() === '') return w('noBatch');
    const day = l.expiry === undefined || l.expiry === null ? null : shopDateText(l.expiry);
    return `${l.batchId} · ${day === null ? w('expiryUnknown') : w('expires').replace('{d}', day)}`;
  };
  const lines = view.lines.map((l, i) => {
    const qty = quantityLabel(l.quantityMinor, l.uom);
    const unit = l.uom === 'ea' ? '' : ` ${w('per')} ${l.ratePer > 1 ? `${l.ratePer} ` : ''}${l.uom}`;
    const rate = l.rateMinor === null ? w('notOnRecord') : `${rupeesText(l.rateMinor)}${l.ratePer > 1 && l.uom === 'ea' ? ` / ${l.ratePer}` : ''}${unit}`;
    const gst = l.gstRateBps === null ? w('unknownGst') : `${(l.gstRateBps / 100).toFixed(l.gstRateBps % 100 === 0 ? 0 : 2)}%`;
    return [String(i + 1), l.name === null || l.name.trim() === '' ? `${l.productId}` : `${l.name} (${l.productId})`, known(l.hsn), ...(isReturn ? [batchText(l)] : []), qty, rate, gst, l.valueMinor === null ? w('notOnRecord') : rupeesText(l.valueMinor)];
  });
  const totals: { label: string; value: string; strong?: boolean }[] = [];
  if (view.statement !== undefined) {
    const s = view.statement;
    totals.push({ label: w('invoiced'), value: `₹${rupeesText(s.invoicedMinor)}` }, { label: w('debitNotes'), value: `₹${rupeesText(s.debitNotesMinor)}` },
      { label: w('paid'), value: `₹${rupeesText(s.paidMinor)}` }, { label: w('withheld'), value: `₹${rupeesText(s.withheldMinor)}` },
      { label: w('owed'), value: `₹${rupeesText(s.owedMinor)}`, strong: true });
  } else {
    totals.push({ label: w('total'), value: view.totalMinor === null ? w('notOnRecord') : `₹${rupeesText(view.totalMinor)}`, strong: true });
  }
  const signatures = view.kind === 'purchase_order' ? [w('sigPrepared'), w('sigApproved'), w('sigSupplier')]
    : view.kind === 'goods_receipt' ? [w('sigReceived'), w('sigChecked'), w('sigDelivered')]
      : isReturn ? [w('sigHandedOver'), w('sigDriver')]
        : [w('sigAccounts'), w('sigApproved'), w('sigConfirmed')];
  const head = isReturn
    ? [w('colN'), w('colItem'), w('colHsn'), w('colBatch'), w('colQty'), w('colRate'), w('colGst'), w('colValue')]
    : [w('colN'), w('colItem'), w('colHsn'), w('colQty'), w('colRate'), w('colGst'), w('colValue')];
  const end = isReturn ? [false, false, false, false, true, true, true, true] : [false, false, false, true, true, true, true];
  return {
    title: w(view.kind),
    kind: view.kind,
    head: [
      { label: w('number'), value: view.documentNumber ?? (isStatement ? w('notNumbered') : w('notOnRecord')) },
      { label: w('date'), value: known(shopDateText(view.date)) },
    ],
    parties: [party(w('from'), view.shop), party(w(view.kind === 'purchase_order' || isReturn ? 'to' : 'supplierOf'), view.supplier)],
    facts: [
      ...view.facts.map((f) => ({ label: w(f.key), value: f.key === 'asAt' ? (shopDateText(f.value) ?? f.value) : f.value })),
      ...(isReturn && view.supplierReturn !== undefined ? returnFacts(view.supplierReturn, w, known) : []),
    ],
    table: isStatement && view.lines.length === 0
      ? { head: [], end: [], rows: [], empty: '' }
      : { head, end, rows: lines, empty: w('noLines') },
    totals,
    notes: isStatement ? [] : isReturn
      ? [w('rtsNote'), ...(view.supplierReturn?.valueSource === 'cost_unknown' ? [w('rtsTyped')] : [])]
      : [w('gstNote'), ...attachmentNote(view, w)],
    signatures,
  };
}
