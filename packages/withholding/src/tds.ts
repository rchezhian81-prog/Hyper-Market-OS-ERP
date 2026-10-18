// Income-tax TDS on payments to suppliers — rent (194-I), contractors (194-C), professionals (194-J) (R3 · A24 · Income-tax
// Act 1961 ss.194C/194I/194J). Deliberately NOT `packages/payroll` (salary TDS, s.192, is a different law and a different
// person's money).
//
// OB-143 "A" (owner, 16 Oct 2026, in writing): built now, SWITCHED OFF. The list of payees, sections, rates and thresholds
// is the chartered accountant's to fill; the owner switches it on. So nothing here knows a rate or a threshold — every
// number is the CA's configuration, and the list starts EMPTY. While switched off a payment deducts nothing and says so.
//
// Once on, the rules the signed sentence states, and only those:
//   • a payment to a payee tagged with a section deducts at that section's configured rate once the single-payment or the
//     financial-year aggregate threshold is crossed (whether the catch-up covers the earlier payments of the year is also
//     the CA's choice per section: `onCrossing`);
//   • the payee is paid NET — the payment still settles the gross the supplier is owed;
//   • the TDS is a LIABILITY until a challan reference is recorded against it;
//   • a quarterly 26Q summary is produced from the deductions and their challans;
//   • a payment to a payee flagged "TDS applicable" but with no section tag is REFUSED — never paid gross by default.
//
// Pure and deterministic: no clock, no I/O.

export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const SECTION_CODE = /^[0-9]{3}[A-Z]{0,2}$/;

/** What a section's catch-up covers when the aggregate threshold is first crossed — the CA's call, per section. */
export type OnCrossing = 'this_payment' | 'whole_aggregate';
export const ON_CROSSING: readonly OnCrossing[] = ['this_payment', 'whole_aggregate'];

/** One section as the CA sets it. Thresholds in paise; `null` = that threshold does not apply. */
export interface TdsSection {
  /** The Act's section as written on the 26Q, e.g. "194C", "194I", "194J". */
  readonly section: string;
  readonly label: string;
  /** The rate in basis points (1% = 100). */
  readonly rateBps: number;
  readonly singleThresholdMinor: number | null;
  readonly aggregateThresholdMinor: number | null;
  readonly onCrossing: OnCrossing;
}

/** A payee on the CA's list: whether TDS applies to them, under which section, and their PAN for the 26Q. */
export interface TdsPayee {
  readonly supplierId: string;
  readonly tdsApplicable: boolean;
  readonly section: string | null;
  readonly pan: string | null;
}

/** The CA's list, versioned and append-only — the latest version stands. */
export interface TdsConfig {
  readonly sections: readonly TdsSection[];
  readonly payees: readonly TdsPayee[];
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
}

/** The owner's switch. Off until the owner turns it on. */
export interface TdsSwitch {
  readonly enabled: boolean;
  readonly by: string;
  readonly at: string;
  readonly reason: string;
}

export const EMPTY_TDS_CONFIG: TdsConfig = Object.freeze({ sections: [], payees: [], version: 0, setBy: '', setAt: '' });

/** Every problem with a list the CA sends, by name — nothing is half-kept. */
export function validateTdsConfig(input: { readonly sections: readonly TdsSection[]; readonly payees: readonly TdsPayee[] }): readonly string[] {
  const problems: string[] = [];
  const codes = new Set<string>();
  for (const s of input.sections) {
    if (!SECTION_CODE.test(s.section)) problems.push(`section "${s.section}" is not a section of the Act as the 26Q writes it (e.g. 194C)`);
    if (codes.has(s.section)) problems.push(`section ${s.section} is listed twice`);
    codes.add(s.section);
    if (typeof s.label !== 'string' || s.label.trim() === '') problems.push(`section ${s.section} has no label`);
    if (!Number.isSafeInteger(s.rateBps) || s.rateBps <= 0 || s.rateBps > 10_000) problems.push(`section ${s.section}: the rate must be a whole number of basis points above 0 and at most 10000 (100%)`);
    for (const [k, v] of [['singleThresholdMinor', s.singleThresholdMinor], ['aggregateThresholdMinor', s.aggregateThresholdMinor]] as const) {
      if (v !== null && (!Number.isSafeInteger(v) || v < 0)) problems.push(`section ${s.section}: ${k} must be whole paise, or null when it does not apply`);
    }
    if (!ON_CROSSING.includes(s.onCrossing)) problems.push(`section ${s.section}: onCrossing must be ${ON_CROSSING.join(' or ')}`);
  }
  const payees = new Set<string>();
  for (const p of input.payees) {
    if (typeof p.supplierId !== 'string' || p.supplierId.trim() === '') { problems.push('a payee has no supplierId'); continue; }
    if (payees.has(p.supplierId)) problems.push(`payee ${p.supplierId} is listed twice`);
    payees.add(p.supplierId);
    if (p.section !== null && !codes.has(p.section)) problems.push(`payee ${p.supplierId} is tagged with section ${p.section}, which is not on the list`);
    if (!p.tdsApplicable && p.section !== null) problems.push(`payee ${p.supplierId} is tagged with a section but flagged "TDS not applicable"`);
    if (p.pan !== null && !PAN_PATTERN.test(p.pan)) problems.push(`payee ${p.supplierId}: the PAN is not a PAN`);
  }
  return problems;
}

/** Payees flagged "TDS applicable" with no section tag — a payment to any of them will be refused; said on the list. */
export function payeesWithoutSection(config: TdsConfig): readonly string[] {
  return config.payees.filter((p) => p.tdsApplicable && p.section === null).map((p) => p.supplierId).sort();
}

/** The Indian financial year (April–March) a date falls in, e.g. 2026-10-05 → "2026-27". */
export function financialYearOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export const QUARTERS: readonly Quarter[] = ['Q1', 'Q2', 'Q3', 'Q4'];
/** The 26Q quarter of a date: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar. */
export function quarterOf(date: string): Quarter {
  const m = Number(date.slice(5, 7));
  return m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4';
}

/** A deduction made on a payment — carried ON the payment record, so the payment and its TDS are one fact. */
export interface TdsDeduction {
  readonly section: string;
  readonly rateBps: number;
  /** What the rate was applied to (this payment, or the year's aggregate not yet deducted on). */
  readonly baseMinor: number;
  readonly tdsMinor: number;
  /** What the payee is actually paid: the gross less the TDS. */
  readonly netMinor: number;
}

export type TdsAssessment =
  | { readonly outcome: 'switched_off'; readonly detail: string }
  | { readonly outcome: 'not_applicable'; readonly detail: string }
  | { readonly outcome: 'below_threshold'; readonly section: string; readonly detail: string }
  | ({ readonly outcome: 'deducted'; readonly detail: string } & TdsDeduction)
  | { readonly outcome: 'refused'; readonly code: 'tds_section_missing' | 'tds_section_unknown' | 'tds_more_than_payment'; readonly detail: string };

/** Half-up rounding of base × rate, in paise. */
export const tdsOn = (baseMinor: number, rateBps: number): number => Math.floor((baseMinor * rateBps + 5_000) / 10_000);

/**
 * What TDS this payment carries. `priorInYear` is what this payee was already paid gross in the same financial year and
 * how much of that was already a base for a deduction — read from the payments themselves.
 */
export function assessTds(input: {
  readonly enabled: boolean;
  readonly config: TdsConfig;
  readonly supplierId: string;
  readonly grossMinor: number;
  readonly priorInYear: { readonly grossMinor: number; readonly deductedOnMinor: number };
}): TdsAssessment {
  if (!input.enabled) return { outcome: 'switched_off', detail: 'TDS on supplier payments is switched off (OB-143) — nothing is deducted' };
  const payee = input.config.payees.find((p) => p.supplierId === input.supplierId);
  if (payee === undefined || !payee.tdsApplicable) return { outcome: 'not_applicable', detail: `${input.supplierId} is not on the CA's list as a payee TDS applies to` };
  if (payee.section === null) {
    return { outcome: 'refused', code: 'tds_section_missing', detail: `${input.supplierId} is flagged "TDS applicable" but carries no section — the CA must tag the section before they can be paid` };
  }
  const section = input.config.sections.find((s) => s.section === payee.section);
  if (section === undefined) return { outcome: 'refused', code: 'tds_section_unknown', detail: `${input.supplierId} is tagged with section ${payee.section}, which is not on the CA's list` };
  const aggregate = input.priorInYear.grossMinor + input.grossMinor;
  const single = section.singleThresholdMinor !== null && input.grossMinor > section.singleThresholdMinor;
  const yearly = section.aggregateThresholdMinor !== null && aggregate > section.aggregateThresholdMinor;
  const noThreshold = section.singleThresholdMinor === null && section.aggregateThresholdMinor === null;
  if (!single && !yearly && !noThreshold) {
    return { outcome: 'below_threshold', section: section.section, detail: `section ${section.section}: this payment and the year so far are within the CA's thresholds — nothing is deducted yet` };
  }
  const baseMinor = section.onCrossing === 'whole_aggregate' && yearly ? aggregate - input.priorInYear.deductedOnMinor : input.grossMinor;
  const tdsMinor = tdsOn(baseMinor, section.rateBps);
  if (tdsMinor > input.grossMinor) {
    return { outcome: 'refused', code: 'tds_more_than_payment', detail: `section ${section.section}: the TDS due (${tdsMinor} paise on the year's aggregate) is more than this payment of ${input.grossMinor} — pay at least the TDS due` };
  }
  return {
    outcome: 'deducted', section: section.section, rateBps: section.rateBps, baseMinor, tdsMinor, netMinor: input.grossMinor - tdsMinor,
    detail: `section ${section.section} at ${(section.rateBps / 100).toFixed(2)}% on ${baseMinor} paise: ${tdsMinor} withheld, ${input.grossMinor - tdsMinor} paid`,
  };
}

/** A payment as the register reads it: who, when, how much gross, and the deduction it carried (when it carried one). */
export interface PaymentWithTds {
  readonly paymentId: string;
  readonly supplierId: string;
  readonly paidOn: string;
  readonly grossMinor: number;
  readonly tds?: TdsDeduction;
}

/** What this payee was paid in the financial year of `paidOn` before this payment — the aggregate the threshold reads. */
export function priorInYear(payments: readonly PaymentWithTds[], supplierId: string, paidOn: string, excludingPaymentId: string): { readonly grossMinor: number; readonly deductedOnMinor: number } {
  const fy = financialYearOf(paidOn);
  const same = payments.filter((p) => p.supplierId === supplierId && p.paymentId !== excludingPaymentId && financialYearOf(p.paidOn) === fy);
  return { grossMinor: same.reduce((s, p) => s + p.grossMinor, 0), deductedOnMinor: same.reduce((s, p) => s + (p.tds?.baseMinor ?? 0), 0) };
}

/** A challan the accountant records: the bank's reference for the TDS deposited, and which deductions it covers. */
export interface TdsChallan {
  readonly challanId: string;
  /** The challan identification as the bank gives it (BSR code, date, serial) — free text, required. */
  readonly challanRef: string;
  readonly depositedOn: string;
  readonly paymentIds: readonly string[];
  readonly amountMinor: number;
  readonly by: string;
  readonly at: string;
}

export interface TdsLiabilityRow extends TdsDeduction {
  readonly paymentId: string;
  readonly supplierId: string;
  readonly paidOn: string;
  readonly grossMinor: number;
  readonly challanId: string | null;
  readonly challanRef: string | null;
  readonly state: 'liability' | 'deposited';
}

/** Every deduction with its challan, or open as a liability. */
export function tdsLiabilities(payments: readonly PaymentWithTds[], challans: readonly TdsChallan[]): readonly TdsLiabilityRow[] {
  const covered = new Map<string, TdsChallan>();
  for (const c of challans) for (const id of c.paymentIds) if (!covered.has(id)) covered.set(id, c);
  return payments.filter((p): p is PaymentWithTds & { tds: TdsDeduction } => p.tds !== undefined && p.tds.tdsMinor > 0)
    .map((p) => {
      const c = covered.get(p.paymentId);
      return { ...p.tds, paymentId: p.paymentId, supplierId: p.supplierId, paidOn: p.paidOn, grossMinor: p.grossMinor, challanId: c?.challanId ?? null, challanRef: c?.challanRef ?? null, state: c === undefined ? 'liability' as const : 'deposited' as const };
    })
    .sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.paymentId.localeCompare(b.paymentId));
}

/** May this challan be recorded? Each payment must carry an open deduction, and the amount must be exactly their TDS. */
export function checkChallan(input: { readonly challan: Pick<TdsChallan, 'paymentIds' | 'amountMinor'>; readonly liabilities: readonly TdsLiabilityRow[] }): readonly string[] {
  const problems: string[] = [];
  if (input.challan.paymentIds.length === 0) problems.push('a challan covers at least one deduction');
  if (new Set(input.challan.paymentIds).size !== input.challan.paymentIds.length) problems.push('a deduction is named twice');
  let due = 0;
  for (const id of input.challan.paymentIds) {
    const row = input.liabilities.find((l) => l.paymentId === id);
    if (row === undefined) problems.push(`payment ${id} carries no TDS deduction`);
    else if (row.state === 'deposited') problems.push(`the TDS on payment ${id} is already covered by challan ${row.challanRef}`);
    else due += row.tdsMinor;
  }
  if (problems.length === 0 && due !== input.challan.amountMinor) problems.push(`the deductions named come to ${due} paise, not the ${input.challan.amountMinor} on the challan`);
  return problems;
}

export interface Form26qRow {
  readonly paymentId: string;
  readonly supplierId: string;
  /** The deductee's PAN from the CA's list; null when the list holds none — said on the row, never invented. */
  readonly pan: string | null;
  readonly section: string;
  readonly paidOn: string;
  readonly grossMinor: number;
  readonly rateBps: number;
  readonly tdsMinor: number;
  readonly challanRef: string | null;
}

export interface Form26qSummary {
  readonly financialYear: string;
  readonly quarter: Quarter;
  readonly rows: readonly Form26qRow[];
  readonly bySection: readonly { readonly section: string; readonly paidMinor: number; readonly tdsMinor: number; readonly depositedMinor: number; readonly count: number }[];
  readonly totalTdsMinor: number;
  readonly depositedMinor: number;
  /** Deductions in the quarter with no challan yet — the 26Q cannot be filed true until each has one. */
  readonly undeposited: readonly string[];
  /** Rows whose deductee has no PAN on the list. */
  readonly withoutPan: readonly string[];
}

/** The quarterly 26Q summary: every deduction in the quarter, by section, with its challan or the lack of one. */
export function form26qSummary(input: { readonly financialYear: string; readonly quarter: Quarter; readonly liabilities: readonly TdsLiabilityRow[]; readonly config: TdsConfig }): Form26qSummary {
  const panOf = new Map(input.config.payees.map((p) => [p.supplierId, p.pan]));
  const inQuarter = input.liabilities.filter((l) => financialYearOf(l.paidOn) === input.financialYear && quarterOf(l.paidOn) === input.quarter);
  const rows: Form26qRow[] = inQuarter.map((l) => ({
    paymentId: l.paymentId, supplierId: l.supplierId, pan: panOf.get(l.supplierId) ?? null, section: l.section, paidOn: l.paidOn,
    grossMinor: l.grossMinor, rateBps: l.rateBps, tdsMinor: l.tdsMinor, challanRef: l.challanRef,
  }));
  const sections = [...new Set(rows.map((r) => r.section))].sort();
  const bySection = sections.map((section) => {
    const of = inQuarter.filter((l) => l.section === section);
    return {
      section, count: of.length, paidMinor: of.reduce((s, l) => s + l.grossMinor, 0), tdsMinor: of.reduce((s, l) => s + l.tdsMinor, 0),
      depositedMinor: of.filter((l) => l.state === 'deposited').reduce((s, l) => s + l.tdsMinor, 0),
    };
  });
  return {
    financialYear: input.financialYear, quarter: input.quarter, rows, bySection,
    totalTdsMinor: rows.reduce((s, r) => s + r.tdsMinor, 0),
    depositedMinor: inQuarter.filter((l) => l.state === 'deposited').reduce((s, l) => s + l.tdsMinor, 0),
    undeposited: inQuarter.filter((l) => l.state === 'liability').map((l) => l.paymentId),
    withoutPan: rows.filter((r) => r.pan === null).map((r) => r.paymentId),
  };
}
