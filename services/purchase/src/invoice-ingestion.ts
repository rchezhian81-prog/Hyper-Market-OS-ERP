// API-03 Supplier-bill INGESTION — e-invoice and OCR into the three-way match (D03-FR-02 · WF-05 · M07 · M30 · P-05 · P-08) — round 8.
//
// WF-05 is "Capture/OCR/import → validate → PO-GRN-invoice match → discrepancy → approval → AP/Tally". Typed capture, the
// box-relayed capture and the supplier portal already put a bill on the supplier-invoice register; this adds the two
// machine-read channels in front of the same register:
//
//   • RECEIVE — a buyer hands in a bill: a GST e-invoice JSON (parsed here, deterministically) or a scan (read by the OCR
//     engine behind the `InvoiceExtractor` port; with no engine connected the scan is kept as `awaiting_manual_capture`, said).
//     The result is a DRAFT: the supplier found by its GSTIN in the supplier master, each line with a SUGGESTED product
//     (only from a mapping a person confirmed before for this supplier's item code — never guessed), and what could not be
//     read listed. A bill the register already holds (the same IRN, or the same supplier invoice number from the same
//     GSTIN) is refused by name. The scan's bytes are not kept (no object store, OB-45): its fingerprint, size and type are.
//   • CONFIRM — a person maps every line to a product and, for a line the engine was unsure of, types the figures from the
//     paper. The bill then goes onto the register through the SAME capture the portal uses (lines re-read under OB-31, every
//     line multiplied, the lines adding up to the total), unchecked — checking it is the three-way match, a second person's
//     own act. The confirmed item-code → product mappings are remembered for the next bill from that supplier.
//
// A machine reads; a person commits (P-05). Nothing here posts money or stock.

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { parseGstEInvoice, type ExtractedInvoice, type ExtractedInvoiceLine, type InvoiceExtractor } from '../../../packages/purchasing/src/invoice-extraction';
import { capturePortalInvoice, type PurchaseDeps } from './index';

/** Lines read below this confidence must have their figures typed by the person confirming. */
export const LOW_CONFIDENCE = 0.9;
/** The largest scan accepted (base64 characters) — a bill photo, not an archive (no object store, OB-45). */
export const MAX_SCAN_BASE64 = 4 * 1024 * 1024;

/** `captured`: a scan a person TYPED on the capture screen — the typed capture named this document (D03-FR-02 round 12). */
export type DocumentState = 'draft' | 'awaiting_manual_capture' | 'unreadable' | 'confirmed' | 'captured';

/** The states of a scan still waiting for a person to type it — the only ones a typed capture may link. */
export const SCAN_AWAITING_TYPING: readonly DocumentState[] = ['awaiting_manual_capture', 'unreadable'];

/**
 * The append-only link "this scan was typed as invoice X" — recorded once per document when a typed capture
 * (`POST /v1/purchase/invoices/:id/capture`) names it. The document itself is never rewritten: the list reads the
 * scan's own record with this link laid over it.
 */
export interface ScanTypedLink {
  readonly documentId: string;
  readonly invoiceId: string;
  readonly typedBy: string;
  readonly typedAt: string;
}

/** Lay the typed-as links over the documents: a linked scan reads as `captured`, with its invoice and who typed it. */
export function withTypedLinks(docs: readonly InvoiceDocumentRecord[], links: readonly ScanTypedLink[]): InvoiceDocumentRecord[] {
  const byDoc = new Map<string, ScanTypedLink>();
  for (const l of links) if (!byDoc.has(l.documentId)) byDoc.set(l.documentId, l); // the first link stands
  return docs.map((d) => {
    const l = byDoc.get(d.documentId);
    return l === undefined || d.state === 'confirmed' ? d : { ...d, state: 'captured', invoiceId: l.invoiceId, typedBy: l.typedBy, typedAt: l.typedAt };
  });
}

export interface DraftLine extends ExtractedInvoiceLine {
  /** The product a person mapped this supplier's item code to before, if any — a suggestion only. */
  readonly suggestedProductId: string | null;
  readonly needsFigures: boolean;
}

export interface InvoiceDocumentRecord {
  readonly documentId: string;
  readonly channel: 'e_invoice' | 'ocr';
  readonly state: DocumentState;
  readonly receivedBy: string;
  readonly receivedAt: string;
  /** The scan's fingerprint (sha-256), type and size — never its bytes. Absent for an e-invoice. */
  readonly scan?: { readonly sha256: string; readonly mediaType: string; readonly bytes: number };
  readonly supplierId: string | null;
  readonly poId: string | null;
  readonly extracted: ExtractedInvoice | null;
  readonly lines: readonly DraftLine[];
  readonly problems: readonly string[];
  readonly confirmedBy?: string;
  readonly confirmedAt?: string;
  readonly invoiceId?: string;
  /** A scan typed on the capture screen: who typed it and when (with `invoiceId`, state `captured`). */
  readonly typedBy?: string;
  readonly typedAt?: string;
}

export interface ItemMapping { readonly supplierId: string; readonly supplierItemCode: string; readonly productId: string; readonly by: string; readonly at: string }

export interface InvoiceIngestionDeps {
  /** The OCR engine (an outside party). Undefined → a scan waits for a person to type it (said). */
  readonly extractor?: InvoiceExtractor;
  readonly document: (tenantId: string, documentId: string) => Promise<InvoiceDocumentRecord | undefined> | InvoiceDocumentRecord | undefined;
  readonly documents: (tenantId: string) => Promise<readonly InvoiceDocumentRecord[]> | readonly InvoiceDocumentRecord[];
  readonly recordDocument: (tenantId: string, doc: InvoiceDocumentRecord) => Promise<void> | void;
  readonly supplierByGstin: (tenantId: string, gstin: string) => Promise<string | undefined> | string | undefined;
  readonly mappings: (tenantId: string, supplierId: string) => Promise<readonly ItemMapping[]> | readonly ItemMapping[];
  readonly recordMappings: (tenantId: string, mappings: readonly ItemMapping[]) => Promise<void> | void;
  /** The supplier-invoice register's own capture (the portal path) — the ONE way a bill reaches the register from here. */
  readonly purchase: PurchaseDeps;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const refuse = (status: number, code: string, whatHappened: string, nextSafeAction = 'Nothing was recorded.') =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

/** Is this bill already on file — the same IRN, or the same invoice number from the same GSTIN, confirmed or in draft? */
const sameBill = (a: ExtractedInvoice, b: ExtractedInvoice): boolean =>
  (a.irn !== null && a.irn === b.irn)
  || (a.supplierGstin !== null && a.supplierInvoiceNo !== null && a.supplierGstin === b.supplierGstin && a.supplierInvoiceNo.toUpperCase() === (b.supplierInvoiceNo ?? '').toUpperCase());

export function invoiceIngestionRoutes(deps: InvoiceIngestionDeps): readonly Route[] {
  return [
    {
      // RECEIVE a bill: { kind: 'e_invoice', eInvoice: {…} } or { kind: 'scan', mediaType, contentBase64 }, optionally
      // { supplierId, poId }. Answers the draft. Idempotent on the document id.
      api: 'API-03', method: 'POST', path: '/v1/purchase/invoice-documents/:documentId',
      permission: 'purchase.invoice.capture', idempotent: true,
      handler: async (ctx) => {
        const documentId = (ctx.params['documentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const kind = b['kind'];
        if (documentId === '' || (kind !== 'e_invoice' && kind !== 'scan') || (b['supplierId'] !== undefined && b['supplierId'] !== null && !isStr(b['supplierId']))
          || (b['poId'] !== undefined && b['poId'] !== null && !isStr(b['poId']))) {
          throw refuse(400, 'not_readable_as_an_invoice_document', 'A bill needs { kind: "e_invoice", eInvoice } or { kind: "scan", mediaType, contentBase64 } (supplierId and poId optional).');
        }
        const existing = await deps.document(ctx.tenantId, documentId);
        if (existing !== undefined) return { status: 200, body: { document: existing, alreadyReceived: true } };
        const receivedAt = deps.now();
        let extracted: ExtractedInvoice | null = null;
        let state: DocumentState = 'draft';
        const problems: string[] = [];
        let scan: InvoiceDocumentRecord['scan'];
        if (kind === 'e_invoice') {
          const parsed = parseGstEInvoice(b['eInvoice']);
          if (!parsed.ok) throw refuse(422, 'not_a_gst_e_invoice', `This is not a GST e-invoice head office can read: ${parsed.problems.join('; ')}.`, 'Ask the supplier for the e-invoice JSON, or hand the paper in as a scan. Nothing was recorded.');
          extracted = parsed.invoice;
        } else {
          if (!isStr(b['mediaType']) || !/^(image\/(png|jpeg|webp)|application\/pdf)$/.test(b['mediaType']) || !isStr(b['contentBase64'])) {
            throw refuse(400, 'not_readable_as_a_scan', 'A scan needs a mediaType (image/png, image/jpeg, image/webp or application/pdf) and its contentBase64.');
          }
          if (b['contentBase64'].length > MAX_SCAN_BASE64) throw refuse(413, 'scan_too_large', `A bill scan is at most ${MAX_SCAN_BASE64} base64 characters (about 3 MB) — a photo of the bill, not an archive.`, 'Take a smaller photo of the bill. Nothing was recorded.');
          const bytes = Buffer.from(b['contentBase64'], 'base64');
          scan = { sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: b['mediaType'], bytes: bytes.length };
          if (deps.extractor === undefined) {
            state = 'awaiting_manual_capture';
            problems.push('no OCR engine is connected: type this bill on the capture screen');
          } else {
            extracted = await deps.extractor.extract({ mediaType: b['mediaType'], contentBase64: b['contentBase64'] });
            if (extracted.lines.length === 0) { state = 'unreadable'; problems.push('the engine read no lines off the scan: type this bill on the capture screen'); }
          }
        }
        // Same bill twice (the IRN, or the number from the same GSTIN) is refused — one bill is one record.
        if (extracted !== null) {
          const dup = (await deps.documents(ctx.tenantId)).find((d) => d.extracted !== null && sameBill(d.extracted, extracted as ExtractedInvoice));
          if (dup !== undefined) throw refuse(409, 'bill_already_received', `This bill (${extracted.irn ?? `${extracted.supplierGstin} ${extracted.supplierInvoiceNo}`}) was already handed in as document ${dup.documentId}${dup.invoiceId === undefined ? '' : ` and is invoice ${dup.invoiceId}`}.`);
        }
        // The supplier: named, else found by the GSTIN on the bill in the supplier master; neither → said.
        let supplierId = isStr(b['supplierId']) ? b['supplierId'].trim() : null;
        if (supplierId === null && extracted?.supplierGstin) supplierId = (await deps.supplierByGstin(ctx.tenantId, extracted.supplierGstin)) ?? null;
        if (extracted !== null && supplierId === null) problems.push(`no supplier in the supplier master has GSTIN ${extracted.supplierGstin ?? '(none on the bill)'}`);
        const mapped = supplierId === null ? [] : await deps.mappings(ctx.tenantId, supplierId);
        const lines: DraftLine[] = (extracted?.lines ?? []).map((l) => ({
          ...l,
          suggestedProductId: l.supplierItemCode === null ? null : [...mapped].reverse().find((m) => m.supplierItemCode === l.supplierItemCode)?.productId ?? null,
          needsFigures: l.confidence < LOW_CONFIDENCE || l.quantity === null || l.unitPriceMinor === null || l.lineTotalMinor === null,
        }));
        const doc: InvoiceDocumentRecord = {
          documentId, channel: kind === 'e_invoice' ? 'e_invoice' : 'ocr', state, receivedBy: ctx.userId, receivedAt, ...(scan === undefined ? {} : { scan }),
          supplierId, poId: isStr(b['poId']) ? b['poId'].trim() : null, extracted, lines, problems: [...problems, ...(extracted?.warnings ?? [])],
        };
        await deps.recordDocument(ctx.tenantId, doc);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'invoice.document.receive', objectType: 'invoice_document', objectId: documentId, at: receivedAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { channel: doc.channel, state, engine: extracted?.engine ?? '', supplierId: supplierId ?? '', lines: String(lines.length), irn: extracted?.irn ?? '', invoiceNo: extracted?.supplierInvoiceNo ?? '' },
          correlationId: documentId,
        });
        return { status: 201, body: { document: doc, alreadyReceived: false } };
      },
    },
    {
      // CONFIRM a draft: { invoiceId, poId?, lines: [{ lineNo, productId, quantity?, unitPriceMinor?, lineTotalMinor? }] } — every
      // line mapped by a person; a low-confidence line's figures typed from the paper. Puts the bill on the register.
      api: 'API-03', method: 'POST', path: '/v1/purchase/invoice-documents/:documentId/confirm',
      permission: 'purchase.invoice.capture', idempotent: true,
      handler: async (ctx) => {
        const documentId = (ctx.params['documentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const doc = await deps.document(ctx.tenantId, documentId);
        if (doc === undefined) throw refuse(404, 'invoice_document_unknown', `No bill ${documentId} has been handed in.`);
        if (doc.state === 'confirmed') return { status: 200, body: { document: doc, invoiceId: doc.invoiceId, alreadyConfirmed: true } };
        if (doc.state !== 'draft' || doc.extracted === null) throw refuse(409, 'nothing_read_to_confirm', `Bill ${documentId} is ${doc.state}: there is no read draft to confirm — type it on the capture screen.`);
        const supplierId = isStr(b['supplierId']) ? b['supplierId'].trim() : doc.supplierId;
        if (!isStr(b['invoiceId']) || supplierId === null || !Array.isArray(b['lines'])) {
          throw refuse(400, 'not_readable_as_a_confirmation', 'Confirming a bill needs { invoiceId, lines: [{ lineNo, productId, … }] } and a supplier (found by GSTIN, or supplierId).');
        }
        const given = new Map<number, Record<string, unknown>>();
        for (const l of b['lines'] as unknown[]) if (isObj(l) && Number.isInteger(l['lineNo'])) given.set(l['lineNo'] as number, l);
        const unmapped: number[] = [];
        const unsure: number[] = [];
        const lines: Record<string, unknown>[] = [];
        for (const d of doc.lines) {
          const g = given.get(d.lineNo);
          if (g === undefined || !isStr(g['productId'])) { unmapped.push(d.lineNo); continue; }
          // A line the engine was unsure of: the person types the figures from the paper (never the machine's guess).
          const typed = isNonNegInt(g['quantity']) && isNonNegInt(g['unitPriceMinor']) && isNonNegInt(g['lineTotalMinor']);
          if (d.needsFigures && !typed) { unsure.push(d.lineNo); continue; }
          lines.push({
            productId: g['productId'].trim(),
            quantity: typed ? g['quantity'] : d.quantity, unitPriceMinor: typed ? g['unitPriceMinor'] : d.unitPriceMinor, lineTotalMinor: typed ? g['lineTotalMinor'] : d.lineTotalMinor,
            ...(d.uom === null ? {} : { uom: d.uom }),
            ...(d.cgstMinor > 0 ? { cgstMinor: d.cgstMinor } : {}), ...(d.sgstMinor > 0 ? { sgstMinor: d.sgstMinor } : {}), ...(d.igstMinor > 0 ? { igstMinor: d.igstMinor } : {}),
          });
        }
        if (unmapped.length > 0 || unsure.length > 0) {
          throw refuse(422, 'lines_need_a_person', `${unmapped.length > 0 ? `Line(s) ${unmapped.join(', ')} are not mapped to a product. ` : ''}${unsure.length > 0 ? `Line(s) ${unsure.join(', ')} were read with low confidence: type their quantity, price and amount from the paper.` : ''}`.trim(), 'Map every line and type the unsure figures, then confirm again. Nothing was recorded.');
        }
        // M07-FR-04 (re-audit 30 Oct 2026): the other charges the bill prints beside its lines (an e-invoice's `OthChrg`) are
        // part of what it totals — kept on the invoice as its landed charges, exactly as the typed capture keeps them.
        const otherMinor = doc.extracted.otherChargesMinor ?? 0;
        const charges = otherMinor > 0 ? { freightMinor: 0, dutyMinor: 0, otherMinor } : undefined;
        const declaredTotalMinor = otherMinor + lines.reduce((s, l) => s + (l['lineTotalMinor'] as number) + ((l['cgstMinor'] as number | undefined) ?? 0) + ((l['sgstMinor'] as number | undefined) ?? 0) + ((l['igstMinor'] as number | undefined) ?? 0), 0);
        if (doc.extracted.statedTotalMinor !== null && doc.extracted.statedTotalMinor !== declaredTotalMinor && b['acceptTotalDifference'] !== true) {
          throw refuse(422, 'does_not_add_up_to_the_bill', `The confirmed lines${charges === undefined ? '' : ' and the bill\'s other charges'} come to ${declaredTotalMinor} paise but the bill states ${doc.extracted.statedTotalMinor} (a round-off, a charge or a misread figure).`, 'Correct the lines, or confirm with acceptTotalDifference: true and say why on the match. Nothing was recorded.');
        }
        const poId = isStr(b['poId']) ? b['poId'].trim() : doc.poId;
        const source = doc.channel === 'e_invoice' ? `e-invoice/${doc.extracted.irn ?? doc.extracted.supplierInvoiceNo ?? documentId}` : `ocr/${documentId}`;
        const out = await capturePortalInvoice(deps.purchase, ctx.tenantId, {
          invoiceId: b['invoiceId'].trim(), supplierId, poId, declaredTotalMinor, lines, submittedBy: ctx.userId, reviewedBy: ctx.userId,
          submissionId: documentId, branchId: ctx.branchId ?? null, source, auditAction: doc.channel === 'e_invoice' ? 'invoice.capture.e_invoice' : 'invoice.capture.ocr',
          // R3 · A17: the bill's own number and date as read off it — what the GSTR-2B lists it by.
          supplierInvoiceNo: doc.extracted.supplierInvoiceNo, supplierInvoiceDate: doc.extracted.invoiceDate,
          ...(charges === undefined ? {} : { charges }),
        });
        if (!out.ok) throw refuse(out.code === 'invoice_id_already_used' ? 409 : 422, out.code, out.detail);
        const at = deps.now();
        const learnt: ItemMapping[] = doc.lines.flatMap((d) => {
          const productId = (lines[doc.lines.indexOf(d)] as { productId: string }).productId;
          return d.supplierItemCode === null || d.suggestedProductId === productId ? [] : [{ supplierId, supplierItemCode: d.supplierItemCode, productId, by: ctx.userId, at }];
        });
        if (learnt.length > 0) await deps.recordMappings(ctx.tenantId, learnt);
        const confirmed: InvoiceDocumentRecord = { ...doc, supplierId, poId, state: 'confirmed', confirmedBy: ctx.userId, confirmedAt: at, invoiceId: out.record.invoiceId };
        await deps.recordDocument(ctx.tenantId, confirmed);
        return { status: 201, body: { document: confirmed, invoice: out.record, alreadyConfirmed: false } };
      },
    },
    {
      api: 'API-03', method: 'GET', path: '/v1/purchase/invoice-documents/:documentId',
      permission: 'purchase.invoice.capture',
      handler: async (ctx) => {
        const doc = await deps.document(ctx.tenantId, (ctx.params['documentId'] ?? '').trim());
        if (doc === undefined) throw refuse(404, 'invoice_document_unknown', 'No such bill has been handed in.', 'Nothing was changed.');
        return { status: 200, body: { document: doc, ocrEngine: deps.extractor?.engine ?? null } };
      },
    },
    {
      // Every bill handed in, newest first — what still waits for a person is listed first.
      api: 'API-03', method: 'GET', path: '/v1/purchase/invoice-documents',
      permission: 'purchase.invoice.capture',
      handler: async (ctx) => {
        const all = [...(await deps.documents(ctx.tenantId))].reverse();
        const done = (d: InvoiceDocumentRecord) => d.state === 'confirmed' || d.state === 'captured';
        const waiting = all.filter((d) => !done(d));
        return { status: 200, body: { documents: [...waiting, ...all.filter(done)], waiting: waiting.length, ocrEngine: deps.extractor?.engine ?? null, asAt: deps.now() } };
      },
    },
  ];
}
