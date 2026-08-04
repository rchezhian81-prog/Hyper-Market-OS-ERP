// Investigation cases, evidence preservation and outcome feedback (M15-FR-04).
//
// A case is opened when somebody may have taken something. That single fact sets every
// design decision in this file, because a case file is read in two situations and both
// are adversarial: a disciplinary meeting, and a court.
//
//   • **EVIDENCE IS APPEND-ONLY.** There is no edit and no delete — not for a manager,
//     not for the owner, not for whoever wrote this. `addEvidence` only ever appends,
//     and each item is sealed to the one before it, so a removal or an alteration is
//     **detectable** rather than merely forbidden. We do not claim tampering is
//     impossible; we guarantee it leaves a hole you can see (the same discipline as
//     `packages/audit`).
//
//   • **THE CHAIN OF CUSTODY IS PART OF THE EVIDENCE.** Who collected it, when, and
//     from where. A CCTV clip with no chain of custody is a video, not evidence, and
//     the first question anyone competent asks is where it has been.
//
//   • **A CASE CANNOT CLOSE WITHOUT AN OUTCOME**, and "unfounded" is a real outcome
//     that must be recordable. A system that only lets you close a case as *proven*
//     quietly pressures people into proving things.
//
//   • **THE ACCUSED IS A PERSON.** Cases carry a subject reference, never a name or a
//     photograph in the record itself (PRV), access is restricted, and an unfounded
//     outcome is stated as plainly as a proven one.
//
//   • **OUTCOMES TUNE THE RULES.** The roadmap asks that outcomes *"measurably adjust
//     the rules that raised them"*. So closing a case returns a concrete, applicable
//     `RuleAdjustment` — a rule that fires ten times and is unfounded ten times is a
//     rule that is wasting the shop's attention, and the module says so with numbers.
//
// Pure and deterministic. The hash is dependency-free and honest about what it is: it
// catches corruption and casual editing, not a determined cryptographic attack — a
// deployment injects a real digest through the `Hasher` port without this changing.

export type CaseState = 'open' | 'closed';

export type CaseOutcome =
  | 'proven'
  | 'unfounded'
  | 'inconclusive'
  | 'process_failure'
  | 'referred_to_police';

export type EvidenceKind =
  | 'transaction_record'
  | 'cctv_reference'
  | 'witness_statement'
  | 'stock_count'
  | 'settlement_record'
  | 'note';

export interface EvidenceItem {
  readonly evidenceId: string;
  readonly kind: EvidenceKind;
  /** A reference, never the material itself — the material lives in object storage. */
  readonly ref: string;
  readonly description: string;
  /** Chain of custody: who collected it, when, and from where. */
  readonly collectedBy: string;
  readonly collectedAt: string;
  readonly collectedFrom: string;
  /** Seal over this item and the one before it. A gap or an edit breaks the chain. */
  readonly seal: string;
}

export interface InvestigationCase {
  readonly caseId: string;
  readonly tenantId: string;
  /** The exception or signal that started it — a case never appears from nowhere. */
  readonly raisedFromRef: string;
  readonly subjectRef: string;
  readonly summary: string;
  readonly valueMinor: number;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly assignedTo: string;
  readonly state: CaseState;
  readonly evidence: readonly EvidenceItem[];
  readonly outcome?: CaseOutcome;
  readonly outcomeNote?: string;
  readonly closedBy?: string;
  readonly closedAt?: string;
}

/**
 * Field separator inside the sealed material. Present at all so that ("ab","c") and
 * ("a","bc") cannot produce the same seal, and written as an **escape** rather than a
 * literal control byte — a source file carrying one reads as binary to git, and its
 * diff then shows a reviewer nothing (`tests/guardrails/plain-text-source.test.ts`).
 */
const SEPARATOR = '\u001f';

/**
 * Dependency-free seal. Deliberately the same shape as `packages/audit`'s: it detects
 * corruption and casual editing and is NOT a cryptographic guarantee. Saying so here
 * is part of the control — an overstated seal is worse than an honest weak one.
 */
export function sealOf(previousSeal: string, item: Omit<EvidenceItem, 'seal'>): string {
  const material = [
    previousSeal,
    item.evidenceId,
    item.kind,
    item.ref,
    item.description,
    item.collectedBy,
    item.collectedAt,
    item.collectedFrom,
  ].join(SEPARATOR);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < material.length; i += 1) {
    const c = material.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export const GENESIS_SEAL = '0000000000000000';

export interface OpenCaseResult {
  readonly opened: boolean;
  readonly detail: string;
  readonly case?: InvestigationCase;
}

/** Open a case. It must come from a raised exception or signal, and name an investigator. */
export function openCase(input: {
  readonly caseId: string;
  readonly tenantId: string;
  readonly raisedFromRef: string;
  readonly subjectRef: string;
  readonly summary: string;
  readonly valueMinor: number;
  readonly openedBy: string;
  readonly assignedTo: string;
  readonly at: string;
}): OpenCaseResult {
  if (input.raisedFromRef.trim() === '') {
    return {
      opened: false,
      detail: 'a case must come from a raised exception or signal — an investigation that starts from a suspicion has nothing to check against',
    };
  }
  if (input.assignedTo.trim() === '') {
    return { opened: false, detail: 'a case needs a named investigator' };
  }
  if (input.summary.trim() === '') {
    return { opened: false, detail: 'a case needs a summary saying what is alleged' };
  }
  if (input.assignedTo === input.subjectRef) {
    // It happens, and it is the sort of thing nobody notices until afterwards.
    return { opened: false, detail: 'the subject of a case cannot investigate it' };
  }

  return {
    opened: true,
    detail: `case ${input.caseId} opened on ${input.subjectRef}, assigned to ${input.assignedTo}`,
    case: {
      caseId: input.caseId,
      tenantId: input.tenantId,
      raisedFromRef: input.raisedFromRef,
      subjectRef: input.subjectRef,
      summary: input.summary,
      valueMinor: input.valueMinor,
      openedBy: input.openedBy,
      openedAt: input.at,
      assignedTo: input.assignedTo,
      state: 'open',
      evidence: [],
    },
  };
}

export interface AddEvidenceResult {
  readonly added: boolean;
  readonly detail: string;
  readonly case: InvestigationCase;
}

/**
 * Add evidence. **Append-only** — the returned case has every previous item unchanged,
 * plus one more, sealed to the chain. There is no `removeEvidence` and no
 * `updateEvidence` in this module, and the tests assert that absence: it is the
 * control, not an oversight (hard rule #6).
 */
export function addEvidence(
  investigation: InvestigationCase,
  item: Omit<EvidenceItem, 'seal'>,
): AddEvidenceResult {
  if (investigation.state === 'closed') {
    return {
      added: false,
      detail: 'this case is closed — new evidence reopens it as a new case rather than being added to a closed record',
      case: investigation,
    };
  }
  if (item.collectedBy.trim() === '' || item.collectedFrom.trim() === '') {
    return {
      added: false,
      detail: 'evidence needs a chain of custody: who collected it and where from. Without that it is material, not evidence',
      case: investigation,
    };
  }
  if (investigation.evidence.some((e) => e.evidenceId === item.evidenceId)) {
    return { added: false, detail: `evidence "${item.evidenceId}" is already on this case`, case: investigation };
  }

  const previous = investigation.evidence[investigation.evidence.length - 1];
  const sealed: EvidenceItem = { ...item, seal: sealOf(previous?.seal ?? GENESIS_SEAL, item) };

  return {
    added: true,
    detail: `${item.kind} added by ${item.collectedBy}`,
    case: { ...investigation, evidence: [...investigation.evidence, sealed] },
  };
}

export interface ChainBreak {
  readonly index: number;
  readonly evidenceId: string;
  readonly detail: string;
}

/**
 * Verify the evidence chain. Reports **every** break, not just the first — a case file
 * that was edited in two places should say so twice, because the pattern of what was
 * changed is itself evidence.
 */
export function verifyEvidence(investigation: InvestigationCase): {
  readonly intact: boolean;
  readonly breaks: readonly ChainBreak[];
} {
  const breaks: ChainBreak[] = [];
  let previous = GENESIS_SEAL;
  investigation.evidence.forEach((item, index) => {
    const { seal, ...rest } = item;
    const expected = sealOf(previous, rest);
    if (expected !== seal) {
      breaks.push({
        index,
        evidenceId: item.evidenceId,
        detail: `the seal on "${item.evidenceId}" does not match its contents — this item was altered, or one before it was removed`,
      });
    }
    previous = seal;
  });
  return { intact: breaks.length === 0, breaks };
}

export interface RuleAdjustment {
  readonly ruleRef: string;
  readonly action: 'tighten' | 'relax' | 'retire' | 'keep';
  readonly detail: string;
}

export interface CloseCaseResult {
  readonly closed: boolean;
  readonly detail: string;
  readonly case: InvestigationCase;
}

/**
 * Close a case with an outcome. "Unfounded" is a first-class outcome — a system that
 * only closes cases as proven quietly pressures people into proving things.
 *
 * A **proven** case is a decision with consequences for a person, so it needs someone
 * other than the investigator (§28).
 */
export function closeCase(input: {
  readonly case: InvestigationCase;
  readonly outcome: CaseOutcome;
  readonly note: string;
  readonly closedBy: string;
  readonly at: string;
}): CloseCaseResult {
  const c = input.case;
  if (c.state === 'closed') {
    return { closed: false, detail: 'this case is already closed', case: c };
  }
  if (input.note.trim() === '') {
    return { closed: false, detail: 'a case outcome needs a note saying what was found', case: c };
  }
  if ((input.outcome === 'proven' || input.outcome === 'referred_to_police') && input.closedBy === c.assignedTo) {
    return {
      closed: false,
      detail: 'a proven outcome needs someone other than the investigator to sign it off (§28)',
      case: c,
    };
  }
  if (input.outcome === 'proven' && c.evidence.length === 0) {
    return { closed: false, detail: 'a case cannot be proven with no evidence on it', case: c };
  }
  const chain = verifyEvidence(c);
  if (!chain.intact) {
    return {
      closed: false,
      detail: `the evidence chain on this case is broken at ${chain.breaks.map((b) => b.evidenceId).join(', ')} — it cannot be closed on evidence that does not verify`,
      case: c,
    };
  }

  return {
    closed: true,
    detail: `closed as ${input.outcome} by ${input.closedBy}`,
    case: {
      ...c,
      state: 'closed',
      outcome: input.outcome,
      outcomeNote: input.note,
      closedBy: input.closedBy,
      closedAt: input.at,
    },
  };
}

/**
 * The feedback loop the roadmap asks for: outcomes **measurably** adjust the rules that
 * raised them. A rule whose cases are almost all unfounded is not protecting the shop
 * — it is spending the manager's attention, and after a few weeks of that nobody reads
 * any of the alerts, including the real ones. So it is reported with numbers and a
 * recommendation, and the recommendation is applied by a person.
 */
export function ruleFeedback(
  cases: readonly InvestigationCase[],
  minimumCases = 5,
): readonly RuleAdjustment[] {
  const byRule = new Map<string, InvestigationCase[]>();
  for (const c of cases) {
    if (c.state !== 'closed') continue;
    const rule = c.raisedFromRef.split(':')[0] ?? c.raisedFromRef;
    byRule.set(rule, [...(byRule.get(rule) ?? []), c]);
  }

  return [...byRule]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ruleRef, rows]): RuleAdjustment => {
      if (rows.length < minimumCases) {
        return {
          ruleRef,
          action: 'keep',
          detail: `${rows.length} closed case(s) — too few to judge the rule on; a rule is not tuned on a handful of outcomes`,
        };
      }
      const proven = rows.filter((c) => c.outcome === 'proven' || c.outcome === 'referred_to_police').length;
      const unfounded = rows.filter((c) => c.outcome === 'unfounded').length;
      const provenPercent = Math.round((proven / rows.length) * 100);

      if (unfounded === rows.length) {
        return {
          ruleRef,
          action: 'retire',
          detail: `${rows.length} cases, every one unfounded — this rule has never once been right, and every alert it sends costs the manager attention that the real ones need`,
        };
      }
      if (provenPercent < 25) {
        return {
          ruleRef,
          action: 'relax',
          detail: `${provenPercent}% of ${rows.length} cases proven — the threshold is too tight and is generating noise; raise it rather than training people to ignore it`,
        };
      }
      if (provenPercent >= 75) {
        return {
          ruleRef,
          action: 'tighten',
          detail: `${provenPercent}% of ${rows.length} cases proven — this rule is finding real losses, so lower the threshold and catch more of them`,
        };
      }
      return {
        ruleRef,
        action: 'keep',
        detail: `${provenPercent}% of ${rows.length} cases proven — the rule is working as intended`,
      };
    });
}
