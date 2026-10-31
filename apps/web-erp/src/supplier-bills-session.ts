// SUPPLIER BILLS — the capture-and-confirm screen over head office's bill-document register (D03-FR-02 · WF-05
// "Capture/OCR/import → validate → PO-GRN-invoice match → discrepancy" · M07 · P-05 · P-08). Round 12.
//
// The routes were built in round 8 (`services/purchase/src/invoice-ingestion.ts`) and had no screen. This is the screen's
// tested, DOM-free model; `web/supplier-bills.js` only draws what it hands over. It holds NO business rule of its own —
// whether a bill is a duplicate, which lines need a person, whether the lines add up, what the match pays — every one is
// head office's, and a refusal is shown in head office's own words (`error.whatHappened`). What this model does:
//
//   • HAND IN a bill: the file a buyer picked becomes the route's body — a GST e-invoice JSON (`kind: 'e_invoice'`) or a
//     scan / photo / PDF (`kind: 'scan'`). The document id is the file's own fingerprint, so handing the same file in twice
//     is ONE document (the route answers `alreadyReceived`), never two bills.
//   • CONFIRM a read draft: every line mapped to a product by a person; a line head office marked `needsFigures` carries
//     the quantity, price and amount the person typed from the paper (rupees → paise exactly, from the decimal text).
//   • TYPE a scan head office could not read (no OCR engine is connected — an outside party, said): the typed capture
//     route (`/v1/purchase/invoices/:id/capture`), the manual-entry path head office already has. The capture names the
//     scan (`documentId`), so head office itself records "typed as invoice X" on it and lists the scan as `captured` —
//     nothing about it is remembered only on this screen (round 12 follow-up).
//     The freight, duty and other charges the paper prints beside its lines ride as `charges` (M07-FR-04, re-audit 30 Oct
//     2026); an e-invoice's other charges (`OthChrg`) are read by head office itself. Head office adds them to the total,
//     keeps them on the bill and spreads them into the goods' cost at the match — none of that is decided here.
//   • CHECK it against the order: the three-way match head office runs over what IT holds (`/match`), its exceptions
//     shown line by line.
//
//   • MATCH A BILL TO A DELIVERY whose cost is not known (OB-509 · G3): goods received with no order, or not on the order,
//     are booked with their cost NOT KNOWN until the supplier's bill is matched to the receipt. Head office lists those
//     receipts with the bills on its register that could be matched (`GET /v1/inventory/receipts-cost-not-known`); a person
//     picks one and head office matches it (`POST /v1/inventory/goods-receipt/:grnId/bill-match`, `{ invoiceId }` only —
//     never a typed cost). Every refusal (the receiver matching their own delivery, a bill for another order …) is said in
//     plain English and Tamil (`billMatchWords`), with head office's own words beside it.
//
// Nothing here posts money or stock; the match is head office's record. A machine reads; a person commits (P-05).

/** One call to head office under the signed-in person's own session. `'unreachable'` when the link is down (P-08). */
export type HeadOfficeCall = (req: {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}) => Promise<{ readonly status: number; readonly body: unknown } | 'unreachable'>;

/** Head office's answer: what it kept, or why not — in its own words. */
export type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly unreachable: true }
  | { readonly ok: false; readonly unreachable: false; readonly status: number; readonly code: string; readonly whatHappened: string; readonly nextSafeAction: string };

export type BillState = 'draft' | 'awaiting_manual_capture' | 'unreadable' | 'confirmed' | 'captured';

export interface BillLine {
  readonly lineNo: number;
  readonly supplierItemCode: string | null;
  readonly description: string;
  readonly hsn: string | null;
  readonly quantity: number | null;
  readonly uom: string | null;
  readonly unitPriceMinor: number | null;
  readonly lineTotalMinor: number | null;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  readonly confidence: number;
  readonly suggestedProductId: string | null;
  readonly needsFigures: boolean;
}

export interface BillDocument {
  readonly documentId: string;
  readonly channel: 'e_invoice' | 'ocr';
  readonly state: BillState;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly scan?: { readonly sha256: string; readonly mediaType: string; readonly bytes: number };
  readonly supplierId: string | null;
  readonly poId: string | null;
  readonly extracted: {
    readonly supplierGstin: string | null; readonly supplierInvoiceNo: string | null; readonly invoiceDate: string | null;
    readonly irn: string | null; readonly statedTotalMinor: number | null; readonly engine: string;
    /** M07-FR-04: the e-invoice's other charges (`OthChrg`) head office read beside the lines — part of the printed total. */
    readonly otherChargesMinor?: number;
  } | null;
  readonly lines: readonly BillLine[];
  readonly problems: readonly string[];
  readonly confirmedBy?: string;
  readonly confirmedAt?: string;
  readonly invoiceId?: string;
  /** A scan typed on the capture screen (state `captured`): who typed it and when — head office's record. */
  readonly typedBy?: string;
  readonly typedAt?: string;
}

export interface BillRegister {
  readonly documents: readonly BillDocument[];
  readonly waiting: number;
  /** The OCR engine head office has connected, or null — none is connected yet (an outside party). */
  readonly ocrEngine: string | null;
  readonly asAt: string;
}

export interface MatchLineView { readonly productId: string; readonly status: 'matched' | 'within_tolerance' | 'blocked'; readonly payableMinor: number; readonly detail: string }
export interface MatchView {
  readonly invoiceId: string;
  readonly poId: string | null;
  readonly blocked: boolean;
  readonly payableMinor: number;
  readonly invoicedMinor: number;
  readonly withheldMinor: number;
  /** M07-FR-04: the bill's freight / duty / other charges inside `invoicedMinor` (0 when it has none) — head office's figure. */
  readonly chargesMinor: number;
  readonly ownerAction: string;
  readonly lines: readonly MatchLineView[];
  /** Head office's flags on the match (`invoice_unknown`, `order_over_invoiced`, …) — shown, never hidden. */
  readonly flags: readonly string[];
  readonly matchedBy: string;
  readonly matchedAt: string;
}

/** A file the buyer picked, as the page read it: its name, media type, bytes (base64) and, for a JSON file, its text. */
export interface PickedFile {
  readonly name: string;
  readonly mediaType: string;
  readonly contentBase64: string;
  readonly text?: string;
  /** sha-256 of the bytes, hex — the document's id is built from it. */
  readonly sha256: string;
}

export type FileRead =
  | { readonly ok: true; readonly documentId: string; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly problem: 'not_a_bill_file' | 'not_json' };

const SCAN_TYPES = /^(image\/(png|jpeg|webp)|application\/pdf)$/;

/** The document id for a file: its own fingerprint, so one file is one document however often it is handed in. */
export const documentIdFor = (sha256: string): string => `bill-${sha256.slice(0, 20)}`;

/**
 * The route's body for a picked file. A `.json` file is a GST e-invoice (`eInvoice` is the parsed JSON — head office reads
 * it and refuses by name what is not one); an image or a PDF is a scan. Anything else is not a bill this screen can hand
 * in (said, nothing sent). `supplierId` and `poId` ride along when the person named them.
 */
export function readPickedFile(file: PickedFile, named: { readonly supplierId?: string; readonly poId?: string } = {}): FileRead {
  const extra = {
    ...(named.supplierId !== undefined && named.supplierId.trim() !== '' ? { supplierId: named.supplierId.trim() } : {}),
    ...(named.poId !== undefined && named.poId.trim() !== '' ? { poId: named.poId.trim() } : {}),
  };
  const documentId = documentIdFor(file.sha256);
  if (file.mediaType === 'application/json' || /\.json$/i.test(file.name)) {
    let eInvoice: unknown;
    try { eInvoice = JSON.parse(file.text ?? ''); } catch { return { ok: false, problem: 'not_json' }; }
    return { ok: true, documentId, body: { kind: 'e_invoice', eInvoice, ...extra } };
  }
  if (SCAN_TYPES.test(file.mediaType)) return { ok: true, documentId, body: { kind: 'scan', mediaType: file.mediaType, contentBase64: file.contentBase64, ...extra } };
  return { ok: false, problem: 'not_a_bill_file' };
}

/** Rupees as a person typed them ("50", "12.5", "1,234.50") → paise, exactly from the text; undefined when not money. */
export function rupeesToPaise(text: string): number | undefined {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.replace(/[,\s₹]/g, ''));
  return m === null ? undefined : Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** A quantity as typed, in the line's unit → its smallest steps (OB-31: kg and L in thousandths); undefined when it does not fit. */
export function quantityToSteps(text: string, uom: string | null): number | undefined {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (m === null) return undefined;
  const steps = uom === 'kg' || uom === 'L' ? 1000 : 1;
  const frac = m[2] ?? '';
  if (steps === 1) return frac.replace(/0/g, '') === '' ? Number(m[1]) : undefined;
  return Number(m[1]) * steps + Number(frac.padEnd(3, '0'));
}

/** What the person entered for one line of a draft: the product, and — for a line head office marked — the figures. */
export interface LineEntry { readonly lineNo: number; readonly productId: string; readonly quantity?: string; readonly unitPrice?: string; readonly amount?: string }

/**
 * The confirmation body. Every line the person mapped goes with its product; a line whose figures they typed goes with them
 * (exact paise). A line left unmapped or a figure that is not money is NOT filled in here — it is left out, so head office
 * refuses the confirmation by name (`lines_need_a_person`) and nothing is recorded. This model never decides it is fine.
 */
export function confirmBody(doc: BillDocument, input: { readonly invoiceId: string; readonly supplierId?: string; readonly poId?: string; readonly entries: readonly LineEntry[]; readonly acceptTotalDifference?: boolean }): Record<string, unknown> {
  const byLine = new Map(input.entries.map((e) => [e.lineNo, e]));
  const lines = doc.lines.flatMap((d) => {
    const e = byLine.get(d.lineNo);
    if (e === undefined || e.productId.trim() === '') return [];
    const quantity = e.quantity === undefined || e.quantity.trim() === '' ? undefined : quantityToSteps(e.quantity, d.uom);
    const unitPriceMinor = e.unitPrice === undefined || e.unitPrice.trim() === '' ? undefined : rupeesToPaise(e.unitPrice);
    const lineTotalMinor = e.amount === undefined || e.amount.trim() === '' ? undefined : rupeesToPaise(e.amount);
    const typed = quantity !== undefined && unitPriceMinor !== undefined && lineTotalMinor !== undefined;
    return [{ lineNo: d.lineNo, productId: e.productId.trim(), ...(typed ? { quantity, unitPriceMinor, lineTotalMinor } : {}) }];
  });
  return {
    invoiceId: input.invoiceId.trim(), lines,
    ...(input.supplierId !== undefined && input.supplierId.trim() !== '' ? { supplierId: input.supplierId.trim() } : {}),
    ...(input.poId !== undefined && input.poId.trim() !== '' ? { poId: input.poId.trim() } : {}),
    ...(input.acceptTotalDifference === true ? { acceptTotalDifference: true } : {}),
  };
}

/** One typed line of a bill head office could not read (the scan path with no OCR engine). */
export interface TypedLine { readonly productId: string; readonly quantity: string; readonly unitPrice: string; readonly amount: string; readonly cgst?: string; readonly sgst?: string }

/**
 * M07-FR-04 (re-audit 30 Oct 2026): the freight, duty and other charges the paper prints beside its lines, as typed (rupees).
 * Each is optional; a blank is none. They are part of the bill's total — head office keeps them on the bill and, when the
 * bill is matched against an issued order, spreads them into the cost of the goods (its rule, not this screen's).
 */
export interface TypedCharges { readonly freight?: string; readonly duty?: string; readonly other?: string }

export type TypedCapture =
  | { readonly ok: true; readonly invoiceId: string; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly problem: 'needs_invoice_supplier_total' | 'not_money' | 'charges_not_money'; readonly line?: number };

/**
 * The typed-capture body (`POST /v1/purchase/invoices/:invoiceId/capture`): the bill as the paper says it. Only the shape is
 * checked here (an invoice number, a supplier, a total, figures that are money) — whether the lines multiply and add up to
 * the total is head office's judgement, refused in its words.
 */
export function typedCaptureBody(input: { readonly invoiceId: string; readonly supplierId: string; readonly poId?: string; readonly total: string; readonly lines: readonly TypedLine[]; readonly documentId?: string; readonly charges?: TypedCharges }): TypedCapture {
  const declaredTotalMinor = rupeesToPaise(input.total);
  if (input.invoiceId.trim() === '' || input.supplierId.trim() === '' || input.total.trim() === '' || input.lines.length === 0) return { ok: false, problem: 'needs_invoice_supplier_total' };
  if (declaredTotalMinor === undefined) return { ok: false, problem: 'not_money' };
  const lines: Record<string, unknown>[] = [];
  for (const [i, l] of input.lines.entries()) {
    const quantity = quantityToSteps(l.quantity, null);
    const unitPriceMinor = rupeesToPaise(l.unitPrice);
    const lineTotalMinor = rupeesToPaise(l.amount);
    const cgstMinor = l.cgst === undefined || l.cgst.trim() === '' ? 0 : rupeesToPaise(l.cgst);
    const sgstMinor = l.sgst === undefined || l.sgst.trim() === '' ? 0 : rupeesToPaise(l.sgst);
    if (l.productId.trim() === '' || quantity === undefined || unitPriceMinor === undefined || lineTotalMinor === undefined || cgstMinor === undefined || sgstMinor === undefined) return { ok: false, problem: 'not_money', line: i + 1 };
    lines.push({ productId: l.productId.trim(), quantity, unitPriceMinor, lineTotalMinor, ...(cgstMinor > 0 ? { cgstMinor } : {}), ...(sgstMinor > 0 ? { sgstMinor } : {}) });
  }
  // M07-FR-04: the charges beside the lines, exact paise; a blank is none, and none at all sends no `charges` (as before).
  const charge = (text: string | undefined): number | undefined => (text === undefined || text.trim() === '' ? 0 : rupeesToPaise(text));
  const freightMinor = charge(input.charges?.freight); const dutyMinor = charge(input.charges?.duty); const otherMinor = charge(input.charges?.other);
  if (freightMinor === undefined || dutyMinor === undefined || otherMinor === undefined) return { ok: false, problem: 'charges_not_money' };
  const charges = freightMinor + dutyMinor + otherMinor === 0 ? undefined : { freightMinor, dutyMinor, otherMinor };
  return {
    ok: true, invoiceId: input.invoiceId.trim(),
    body: {
      supplierId: input.supplierId.trim(), ...(input.poId !== undefined && input.poId.trim() !== '' ? { poId: input.poId.trim() } : {}), declaredTotalMinor, lines,
      ...(charges === undefined ? {} : { charges }),
      // The scan this bill was typed from: head office links it (and refuses by name a scan that is not waiting to be typed).
      ...(input.documentId !== undefined && input.documentId.trim() !== '' ? { documentId: input.documentId.trim() } : {}),
    },
  };
}

/** Head office's match record → what the screen shows: the verdict, the money, and each line's exception in its words. */
export function presentMatch(raw: unknown): MatchView | null {
  if (raw === null || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m['invoiceId'] !== 'string' || typeof m['blocked'] !== 'boolean' || !Array.isArray(m['lines'])) return null;
  const lines = (m['lines'] as Record<string, unknown>[]).map((l) => ({
    productId: String(l['productId']), status: l['status'] as MatchLineView['status'], payableMinor: Number(l['payableMinor'] ?? 0), detail: String(l['detail'] ?? ''),
  }));
  return {
    invoiceId: m['invoiceId'], poId: typeof m['poId'] === 'string' ? m['poId'] : null, blocked: m['blocked'],
    payableMinor: Number(m['payableMinor'] ?? 0), invoicedMinor: Number(m['invoicedMinor'] ?? 0), withheldMinor: Number(m['withheldMinor'] ?? 0),
    chargesMinor: Number((m['landedCharges'] as { totalMinor?: unknown } | undefined)?.totalMinor ?? 0),
    ownerAction: String(m['ownerAction'] ?? ''),
    // Exceptions first (P-03): a blocked line before one within tolerance before a matched one.
    lines: [...lines].sort((a, b) => rank(a.status) - rank(b.status)),
    flags: Array.isArray(m['flags']) ? (m['flags'] as unknown[]).map(String) : [],
    matchedBy: String(m['matchedBy'] ?? ''), matchedAt: String(m['matchedAt'] ?? ''),
  };
}
const rank = (s: MatchLineView['status']): number => (s === 'blocked' ? 0 : s === 'within_tolerance' ? 1 : 2);

/** What still needs a person on a document, so the register can say it (control by exception, P-03). */
export function whatItNeeds(doc: BillDocument): 'map_and_confirm' | 'type_it' | 'nothing' {
  if (doc.state === 'confirmed' || doc.state === 'captured') return 'nothing';
  return doc.state === 'draft' ? 'map_and_confirm' : 'type_it';
}

const answerOf = <T>(r: { status: number; body: unknown } | 'unreachable', take: (body: unknown) => T): Answer<T> => {
  if (r === 'unreachable') return { ok: false, unreachable: true };
  if (r.status >= 200 && r.status < 300) return { ok: true, value: take(r.body) };
  const e = ((r.body ?? {}) as { error?: { code?: string; whatHappened?: string; nextSafeAction?: string } }).error ?? {};
  return { ok: false, unreachable: false, status: r.status, code: e.code ?? String(r.status), whatHappened: e.whatHappened ?? `head office answered ${r.status}`, nextSafeAction: e.nextSafeAction ?? '' };
};

/** A short, stable digest of a body — the idempotency key of a write, so a re-click collapses and a changed body is new. */
export function bodyKey(prefix: string, body: unknown): string {
  const text = JSON.stringify(body);
  let h1 = 0x811c9dc5; let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return `${prefix}-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

const nonce = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ── OB-509 (G3): receipts whose cost is not known, and matching a registered bill to one ─────────────────────────────

/** A bill on head office's register that could be matched to a waiting receipt — its price for each waiting product. */
export interface CandidateBillView {
  readonly invoiceId: string;
  readonly supplierId: string;
  readonly poId: string | null;
  readonly currency: string;
  readonly prices: readonly { readonly productId: string; readonly unitPriceMinor: number; readonly unitPricePer?: number }[];
  readonly checkedBy: string | null;
}

/** One receipt still waiting for its supplier's bill, as head office listed it. */
export interface WaitingReceiptView {
  readonly grnId: string;
  readonly number: string;
  readonly poId: string | null;
  readonly warehouseId: string;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly waiting: readonly { readonly lineId: string; readonly productId: string; readonly uom: string; readonly because: 'no_issued_order' | 'not_on_order'; readonly inStockMinor: number }[];
  readonly bills: readonly CandidateBillView[];
  /** The reader booked this delivery in — head office refuses them the match (§28); the screen says so and offers nothing. */
  readonly receivedByYou: boolean;
}

export interface WaitingForBillList {
  readonly receipts: readonly WaitingReceiptView[];
  readonly count: number;
  readonly asAt: string;
}

/** What head office answered a match: the lines whose cost the bill made known, and any still waiting. */
export interface ReceiptBillMatchView {
  readonly matched: readonly { readonly lineId: string; readonly productId: string; readonly unitCost: { readonly minor: number; readonly currency: string; readonly per?: number }; readonly quantityMinor: number; readonly valueMinor: number }[];
  readonly stillNotKnown: readonly { readonly lineId: string; readonly productId: string }[];
  readonly alreadyMatched: boolean;
}

export type BillMatchLang = 'en' | 'ta';

/** Every refusal of the bill match head office can give, said in plain words for the office — English and Tamil. */
export const BILL_MATCH_WORDS: Readonly<Record<BillMatchLang, Readonly<Record<string, string>>>> = Object.freeze({
  en: {
    matched: 'Matched — the cost of these goods is now the bill\'s, and their stock is valued at it.',
    alreadyMatched: 'This bill was already matched to this delivery — nothing was changed.',
    stillWaiting: 'Still waiting for a bill:',
    unreachable: 'Head office cannot be reached — nothing was changed. Try again when connected.',
    pickBill: 'Pick the supplier bill first.', pick_a_bill: 'Pick the supplier bill first — nothing was sent.',
    receivedByYou: 'You booked this delivery in, so another person must match its bill.',
    self_match: 'Not matched — you booked this delivery in, so another person (the buyer or the accountant) must match its bill.',
    bill_for_another_order: 'Not matched — that bill is for a different purchase order (or for none) than this delivery.',
    bill_unknown: 'Not matched — that bill is not on head office\'s register. Hand it in or type it above first.',
    receipt_unknown: 'Not matched — head office has no such delivery. The store may not have synchronised yet.',
    nothing_waiting_for_a_bill: 'Not matched — nothing on this delivery is waiting for that bill.',
    bill_names_none_of_these_goods: 'Not matched — that bill does not name any of the goods whose cost is not known.',
    bill_match_not_available: 'Not matched — head office cannot match bills to deliveries just now.',
    not_readable_as_a_bill_match: 'Not matched — only a bill on the register can be matched; a typed cost is never taken.',
    forbidden: 'Not matched — your role cannot match supplier bills.',
    outside_your_branch_scope: 'Not matched — that delivery belongs to a store outside yours.',
    other: 'Not matched — head office refused it.',
    headOfficeSaid: 'Head office said:',
  },
  ta: {
    matched: 'பொருத்தப்பட்டது — இந்தப் பொருட்களின் விலை இப்போது பில்லின் விலை; அவற்றின் இருப்பு அந்த விலையில் மதிப்பிடப்படுகிறது.',
    alreadyMatched: 'இந்த பில் ஏற்கனவே இந்த டெலிவரியுடன் பொருத்தப்பட்டது — எதுவும் மாற்றப்படவில்லை.',
    stillWaiting: 'இன்னும் பில்லுக்காகக் காத்திருப்பவை:',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை. இணைப்பு கிடைத்ததும் மீண்டும் முயலவும்.',
    pickBill: 'முதலில் சப்ளையர் பில்லைத் தேர்ந்தெடுக்கவும்.', pick_a_bill: 'முதலில் சப்ளையர் பில்லைத் தேர்ந்தெடுக்கவும் — எதுவும் அனுப்பப்படவில்லை.',
    receivedByYou: 'இந்த டெலிவரியை நீங்கள் பெற்றீர்கள்; எனவே அதன் பில்லை வேறு ஒருவர் பொருத்த வேண்டும்.',
    self_match: 'பொருத்தப்படவில்லை — இந்த டெலிவரியை நீங்கள் பெற்றீர்கள்; எனவே வேறு ஒருவர் (வாங்குநர் அல்லது கணக்காளர்) அதன் பில்லைப் பொருத்த வேண்டும்.',
    bill_for_another_order: 'பொருத்தப்படவில்லை — அந்த பில் இந்த டெலிவரியின் கொள்முதல் ஆர்டருக்கானது அல்ல.',
    bill_unknown: 'பொருத்தப்படவில்லை — அந்த பில் தலைமை அலுவலகப் பதிவேட்டில் இல்லை. முதலில் மேலே அதைக் கொடுக்கவும் அல்லது தட்டச்சு செய்யவும்.',
    receipt_unknown: 'பொருத்தப்படவில்லை — அப்படி ஒரு டெலிவரி தலைமை அலுவலகத்தில் இல்லை. கடை இன்னும் ஒத்திசைக்காமல் இருக்கலாம்.',
    nothing_waiting_for_a_bill: 'பொருத்தப்படவில்லை — இந்த டெலிவரியில் எதுவும் அந்த பில்லுக்காகக் காத்திருக்கவில்லை.',
    bill_names_none_of_these_goods: 'பொருத்தப்படவில்லை — விலை தெரியாத பொருட்கள் எதுவும் அந்த பில்லில் இல்லை.',
    bill_match_not_available: 'பொருத்தப்படவில்லை — தலைமை அலுவலகத்தால் இப்போது பில்களை டெலிவரிகளுடன் பொருத்த முடியாது.',
    not_readable_as_a_bill_match: 'பொருத்தப்படவில்லை — பதிவேட்டில் உள்ள பில்லை மட்டுமே பொருத்த முடியும்; தட்டச்சு செய்த விலை ஒருபோதும் ஏற்கப்படாது.',
    forbidden: 'பொருத்தப்படவில்லை — உங்கள் பங்கால் சப்ளையர் பில்களைப் பொருத்த முடியாது.',
    outside_your_branch_scope: 'பொருத்தப்படவில்லை — அந்த டெலிவரி உங்கள் கடைக்கு வெளியே உள்ள கடையைச் சேர்ந்தது.',
    other: 'பொருத்தப்படவில்லை — தலைமை அலுவலகம் மறுத்தது.',
    headOfficeSaid: 'தலைமை அலுவலகம் சொன்னது:',
  },
});

/**
 * The match's answer in the reader's language: what happened in plain words; for a refusal, head office's own words beside it
 * (they name the bill and the delivery). `good` tells the page which tone to draw.
 */
export function billMatchWords(lang: BillMatchLang, answer: Answer<ReceiptBillMatchView>): { readonly good: boolean; readonly text: string } {
  const w = BILL_MATCH_WORDS[lang];
  if (answer.ok) {
    const still = answer.value.stillNotKnown.map((l) => l.productId);
    const head = answer.value.alreadyMatched ? w['alreadyMatched']! : w['matched']!;
    return { good: true, text: still.length === 0 ? head : `${head} ${w['stillWaiting']!} ${still.join(', ')}` };
  }
  if (answer.unreachable) return { good: false, text: w['unreachable']! };
  const plain = w[answer.code] ?? w['other']!;
  return { good: false, text: answer.whatHappened === '' ? plain : `${plain} ${w['headOfficeSaid']!} ${answer.whatHappened}` };
}

const asWaitingList = (b: unknown): WaitingForBillList => {
  const body = (b ?? {}) as { receipts?: unknown; count?: unknown; asAt?: unknown };
  const receipts = Array.isArray(body.receipts) ? body.receipts as WaitingReceiptView[] : [];
  return { receipts, count: typeof body.count === 'number' ? body.count : receipts.length, asAt: typeof body.asAt === 'string' ? body.asAt : '' };
};

export interface SupplierBillsSession {
  /** Whether the signed-in person may hand in, confirm and type bills (`purchase.invoice.capture`). */
  readonly mayCapture: boolean;
  /** Whether they may run the three-way match (`purchase.invoice.match`). */
  readonly mayMatch: boolean;
  register(): Promise<Answer<BillRegister>>;
  handIn(file: PickedFile, named?: { readonly supplierId?: string; readonly poId?: string }): Promise<Answer<{ readonly document: BillDocument; readonly alreadyReceived: boolean }> | { readonly ok: false; readonly unreachable: false; readonly status: 0; readonly code: 'not_a_bill_file' | 'not_json'; readonly whatHappened: ''; readonly nextSafeAction: '' }>;
  confirm(doc: BillDocument, input: Parameters<typeof confirmBody>[1]): Promise<Answer<{ readonly document: BillDocument; readonly invoiceId: string }>>;
  type(input: Parameters<typeof typedCaptureBody>[0]): Promise<Answer<{ readonly invoiceId: string }> | Extract<TypedCapture, { ok: false }>>;
  match(invoiceId: string): Promise<Answer<MatchView>>;
  /** The latest match head office holds for an invoice (null when nobody has matched it). */
  latestMatch(invoiceId: string): Promise<Answer<MatchView | null>>;
  /** OB-509 (G3): the receipts still waiting for their supplier's bill, with the registered bills that could be matched. */
  waitingForBill(): Promise<Answer<WaitingForBillList>>;
  /** OB-509 (G3): match a registered bill to a receipt — head office decides; only `{ invoiceId }` is sent, never a cost. */
  matchToReceipt(grnId: string, invoiceId: string): Promise<Answer<ReceiptBillMatchView> | { readonly ok: false; readonly unreachable: false; readonly status: 0; readonly code: 'pick_a_bill'; readonly whatHappened: ''; readonly nextSafeAction: '' }>;
  /** OB-509 (G3): the match's answer in plain English or Tamil (`billMatchWords`), for the page to show as it is. */
  matchWords(lang: BillMatchLang, answer: Answer<ReceiptBillMatchView>): { readonly good: boolean; readonly text: string };
}

export function createSupplierBillsSession(call: HeadOfficeCall, viewer: { readonly permissions: readonly string[] }): SupplierBillsSession {
  const may = new Set(viewer.permissions);
  return {
    mayCapture: may.has('purchase.invoice.capture'),
    mayMatch: may.has('purchase.invoice.match'),
    register: async () => answerOf(await call({ method: 'GET', path: '/v1/purchase/invoice-documents' }), (b) => b as BillRegister),
    handIn: async (file, named) => {
      const read = readPickedFile(file, named);
      if (!read.ok) return { ok: false, unreachable: false, status: 0, code: read.problem, whatHappened: '', nextSafeAction: '' };
      // The id is the file's fingerprint: the same file again is the same document, and head office ANSWERS it as already
      // received (the route is idempotent on the id). The key is each click's own, so that answer is head office's, not a replay.
      return answerOf(await call({ method: 'POST', path: `/v1/purchase/invoice-documents/${encodeURIComponent(read.documentId)}`, body: read.body, idempotencyKey: `${read.documentId}-${nonce()}` }),
        (b) => b as { document: BillDocument; alreadyReceived: boolean });
    },
    confirm: async (doc, input) => {
      const body = confirmBody(doc, input);
      return answerOf(await call({ method: 'POST', path: `/v1/purchase/invoice-documents/${encodeURIComponent(doc.documentId)}/confirm`, body, idempotencyKey: bodyKey(`confirm-${doc.documentId}`, body) }),
        (b) => { const r = b as { document: BillDocument; invoiceId?: string }; return { document: r.document, invoiceId: r.document.invoiceId ?? r.invoiceId ?? '' }; });
    },
    type: async (input) => {
      const typed = typedCaptureBody(input);
      if (!typed.ok) return typed;
      return answerOf(await call({ method: 'POST', path: `/v1/purchase/invoices/${encodeURIComponent(typed.invoiceId)}/capture`, body: typed.body, idempotencyKey: bodyKey(`typed-${typed.invoiceId}`, typed.body) }),
        () => ({ invoiceId: typed.invoiceId }));
    },
    match: async (invoiceId) => {
      // A fresh check each click (head office records each one with its sources); the key is the click's own.
      const key = `match-${invoiceId}-${nonce()}`;
      const r = answerOf(await call({ method: 'POST', path: `/v1/purchase/invoices/${encodeURIComponent(invoiceId)}/match`, body: {}, idempotencyKey: key }), presentMatch);
      return r.ok && r.value === null ? { ok: false, unreachable: false, status: 200, code: 'unreadable_match', whatHappened: 'head office answered with something that is not a match', nextSafeAction: '' } : r as Answer<MatchView>;
    },
    latestMatch: async (invoiceId) => answerOf(await call({ method: 'GET', path: `/v1/purchase/invoices/${encodeURIComponent(invoiceId)}` }), (b) => presentMatch((b as { match?: unknown }).match ?? null)),
    waitingForBill: async () => answerOf(await call({ method: 'GET', path: '/v1/inventory/receipts-cost-not-known' }), asWaitingList),
    matchToReceipt: async (grnId, invoiceId) => {
      if (invoiceId.trim() === '' || grnId.trim() === '') return { ok: false, unreachable: false, status: 0, code: 'pick_a_bill', whatHappened: '', nextSafeAction: '' };
      // Each click its own key: head office is idempotent on the receipt and bill itself (a second match is "already matched").
      return answerOf(await call({ method: 'POST', path: `/v1/inventory/goods-receipt/${encodeURIComponent(grnId.trim())}/bill-match`, body: { invoiceId: invoiceId.trim() }, idempotencyKey: `bill-match-${grnId.trim()}-${nonce()}` }),
        (b) => {
          const r = (b ?? {}) as Partial<ReceiptBillMatchView>;
          return { matched: Array.isArray(r.matched) ? r.matched : [], stillNotKnown: Array.isArray(r.stillNotKnown) ? r.stillNotKnown : [], alreadyMatched: r.alreadyMatched === true };
        });
    },
    matchWords: billMatchWords,
  };
}

/** The browser's call: same-origin, under the signed-in person's own session — never a service token. */
export function browserHeadOfficeCall(fetchFn: typeof fetch): HeadOfficeCall {
  return async ({ method, path, body, idempotencyKey }) => {
    try {
      const res = await fetchFn(path, {
        method, credentials: 'same-origin',
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } catch {
      return 'unreachable';
    }
  };
}
