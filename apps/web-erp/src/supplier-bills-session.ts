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
//   • CHECK it against the order: the three-way match head office runs over what IT holds (`/match`), its exceptions
//     shown line by line.
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

export type TypedCapture =
  | { readonly ok: true; readonly invoiceId: string; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly problem: 'needs_invoice_supplier_total' | 'not_money'; readonly line?: number };

/**
 * The typed-capture body (`POST /v1/purchase/invoices/:invoiceId/capture`): the bill as the paper says it. Only the shape is
 * checked here (an invoice number, a supplier, a total, figures that are money) — whether the lines multiply and add up to
 * the total is head office's judgement, refused in its words.
 */
export function typedCaptureBody(input: { readonly invoiceId: string; readonly supplierId: string; readonly poId?: string; readonly total: string; readonly lines: readonly TypedLine[]; readonly documentId?: string }): TypedCapture {
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
  return {
    ok: true, invoiceId: input.invoiceId.trim(),
    body: {
      supplierId: input.supplierId.trim(), ...(input.poId !== undefined && input.poId.trim() !== '' ? { poId: input.poId.trim() } : {}), declaredTotalMinor, lines,
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
