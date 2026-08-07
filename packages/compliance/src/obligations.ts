// Licence, certificate and compliance-evidence register (M34-FR-03 / §9.3).
//
// A hypermarket runs on paper it did not write: the food licence, the Legal
// Metrology stamping certificate for every weighing scale, the trade licence, the
// fire NOC, the shop-and-establishment registration. Any one of them expiring
// quietly can close the shop for a day or lose it a prosecution — and the way they
// expire is always the same. Nobody owned the date.
//
// So this register enforces two things the roadmap is explicit about:
//
//   1. EVERY OBLIGATION HAS A NAMED PERSON. Not "compliance", not "the manager" —
//      a person, with a name. An alert that reaches a role reaches nobody.
//   2. ALERTS ESCALATE AS THE DATE APPROACHES, and an expired licence keeps
//      shouting. A reminder that fires once, thirty days out, and never again is
//      how a licence expires.
//
// Nothing here deletes a record. An obligation that no longer applies is CLOSED
// with a reason and stays retrievable, because an inspector's question is usually
// about the period you no longer operate in (hard rule #6).
//
// Pure and deterministic: the date is passed in, there is no clock.

export type ObligationKind =
  | 'licence'
  | 'certificate'
  | 'registration'
  | 'inspection'
  | 'calibration'
  | 'insurance'
  | 'training';

export type ObligationStatus = 'active' | 'closed';

/** Who is accountable — a person, never a role. */
export interface ResponsiblePerson {
  readonly userId: string;
  readonly name: string;
  /** Who is told when the responsible person does not act in time. */
  readonly escalatesToUserId?: string;
}

/** A document, photograph or certificate proving the obligation is met. */
export interface EvidenceRef {
  readonly evidenceId: string;
  readonly description: string;
  /** ISO-8601 UTC when it was recorded. Evidence is never removed. */
  readonly recordedAt: string;
}

export interface Obligation {
  readonly obligationId: string;
  readonly tenantId: string;
  readonly branchId: string | null;
  readonly kind: ObligationKind;
  readonly name: string;
  /** The authority that issues or inspects it, e.g. "FSSAI", "Legal Metrology". */
  readonly authority: string;
  readonly reference?: string;
  /** ISO-8601 date (YYYY-MM-DD). */
  readonly validFrom: string;
  /** ISO-8601 date. Omit for an obligation with no expiry (rare, and stated). */
  readonly expiresOn?: string;
  readonly responsible: ResponsiblePerson;
  readonly evidence?: readonly EvidenceRef[];
  readonly status: ObligationStatus;
  /** Why it was closed — required to close, retained for ever. */
  readonly closedReason?: string;
  readonly closedAt?: string;
}

export class MissingResponsiblePersonError extends Error {
  constructor(public readonly obligationId: string) {
    super(
      `Obligation "${obligationId}" has no named responsible person — an alert that reaches a role reaches nobody (M34-FR-03)`,
    );
    this.name = 'MissingResponsiblePersonError';
  }
}

export class CannotDeleteObligationError extends Error {
  constructor(public readonly obligationId: string) {
    super(
      `Obligation "${obligationId}" can be closed with a reason, never removed — an inspector's question is usually about the period you no longer operate in (hard rule #6)`,
    );
    this.name = 'CannotDeleteObligationError';
  }
}

/** How urgently an obligation needs attention. */
export type AlertLevel = 'expired' | 'critical' | 'warning' | 'notice';

export interface ExpiryAlert {
  readonly obligationId: string;
  readonly name: string;
  readonly authority: string;
  readonly branchId: string | null;
  readonly expiresOn: string;
  /** Negative once it has expired. */
  readonly daysRemaining: number;
  readonly level: AlertLevel;
  /** The person who must act — by name (M34-FR-03 acceptance). */
  readonly responsible: ResponsiblePerson;
  /** Set once the escalation threshold has passed and someone else must be told. */
  readonly escalatedToUserId?: string;
  /** No evidence on file is itself a finding, separate from the expiry date. */
  readonly evidenceMissing: boolean;
  readonly message: string;
}

/** Per-tenant alerting thresholds — chosen, never hard-coded. */
export interface AlertPolicy {
  /** Start reminding this many days before expiry. */
  readonly noticeDays: number;
  readonly warningDays: number;
  readonly criticalDays: number;
  /** Escalate to the named deputy once inside this many days. */
  readonly escalateWithinDays: number;
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  noticeDays: 90,
  warningDays: 45,
  criticalDays: 15,
  escalateWithinDays: 7,
};

function daysBetweenDates(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Validate an obligation before it enters the register. */
export function registerObligation(obligation: Obligation): Obligation {
  if (obligation.responsible.userId.trim() === '' || obligation.responsible.name.trim() === '') {
    throw new MissingResponsiblePersonError(obligation.obligationId);
  }
  return obligation;
}

/**
 * Close an obligation that no longer applies. The record stays in the register for
 * ever with its reason — this is the only way to take one out of the alert list.
 */
export function closeObligation(obligation: Obligation, reason: string, at: string): Obligation {
  if (reason.trim() === '') {
    throw new CannotDeleteObligationError(obligation.obligationId);
  }
  return { ...obligation, status: 'closed', closedReason: reason, closedAt: at };
}

/**
 * What needs attention, worst first. An expired licence stays in the list and keeps
 * escalating — it does not drop off once the date passes, which is precisely when
 * most systems go quiet (M34-FR-03 acceptance).
 */
export function expiryAlerts(
  obligations: readonly Obligation[],
  asOfDate: string,
  policy: AlertPolicy = DEFAULT_ALERT_POLICY,
): readonly ExpiryAlert[] {
  const alerts: ExpiryAlert[] = [];

  for (const obligation of obligations) {
    if (obligation.status === 'closed') continue;
    if (obligation.expiresOn === undefined) continue;

    const daysRemaining = daysBetweenDates(asOfDate, obligation.expiresOn);
    if (daysRemaining > policy.noticeDays) continue;

    const level: AlertLevel =
      daysRemaining < 0
        ? 'expired'
        : daysRemaining <= policy.criticalDays
          ? 'critical'
          : daysRemaining <= policy.warningDays
            ? 'warning'
            : 'notice';

    const escalate =
      daysRemaining <= policy.escalateWithinDays && obligation.responsible.escalatesToUserId !== undefined;
    const evidenceMissing = (obligation.evidence ?? []).length === 0;

    const message =
      daysRemaining < 0
        ? `${obligation.name} (${obligation.authority}) EXPIRED ${-daysRemaining} days ago — ${obligation.responsible.name} must renew it now`
        : `${obligation.name} (${obligation.authority}) expires in ${daysRemaining} days — ${obligation.responsible.name} to renew`;

    alerts.push({
      obligationId: obligation.obligationId,
      name: obligation.name,
      authority: obligation.authority,
      branchId: obligation.branchId,
      expiresOn: obligation.expiresOn,
      daysRemaining,
      level,
      responsible: obligation.responsible,
      ...(escalate ? { escalatedToUserId: obligation.responsible.escalatesToUserId } : {}),
      evidenceMissing,
      message,
    });
  }

  // Worst first: the most overdue at the top, so the list is read in the right order.
  return alerts.sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/** Obligations with nothing on file to show an inspector — a finding in itself. */
export function missingEvidence(obligations: readonly Obligation[]): readonly Obligation[] {
  return obligations.filter((o) => o.status === 'active' && (o.evidence ?? []).length === 0);
}

/** Add evidence. Evidence is only ever added — never replaced or removed. */
export function attachEvidence(obligation: Obligation, evidence: EvidenceRef): Obligation {
  return { ...obligation, evidence: [...(obligation.evidence ?? []), evidence] };
}

/** True when every active obligation for a branch is currently valid. */
export function isCompliant(
  obligations: readonly Obligation[],
  asOfDate: string,
  branchId?: string,
): boolean {
  return !obligations.some(
    (o) =>
      o.status === 'active' &&
      (branchId === undefined || o.branchId === branchId) &&
      o.expiresOn !== undefined &&
      o.expiresOn < asOfDate,
  );
}
