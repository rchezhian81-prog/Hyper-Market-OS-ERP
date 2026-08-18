# ADR NNNN — <short decision title>

- **Status:** Proposed | Accepted | Superseded by ADR-XXXX
- **Date:** <DD Month YYYY>
- **Context:** What forces are at play — the requirement, the roadmap §, the constraint, the code as it
  stands. Link the evidence (`path.ts:line`). State the problem before the decision.

## Decision

The decision, stated plainly. What we will do, and the boundary of what we will NOT do.

## §19-substitution impact (required when this ADR records a substitution from the roadmap §19 baseline)

Per CLAUDE.md, a substitution from the technology baseline must be analysed on six axes:

- **Offline:** effect on the offline-first guarantee (P-01).
- **Support:** operational burden, who runs it, failure modes.
- **Security:** attack surface, data exposure, least-privilege impact.
- **Cost:** infrastructure and engineering cost vs the baseline.
- **Portability:** lock-in, exportability, versioned contracts (P-06).
- **Maintainability:** long-term code/ops health.

Omit this section for decisions that are not §19 substitutions.

## Consequences

What becomes true, what trade-offs are accepted, what is now constrained.

## Reconsider-when

The concrete trigger that should re-open this decision (e.g. "multi-instance cloud", "a second store").
