// The gate-decision register (QG-12 · roadmap §22, §36; OB-288 gates lane).
//
// Roadmap §22 QG-12 Owner: "Every gate ends GO, HOLD or REWORK with evidence; silence is not approval."
// §36 RACI: the Owner/Director is accountable for "stage GO/HOLD/REWORK, critical risk and final acceptance".
//
// So for every quality gate (QG-01 … QG-12) and every release (R0 … R8) this register holds the decision a NAMED
// person made, the evidence it rests on and the reason. The rules:
//
//   • There is NO default. A gate nobody has decided reads "undecided" — never GO, never HOLD. Silence is not
//     approval, and it is not refusal either: it is a decision still owed, and the register says so.
//   • Every decision — GO, HOLD or REWORK — needs at least one piece of evidence (a label and where to find it)
//     and a written reason. A decision without evidence is an opinion.
//   • GO is refused while anything blocks the gate: an open critical/high risk registered against it, an open
//     critical/high security finding, or a gate check that reads HOLD (QG-08 rehearsals). The blockers are named.
//   • Decisions are append-only. A later decision supersedes an earlier one; the history is kept (hard rule #2).
//     A GO that something blocks AFTER it was given is shown as "GO, now blocked" — never quietly still GO (P-08).
//
// Pure and deterministic: no clock, no I/O, no runtime imports.

export type GateDecisionKind = 'GO' | 'HOLD' | 'REWORK';
export const GATE_DECISION_KINDS: readonly GateDecisionKind[] = Object.freeze(['GO', 'HOLD', 'REWORK']);

export interface QualityGate {
  readonly gate: string;
  readonly name: string;
  /** The roadmap's own pass condition (§22), word for word. */
  readonly passCondition: string;
}

/** Roadmap §22, the twelve quality gates and their pass conditions, verbatim. */
export const QUALITY_GATES: readonly QualityGate[] = Object.freeze([
  { gate: 'QG-01', name: 'Requirements', passCondition: 'No build without approved ID, rules, actors, errors, permissions and testable acceptance.' },
  { gate: 'QG-02', name: 'UX', passCondition: 'Frequent action ≤3 interactions where feasible; cashier training/performance targets proven.' },
  { gate: 'QG-03', name: 'Code', passCondition: 'Review, automated tests, security scans, SBOM and documentation green.' },
  { gate: 'QG-04', name: 'Offline', passCondition: 'Core sale survives internet/cloud outage; sync retries produce one business effect.' },
  { gate: 'QG-05', name: 'Performance', passCondition: 'Scan-to-line p95 ≤300 ms target on certified pilot hardware; audited targets for other journeys.' },
  { gate: 'QG-06', name: 'Security', passCondition: 'Zero open critical/high findings at go-live; independent penetration test before customer launch.' },
  { gate: 'QG-07', name: 'Data', passCondition: 'Migration, stock, financial, tax and loyalty control totals signed.' },
  { gate: 'QG-08', name: 'Recovery', passCondition: 'Backup restore, store recovery, rollback and incident escalation rehearsed.' },
  { gate: 'QG-09', name: 'Adoption', passCondition: 'Role curriculum, competency, floor support and SOP acknowledgements complete.' },
  { gate: 'QG-10', name: 'Production', passCondition: 'Health, smoke, reconciliation, monitoring and rollback verified after every release.' },
  { gate: 'QG-11', name: 'AI', passCondition: 'Accuracy/safety evaluations, authority, evidence, human override, budgets and kill switch pass.' },
  { gate: 'QG-12', name: 'Owner', passCondition: 'Every gate ends GO, HOLD or REWORK with evidence; silence is not approval.' },
].map((g) => Object.freeze(g)));

/** Roadmap release plan R0 … R8. */
export const RELEASES: readonly string[] = Object.freeze(['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']);

export interface EvidenceLink {
  /** What it is, in words ("CI run 1234 — all scans green", "DR drill register Q4"). */
  readonly label: string;
  /** Where to find it: a URL, a file path in the repository, a register id. */
  readonly ref: string;
}

/** Something that stops a gate passing right now. */
export interface GateBlocker {
  readonly gate: string;
  readonly kind: 'risk' | 'finding' | 'check';
  /** The risk id, finding id or check name. */
  readonly ref: string;
  readonly reason: string;
}

export interface GateDecision {
  readonly decisionId: string;
  readonly gate: string;
  readonly release: string;
  readonly decision: GateDecisionKind;
  readonly evidence: readonly EvidenceLink[];
  readonly rationale: string;
  /** The authenticated person who decided — never a field the client sends. */
  readonly decidedBy: string;
  readonly decidedAt: string;
  /** What blocked the gate when the decision was made (empty for a GO — a GO cannot be made over a blocker). */
  readonly blockersAtDecision: readonly GateBlocker[];
}

export class UnknownGateError extends Error {
  constructor(public readonly gate: string) {
    super(`"${gate}" is not one of the twelve quality gates (QG-01 … QG-12, roadmap §22)`);
    this.name = 'UnknownGateError';
  }
}

export class UnknownReleaseError extends Error {
  constructor(public readonly release: string) {
    super(`"${release}" is not a release in the roadmap plan (R0 … R8)`);
    this.name = 'UnknownReleaseError';
  }
}

export class DecisionNotReadableError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`A gate decision needs: ${problems.join('; ')}`);
    this.name = 'DecisionNotReadableError';
  }
}

export class GoWhileBlockedError extends Error {
  constructor(public readonly gate: string, public readonly blockers: readonly GateBlocker[]) {
    super(`${gate} cannot be GO while ${blockers.length} thing(s) block it: ${blockers.map((b) => b.reason).join('; ')}`);
    this.name = 'GoWhileBlockedError';
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function assertGate(gate: string): QualityGate {
  const g = QUALITY_GATES.find((q) => q.gate === gate);
  if (g === undefined) throw new UnknownGateError(gate);
  return g;
}

export function assertRelease(release: string): string {
  if (!RELEASES.includes(release)) throw new UnknownReleaseError(release);
  return release;
}

/** Read the evidence list from an untrusted body; undefined when it is not a list of { label, ref }. */
export function readEvidence(raw: unknown): readonly EvidenceLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: EvidenceLink[] = [];
  for (const e of raw as unknown[]) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return undefined;
    const r = e as Record<string, unknown>;
    if (!isStr(r['label']) || !isStr(r['ref'])) return undefined;
    out.push({ label: r['label'].trim().slice(0, 300), ref: r['ref'].trim().slice(0, 500) });
  }
  return out;
}

/**
 * Make a decision. Refuses an unknown gate or release, a decision without evidence, a reason or a named decider,
 * and a GO while anything blocks the gate. `blockers` is every blocker the caller knows of; only this gate's count.
 */
export function decideGate(input: {
  readonly decisionId: string;
  readonly gate: string;
  readonly release: string;
  readonly decision: unknown;
  readonly evidence: unknown;
  readonly rationale: unknown;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly blockers: readonly GateBlocker[];
}): GateDecision {
  assertGate(input.gate);
  assertRelease(input.release);
  const problems: string[] = [];
  if (!GATE_DECISION_KINDS.includes(input.decision as GateDecisionKind)) problems.push('decision is GO, HOLD or REWORK');
  const evidence = readEvidence(input.evidence);
  if (evidence === undefined || evidence.length === 0) problems.push('evidence is at least one { label, ref } — what the decision rests on and where to find it');
  if (!isStr(input.rationale)) problems.push('rationale says, in writing, why');
  if (!isStr(input.decidedBy)) problems.push('a decision is made in a named person\'s own name');
  if (!isStr(input.decisionId)) problems.push('a decision id');
  if (problems.length > 0) throw new DecisionNotReadableError(problems);
  const mine = input.blockers.filter((b) => b.gate === input.gate);
  const decision = input.decision as GateDecisionKind;
  if (decision === 'GO' && mine.length > 0) throw new GoWhileBlockedError(input.gate, mine);
  return {
    decisionId: input.decisionId, gate: input.gate, release: input.release, decision,
    evidence: evidence!, rationale: (input.rationale as string).trim(), decidedBy: input.decidedBy, decidedAt: input.decidedAt,
    blockersAtDecision: mine,
  };
}

/**
 * QG-12's own pass condition is that every OTHER gate ends GO, HOLD or REWORK. So for a release, each of QG-01 …
 * QG-11 with no decision yet is a blocker on QG-12: the owner cannot say "every gate has ended" while one has not.
 */
export function undecidedGateBlockers(decisions: readonly GateDecision[], release: string): readonly GateBlocker[] {
  assertRelease(release);
  const decided = new Set(decisions.filter((d) => d.release === release).map((d) => d.gate));
  return QUALITY_GATES.filter((g) => g.gate !== 'QG-12' && !decided.has(g.gate)).map((g) => ({
    gate: 'QG-12', kind: 'check' as const, ref: `undecided:${g.gate}`,
    reason: `${g.gate} ${g.name} has no GO, HOLD or REWORK decision for ${release} yet`,
  }));
}

export type GateState = 'undecided' | 'GO' | 'HOLD' | 'REWORK' | 'GO_NOW_BLOCKED';

export interface GateStanding {
  readonly gate: string;
  readonly name: string;
  readonly passCondition: string;
  readonly release: string;
  /** The latest decision for this gate and release, or null — there is no default (silence is not approval). */
  readonly decision: GateDecisionKind | null;
  readonly state: GateState;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly rationale?: string;
  readonly evidence: readonly EvidenceLink[];
  /** What blocks the gate NOW. */
  readonly blockers: readonly GateBlocker[];
  /** How many decisions this gate has had for this release (the history is kept). */
  readonly decisionsMade: number;
}

/**
 * Every gate's standing for one release: the latest decision (in decision time order), or undecided. A GO that
 * something now blocks reads GO_NOW_BLOCKED, so a later problem is never hidden behind an earlier yes.
 */
export function gateRegister(decisions: readonly GateDecision[], release: string, blockers: readonly GateBlocker[]): readonly GateStanding[] {
  assertRelease(release);
  return QUALITY_GATES.map((g): GateStanding => {
    const mine = decisions
      .filter((d) => d.gate === g.gate && d.release === release)
      .slice()
      .sort((a, z) => (a.decidedAt < z.decidedAt ? -1 : a.decidedAt > z.decidedAt ? 1 : 0));
    const latest = mine.at(-1);
    const now = blockers.filter((b) => b.gate === g.gate);
    if (latest === undefined) {
      return { gate: g.gate, name: g.name, passCondition: g.passCondition, release, decision: null, state: 'undecided', evidence: [], blockers: now, decisionsMade: 0 };
    }
    const state: GateState = latest.decision === 'GO' && now.length > 0 ? 'GO_NOW_BLOCKED' : latest.decision;
    return {
      gate: g.gate, name: g.name, passCondition: g.passCondition, release, decision: latest.decision, state,
      decidedBy: latest.decidedBy, decidedAt: latest.decidedAt, rationale: latest.rationale, evidence: latest.evidence,
      blockers: now, decisionsMade: mine.length,
    };
  });
}

export interface GateRegisterSummary {
  readonly undecided: number;
  readonly go: number;
  readonly hold: number;
  readonly rework: number;
  readonly goNowBlocked: number;
  /** True only when all twelve gates read GO with nothing blocking them. */
  readonly allGo: boolean;
}

export function summariseGateRegister(standings: readonly GateStanding[]): GateRegisterSummary {
  const n = (s: GateState): number => standings.filter((g) => g.state === s).length;
  return {
    undecided: n('undecided'), go: n('GO'), hold: n('HOLD'), rework: n('REWORK'), goNowBlocked: n('GO_NOW_BLOCKED'),
    allGo: standings.length === QUALITY_GATES.length && standings.every((g) => g.state === 'GO'),
  };
}
