// D03-FR-02 / WF-05 "Capture/OCR/import" (round 8): reading a supplier's bill into a DRAFT a person confirms.
//
// Two channels, one draft shape:
//   • a GST e-invoice (the supplier's IRP-registered invoice JSON, NIC schema: DocDtls / SellerDtls / ItemList / ValDtls,
//     plus the Irn) — parsed HERE, deterministically, amounts in rupees turned into paise exactly from their decimal text;
//   • a scanned or photographed bill — read by an OCR ENGINE behind the `InvoiceExtractor` port. The engine is an outside
//     party (no engine is connected in production yet); `FakeOcrExtractor` is the deterministic stand-in the tests drive.
//
// Nothing here decides anything: every figure is a suggestion with a confidence, and a person confirms the bill line by line
// before it reaches the supplier-invoice register (P-05 — a machine reads, a person commits). What the extraction could not
// read is said in `warnings`, never filled in.

/** One line as read off the bill. Quantities are in the line unit's smallest steps (OB-31: kg → grams). */
export interface ExtractedInvoiceLine {
  readonly lineNo: number;
  readonly supplierItemCode: string | null;
  readonly description: string;
  readonly hsn: string | null;
  readonly quantity: number | null;
  readonly uom: string | null;
  /** Per WHOLE unit of `uom` (per item; per kg), in paise. */
  readonly unitPriceMinor: number | null;
  readonly lineTotalMinor: number | null;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  /** 0–1: how sure the reader is of this line's figures. The e-invoice parser is 1 (it reads a structured file). */
  readonly confidence: number;
}

export interface ExtractedInvoice {
  readonly channel: 'e_invoice' | 'ocr';
  readonly engine: string;
  readonly supplierGstin: string | null;
  readonly supplierInvoiceNo: string | null;
  /** YYYY-MM-DD */
  readonly invoiceDate: string | null;
  /** The e-invoice's Invoice Reference Number, when the bill carries one. */
  readonly irn: string | null;
  readonly lines: readonly ExtractedInvoiceLine[];
  /** What the bill itself says it totals (with tax), or null when it says nothing readable. */
  readonly statedTotalMinor: number | null;
  readonly confidence: number;
  readonly warnings: readonly string[];
}

/** A scanned bill handed to an OCR engine. */
export interface InvoiceDocument {
  readonly mediaType: string;
  readonly contentBase64: string;
}

/** The OCR port: an outside engine reads a scan into a draft. Adapters live at the edge of the system; none is live yet. */
export interface InvoiceExtractor {
  readonly engine: string;
  extract(doc: InvoiceDocument): Promise<ExtractedInvoice>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null);

/**
 * Rupees (a JSON number or string such as 1234.5) → paise, exactly, from the DECIMAL TEXT — never through binary floating
 * point. More than two decimals, or anything not a plain decimal, is `undefined` (said, never rounded silently).
 */
export function rupeesToPaise(v: unknown): number | undefined {
  const text = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : typeof v === 'string' ? v.trim() : '';
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (m === null) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** A quantity in a unit → its smallest steps (kg/L → thousandths, from the decimal text); undefined when it does not fit. */
function quantityInSteps(v: unknown, unit: string | null): number | undefined {
  const text = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (m === null) return undefined;
  const steps = unit === 'kg' || unit === 'L' ? 1000 : 1;
  const whole = Number(m[1]) * steps;
  const frac = m[2] ?? '';
  if (steps === 1) return frac.replace(/0/g, '') === '' ? whole : undefined;
  return whole + Number(frac.padEnd(3, '0'));
}

/** NIC unit codes the store counts in (OB-31); any other is left for the person (null + warning). */
const NIC_UNITS: Readonly<Record<string, string>> = { NOS: 'ea', PCS: 'ea', UNT: 'ea', BOX: 'ea', KGS: 'kg', LTR: 'L', GMS: 'g', MLT: 'ml' };

const isoFromDdMmYyyy = (v: unknown): string | null => {
  const m = typeof v === 'string' ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim()) : null;
  return m === null ? null : `${m[3]}-${m[2]}-${m[1]}`;
};

/**
 * Parse a GST e-invoice (the supplier's IRP-registered JSON). Returns the draft, or the reasons it is not one. The IRP's
 * signature on the invoice is NOT verified here (that needs the IRP's public key — an outside party); the draft says so.
 */
export function parseGstEInvoice(json: unknown): { readonly ok: true; readonly invoice: ExtractedInvoice } | { readonly ok: false; readonly problems: readonly string[] } {
  if (!isObj(json)) return { ok: false, problems: ['not a JSON object'] };
  const doc = json['DocDtls'];
  const seller = json['SellerDtls'];
  const items = json['ItemList'];
  const problems: string[] = [];
  if (!isObj(doc) || str(doc['No']) === null) problems.push('DocDtls.No (the invoice number) is missing');
  if (!isObj(seller) || str(seller['Gstin']) === null) problems.push('SellerDtls.Gstin (the supplier\'s GSTIN) is missing');
  if (!Array.isArray(items) || items.length === 0) problems.push('ItemList has no lines');
  if (problems.length > 0) return { ok: false, problems };
  const warnings: string[] = ['irp_signature_not_verified'];
  const lines: ExtractedInvoiceLine[] = (items as unknown[]).map((raw, i) => {
    const it = isObj(raw) ? raw : {};
    const unitCode = str(it['Unit'])?.toUpperCase() ?? null;
    const uom = unitCode === null ? null : NIC_UNITS[unitCode] ?? null;
    if (unitCode !== null && uom === null) warnings.push(`line ${i + 1}: unit "${unitCode}" is not one the store counts in`);
    const quantity = uom === null ? undefined : quantityInSteps(it['Qty'], uom);
    if (quantity === undefined) warnings.push(`line ${i + 1}: quantity "${String(it['Qty'])}" could not be read in ${uom ?? 'a known unit'}`);
    const unitPriceMinor = rupeesToPaise(it['UnitPrice']);
    const lineTotalMinor = rupeesToPaise(it['TotAmt']);
    if (unitPriceMinor === undefined || lineTotalMinor === undefined) warnings.push(`line ${i + 1}: price or amount has more than two decimals or is not a number`);
    const discount = rupeesToPaise(it['Discount']) ?? 0;
    if (discount > 0) warnings.push(`line ${i + 1}: a discount of ${discount} paise is on the line — the taxable value is less than quantity × price`);
    return {
      lineNo: i + 1, supplierItemCode: str(it['BchDtls'] !== undefined && isObj(it['BchDtls']) ? it['BchDtls']['Nm'] : null) ?? str(it['Barcde']) ?? null,
      description: str(it['PrdDesc']) ?? '', hsn: str(it['HsnCd']), quantity: quantity ?? null, uom,
      unitPriceMinor: unitPriceMinor ?? null, lineTotalMinor: lineTotalMinor ?? null,
      cgstMinor: rupeesToPaise(it['CgstAmt']) ?? 0, sgstMinor: rupeesToPaise(it['SgstAmt']) ?? 0, igstMinor: rupeesToPaise(it['IgstAmt']) ?? 0,
      confidence: 1,
    };
  });
  const val = json['ValDtls'];
  const statedTotalMinor = isObj(val) ? rupeesToPaise(val['TotInvVal']) ?? null : null;
  return {
    ok: true,
    invoice: {
      channel: 'e_invoice', engine: 'gst-e-invoice-json',
      supplierGstin: str((seller as Record<string, unknown>)['Gstin'])?.toUpperCase() ?? null,
      supplierInvoiceNo: str((doc as Record<string, unknown>)['No']), invoiceDate: isoFromDdMmYyyy((doc as Record<string, unknown>)['Dt']),
      irn: str(json['Irn']), lines, statedTotalMinor, confidence: 1, warnings,
    },
  };
}

/**
 * The deterministic stand-in for an OCR engine (tests and demos only — never a production adapter). It "reads" a synthetic
 * scan: base64 of a plain-text layout
 *
 *   SYNTHETIC-SCAN v1
 *   GSTIN: 33AAAAA0000A1Z5
 *   INVOICE: INV-77
 *   DATE: 2026-10-05
 *   LINE: <item code>|<description>|<hsn>|<qty>|<unit>|<rate ₹>|<amount ₹>|<cgst ₹>|<sgst ₹>|<igst ₹>
 *   TOTAL: <₹>
 *
 * A field written with a trailing `?` is read with low confidence (0.6) — how a smudged figure comes back from a real engine.
 */
export class FakeOcrExtractor implements InvoiceExtractor {
  readonly engine = 'fake-ocr (synthetic, tests only)';
  extract(doc: InvoiceDocument): Promise<ExtractedInvoice> {
    const text = Buffer.from(doc.contentBase64, 'base64').toString('utf8');
    const rows = text.split(/\r?\n/).map((r) => r.trim()).filter((r) => r !== '');
    const warnings: string[] = [];
    if (rows[0] !== 'SYNTHETIC-SCAN v1') {
      return Promise.resolve({ channel: 'ocr', engine: this.engine, supplierGstin: null, supplierInvoiceNo: null, invoiceDate: null, irn: null, lines: [], statedTotalMinor: null, confidence: 0, warnings: ['nothing readable on the scan'] });
    }
    const field = (k: string): string | null => { const r = rows.find((x) => x.startsWith(`${k}:`)); return r === undefined ? null : r.slice(k.length + 1).trim(); };
    const lines: ExtractedInvoiceLine[] = rows.filter((r) => r.startsWith('LINE:')).map((r, i) => {
      const parts = r.slice(5).split('|').map((p) => p.trim());
      let low = false;
      const clean = (p: string | undefined): string => { const v = p ?? ''; if (v.endsWith('?')) { low = true; return v.slice(0, -1); } return v; };
      const [code, desc, hsn, qty, unit, rate, amount, cgst, sgst, igst] = parts.map(clean);
      const uom = unit === undefined || unit === '' ? null : NIC_UNITS[unit.toUpperCase()] ?? null;
      const quantity = uom === null ? undefined : quantityInSteps(qty, uom);
      if (quantity === undefined) warnings.push(`line ${i + 1}: quantity not readable`);
      return {
        lineNo: i + 1, supplierItemCode: code === '' ? null : code ?? null, description: desc ?? '', hsn: hsn === '' ? null : hsn ?? null,
        quantity: quantity ?? null, uom, unitPriceMinor: rupeesToPaise(rate) ?? null, lineTotalMinor: rupeesToPaise(amount) ?? null,
        cgstMinor: rupeesToPaise(cgst) ?? 0, sgstMinor: rupeesToPaise(sgst) ?? 0, igstMinor: rupeesToPaise(igst) ?? 0,
        confidence: low ? 0.6 : 0.97,
      };
    });
    const total = field('TOTAL');
    const confidence = lines.length === 0 ? 0 : Math.min(...lines.map((l) => l.confidence));
    return Promise.resolve({
      channel: 'ocr', engine: this.engine, supplierGstin: field('GSTIN')?.toUpperCase() ?? null, supplierInvoiceNo: field('INVOICE'),
      invoiceDate: field('DATE'), irn: null, lines, statedTotalMinor: total === null ? null : rupeesToPaise(total) ?? null, confidence, warnings,
    });
  }
}
