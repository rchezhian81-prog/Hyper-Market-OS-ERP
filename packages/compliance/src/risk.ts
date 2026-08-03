// Risk, control, incident, remediation and attestation registers (M34-FR-04).
//
// The point of these registers is not the paperwork. It is that when something goes
// wrong, you can answer three questions immediately:
//
//   • WHICH CONTROL WAS SUPPOSED TO STOP THIS?  (incident → control)
//   • WHAT ARE WE DOING ABOUT IT, AND WHO OWNS IT?  (incident → remediation)
//   • DID ANYONE EVER CHECK THAT THE CONTROL WORKS?  (control → attestation)
//
// A register where those links are optional degrades into a list nobody reads. So an
// incident must name the control it defeated, remediation must name an owner and a
// date, and an attestation is immutable and dated — a tick with no date is not
// evidence that anything was checked.
//
// The quality gates read this (QG-06 security, QG-08 recovery): an OPEN CRITICAL RISK
// BLOCKS ITS GATE. That is the whole reason risks are tracked rather than discussed.
//
// Pure and deterministic: no clock, no I/O.

export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low';
export type RiskStatus = 'open' | 'mitigated' | 'accepted' | 'closed';

export interface Risk {
  readonly riskId: string;
  readonly title: string;
  readonly severity: RiskSeverity;
  readonly status: RiskStatus;
  /** The controls meant to hold this risk down. */
  readonly controlIds: readonly string[];
  readonly ownerUserId: string;
  /** Required to ACCEPT a risk — someone must say why, in their own name. */
  readonly acceptedBy?: string;
  readonly acceptanceRationale?: string;
  /** The quality gates this risk blocks while it is open and critical. */
  readonly blocksGates?: readonly string[];
}

export interface Control {
  readonly controlId: string;
  readonly title: string;
  /** Which requirement or principle this control implements. */
  readonly implements: string;
  readonly ownerUserId: string;
}

export type IncidentSeverity = 'sev1' | 'sev2' | 'sev3';

export interface Incident {
  readonly incidentId: string;
  readonly title: string;
  readonly severity: IncidentSeverity;
  readonly occurredAt: string;
  readonly detectedAt: string;
  /** The control that should have prevented it — required (M34-FR-04). */
  readonly controlId: string;
  readonly remediationIds?: readonly string[];
  readonly closedAt?: string;
}

export interface Remediation {
  readonly remediationId: string;
  readonly incidentId: string;
  readonly action: string;
  /** A named owner — remediation with no owner is a wish. */
  readonly ownerUserId: string;
  /** ISO-8601 date it is due. */
  readonly dueOn: string;
  readonly completedAt?: string;
}

/** A dated, immutable statement that someone checked a control (M34-FR-04). */
export interface Attestation {
  readonly attestationId: string;
  readonly controlId: string;
  readonly attestedBy: string;
  /** ISO-8601 UTC — a tick with no date is not evidence. */
  readonly attestedAt: string;
  readonly statement: string;
}

export class UnlinkedIncidentError extends Error {
  constructor(
    public readonly incidentId: string,
    public readonly controlId: string,
  ) {
    super(
      `Incident "${incidentId}" names control "${controlId}", which is not in the control register — an incident that links to nothing teaches nothing`,
    );
    this.name = 'UnlinkedIncidentError';
  }
}

export class UnownedRemediationError extends Error {
  constructor(public readonly remediationId: string) {
    super(`Remediation "${remediationId}" has no owner or no due date — that is a wish, not a plan`);
    this.name = 'UnownedRemediationError';
  }
}

export class UnjustifiedAcceptanceError extends Error {
  constructor(public readonly riskId: string) {
    super(
      `Risk "${riskId}" cannot be accepted without a named person and a written rationale — accepting a risk is a decision, and decisions have authors`,
    );
    this.name = 'UnjustifiedAcceptanceError';
  }
}

/** Record an incident, insisting on the link to the control it defeated. */
export function recordIncident(incident: Incident, controls: readonly Control[]): Incident {
  if (!controls.some((c) => c.controlId === incident.controlId)) {
    throw new UnlinkedIncidentError(incident.incidentId, incident.controlId);
  }
  return incident;
}

/** Record remediation, insisting on an owner and a date. */
export function recordRemediation(remediation: Remediation): Remediation {
  if (remediation.ownerUserId.trim() === '' || remediation.dueOn.trim() === '') {
    throw new UnownedRemediationError(remediation.remediationId);
  }
  return remediation;
}

/** Accept a risk — only in someone's name, with a written reason. */
export function acceptRisk(risk: Risk, acceptedBy: string, rationale: string): Risk {
  if (acceptedBy.trim() === '' || rationale.trim() === '') {
    throw new UnjustifiedAcceptanceError(risk.riskId);
  }
  return { ...risk, status: 'accepted', acceptedBy, acceptanceRationale: rationale };
}

export interface GateBlock {
  readonly gate: string;
  readonly riskId: string;
  readonly title: string;
  readonly severity: RiskSeverity;
  readonly ownerUserId: string;
  readonly reason: string;
}

/**
 * Which quality gates cannot pass right now, and why. An OPEN CRITICAL risk blocks
 * the gates it is registered against — an accepted one does not, because acceptance
 * is a recorded decision by a named person, not silence (M34-FR-04 acceptance).
 */
export function blockedGates(risks: readonly Risk[]): readonly GateBlock[] {
  const blocks: GateBlock[] = [];
  for (const risk of risks) {
    if (risk.status !== 'open') continue;
    if (risk.severity !== 'critical') continue;
    for (const gate of risk.blocksGates ?? []) {
      blocks.push({
        gate,
        riskId: risk.riskId,
        title: risk.title,
        severity: risk.severity,
        ownerUserId: risk.ownerUserId,
        reason: `open critical risk "${risk.title}" — ${risk.ownerUserId} owns it`,
      });
    }
  }
  return blocks;
}

/** True when a named gate has nothing open against it. */
export function gateCanPass(gate: string, risks: readonly Risk[]): boolean {
  return !blockedGates(risks).some((b) => b.gate === gate);
}

export interface ControlHealth {
  readonly controlId: string;
  readonly title: string;
  /** Incidents where this control failed to hold. */
  readonly incidentCount: number;
  /** Remediation still open past its due date. */
  readonly overdueRemediations: number;
  /** When it was last attested — undefined means nobody has ever checked it. */
  readonly lastAttestedAt?: string;
  /** True when it has never been attested, or the last attestation is stale. */
  readonly needsAttestation: boolean;
}

/**
 * The state of every control: has it failed, is the fix late, and has anyone
 * actually checked it lately? A control nobody has ever attested is reported as
 * such — an untested control is an assumption, not a control.
 */
export function controlHealth(input: {
  readonly controls: readonly Control[];
  readonly incidents: readonly Incident[];
  readonly remediations: readonly Remediation[];
  readonly attestations: readonly Attestation[];
  readonly asOfDate: string;
  /** Attestations older than this are stale — per tenant, chosen. */
  readonly attestationValidDays: number;
}): readonly ControlHealth[] {
  return input.controls.map((control): ControlHealth => {
    const incidents = input.incidents.filter((i) => i.controlId === control.controlId);
    const incidentIds = new Set(incidents.map((i) => i.incidentId));
    const overdue = input.remediations.filter(
      (r) => incidentIds.has(r.incidentId) && r.completedAt === undefined && r.dueOn < input.asOfDate,
    ).length;

    const attestations = input.attestations
      .filter((a) => a.controlId === control.controlId)
      .sort((a, b) => a.attestedAt.localeCompare(b.attestedAt));
    const last = attestations[attestations.length - 1];
    const staleFrom = new Date(
      Date.parse(`${input.asOfDate}T00:00:00Z`) - input.attestationValidDays * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);

    return {
      controlId: control.controlId,
      title: control.title,
      incidentCount: incidents.length,
      overdueRemediations: overdue,
      ...(last !== undefined ? { lastAttestedAt: last.attestedAt } : {}),
      needsAttestation: last === undefined || last.attestedAt.slice(0, 10) < staleFrom,
    };
  });
}

/** Remediation past its due date and still not done — the follow-through report. */
export function overdueRemediations(
  remediations: readonly Remediation[],
  asOfDate: string,
): readonly Remediation[] {
  return remediations.filter((r) => r.completedAt === undefined && r.dueOn < asOfDate);
}
