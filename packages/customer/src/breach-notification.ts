// Personal-data breach notification (C2 / M16·M34 — DPDP Act 2023 s.8(6) + the DPDP Rules). When personal
// data is breached, the law does not leave the response to judgement: the Data Fiduciary must tell the
// **Data Protection Board** and every affected **Data Principal**, on a clock, with prescribed content.
//
// This engine turns a breach event into the notification WORKFLOW those rules require:
//   • **Board — immediate intimation:** on becoming aware, without delay.
//   • **Board — detailed report:** within **72 hours** of becoming aware (discoveredAt + 72h), with the
//     prescribed facts (what happened, the circumstances, mitigation, findings, remedial measures).
//   • **Affected principals — notice:** without delay, describing the breach, its likely consequences, the
//     mitigation taken, the safety steps the person can take, and a contact point.
//
// It **drafts and tracks; a person sends** (the same discipline as the AI-draft and markdown work): every
// plan is `advisoryOnly: true` and there is no function here that transmits a notice. It is pure and
// deterministic — the deadline comes from `discoveredAt`, the "now" is supplied — so the same breach always
// produces the same obligations. The prescribed-content lists are named constants: a legal fact, so a rules
// change is a one-line edit with a failing test, never buried in logic.

const HOURS_72_MS = 72 * 60 * 60 * 1000;

/** The prescribed content of the Board's 72-hour detailed report (a missing field blocks a compliant filing). */
export const BOARD_REPORT_FIELDS = ['description', 'likelyConsequences', 'mitigationMeasures', 'remedialMeasures', 'contactPoint'] as const;
/** The prescribed content of the notice to each affected Data Principal. */
export const PRINCIPAL_NOTICE_FIELDS = ['description', 'likelyConsequences', 'mitigationMeasures', 'safetyMeasuresForPrincipals', 'contactPoint'] as const;

export interface BreachInput {
  readonly breachId: string;
  /** When the Data Fiduciary became AWARE of the breach (ISO) — the clock starts here, not when it occurred. */
  readonly discoveredAt: string;
  /** Now (ISO) — supplied, so the assessment is deterministic. */
  readonly asOf: string;
  readonly affectedDataCategories: readonly string[];
  readonly affectedPrincipalCount: number;
  // The content prepared for the notices — presence is checked against the prescribed fields above.
  readonly description?: string;
  readonly likelyConsequences?: string;
  readonly mitigationMeasures?: string;
  readonly remedialMeasures?: string;
  readonly safetyMeasuresForPrincipals?: string;
  readonly contactPoint?: string;
  // What has already been done (the caller tracks each filing; this never sends anything).
  readonly boardIntimatedAt?: string;
  readonly boardReportFiledAt?: string;
  readonly principalsNotifiedAt?: string;
}

export type BreachObligationKind = 'board_immediate_intimation' | 'board_72h_report' | 'affected_principal_notices';
export type BreachObligationStatus = 'done' | 'due' | 'overdue';

export interface BreachObligation {
  readonly obligation: BreachObligationKind;
  /** `immediately`, or an ISO deadline for the timed one. */
  readonly due: string;
  readonly status: BreachObligationStatus;
  /** Prescribed fields not yet provided — a compliant notice cannot go without them. */
  readonly missingContent: readonly string[];
  readonly detail: string;
}

export interface BreachNotificationPlan {
  readonly breachId: string;
  /** discoveredAt + 72 hours — the Board detailed-report deadline. */
  readonly reportDeadline: string;
  readonly obligations: readonly BreachObligation[];
  /** True only when every obligation is done and no prescribed content is missing. */
  readonly allSatisfied: boolean;
  /** Always true — this drafts and tracks the notifications; a person sends them (accountability stays human). */
  readonly advisoryOnly: true;
  readonly detail: string;
}

export class InvalidBreachInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBreachInputError';
  }
}

const isIso = (v: string): boolean => /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
const present = (v: string | undefined): boolean => typeof v === 'string' && v.trim() !== '';

/**
 * Assess the breach-notification obligations for a personal-data breach (DPDP s.8(6) / Rules). Returns the
 * Board immediate intimation, the 72-hour Board report (with its deadline and overdue state), and the
 * affected-principal notices, each with the prescribed content still missing. Advisory only — a person sends.
 */
export function assessBreachNotification(input: BreachInput): BreachNotificationPlan {
  if (!present(input.breachId)) throw new InvalidBreachInputError('a breach needs a breachId');
  if (!isIso(input.discoveredAt)) throw new InvalidBreachInputError('discoveredAt must be an ISO date-time');
  if (!isIso(input.asOf)) throw new InvalidBreachInputError('asOf must be an ISO date-time');
  if (!Array.isArray(input.affectedDataCategories)) throw new InvalidBreachInputError('affectedDataCategories must be a list');
  if (!Number.isInteger(input.affectedPrincipalCount) || input.affectedPrincipalCount < 0) {
    throw new InvalidBreachInputError('affectedPrincipalCount must be a whole number of at least 0');
  }

  const discovered = Date.parse(input.discoveredAt);
  const now = Date.parse(input.asOf);
  const reportDeadline = new Date(discovered + HOURS_72_MS).toISOString();

  const record = input as unknown as Record<string, string | undefined>;
  const missingOf = (fields: readonly string[]): string[] => fields.filter((f) => !present(record[f]));

  const obligations: BreachObligation[] = [
    {
      obligation: 'board_immediate_intimation',
      due: 'immediately',
      status: present(input.boardIntimatedAt) ? 'done' : 'due',
      missingContent: present(input.boardIntimatedAt) ? [] : missingOf(['description']),
      detail: present(input.boardIntimatedAt)
        ? `the Board was intimated at ${input.boardIntimatedAt}`
        : 'the Board must be intimated of the breach without delay',
    },
    {
      obligation: 'board_72h_report',
      due: reportDeadline,
      status: present(input.boardReportFiledAt) ? 'done' : (now > discovered + HOURS_72_MS ? 'overdue' : 'due'),
      missingContent: present(input.boardReportFiledAt) ? [] : missingOf(BOARD_REPORT_FIELDS),
      detail: present(input.boardReportFiledAt)
        ? `the detailed report was filed at ${input.boardReportFiledAt}`
        : `the detailed report to the Board is due by ${reportDeadline} (72 hours from discovery)`,
    },
    {
      obligation: 'affected_principal_notices',
      due: 'immediately',
      status: present(input.principalsNotifiedAt) ? 'done' : 'due',
      missingContent: present(input.principalsNotifiedAt) ? [] : missingOf(PRINCIPAL_NOTICE_FIELDS),
      detail: present(input.principalsNotifiedAt)
        ? `${input.affectedPrincipalCount} affected person(s) were notified at ${input.principalsNotifiedAt}`
        : `${input.affectedPrincipalCount} affected person(s) must be notified without delay`,
    },
  ];

  const allSatisfied = obligations.every((o) => o.status === 'done' && o.missingContent.length === 0);
  const outstanding = obligations.filter((o) => o.status !== 'done');

  return {
    breachId: input.breachId,
    reportDeadline,
    obligations,
    allSatisfied,
    advisoryOnly: true,
    detail: allSatisfied
      ? 'every breach-notification obligation is met'
      : `${outstanding.length} obligation(s) outstanding${outstanding.some((o) => o.status === 'overdue') ? ' (one is OVERDUE)' : ''} — draft and send them; the Board and every affected person must be told`,
  };
}
