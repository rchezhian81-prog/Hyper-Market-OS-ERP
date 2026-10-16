// Internal Committee complaints register and annual report (R2 addendum C20 · M25/M34).
//
// The law the repository names: the Sexual Harassment of Women at Workplace (Prevention, Prohibition and Redressal)
// Act, 2013 — "Internal Committee (>10 staff), confidential complaints register, annual report to District Officer
// by 31 Jan" (docs/requirements/WORLDWIDE_REQUIREMENTS_GAP_ANALYSIS.md row C20: POSH Act 2013 s.4, s.21 + Rule 14,
// s.26). Those are the only facts used here.
//
//   • **The register is append-only.** A complaint is received once; what happens to it is a new step (inquiry
//     started, disposed). Nothing is ever edited or removed (hard rules #2 and #6). A step after disposal is refused.
//   • **The annual report carries counts only** — never a name, a reference or a summary — so the employer and the
//     District Officer can read it without the register's confidentiality being broken.
//   • **The 31 January due date is surfaced** as an exception from 1 January until the report is recorded as filed,
//     and as overdue after it (P-03, P-08).
//
// Which calendar year a 31 January report covers (taken here as the year just ended) and the report's prescribed
// particulars are pending the CA's confirmation — see docs/requirements/hr-compliance-settings.md.
//
// Pure and deterministic: dates are passed in, no clock, no I/O. Who may read is the API's job (restricted roles,
// every read audited).

export const POSH_LAW = 'Sexual Harassment of Women at Workplace (Prevention, Prohibition and Redressal) Act, 2013';

/** A complaint as the Internal Committee received it. Confidential. */
export interface PoshComplaint {
  readonly complaintId: string;
  /** The store-local date the committee received it (YYYY-MM-DD). */
  readonly receivedOn: string;
  /** Who complained — an employee id or the committee's own reference. Confidential. */
  readonly complainantRef: string;
  /** Who the complaint is about. Confidential. */
  readonly respondentRef: string;
  /** The committee's own summary. Confidential. */
  readonly summary: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export type PoshStepKind = 'inquiry_started' | 'disposed';
/** How a disposed complaint ended — the register's own categories. */
export type PoshOutcome = 'upheld' | 'not_upheld' | 'conciliation' | 'withdrawn';
export const POSH_OUTCOMES: readonly PoshOutcome[] = Object.freeze(['upheld', 'not_upheld', 'conciliation', 'withdrawn']);

/** One step a complaint moved through — appended, never edited. */
export interface PoshStep {
  readonly complaintId: string;
  readonly stepId: string;
  readonly kind: PoshStepKind;
  /** The store-local date of the step. */
  readonly on: string;
  /** Required when `kind` is `disposed`. */
  readonly outcome?: PoshOutcome;
  /** The committee's note. Confidential. */
  readonly note?: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export type PoshStatus = 'received' | 'under_inquiry' | 'disposed';

export interface PoshComplaintView extends PoshComplaint {
  readonly status: PoshStatus;
  readonly outcome?: PoshOutcome;
  readonly disposedOn?: string;
  readonly steps: readonly PoshStep[];
}

const isDate = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

/** Fold a complaint and its steps into where it stands. */
export function poshComplaintView(complaint: PoshComplaint, steps: readonly PoshStep[]): PoshComplaintView {
  const mine = steps.filter((s) => s.complaintId === complaint.complaintId).sort((a, b) => a.on.localeCompare(b.on) || a.recordedAt.localeCompare(b.recordedAt));
  const disposed = mine.find((s) => s.kind === 'disposed');
  const status: PoshStatus = disposed !== undefined ? 'disposed' : mine.some((s) => s.kind === 'inquiry_started') ? 'under_inquiry' : 'received';
  return {
    ...complaint, status, steps: mine,
    ...(disposed?.outcome === undefined ? {} : { outcome: disposed.outcome }),
    ...(disposed === undefined ? {} : { disposedOn: disposed.on }),
  };
}

export type PoshStepRefusal = 'not_readable' | 'before_receipt' | 'already_disposed' | 'outcome_needed' | 'inquiry_already_started';

/** Decide whether a new step may be appended — refused with the reason in words, never overwriting. */
export function admitPoshStep(view: PoshComplaintView, step: Pick<PoshStep, 'kind' | 'on' | 'outcome'>): { readonly ok: true } | { readonly ok: false; readonly code: PoshStepRefusal; readonly detail: string } {
  if ((step.kind !== 'inquiry_started' && step.kind !== 'disposed') || !isDate(step.on)) {
    return { ok: false, code: 'not_readable', detail: 'A step needs a kind (inquiry_started or disposed) and a date (YYYY-MM-DD).' };
  }
  if (step.on < view.receivedOn) return { ok: false, code: 'before_receipt', detail: `The step is dated ${step.on}, before the complaint was received on ${view.receivedOn}.` };
  if (view.status === 'disposed') return { ok: false, code: 'already_disposed', detail: `The complaint was disposed of on ${view.disposedOn}; the register keeps that and takes no further step.` };
  if (step.kind === 'inquiry_started' && view.status === 'under_inquiry') return { ok: false, code: 'inquiry_already_started', detail: 'An inquiry is already recorded as started for this complaint.' };
  if (step.kind === 'disposed' && (step.outcome === undefined || !POSH_OUTCOMES.includes(step.outcome))) {
    return { ok: false, code: 'outcome_needed', detail: `Disposing of a complaint needs an outcome: ${POSH_OUTCOMES.join(', ')}.` };
  }
  return { ok: true };
}

/** The annual report — counts only, nothing that names or identifies anyone. */
export interface PoshAnnualReport {
  readonly year: number;
  readonly periodFrom: string;
  readonly periodTo: string;
  /** 31 January of the following year. */
  readonly dueBy: string;
  readonly law: string;
  /** Complaints still open on 1 January of the year (carried in). */
  readonly pendingAtStart: number;
  readonly receivedInYear: number;
  readonly disposedInYear: number;
  readonly disposedByOutcome: Readonly<Record<PoshOutcome, number>>;
  /** Complaints still open on 31 December of the year (carried forward). */
  readonly pendingAtEnd: number;
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly formatNote: string;
}

export const POSH_REPORT_FORMAT_NOTE =
  'Counts from the Internal Committee register for the calendar year. Which year a 31 January report covers and the report\'s prescribed particulars are pending the CA\'s confirmation.';

/** 31 January of the year after `year`. */
export const poshReportDueBy = (year: number): string => `${year + 1}-01-31`;

/** Generate the annual report for one calendar year from the register. */
export function poshAnnualReport(input: {
  readonly year: number;
  readonly complaints: readonly PoshComplaint[];
  readonly steps: readonly PoshStep[];
  readonly generatedAt: string;
  readonly generatedBy: string;
}): PoshAnnualReport {
  if (!Number.isInteger(input.year) || input.year < 2013 || input.year > 9998) throw new RangeError(`year must be a calendar year, got ${input.year}`);
  const from = `${input.year}-01-01`;
  const to = `${input.year}-12-31`;
  const views = input.complaints.map((c) => poshComplaintView(c, input.steps));
  const openOn = (v: PoshComplaintView, day: string, inclusive: boolean): boolean =>
    (inclusive ? v.receivedOn <= day : v.receivedOn < day) && (v.disposedOn === undefined || (inclusive ? v.disposedOn > day : v.disposedOn >= day));
  const disposedIn = views.filter((v) => v.disposedOn !== undefined && v.disposedOn >= from && v.disposedOn <= to);
  const byOutcome = Object.fromEntries(POSH_OUTCOMES.map((o) => [o, disposedIn.filter((v) => v.outcome === o).length])) as Record<PoshOutcome, number>;
  return {
    year: input.year, periodFrom: from, periodTo: to, dueBy: poshReportDueBy(input.year), law: POSH_LAW,
    pendingAtStart: views.filter((v) => openOn(v, from, false)).length,
    receivedInYear: views.filter((v) => v.receivedOn >= from && v.receivedOn <= to).length,
    disposedInYear: disposedIn.length,
    disposedByOutcome: byOutcome,
    pendingAtEnd: views.filter((v) => openOn(v, to, true)).length,
    generatedAt: input.generatedAt, generatedBy: input.generatedBy, formatNote: POSH_REPORT_FORMAT_NOTE,
  };
}

/** The employer's record that a year's report went to the District Officer. */
export interface PoshReportFiling {
  readonly year: number;
  readonly filedOn: string;
  /** The acknowledgement or reference the District Officer gave. */
  readonly reference: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface PoshReportException {
  readonly year: number;
  readonly dueBy: string;
  readonly state: 'due' | 'overdue';
  /** Whether a report has been generated for the year yet. */
  readonly generated: boolean;
  /** Days left until the due date (0 on the day); negative once overdue. */
  readonly daysToDue: number;
  readonly detail: string;
}

/**
 * The annual-report exceptions as of a date: every calendar year that has ended and whose report is not recorded
 * as filed — `due` up to and including 31 January, `overdue` after. The years checked run from the first year the
 * register (or the shop's start year) knows up to the year just ended, so a year with no complaints still owes its
 * report.
 */
export function poshReportExceptions(input: {
  readonly asOf: string;
  /** The first calendar year the shop owes a report for. */
  readonly firstYear: number;
  readonly generatedYears: readonly number[];
  readonly filings: readonly PoshReportFiling[];
}): readonly PoshReportException[] {
  if (!isDate(input.asOf)) throw new RangeError(`asOf must be YYYY-MM-DD, got "${input.asOf}"`);
  const lastEnded = Number(input.asOf.slice(0, 4)) - 1;
  const filed = new Set(input.filings.map((f) => f.year));
  const generated = new Set(input.generatedYears);
  const out: PoshReportException[] = [];
  for (let year = input.firstYear; year <= lastEnded; year += 1) {
    if (filed.has(year)) continue;
    const dueBy = poshReportDueBy(year);
    const daysToDue = Math.round((Date.parse(`${dueBy}T00:00:00Z`) - Date.parse(`${input.asOf}T00:00:00Z`)) / 86_400_000);
    const state = daysToDue >= 0 ? 'due' : 'overdue';
    out.push({
      year, dueBy, state, generated: generated.has(year), daysToDue,
      detail: state === 'due'
        ? `The Internal Committee annual report for ${year} is due to the District Officer by ${dueBy} (${daysToDue} day(s) left)${generated.has(year) ? '' : ' — not generated yet'}`
        : `The Internal Committee annual report for ${year} was due by ${dueBy} and is not recorded as filed — ${-daysToDue} day(s) overdue`,
    });
  }
  return out;
}
