# SRE Retail OS — Project Status

_Read this file, together with `CLAUDE.md`, at the start of every session (prompt R6)._
_Update it at the end of every session (prompt R10). This is what stops the project drifting._

Last updated: 2 August 2026

---

## Current stage
**Setup (Part 1 of the Build Pack).** No application code exists yet, by design.
The next stage is **Stage 0 — Owner approval and governance**, which is blocked
until the owner decisions below are made.

## Last completed
- **Setup 1 — Project and rules.** Repository folder structure, `CLAUDE.md`,
  `docs/STATUS.md`, `docs/traceability.md`, `.gitignore` and the first commit.
- **Setup 3 — Safety net.** Test runner with a single command, continuous
  integration on every pull request (type check, lint, tests, secret scan,
  dependency vulnerability scan), a pre-commit secret block, a demonstrated
  failing-then-passing test, and `docs/runbooks/how-to-check-tests.md`.
- **Setup 4 — Decisions and guardrails.** `docs/adr/0001-baseline-decisions.md`
  and machine-checkable guardrail tests in `tests/guardrails/` for the six
  hard rules from roadmap sections 18 and 20.

## In progress
- Nothing. Setup is at a clean stopping point.

## Blocked
- **Setup 2 — Requirement index — needs the roadmap.** The controlling document
  `docs/roadmap/roadmap-v2.0.docx` (Final Master Roadmap & Developer
  Requirements v2.0) is **not yet in the repository**. Setup 2, and the
  roadmap-sourced parts of Stage 0 and the ADR, cannot be completed until it is
  placed at `docs/roadmap/roadmap-v2.0.docx`. A structured, clearly-marked
  placeholder index has been created at `docs/requirements/index.md`.

## Needs owner decision
Before Stage 0 can pass its gate (see Annexure G and Annexure H), the owner must:
- **D4 — Second technical custodian.** Write the name into the roadmap.
  Annexure H: _"the only one I would refuse to start without."_ Fill this first.
- **A-01 to A-05 (Annexure G, HIGH).** Close these five findings — about half a
  day's work between them, none needs a feature:
  - A-01 Put target months against M0–M8.
  - A-02 Write the four M5 feasibility checkpoints into §36.1.
  - A-03 Add the read-only supplier-invoice import slice after stage 5.
  - A-04 Add six business measures to §2.3, each with a Stage 1 baseline.
  - A-05 Allocate a named person and funded help to run the parallel period.
- **D3 running-cost ceiling, D5 GO date, D8 completion date** — the three
  remaining blank blocking owner fields (may close together at GO).

## Next session should start with
1. Place `docs/roadmap/roadmap-v2.0.docx` in the repository, then run **Setup 2**
   to build the requirement index and open-questions list.
2. In parallel, the owner closes D4 and findings A-01 to A-05.
3. Then run the **Stage 0** prompt to create and populate the governance
   registers, and check it against the Stage 0 acceptance list in Annexure H.
