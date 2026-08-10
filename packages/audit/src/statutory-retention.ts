// Statutory retention clocks — longest statute wins + legal hold (roadmap v2.1 A28 / M34-FR-02).
//
// The same record is kept for the LONGEST period any law demands of it, not the shortest that happens
// to apply. A sales invoice is a GST record (72 months), an income-tax record (6 years) AND a book of
// account under the Companies Act (8 years) — so it is kept eight years, because destroying it at six
// to satisfy one statute breaches another. This resolves that: given the statutes that bind a record,
// it returns the governing (longest) period and the date the record may be reviewed for deletion.
//
// A LEGAL HOLD overrides the clock entirely. A record wanted for a dispute, an investigation or a case
// is not deletable however old it is — the hold beats the retention date, never the other way round.
// This never deletes anything; it reports when a record MAY be considered for deletion by a human.
// Pure and deterministic: "today" is passed in, there is no clock.

/** The statutes whose retention periods bind a hypermarket's records. */
export type Statute = 'gst' | 'income_tax' | 'companies_act';

export interface StatutoryPeriod {
  readonly statute: Statute;
  readonly label: string;
  readonly months: number;
}

/** Statutory minimums — legal facts, stated as named constants so a change is a one-line, tested edit. */
export const STATUTORY_RETENTION: Readonly<Record<Statute, StatutoryPeriod>> = {
  gst: { statute: 'gst', label: 'GST (CGST Act — 72 months)', months: 72 },
  income_tax: { statute: 'income_tax', label: 'Income-tax (6 years)', months: 72 },
  companies_act: { statute: 'companies_act', label: 'Companies Act (8 years)', months: 96 },
};

export interface EffectiveRetention {
  readonly months: number;
  readonly governingStatute: Statute;
  readonly label: string;
}

export interface StatutoryRetentionDecision {
  /** The date the record may first be reviewed for deletion (YYYY-MM-DD). */
  readonly retainUntil: string;
  readonly effective: EffectiveRetention;
  /** True only when the retention period has elapsed AND no legal hold applies. */
  readonly mayDelete: boolean;
  readonly blockedBy?: 'retention_period' | 'legal_hold';
  readonly detail: string;
}

export class InvalidRetentionInput extends Error {
  constructor(detail: string) {
    super(`Cannot assess retention: ${detail}`);
    this.name = 'InvalidRetentionInput';
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, label: string): void {
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new InvalidRetentionInput(`${label} "${value}" is not a valid YYYY-MM-DD date`);
  }
}

/** Add whole months to a YYYY-MM-DD date, clamping the day to the target month's last day. */
function addMonths(dateISO: string, months: number): string {
  const [y, m, d] = dateISO.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1; // 1-indexed target month
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

/**
 * The governing (longest) statutory retention period among those that bind a record (A28).
 *
 * @throws InvalidRetentionInput if no statutes are given or one is not recognised.
 */
export function longestStatutoryRetention(statutes: readonly Statute[]): EffectiveRetention {
  if (statutes.length === 0) throw new InvalidRetentionInput('at least one statute must apply to the record');
  const periods = statutes.map((s) => {
    const p = STATUTORY_RETENTION[s];
    if (p === undefined) throw new InvalidRetentionInput(`unknown statute "${String(s)}"`);
    return p;
  });
  const longest = periods.reduce((a, b) => (b.months > a.months ? b : a));
  return { months: longest.months, governingStatute: longest.statute, label: longest.label };
}

/**
 * Whether a record may be considered for deletion, honouring the longest applicable statute AND any
 * legal hold (A28). A hold blocks deletion regardless of the period; otherwise the record may be
 * reviewed only once the governing period has elapsed. Nothing is deleted here.
 *
 * @throws InvalidRetentionInput on a bad date or an empty/unknown statute set.
 */
export function statutoryRetentionDecision(input: {
  readonly recordDate: string;
  readonly statutes: readonly Statute[];
  readonly asOf: string;
  readonly onLegalHold?: boolean;
}): StatutoryRetentionDecision {
  assertDate(input.recordDate, 'recordDate');
  assertDate(input.asOf, 'asOf');
  const effective = longestStatutoryRetention(input.statutes);
  const retainUntil = addMonths(input.recordDate, effective.months);

  if (input.onLegalHold === true) {
    return {
      retainUntil, effective, mayDelete: false, blockedBy: 'legal_hold',
      detail: `under legal hold — a hold blocks deletion regardless of the ${effective.label} period (would otherwise run to ${retainUntil})`,
    };
  }
  if (input.asOf < retainUntil) {
    return {
      retainUntil, effective, mayDelete: false, blockedBy: 'retention_period',
      detail: `within the ${effective.label} period — keep until ${retainUntil}`,
    };
  }
  return {
    retainUntil, effective, mayDelete: true,
    detail: `past the ${effective.label} period (kept until ${retainUntil}) and not under hold — a human may now review it for deletion`,
  };
}
