# SRE Retail OS — Project Status

_Read this file, together with `CLAUDE.md`, at the start of every session (prompt R6)._
_Update it at the end of every session (prompt R10). This is what stops the project drifting._

Last updated: 2 August 2026

---

## Current stage
**Stage 0 — Owner approval and governance (work complete; gate not yet signed).**
No application code exists yet, by design. The governance registers are built and
populated from every source available. The Stage 0 **gate** cannot be signed until
the owner fills the **D4 second-custodian name** (the one field Annexure H will not
start without). Setup 2 is partially done and can be finished when the roadmap file
is added.

## Last completed
- **Setup 1 — Project and rules.** Folder structure, `CLAUDE.md`, `STATUS.md`,
  `traceability.md`, `.gitignore`, first commit.
- **Setup 3 — Safety net.** One-command test runner, CI (type check, lint, tests,
  secret scan, dependency scan), pre-commit secret block, demonstrated
  failing-then-passing test, `docs/runbooks/how-to-check-tests.md`.
- **Setup 4 — Decisions and guardrails.** `docs/adr/0001-baseline-decisions.md`
  and six machine-checkable guardrail tests for the hard rules.
- **Stage 0 — Governance registers.** `docs/registers/`: `decisions.md`,
  `risks.md` (the 17 Annexure G findings + structural risks), `compliance.md`
  (GST, FSSAI, Legal Metrology, DPDP incl. both fixed dates, CERT-In, consumer,
  RBI payment), `issues.md`, `changes.md`, `requirements.md`.
- **Setup 2 (partial) — Requirement index.** `docs/requirements/index.md` upgraded
  from a blank scaffold to a real module/extension/gate/agent/control map sourced
  from Annexure H, with every roadmap-only detail marked `⛔ roadmap`.

## In progress
- Nothing active. Clean stopping point.

## Blocked (inputs I cannot supply — not decisions I'm waiting on)
- **The roadmap file itself.** `docs/roadmap/roadmap-v2.0.docx` was never provided
  to this session (only Annexures G and H were). Everything marked `⛔ roadmap` in
  the index and registers needs it to be completed verbatim. I have built
  everything that can be built correctly without it; I will not invent its
  contents (`CLAUDE.md` rule #1).
- **Real-world facts only the owner holds:** the D4 custodian's name, the D3/D5/D8
  values, which conditional departments the store operates (Stage 16). These are
  recorded as **open** in `docs/registers/decisions.md` — which is the correct
  place for them; the register tracks them, the project is not stalled on them.

## Needs owner decision (recorded, not blocking further build)
Tracked in `docs/registers/decisions.md` and `risks.md`:
- **D4 second technical custodian** — fill first (blocks only the Stage 0 gate).
- **A-01…A-05** (HIGH) and **D3 / D5 / D8** — close before the formal GO.

## Next session should start with
1. If the roadmap `.docx` is available, place it at `docs/roadmap/roadmap-v2.0.docx`
   and finish Setup 2 (complete every `⛔ roadmap` cell) and the roadmap-sourced
   rows of the registers and ADR.
2. Otherwise continue with what does **not** need the roadmap: Stage 5 engineering
   foundation planning, and Stage 1 discovery *templates* (as-is/to-be/baseline
   forms) ready for the owner's store measurements.
3. Owner fills D4 to allow the Stage 0 gate to be signed.
