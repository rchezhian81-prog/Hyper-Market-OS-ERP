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
// The quality gates read this (QG-06 security, QG-08 recovery): an OPEN CRITICAL OR HIGH RISK
// BLOCKS ITS GATE. That is the whole reason risks are tracked rather than discussed. Roadmap §22
// QG-06 says "zero open critical/high findings at go-live" and §35.1 "zero unresolved
// critical/high findings", so a high blocks exactly as a critical does (OB-288 lane gates, QG-06).
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
  /** OB-330: a critical or high risk's acceptance also carries the named security reviewer's signature. */
  readonly securityReviewedBy?: string;
  readonly securityReviewRationale?: string;
  /** The quality gates this risk blocks while it is open and critical or high (§22 QG-06, §35.1). */
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

/** The severities that block a gate while open: §22 QG-06 "zero open critical/high findings". */
export const GATE_BLOCKING_SEVERITIES: readonly RiskSeverity[] = Object.freeze(['critical', 'high']);

/**
 * Which quality gates cannot pass right now, and why. An OPEN CRITICAL OR HIGH risk blocks
 * the gates it is registered against — an accepted one does not, because acceptance
 * is a recorded decision by a named person, not silence (M34-FR-04 acceptance).
 */
export function blockedGates(risks: readonly Risk[]): readonly GateBlock[] {
  const blocks: GateBlock[] = [];
  for (const risk of risks) {
    if (risk.status !== 'open') continue;
    if (!GATE_BLOCKING_SEVERITIES.includes(risk.severity)) continue;
    for (const gate of risk.blocksGates ?? []) {
      blocks.push({
        gate,
        riskId: risk.riskId,
        title: risk.title,
        severity: risk.severity,
        ownerUserId: risk.ownerUserId,
        reason: `open ${risk.severity} risk "${risk.title}" — ${risk.ownerUserId} owns it`,
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

// ── OB-330 (owner, 23 Oct 2026, in writing · roadmap §35.1): accepting a critical or high risk takes TWO signatures ──────
//
// The owner AND a named security reviewer. Until the owner names a reviewer (entered on screen, never in code), no critical
// or high risk can be accepted at all — it must be fixed. The two signatures are two different people; each is for the
// risk as it stood when they signed (a risk re-stated since is a new decision); the reviewer who signs must be the one
// named NOW. A medium or low risk is accepted by one compliance manager, as before.

/** The severities whose acceptance needs both signatures. */
export const TWO_SIGNATURE_SEVERITIES: readonly RiskSeverity[] = GATE_BLOCKING_SEVERITIES;
export const needsTwoSignatures = (risk: Pick<Risk, 'severity'>): boolean => TWO_SIGNATURE_SEVERITIES.includes(risk.severity);

/** The security reviewer the owner named — a person head office knows, never the owner naming them. */
export interface SecurityReviewer {
  readonly userId: string;
  readonly displayName: string;
  readonly namedBy: string;
  readonly namedAt: string;
  readonly reason: string;
}

export type AcceptanceSignatureRole = 'owner' | 'security_reviewer';

/** One signature on a critical/high risk's acceptance — append-only; it counts only for the risk state it was given for. */
export interface RiskAcceptanceSignature {
  readonly riskId: string;
  readonly as: AcceptanceSignatureRole;
  readonly signedBy: string;
  readonly rationale: string;
  readonly signedAt: string;
  /** The risk as it stood when signed (title, severity, gates…) — a re-stated risk needs signing again. */
  readonly riskDigest: string;
}

/** The risk state a signature is bound to. */
export const riskStateDigest = (r: Risk): string =>
  [r.riskId, r.title, r.severity, r.status, r.ownerUserId, [...r.controlIds].join('.'), [...(r.blocksGates ?? [])].join('.')].join('|');

export type TwoSignatureRefusal =
  | 'not_a_two_signature_risk' | 'risk_not_open' | 'must_be_fixed_no_security_reviewer' | 'owner_signs_as_owner'
  | 'not_the_named_security_reviewer' | 'one_person_cannot_sign_twice' | 'acceptance_needs_a_rationale';

export type TwoSignatureJudgement =
  | { readonly ok: false; readonly refusal: TwoSignatureRefusal; readonly detail: string }
  /** The signature is good. `accepted` is the risk, accepted in the owner's name with the reviewer's, when both are now in. */
  | { readonly ok: true; readonly signature: RiskAcceptanceSignature; readonly accepted?: Risk; readonly waitingFor?: AcceptanceSignatureRole };

/**
 * Judge one signature on a critical or high risk's acceptance. `signerIsOwner` is from the signer's own grants (never the
 * request); `reviewer` is the one named now (undefined: nobody); `prior` is every signature already recorded on this risk.
 */
export function judgeAcceptanceSignature(input: {
  readonly risk: Risk;
  readonly as: AcceptanceSignatureRole;
  readonly signer: string;
  readonly signerIsOwner: boolean;
  readonly rationale: string;
  readonly reviewer: SecurityReviewer | undefined;
  readonly prior: readonly RiskAcceptanceSignature[];
  readonly at: string;
}): TwoSignatureJudgement {
  const { risk } = input;
  const refuse = (refusal: TwoSignatureRefusal, detail: string): TwoSignatureJudgement => ({ ok: false, refusal, detail });
  if (!needsTwoSignatures(risk)) return refuse('not_a_two_signature_risk', `risk ${risk.riskId} is ${risk.severity}; one compliance manager accepts it`);
  if (risk.status !== 'open') return refuse('risk_not_open', `risk ${risk.riskId} is ${risk.status}, not open — there is nothing to accept`);
  if (input.reviewer === undefined) {
    return refuse('must_be_fixed_no_security_reviewer', `no security reviewer is named, so a ${risk.severity} risk cannot be accepted — it must be fixed (OB-330). The owner names the reviewer on the Risk acceptance screen`);
  }
  if (input.rationale.trim() === '') return refuse('acceptance_needs_a_rationale', 'a signature on an acceptance needs a written reason');
  if (input.as === 'owner' && !input.signerIsOwner) return refuse('owner_signs_as_owner', `${input.signer} does not hold the owner's role — the first signature on a ${risk.severity} risk is the owner's`);
  if (input.as === 'security_reviewer' && input.signer !== input.reviewer.userId) {
    return refuse('not_the_named_security_reviewer', `${input.signer} is not the named security reviewer (${input.reviewer.displayName}, ${input.reviewer.userId})`);
  }
  const digest = riskStateDigest(risk);
  const live = input.prior.filter((s) => s.riskId === risk.riskId && s.riskDigest === digest && (s.as === 'owner' || s.signedBy === input.reviewer!.userId));
  const other = live.filter((s) => s.as !== input.as).at(-1);
  if (other !== undefined && other.signedBy === input.signer) {
    return refuse('one_person_cannot_sign_twice', `${input.signer} already signed this acceptance as the ${other.as === 'owner' ? 'owner' : 'security reviewer'} — the second signature is another person's`);
  }
  const signature: RiskAcceptanceSignature = { riskId: risk.riskId, as: input.as, signedBy: input.signer, rationale: input.rationale.trim(), signedAt: input.at, riskDigest: digest };
  if (other === undefined) return { ok: true, signature, waitingFor: input.as === 'owner' ? 'security_reviewer' : 'owner' };
  const ownerSig = input.as === 'owner' ? signature : other;
  const reviewerSig = input.as === 'owner' ? other : signature;
  const accepted: Risk = {
    ...acceptRisk(risk, ownerSig.signedBy, ownerSig.rationale),
    securityReviewedBy: reviewerSig.signedBy, securityReviewRationale: reviewerSig.rationale,
  };
  return { ok: true, signature, accepted };
}

/** Where a critical/high risk's acceptance stands — for the screen and the register. */
export function acceptanceSignatures(risk: Risk, prior: readonly RiskAcceptanceSignature[], reviewer: SecurityReviewer | undefined): {
  readonly needsTwo: boolean; readonly owner: RiskAcceptanceSignature | null; readonly securityReviewer: RiskAcceptanceSignature | null;
  readonly mustBeFixed: boolean;
} {
  const digest = riskStateDigest(risk);
  const live = prior.filter((s) => s.riskId === risk.riskId && s.riskDigest === digest);
  return {
    needsTwo: needsTwoSignatures(risk),
    owner: live.filter((s) => s.as === 'owner').at(-1) ?? null,
    securityReviewer: reviewer === undefined ? null : live.filter((s) => s.as === 'security_reviewer' && s.signedBy === reviewer.userId).at(-1) ?? null,
    mustBeFixed: needsTwoSignatures(risk) && reviewer === undefined,
  };
}
