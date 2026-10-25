// A COPY of a bill by its number, as the till prints it (OB-373 · M12-FR-02 · hard rules #1 and #3).
//
// The store computer answers the bill exactly as it was saved (edge/store-edge/src/bill-copies.ts — lines, prices, tax,
// tenders, number and date, nothing of the customer) and has ALREADY recorded the copy before it answered. This turns that
// answer into the bill the till prints, through the till's ONE renderer — never re-priced:
//
//   • in real trading, the Rule 46 tax invoice rebuilt from the saved lines and the shop's legal identity, marked
//     "DUPLICATE — reprint" (English) or "நகல் (DUPLICATE) — மறு அச்சு" (Tamil);
//   • otherwise the till's receipt, marked "*** REPRINT ***" with the reason.
//
// Pure and synchronous: no network, no clock. A bill that cannot be made is RETURNED with why (P-08), never thrown.

import { money, type CurrencyCode } from '../../../packages/contracts/src/money';
import { rate } from '../../../packages/contracts/src/rate';
import { splitInclusive } from '../../../packages/pricing/src/pricing';
import { splitInclusiveWithCess, readCessRate } from '../../../packages/finance/src/cess';
import { buildTaxInvoice, type TaxInvoiceIdentity } from '../../../packages/receipt/src/tax-invoice';
import { billTaxInvoice, billReceipt, type BillTemplate, type BillTaxInvoice, type BillReceipt } from './bill-receipt';
import type { InvoiceLanguage, InvoiceRow, B2cDynamicQrSetting } from '../../../packages/receipt/src/index';
import type { CommittedBill } from './session';

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The store computer's answer for one copy (`POST /lane/bill-copies`, printed: true). */
export interface BillCopyAnswer {
  readonly copyNumber: number;
  readonly billNumber: string;
  readonly saleId: string;
  readonly billLaneId: string;
  readonly bill: Rec;
  readonly names: Readonly<Record<string, { readonly name: string; readonly nameTa?: string }>>;
}

/** The saved bill → the till's `CommittedBill` (with the tax invoice rebuilt when an identity is given), or why not. */
export function committedBillOf(answer: BillCopyAnswer, identity?: TaxInvoiceIdentity | null): { readonly ok: true; readonly bill: CommittedBill } | { readonly ok: false; readonly why: string } {
  const r = answer.bill;
  const currency = (str(r['currency']) ?? 'INR') as CurrencyCode;
  const rawLines = (Array.isArray(r['lines']) ? r['lines'] : []).filter(isObj);
  if (rawLines.length === 0) return { ok: false, why: 'the store computer\'s record of this bill has no lines' };
  const lines = rawLines.map((l) => {
    const productId = str(l['productId']) ?? '';
    return {
      productId, description: answer.names[productId]?.name ?? productId,
      quantityMinor: num(l['quantityMinor']) ?? 0, uom: str(l['uom']) ?? 'ea', unitPriceMinor: num(l['unitPriceMinor']) ?? 0,
      lineTotalMinor: num(l['lineTotalMinor']) ?? 0, taxRateBps: num(l['taxRateBps']) ?? 0, hsnCode: str(l['hsnCode']),
      cess: readCessRate(l['cess']), cessMinor: num(l['cessMinor']), huid: str(l['huid']), batchId: str(l['batchId']),
    };
  });
  const bands = new Map<number, { net: number; tax: number }>();
  try {
    for (const l of lines) {
      const band = bands.get(l.taxRateBps) ?? { net: 0, tax: 0 };
      if (l.cess !== undefined) {
        const s = splitInclusiveWithCess({ grossMinor: l.lineTotalMinor, gstRateBps: l.taxRateBps, cess: l.cess, quantity: l.quantityMinor });
        bands.set(l.taxRateBps, { net: band.net + s.taxableMinor, tax: band.tax + s.gstMinor });
      } else {
        const s = splitInclusive(money(l.lineTotalMinor, currency), rate(l.taxRateBps));
        bands.set(l.taxRateBps, { net: band.net + s.net.minor, tax: band.tax + s.tax.minor });
      }
    }
  } catch (e) {
    return { ok: false, why: `the saved bill's tax could not be laid out (${e instanceof Error ? e.message : String(e)})` };
  }
  const tenders = (Array.isArray(r['tenders']) ? r['tenders'] : []).filter(isObj).map((t) => ({
    kind: str(t['kind']) ?? 'unknown', amountMinor: num(t['amountMinor']) ?? 0, ...(str(t['machineRef']) === undefined ? {} : { machineRef: str(t['machineRef'])! }),
  }));
  const number = str(r['number']) ?? str(r['receiptNumber']) ?? answer.billNumber;
  const committedAt = str(r['committedAt']) ?? '';
  const laneId = str(r['laneId']) ?? answer.billLaneId;
  const cashierId = str(r['cashierId']) ?? '';
  const totalMinor = num(r['total']) ?? lines.reduce((n, l) => n + l.lineTotalMinor, 0);
  let taxInvoice: CommittedBill['taxInvoice'];
  if (identity !== undefined) {
    const built = buildTaxInvoice({
      identity, number, committedAt, laneId, cashierId,
      lines: lines.map((l) => ({
        description: l.description, ...(l.hsnCode === undefined ? {} : { hsnCode: l.hsnCode }), quantityMinor: l.quantityMinor, uom: l.uom,
        unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor, taxRateBps: l.taxRateBps, ...(l.cess === undefined ? {} : { cess: l.cess }),
      })),
      tenders, totalMinor,
    });
    // A copy is never a sale: say what the invoice lacks — the sale itself stands as it was saved.
    if (!built.ok) return { ok: false, why: `This copy cannot be printed as a tax invoice: ${built.problems.map((p) => p.words).join('; ')}. The sale stands; tell the manager.` };
    taxInvoice = built.doc;
  }
  const bill: CommittedBill = {
    number, saleId: str(r['id']) ?? answer.saleId, tradingDay: str(r['tradingDay']) ?? '', committedAt, laneId, cashierId, currency,
    lines: lines.map((l) => ({
      description: l.description, quantityMinor: l.quantityMinor, uom: l.uom, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor,
      ...(l.huid === undefined ? {} : { huid: l.huid }), ...(l.batchId === undefined ? {} : { batchId: l.batchId }), ...(l.cessMinor === undefined ? {} : { cessMinor: l.cessMinor }),
    })),
    taxBands: [...bands.entries()].sort((a, b) => a[0] - b[0]).map(([rateBps, b]) => ({ rateBps, netMinor: b.net, taxMinor: b.tax })),
    netMinor: num(r['netMinor']) ?? [...bands.values()].reduce((n, b) => n + b.net, 0),
    taxMinor: num(r['taxMinor']) ?? [...bands.values()].reduce((n, b) => n + b.tax, 0),
    ...(num(r['cessMinor']) === undefined ? {} : { cessMinor: num(r['cessMinor'])! }),
    totalMinor, tenders, ...(taxInvoice === undefined ? {} : { taxInvoice }),
  };
  return { ok: true, bill };
}

/** What the till prints for one copy: the bill's lines, marked as a copy, and which copy it is. */
export type BillCopyPrint =
  | {
    readonly ok: true; readonly lines: readonly string[]; readonly paper: string; readonly number: string; readonly copyNumber: number; readonly billLaneId: string;
    /** In real trading: the invoice's rows for the paper (each tagged with its Rule 46 field) and the paper's width. */
    readonly rows?: readonly InvoiceRow[]; readonly paperWidthMm?: number;
  }
  | { readonly ok: false; readonly why: string };

/** The copy, laid out for paper: the tax invoice marked DUPLICATE in real trading, else the receipt marked REPRINT. */
export function billCopyPrint(answer: BillCopyAnswer, options: {
  readonly realTrading: boolean; readonly identity?: TaxInvoiceIdentity | null; readonly language?: InvoiceLanguage;
  readonly template?: BillTemplate | null; readonly fssaiLicenceNo?: string; readonly b2cDynamicQr?: B2cDynamicQrSetting;
  readonly reason: string; readonly by: string; readonly at: string;
}): BillCopyPrint {
  const made = committedBillOf(answer, options.realTrading ? (options.identity ?? null) : undefined);
  if (!made.ok) return made;
  const copyLine = options.language === 'ta' ? `நகல் எண் ${answer.copyNumber} (Copy ${answer.copyNumber})` : `Copy ${answer.copyNumber}`;
  if (options.realTrading) {
    const inv: BillTaxInvoice = billTaxInvoice(made.bill, {
      template: options.template ?? null, duplicate: true, ...(options.language === undefined ? {} : { language: options.language }),
      ...(options.fssaiLicenceNo === undefined ? {} : { fssaiLicenceNo: options.fssaiLicenceNo }),
      ...(options.b2cDynamicQr === undefined ? {} : { b2cDynamicQr: options.b2cDynamicQr }),
    });
    if (!inv.ok) return inv;
    return {
      ok: true, lines: [...inv.lines, copyLine], rows: [...inv.rows, { kind: 'text', text: copyLine, fields: [] }], paper: inv.paper, paperWidthMm: inv.paperWidthMm,
      number: inv.number, copyNumber: answer.copyNumber, billLaneId: answer.billLaneId,
    };
  }
  const rec: BillReceipt = billReceipt(made.bill, options.template ?? null, {
    ...(options.fssaiLicenceNo === undefined ? {} : { fssaiLicenceNo: options.fssaiLicenceNo }),
    reprintOf: { reason: `${options.reason} — ${copyLine}`, by: options.by, at: options.at },
  });
  if (!rec.ok) return rec;
  return { ok: true, lines: rec.lines, paper: rec.paper, number: made.bill.number, copyNumber: answer.copyNumber, billLaneId: answer.billLaneId };
}
