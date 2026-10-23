// The B2C DYNAMIC QR on the bill (roadmap v2.1 A22 · CGST Notification 14/2020-CT · owner OB-326 "build, switched OFF").
//
// The rule: a taxpayer whose aggregate turnover passes ₹500 crore prints a dynamic QR code on every B2C invoice. SRE is far
// below it, so the switch stays OFF and nothing changes on SRE's bills; a shop on the system that passes the threshold
// turns it on in store setup and gives its collection details. The QR then carries what the notification lists — the
// supplier's GSTIN, the supplier's UPI ID, the payee's bank account and IFSC, the invoice number and date, the total
// invoice value, and the GST with its breakup (CGST, SGST, IGST, cess) — as a UPI payment link, so a customer's UPI app can
// read it and pay the exact bill.
//
// Never invented (P-08): while the switch is on and a detail is missing, no QR is printed and the till says which detail
// is "not set"; switched off, nothing is said or printed. The exact parameter names a bank's UPI app expects for the GST
// fields are confirmed with the bank and the CA before a shop switches it on (EXTERNAL); the encoder itself is ISO/IEC
// 18004 (`qr-code.ts`). Pure and offline: built from the committed invoice on the till, no network, no clock.

import type { TaxInvoiceDocument } from './tax-invoice';
import { encodeQr, qrSvg } from './qr-code';

/** The shop's switch and collection details, from store setup (`invoice.b2c_dynamic_qr.*`). */
export interface B2cDynamicQrSetting {
  readonly on: boolean;
  /** The supplier's UPI ID (virtual payment address), e.g. `shop@bank`. */
  readonly upiId?: string;
  /** The payee's bank account number the UPI ID settles to. */
  readonly bankAccountNo?: string;
  /** That account's IFSC. */
  readonly ifsc?: string;
}

export type B2cQrDetail = 'upi_id' | 'bank_account' | 'ifsc';

/** What the notification asks the QR to carry, as it is put on this bill. */
export interface B2cQrFields {
  readonly supplierGstin: string;
  readonly upiId: string;
  readonly bankAccountNo: string;
  readonly ifsc: string;
  readonly invoiceNo: string;
  readonly invoiceDate: string;
  readonly totalMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  readonly cessMinor: number;
}

export type B2cQrPlan =
  | { readonly state: 'off' }
  | { readonly state: 'not_set'; readonly missing: readonly B2cQrDetail[] }
  | { readonly state: 'ready'; readonly payload: string; readonly fields: B2cQrFields; readonly svg: string };

const UPI_ID = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$/;
const BANK_ACCOUNT = /^\d{9,18}$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Whether a setup answer is a UPI ID / bank account number / IFSC this check accepts (an empty answer means "not set"). */
export const isUpiId = (v: string): boolean => UPI_ID.test(v);
export const isBankAccountNo = (v: string): boolean => BANK_ACCOUNT.test(v);
export const isIfsc = (v: string): boolean => IFSC.test(v);

const rupees = (minor: number): string => (minor / 100).toFixed(2);

/** The details still to give before the QR can print, in a fixed order. */
export function b2cQrMissing(setting: B2cDynamicQrSetting): readonly B2cQrDetail[] {
  const missing: B2cQrDetail[] = [];
  if (setting.upiId === undefined || !isUpiId(setting.upiId.trim())) missing.push('upi_id');
  if (setting.bankAccountNo === undefined || !isBankAccountNo(setting.bankAccountNo.trim())) missing.push('bank_account');
  if (setting.ifsc === undefined || !isIfsc(setting.ifsc.trim().toUpperCase())) missing.push('ifsc');
  return missing;
}

/**
 * The QR for one committed B2C invoice: off (nothing to print), not set (which details are missing), or ready (the UPI
 * payment link, the fields it carries, and the symbol as SVG for the paper). Deterministic: the same invoice and setting
 * always give the same QR.
 */
export function b2cDynamicQrFor(setting: B2cDynamicQrSetting | undefined, doc: TaxInvoiceDocument): B2cQrPlan {
  if (setting === undefined || setting.on !== true) return { state: 'off' };
  const missing = b2cQrMissing(setting);
  if (missing.length > 0) return { state: 'not_set', missing };
  const fields: B2cQrFields = {
    supplierGstin: doc.supplier.gstin, upiId: setting.upiId!.trim(), bankAccountNo: setting.bankAccountNo!.trim(), ifsc: setting.ifsc!.trim().toUpperCase(),
    invoiceNo: doc.number, invoiceDate: doc.date, totalMinor: doc.totalMinor,
    cgstMinor: doc.cgstMinor, sgstMinor: doc.sgstMinor, igstMinor: doc.igstMinor, cessMinor: doc.cessMinor,
  };
  const params: readonly (readonly [string, string])[] = [
    ['pa', fields.upiId], ['pn', doc.supplier.legalName], ['am', rupees(fields.totalMinor)], ['cu', 'INR'],
    ['tr', fields.invoiceNo], ['tn', `Invoice ${fields.invoiceNo}`],
    ['gstIn', fields.supplierGstin], ['invoiceNo', fields.invoiceNo], ['invoiceDate', fields.invoiceDate],
    ['gstBrkUp', `CGST:${rupees(fields.cgstMinor)}|SGST:${rupees(fields.sgstMinor)}|IGST:${rupees(fields.igstMinor)}|CESS:${rupees(fields.cessMinor)}`],
    ['bankAcc', fields.bankAccountNo], ['ifsc', fields.ifsc],
  ];
  const payload = `upi://pay?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
  return { state: 'ready', payload, fields, svg: qrSvg(encodeQr(payload, { ecl: 'M' }), { moduleSize: 3, title: `Invoice ${fields.invoiceNo}` }) };
}
