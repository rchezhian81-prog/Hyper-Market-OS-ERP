// The 30-day e-invoice reporting guard (R3 · A21 · owner decision OB-149 "A": a small guard, SWITCHED OFF).
//
// Signed acceptance (OB-188): "When switched on (turnover ₹10 crore or more), a B2B invoice or credit/debit note not
// reported to the e-invoice portal within 30 days is blocked and shown as an exception. While switched off, nothing is
// blocked, and the setting's state is shown on the GST page."
//
// The 30 days are the portal's rule for a business at ₹10 crore or more (GSTN advisory, from 1 April 2025): the IRP
// refuses to register a document dated more than 30 days before it is reported. The shop's band is ₹5–10 crore (D2),
// so the guard is OFF; the owner turns it on the year turnover reaches ₹10 crore. Pure — `today` is supplied.

import { daysBetween } from './filing-calendar';

/** The portal's reporting window, in days from the document date. A statutory number, not the owner's. */
export const EINVOICE_REPORTING_WINDOW_DAYS = 30;

export type EInvoiceReportingDocType = 'INV' | 'CRN' | 'DBN';

export type EInvoiceGuardDecision =
  | { readonly blocked: false; readonly switchedOn: boolean; readonly daysSinceDocument: number; readonly detail: string }
  | { readonly blocked: true; readonly switchedOn: true; readonly daysSinceDocument: number; readonly detail: string };

/**
 * May a B2B document dated `documentDate` still be reported on `today`? While the guard is switched off: always (and
 * it says it is off). While on: only within 30 days of the document date.
 */
export function judgeEInvoiceReporting(input: {
  readonly switchedOn: boolean;
  readonly documentDate: string;
  readonly today: string;
  readonly documentType: EInvoiceReportingDocType;
}): EInvoiceGuardDecision {
  const days = daysBetween(input.documentDate, input.today);
  const what = input.documentType === 'INV' ? 'invoice' : input.documentType === 'CRN' ? 'credit note' : 'debit note';
  if (!input.switchedOn) {
    return { blocked: false, switchedOn: false, daysSinceDocument: days, detail: `the 30-day e-invoice reporting guard is switched off (OB-149) — nothing is blocked` };
  }
  if (days > EINVOICE_REPORTING_WINDOW_DAYS) {
    return { blocked: true, switchedOn: true, daysSinceDocument: days, detail: `this ${what} is dated ${input.documentDate}, ${days} days ago — past the portal's ${EINVOICE_REPORTING_WINDOW_DAYS}-day reporting window, so it is blocked and listed as an exception` };
  }
  return { blocked: false, switchedOn: true, daysSinceDocument: days, detail: `within the ${EINVOICE_REPORTING_WINDOW_DAYS}-day reporting window (${days} day(s) since the document date)` };
}
