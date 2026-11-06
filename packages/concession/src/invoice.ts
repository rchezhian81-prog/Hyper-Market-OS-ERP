// M27-FR-03 "settle concession counter sales, ISSUE INVOICES and reconcile" — the shop's invoice to a concessionaire for a
// period (Round 4d). Pure and deterministic; the routes are services/finance/src/concession-invoices.ts.
//
// The invoice charges what the contract says for the period (the rent, or the revenue share, or the higher of both, and the
// utilities), each line with the GST the CA set for it; it NETS that against the counter's sales the shop's tills collected
// on the concessionaire's behalf (a liability — never the shop's revenue); and it STATES the deposit held, never netting it
// (that is a commercial decision, not an invoice's). Which GST applies to rent, revenue share and utilities recovery, and
// whether within the state or across it, is the CA's to confirm: no rate is assumed here — the treatment is an input.

import type { PeriodCharge } from './concession';

/** The CA's GST treatment of a concession's charges — one version of it. Rates in basis points (1800 = 18%). */
export interface ConcessionGstTreatment {
  readonly rentBps: number;
  readonly revenueShareBps: number;
  readonly utilitiesBps: number;
  /** Within the state (CGST + SGST, half each) or across it (IGST). */
  readonly supply: 'intra_state' | 'inter_state';
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
  readonly note?: string;
}

export type InvoiceLineKind = 'rent' | 'revenue_share' | 'utilities';

export interface ConcessionInvoiceLine {
  readonly kind: InvoiceLineKind;
  readonly taxableMinor: number;
  readonly rateBps: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  readonly totalMinor: number;
}

export interface ConcessionInvoiceFigures {
  readonly lines: readonly ConcessionInvoiceLine[];
  readonly taxableMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  /** What the concessionaire is invoiced for the period, GST included. */
  readonly invoiceTotalMinor: number;
  /** The counter's sales the shop's tills took on their behalf in the period — held for them. */
  readonly collectedForThemMinor: number;
  /** Collected less the invoice: above 0 the shop pays them; below 0 they owe the shop. */
  readonly netPayableToThemMinor: number;
  /** Stated, never netted. */
  readonly depositHeldMinor: number;
}

/** GST on one line, rounded once per tax to the paisa (half up). Within the state each half is its own rounded figure. */
function taxOf(taxableMinor: number, rateBps: number, supply: ConcessionGstTreatment['supply']): { cgst: number; sgst: number; igst: number } {
  if (supply === 'inter_state') return { cgst: 0, sgst: 0, igst: Math.round((taxableMinor * rateBps) / 10_000) };
  const half = Math.round((taxableMinor * rateBps) / 20_000);
  return { cgst: half, sgst: half, igst: 0 };
}

/** The invoice's figures for a period charge, under the CA's treatment. Lines of nought are left out. */
export function concessionInvoiceFigures(input: {
  readonly charge: PeriodCharge;
  readonly collectedForThemMinor: number;
  readonly depositHeldMinor: number;
  readonly gst: Pick<ConcessionGstTreatment, 'rentBps' | 'revenueShareBps' | 'utilitiesBps' | 'supply'>;
}): ConcessionInvoiceFigures {
  const c = input.charge;
  // Which the contract actually charged: the rent, or the share (the higher of both picks one of the two — never the sum).
  const chargeKind: InvoiceLineKind = c.basis === 'fixed_rent' ? 'rent' : c.basis === 'revenue_share' ? 'revenue_share' : c.chargeMinor === c.fixedRentMinor && c.fixedRentMinor >= c.revenueShareMinor ? 'rent' : 'revenue_share';
  const raw: { kind: InvoiceLineKind; taxable: number; rate: number }[] = [
    { kind: chargeKind, taxable: c.chargeMinor, rate: chargeKind === 'rent' ? input.gst.rentBps : input.gst.revenueShareBps },
    { kind: 'utilities', taxable: c.utilitiesMinor, rate: input.gst.utilitiesBps },
  ];
  const lines = raw.filter((l) => l.taxable > 0).map((l): ConcessionInvoiceLine => {
    const t = taxOf(l.taxable, l.rate, input.gst.supply);
    return { kind: l.kind, taxableMinor: l.taxable, rateBps: l.rate, cgstMinor: t.cgst, sgstMinor: t.sgst, igstMinor: t.igst, totalMinor: l.taxable + t.cgst + t.sgst + t.igst };
  });
  const sum = (f: (l: ConcessionInvoiceLine) => number) => lines.reduce((n, l) => n + f(l), 0);
  const invoiceTotalMinor = sum((l) => l.totalMinor);
  return {
    lines, taxableMinor: sum((l) => l.taxableMinor), cgstMinor: sum((l) => l.cgstMinor), sgstMinor: sum((l) => l.sgstMinor), igstMinor: sum((l) => l.igstMinor),
    invoiceTotalMinor, collectedForThemMinor: input.collectedForThemMinor, netPayableToThemMinor: input.collectedForThemMinor - invoiceTotalMinor, depositHeldMinor: input.depositHeldMinor,
  };
}

/**
 * The posting components for the settlement journal (kind `concession_settlement`, through the accountant's posting map):
 * what was held for them comes off the liability; the charge and utilities are income; the GST is output tax; the rest is
 * payable to them — or, when they owe the shop, a receivable. Debits equal credits by construction.
 */
export function concessionSettlementComponents(f: ConcessionInvoiceFigures): Readonly<Record<string, number>> {
  const chargeLine = f.lines.find((l) => l.kind !== 'utilities');
  return {
    collected: f.collectedForThemMinor,
    receivable: f.netPayableToThemMinor < 0 ? -f.netPayableToThemMinor : 0,
    charge: chargeLine?.taxableMinor ?? 0,
    utilities: f.lines.find((l) => l.kind === 'utilities')?.taxableMinor ?? 0,
    cgst: f.cgstMinor, sgst: f.sgstMinor, igst: f.igstMinor,
    payable: f.netPayableToThemMinor > 0 ? f.netPayableToThemMinor : 0,
  };
}

/** The Indian financial year (April to March) a date falls in, as "2026-27". */
export function financialYearOf(day: string): string {
  const y = Number(day.slice(0, 4)); const m = Number(day.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The next number on the gap-free series for a financial year: CI/2026-27/0001, …, given the numbers already issued. */
export function nextConcessionInvoiceNumber(issued: readonly string[], financialYear: string): string {
  const prefix = `CI/${financialYear}/`;
  const used = issued.filter((n) => n.startsWith(prefix)).map((n) => Number(n.slice(prefix.length))).filter((n) => Number.isInteger(n));
  return `${prefix}${String((used.length === 0 ? 0 : Math.max(...used)) + 1).padStart(4, '0')}`;
}
