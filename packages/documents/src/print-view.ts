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

import { quantityLabel } from '../../contracts/src/quantity';

export type PrintKind = 'purchase_order' | 'goods_receipt' | 'supplier_statement';
export const PRINT_KINDS: readonly PrintKind[] = Object.freeze(['purchase_order', 'goods_receipt', 'supplier_statement']);

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
    printedAt: 'Read from head office at {t}', copyNote: 'Printed from the copy kept on this computer (read from head office at {t}). Head office could not be reached just now.',
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
    printedAt: 'தலைமை அலுவலகத்திலிருந்து படித்த நேரம் {t}', copyNote: 'இந்தக் கணினியில் வைத்திருந்த நகலிலிருந்து அச்சிடப்பட்டது (தலைமை அலுவலகத்திலிருந்து படித்த நேரம் {t}). இப்போது தலைமை அலுவலகத்தை அடைய முடியவில்லை.',
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
  const lines = view.lines.map((l, i) => {
    const qty = quantityLabel(l.quantityMinor, l.uom);
    const unit = l.uom === 'ea' ? '' : ` ${w('per')} ${l.ratePer > 1 ? `${l.ratePer} ` : ''}${l.uom}`;
    const rate = l.rateMinor === null ? w('notOnRecord') : `${rupeesText(l.rateMinor)}${l.ratePer > 1 && l.uom === 'ea' ? ` / ${l.ratePer}` : ''}${unit}`;
    const gst = l.gstRateBps === null ? w('unknownGst') : `${(l.gstRateBps / 100).toFixed(l.gstRateBps % 100 === 0 ? 0 : 2)}%`;
    return [String(i + 1), l.name === null || l.name.trim() === '' ? `${l.productId}` : `${l.name} (${l.productId})`, known(l.hsn), qty, rate, gst, l.valueMinor === null ? w('notOnRecord') : rupeesText(l.valueMinor)];
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
      : [w('sigAccounts'), w('sigApproved'), w('sigConfirmed')];
  return {
    title: w(view.kind),
    kind: view.kind,
    head: [
      { label: w('number'), value: view.documentNumber ?? (isStatement ? w('notNumbered') : w('notOnRecord')) },
      { label: w('date'), value: known(shopDateText(view.date)) },
    ],
    parties: [party(w('from'), view.shop), party(w(view.kind === 'purchase_order' ? 'to' : 'supplierOf'), view.supplier)],
    facts: view.facts.map((f) => ({ label: w(f.key), value: f.key === 'asAt' ? (shopDateText(f.value) ?? f.value) : f.value })),
    table: isStatement && view.lines.length === 0
      ? { head: [], end: [], rows: [], empty: '' }
      : { head: [w('colN'), w('colItem'), w('colHsn'), w('colQty'), w('colRate'), w('colGst'), w('colValue')], end: [false, false, false, true, true, true, true], rows: lines, empty: w('noLines') },
    totals,
    notes: isStatement ? [] : [w('gstNote')],
    signatures,
  };
}
